# Ranked & MMR

**MMR** (Match Making Rating) is a player's hidden skill estimate. The ranked system is built around it and does five things:

1. **Rates skill** — a Glicko‑2‑derived rating (`MMR`, plus an uncertainty `RD` and a `Volatility`) that converges fast and self‑corrects.
2. **Shows a ladder** — a visible tier / division / **Rank Points (RP)** climb mapped from MMR, tuned so RP chases your true MMR.
3. **Reads the board** — the *size* of each MMR swing is scaled by how **decisively** the game was won (surviving army, speed), not just win/loss.
4. **Removes structural bias** — a self‑calibrating **side‑bias** term so being assigned GREEN/lower vs RED/upper never quietly costs you rating.
5. **Handles abandons fairly** — leans on the existing **AI‑takeover** flow so a disconnect never leaves a turn unmade, and separates *skill* (MMR) from *reliability* (queue behaviour).

> **Status: proposed design, not yet implemented.** Today the server records `wins` / `losses` / `totalGamesPlayed` and stubs rating (`mm/v1/lobby.ts` — `setRating(0)`, `PLACEHOLDER_LEAGUE`). All constants below are **proposed** starting values; §13 collects them. The pure rating math is intended to live in the **shared engine** (`common/src/ranked/`) so the client can *preview* a match's `±MMR` and the authoritative server can *commit* it from the identical code — the same client/server split the fight engine already uses. Integration points are in §12.

---

## 0. The rating triple

Every player carries three numbers, not one:

| Symbol | Name | Meaning | Range (proposed) |
| --- | --- | --- | --- |
| `MMR` | Match Making Rating | skill estimate (the "score") | ~0 – 3000, seeded **1500** |
| `RD` | Rating Deviation | how *unsure* we are of `MMR` (± window) | **45** (certain) – **350** (new/idle) |
| `σ`  | Volatility | how *erratic* recent results are | ~**0.06** |

`MMR` is what matchmaking and the ladder read. `RD` is the engine of the whole system: **high RD → big, fast rating moves; low RD → small, stable ones.** A brand‑new or long‑idle account has high `RD` and rockets toward its true skill; a grinder sits at low `RD` and barely twitches per game. Displayed skill is `MMR`; a client may show the confidence band `MMR ± 2·RD`.

We seed **at the population mean (1500), not low** — Glicko places you by shrinking `RD`, not by climbing from the bottom. Placements (§4) are just the high‑`RD` window.

---

## 1. Expected result

Before a game, each player has an **expected score** `E ∈ (0,1)` — their win probability given the rating gap, damped by the opponent's uncertainty and corrected for side:

```
g(RD)   = 1 / sqrt(1 + 3·(RD·ln10/400)² )          // Glicko RD-damping, ∈ (0,1]
E_raw   = 1 / (1 + 10^( g(RD_opp)·(MMR_opp − MMR_you) / 400 ))
E       = clamp(E_raw + sideOffset, 0.01, 0.99)     // §1.1
```

`SCALE = 400` is the familiar Elo scale (a 400‑point gap ≈ 10:1 odds). `g(RD_opp)` pulls `E` toward 0.5 when the opponent is poorly measured, so beating an uncertain player is worth less certainty in return.

### 1.1 Side‑bias self‑correction

HOC assigns players to **GREEN / lower** or **RED / upper**. If one side is structurally favored (first‑move, geometry), a naïve rating quietly taxes whoever draws the weak side. We remove it with a small, **data‑driven** offset:

```
p_side   = trailing-window win rate of YOUR assigned side over all ranked games
sideOffset(you) = SIDE_BETA · (p_side − 0.5)          // SIDE_BETA = 0.10 (proposed)
```

If your side wins 54% globally, you were ~expected to win a bit more, so a win pays slightly less and a loss costs slightly more — and the *disadvantaged* side is rewarded symmetrically. The term is **auto‑calibrated** (recomputed from live results) and **disabled** while `|p_side − 0.5| < 0.02` so noise can't manufacture a bias. Matchmaking also *assigns* sides to cancel this out (§10), so `sideOffset` is a second line of defence, not the primary fix.

---

## 2. The per‑game update

We treat **one game as one rating period** (the standard Glicko‑2 per‑game simplification). Let `S` be the actual score:

```
S = 1.0  win     0.5  draw (rare — see §8)     0.0  loss
```

The intuitive, tuned form used for display and preview:

```
K        = K_BASE · (RD_you / RD_REF)               // K_BASE = 24, RD_REF = 60
ΔMMR_raw = K · (S − E)                               // classic surprise term
ΔMMR     = clamp( ΔMMR_raw · D , −SWING_CAP, +SWING_CAP )   // D = §3, SWING_CAP = 48
MMR_you += round(ΔMMR)
```

* `S − E` is the **surprise**: beating a stronger player (low `E`) pays a lot; stomping a much weaker one pays almost nothing.
* `K` scales with **your** `RD`, so uncertain players move fast and settled players move slow.
* `D` (Decisiveness, §3) scales the *magnitude* only — it can never flip the sign.
* `SWING_CAP` bounds any single game.

`RD` and `σ` update by the **canonical Glicko‑2 equations** (convert ratings to the internal scale `μ = (MMR−1500)/173.7178`, `φ = RD/173.7178`; solve the volatility iteration; shrink `φ` toward `RD_FLOOR = 45` on a played game, grow it on idle — §7). The Elo‑form above is the tuned approximation of that same step for readability and client previews; the server commits the full Glicko‑2 result.

---

## 3. Decisiveness — the board turned into a multiplier

*(This is the HOC‑specific heart of the system.)* Win/loss is binary, but a fight isn't: a flawless sweep and a one‑stack squeaker are not the same performance. **Decisiveness `D`** nudges the swing within a hard band so blowouts move rating a little more and nailbiters a little less — **without ever letting farming beat skill.**

From the final board state (the authoritative end‑of‑fight snapshot):

```
armyFrac  = Σ surviving-winner stack power / winner starting army power     ∈ [0,1]
speedFrac = clamp( (LAP_SOFT_CAP − laps) / LAP_SOFT_CAP , 0, 1 )            // LAP_SOFT_CAP = 12
dom       = 0.7·armyFrac + 0.3·speedFrac                                     // "domination index" ∈ [0,1]
D         = D_MIN + (D_MAX − D_MIN)·dom          // D_MIN = 0.75, D_MAX = 1.25  →  D ∈ [0.75, 1.25]
```

Both players scale by the **same** `D` (winner gains `D·|Δ|`, loser loses `D·|Δ|`), so the ledger stays balanced.

| Outcome | `dom` | `D` | Effect on the swing |
| --- | --- | --- | --- |
| Flawless, fast sweep | ~1.0 | **1.25** | +25% |
| Even trade | ~0.5 | ~1.00 | neutral |
| Pyrrhic, grindy win | ~0.1 | **~0.80** | −20% |

**Guardrail:** the band is `±25%`, deliberately small. The skill term `(S − E)` still dominates every game — Decisiveness *colours* the result, it never *decides* it. `armyFrac` uses stack **power/value** (so losing a big front‑line stack costs more than a trash mob), read from the same stat the engine already tracks. *Non‑goal:* faction/synergy diversity, hero picks, and "style" do **not** feed MMR — MMR is pure results. (They may drive cosmetic post‑game scores elsewhere.)

---

## 4. Placements & provisional rating

* New account seeds `MMR = 1500`, `RD = 350`, `σ = 0.06`.
* First **`PLACEMENT_GAMES = 10`** are *provisional*: high `RD` ⇒ large `K` ⇒ your rating sprints toward the truth. No tier is shown; the UI shows a "placing" badge and a rough range.
* **Placement streak bonus** (anti‑smurf, §9): each consecutive placement **win** adds a decaying `STREAK_BONUS` on top of the normal gain (`+16, +12, +9, …`), so a strong player escaping a low seed doesn't waste ten games beating up beginners.
* After placements, `RD` has fallen to the active band (~60–80) and a tier is assigned from `MMR` (§5).

---

## 5. The visible ladder — Tiers, Divisions, Rank Points

MMR is hidden; players climb a **ladder** derived from it. This is the dopamine layer, and it's tuned so **RP chases MMR**.

### Tiers & divisions

```
Wood · Bronze · Silver · Gold · Platinum · Diamond · Master · Grandmaster · Mythic
```

* **Wood → Diamond**: four divisions each (`IV → III → II → I`), `RP_PER_DIVISION = 100` RP per division.
* **Master → Mythic**: **apex** — no divisions; RP is a raw leaderboard number (`RP = MMR − MASTER_FLOOR`) and decays on idle (§7). Grandmaster / Mythic are **population‑capped** (e.g. top 500 / top 0.1%), not fixed cutoffs.
* Tier cutoffs are **percentile‑anchored per season** (recomputed from the live population at season start), so "Gold" means "middle of the pack" every season instead of drifting with rating inflation. The MMR→tier table in §13 is only the *initial* mapping.

### Gaining / losing RP — the elastic band

RP per game isn't flat; it's pulled toward your **true** MMR so you reach your real rank fast and stick there:

```
anchor = expected MMR for your current (tier, division)      // §13 table
gap    = MMR_you − anchor                                     // + = you're under-ranked
rpGain = clamp( RP_BASE + GAP_K·gap , 10, 35 )                // RP_BASE = 20, GAP_K = 0.05
rpLoss = clamp( RP_BASE − GAP_K·gap , 10, 35 )
```

* **Under‑ranked** (MMR ≫ your division): big RP gains, tiny RP losses → you shoot up. This is why a returning smurf "climbs out" quickly and *feels* it.
* **At your rank** (gap ≈ 0): symmetric ±20, the classic tug‑of‑war.
* **Over‑ranked**: small gains, big losses → gravity returns you to true rank.

### Promotion & demotion

* Cross **100 RP** in a division → **promote** (division up, or tier up from `I`). No promo‑series gate below Diamond (they mostly frustrate); Diamond→Master uses a **best‑of‑5 promotion series** to make the apex feel earned.
* Hit **0 RP** and lose → **demote**, unless a **demotion shield** is active: on entering a division you get **`SHIELD_GAMES = 3`** grace games at 0 RP before you can fall. Shields refill after a short win.
* Apex has no shields — you float on raw `MMR − MASTER_FLOOR`.

---

## 6. Seasons & soft reset

* A season is **`SEASON_DAYS = 70`**. At rollover, ratings **soft‑reset** toward the mean (never wiped):

```
MMR_new = round( MMR_old·(1 − PULL) + 1500·PULL )     // PULL = 0.35
RD_new  = min( 150, RD_old · 1.4 )                     // re-open uncertainty a little
```

  Everyone re‑settles in a handful of games while keeping the shape of the ladder. `PULL = 0.35` compresses extremes (a 2400 → ~2085, a 900 → ~1110) so top players re‑prove and the ladder breathes.
* **Rewards** are granted by **peak tier** reached that season (not final), so chasing rank never punishes you for a bad closing week.

---

## 7. Inactivity & RD decay

Idleness grows *uncertainty*, not loss of skill:

```
RD ← min( 350, sqrt( RD² + c²·Δt_periods ) )          // Glicko decay, c tuned so RD: 60 → 350 over ~90 idle days
```

* Come back after a break: `RD` is high, so your first few games swing hard and re‑seat you quickly. **You never lose your tier just for not playing** below the apex.
* **Apex only:** to keep the leaderboard live, Master+ RP decays after **`DECAY_GRACE = 10`** idle days at `DECAY_RATE` RP/day until you play. This is a leaderboard‑freshness rule, not a skill penalty.

---

## 8. Abandons, disconnects & the AI‑takeover rule

HOC never leaves a turn unmade: two consecutive missed turns hand a player's units to the **server AI**, and the game always reaches a real result (human or AI). Ranked leans on that:

| Situation | MMR | Reliability / RP |
| --- | --- | --- |
| Game reaches a result (even AI‑completed) | **Normal** MMR for both — the fight was decided | — |
| **You** triggered AI‑takeover and **lost** | Normal MMR loss (no *extra* penalty) | **Reliability** hit → queue cooldown; repeated ⇒ low‑priority queue |
| You abandoned but your AI still **won** | Keep the win MMR | No reliability credit; abandon still logged |
| Opponent DC'd, you win via *their* AI | **Normal** win | — |
| **Dodge in PICK/ban** (before PLAY starts) | **No MMR change** (game never began) | Dodger takes an RP dock + escalating queue timeout |
| True server‑side draw (timeout stalemate, extremely rare) | `S = 0.5` both | — |

The principle: **MMR measures who would have won; Reliability measures whether you showed up.** They're separate ledgers so one bad‑connection night doesn't tank your rank, but chronic quitting still gets throttled. This maps cleanly onto the existing takeover + `GameStatus` lifecycle.

---

## 9. Anti‑smurf / fast convergence

Three mechanisms already above combine to make new‑account stomping short‑lived:

1. **High seed `RD` (350)** ⇒ large `K` ⇒ every early result moves rating a lot.
2. **Placement streak bonus** (§4) ⇒ consecutive early wins add extra MMR, so a smurf leaves the beginner pool in ~3–5 games rather than 10.
3. **Volatility `σ`** ⇒ when results consistently defy expectation (a "1500" winning 8 straight vs 1900s), Glicko‑2 *raises* `σ`, which widens `RD`, which accelerates the climb further — the rating actively chases a moving target.

Net effect: a genuinely strong new player converges to their real MMR inside their placement window, minimizing the games where beginners face them.

---

## 10. Matchmaking integration

Replace today's **win‑rate** pairing with an MMR‑aware match that widens over time (the queue daemon already polls on an interval and expands tolerance):

```
tol(t)       = TOL0 + TOL_RATE·t                       // TOL0 = 60 MMR, TOL_RATE = 20 MMR/s in queue
eligible(a,b)= |MMR_a − MMR_b| ≤ tol(t_a) + k·(RD_a + RD_b)   // uncertain players match a wider band
matchQuality = 1 − |MMR_a − MMR_b| / SPREAD            // pick the best eligible pair
```

* **Uncertainty‑aware:** high‑`RD` players (new/returning) match a wider MMR range so they aren't stuck waiting; low‑`RD` players get tight, fair pairings.
* **Side assignment cancels bias:** when a pair is made, assign the **structurally‑favored side to the *lower*‑MMR player** (using the live `p_side` from §1.1). This is the primary side‑bias fix; `sideOffset` only mops up the residue.
* **Preview:** because the math is in `common/`, the client can show each player their projected `+X / −Y MMR` *before* accepting, from the same code the server will commit.

---

## 11. Worked examples

**A — even match, clean win.** You `1500` (RD 60) beat an equal `1500` (RD 60); you finish with 80% army fast (`armyFrac 0.8`, `speedFrac 0.7`).
`E = 0.5` · `K = 24·(60/60) = 24` · raw `= 24·(1−0.5) = +12` · `dom = 0.7·0.8+0.3·0.7 = 0.77` · `D = 0.75+0.5·0.77 = 1.14` → **ΔMMR ≈ +14** (opponent −14).

**B — upset.** You `1400` (placement, RD 200) beat `1700` (RD 60) in a grind (`dom ≈ 0.15`).
`E = 1/(1+10^(300/400)) ≈ 0.15` · `K = 24·(200/60) = 80` · raw `= 80·(1−0.15) = +68` → capped at `SWING_CAP` · `D = 0.75+0.5·0.15 ≈ 0.83` → **ΔMMR ≈ +48 (cap)**. Big, correct, but bounded — and `RD` collapses toward the active band.

**C — RP chases MMR.** You're **Gold IV** (anchor `1350`) but your real `MMR` is `1500`, so `gap = +150`.
`rpGain = clamp(20 + 0.05·150, 10, 35) = clamp(27.5) = 27` · `rpLoss = clamp(20 − 7.5) = 13`. You promote in a few wins and barely dip on losses — the ladder catches up to your skill.

---

## 12. Implementation plan / integration points

Proposed; nothing here exists yet. Pure math in **common** (shared, client‑previewable), commits and persistence on the **server**.

| Piece | Where (proposed) |
| --- | --- |
| Pure MMR/RD/σ update, `E`, `D`, RP math (unit‑tested, no I/O) | **`common/src/ranked/mmr.ts`** (+ `common/src/ranked/ladder.ts`) |
| Constants (§13) | `common/src/ranked/ranked_constants.ts` (mirrors `src/constants.ts` style) |
| Player schema: `mmr, rd, volatility, rankPoints, tier, division, placementGamesPlayed, reliability, peakTier, seasonId, lastRankedAt` | server Player model / ArangoDB `Players*` collection |
| Commit result → rating update | server `api/db/arango_hoc.ts` `reflectGameResult` (extend the existing win/loss txn) |
| Decisiveness inputs (`armyFrac`, `laps`) | captured at fight end in the play session, on `GameStatus.PAID` transition |
| Real rating / league (remove stubs) | server `api/mm/v1/lobby.ts` (`setRating` / `setLeague` placeholders) |
| MMR‑aware pairing + side assignment | server `api/mm/v1/match.ts` (pairing loop), `matchmaking_queue.ts` (carry MMR/RD in queue entries) |
| Side‑bias `p_side` aggregation | periodic job over ranked results; cached for `E`/pairing |
| Season rollover + reward grant | scheduled job (soft reset §6) |
| Client `±MMR` preview + tier/RP UI | client reads `common/src/ranked/` directly (matchmaking + post‑game screens) |

**Tests** (to mirror `test/units/…` rigor): symmetry (`Δwinner = −Δloser` before `D`), `E` monotonic in rating gap, `RD` shrinks on play / grows on idle, `D` bounded to `[0.75,1.25]`, `SWING_CAP` respected, RP elastic band, promotion/demotion + shield, placement streak, side‑bias disabled under threshold, soft‑reset compression.

---

## 13. Tunables summary

| Constant | Proposed | Purpose |
| --- | --- | --- |
| `MMR_SEED` | 1500 | new‑account rating (population mean) |
| `RD_START` / `RD_FLOOR` | 350 / 45 | uncertainty window (new‑idle → most‑certain) |
| `RD_REF` | 60 | `K` reference — the "settled" RD |
| `VOL_START` | 0.06 | seed volatility `σ` |
| `SCALE` | 400 | logistic rating scale (Elo‑like) |
| `K_BASE` | 24 | base step at `RD = RD_REF` |
| `SWING_CAP` | 48 | max |ΔMMR| per game |
| `PLACEMENT_GAMES` | 10 | provisional window |
| `STREAK_BONUS` | 16↘ (decaying) | placement win‑streak accelerator |
| `D_MIN` / `D_MAX` | 0.75 / 1.25 | Decisiveness band (±25%) |
| `LAP_SOFT_CAP` | 12 | speed reference for `speedFrac` |
| `SIDE_BETA` / threshold | 0.10 / 0.02 | side‑bias strength / dead‑zone |
| `RP_PER_DIVISION` | 100 | RP width of a division |
| `RP_BASE` / `GAP_K` | 20 / 0.05 | RP per game + elastic‑band strength |
| `SHIELD_GAMES` | 3 | demotion‑shield grace games |
| `SEASON_DAYS` / `PULL` | 70 / 0.35 | season length / soft‑reset compression |
| `DECAY_GRACE` / `DECAY_RATE` | 10 days / tuned | apex leaderboard decay |

**Initial MMR → tier mapping** (percentile‑recalibrated each season):

| Tier | MMR (initial) | | Tier | MMR (initial) |
| --- | --- | --- | --- | --- |
| Wood | < 900 | | Diamond | 1700 – 1899 |
| Bronze | 900 – 1099 | | Master | 1900 – 2099 |
| Silver | 1100 – 1299 | | Grandmaster | 2100 – 2299 (capped) |
| Gold | 1300 – 1499 | | Mythic | ≥ 2300 (top 0.1%) |
| Platinum | 1500 – 1699 | | | |
