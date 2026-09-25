# Preregistration — a v6 prior fitted under the live synergy variants and split pass, variant-aware (P17)

Written 2026-09-24 ~17:36Z, before any P17 data game (P15's stage-1 arms are running; none has finished).
Base: common fb1d99d (the P15 harness options) — the data and every P17 game use `--live-synergy-variants
--tactical-splits`.

## Why
The v4 prior (P7, and the shipped v4-w16-r4) was fitted in a harness that always fielded the DEFAULT synergy
variants, added setup-v0's picks on top (so Might armies played BOTH Might synergies: aura range by default and
stack-abilities power by the policy's pick), never split into Placement/Nature board-unit slots, and deployed
Placement in the fixed 3-deep zone. Live, each faction fields one variant drawn per game and the bot splits into
open slots. Creature lifts that include synergy value (every Might, Nature, Life and Chaos creature) are therefore
measured in a world the live bot never plays. The v4 re-fit on current armies was worth +13pp at weight 8 (P7);
a re-fit under the live mechanics is the same lever pointed at the remaining mismatch. The draft can also READ the
drawn variants (public from the first draft screen), which no policy does today.

## Data (fixed now)
`ranked_draft_eval` with both seats v4-w16-r4 + `conditional-v1:sniper+t2a19` + SEE_NONE, live draft rules, side
board, deterministic a19, live synergy variants and the split pass, exploration 0.5 (every bundle/creature decision
uniform at random with probability 0.5, both seats — the v4 data's design), armies recorded, 8000 games, seed
99450001, 16 shards of 500.

## Fit (fixed now; `fit_v6.py`, mirrors fit_ranked_draft_unit_strength.ts)
Ridge logistic regression by Newton steps on every decisive game: unpenalized battle-side and drafting-seat terms,
creature presence differences (lambda 4), plus per faction x variant x synergy level (1 and 2; level 3 pooled with
2) the difference of indicators "the army reaches this level and the board fields this variant" (lambda 4). Lift
= beta/4 in pp; board bootstrap (200) for standard errors; conservative = point shrunk toward 0 by one SE — the v4
method exactly, with the synergy columns added. Output: prior `ranked-unit-strength-a19-side-v6` (same schema as v4)
plus its conservative synergy-variant table.

## Policies (registered after the fit, before any selection game)
- `…-v6-w16-r4`: the v6 creature lifts at the shipped weight and floor, no variant term.
- `…-v6-w16-r4-sv`: the same plus the v6 synergy-variant table read at draft time (option-value rule of
  draft_synergy_variants.ts).

## Selection (seed 99460001, 2000 games each vs policy:v4-w16-r4, same setup/doctrine/fidelity, both arms on it)
Continue with the better draw-aware arm only if it reaches 52.0%.

## Confirmation and robustness (the eight gates of verdict.py, unchanged)
Chosen policy vs v4-w16-r4, 8000 games, seed 99470001. Robustness vs pool `reference`, 2000 games per opponent,
seed 99480001, candidate and v4-w16-r4 alike, all with the fidelity options. PASS -> the id is registered on main
and becomes the ranked default; a `-sv` winner also needs the server's draft policy to pass the game's variants
(`synergyVariantsForSeed(gameId)`), shipped in the same change. Rollback `HOC_DRAFT_WEIGHTS=…-v4-w16-r4`.

Seeds are never re-rolled; every result is reported.

Prediction, written down so it can be wrong: v6-w16-r4 lands within ±2pp of v4-w16-r4 (lifts correlate > 0.9);
the variant-aware arm adds 1-3pp more; the better arm lands at 52-55% and passes.

## Amendment 2026-09-24 ~17:42Z, before any data game
Both seats run one policy off one exploration stream, so a board's games 4b+2 and 4b+3 would replay 4b and 4b+1
exactly (the reason collect_ranked_draft_strength_data plays only 4b and 4b+1). The data is therefore drawn from the
16000-game index space of seed 99450001 (4000 boards) and only games 4b and 4b+1 are played — 32 shards, of which the
16 with shard % 4 in {0, 1} run: 8000 unique fights, the size of the v4 data.

## Amendment 2026-09-24 17:49Z, as the data started
The data games also record every real turn's V2 leaf features (`--value-data`, a never-deciding capture) so the same
8000 fights can later train a leaf refit (preregistered separately before any use). Tree: common f86e236 (fb1d99d plus
the -sv plumbing and the capture; the v4-w16-r4 policy it plays is byte-identical). First shards started 17:49:04Z.
Timestamp note: the times above were first written as estimates ahead of the clock and are corrected to the host
clock here.

## Amendment 2026-09-24 ~18:05Z, before any P17 data game finished or was read
Why: in P15's BASE (current stack vs itself under the live mechanics, first 1000 games) only 20% of armies reach the
four natively ranged creatures the r4 floor targets (2 ranged: 33% of armies, 3: 46%, 4: 18%) — the floor binds
only as a last resort, when level 3/4 offers often hold no ranged creature — and on the old explored data
(v4+v5, 16,000 games) a four-ranged army beats a three-ranged one by ~+0.27 logit BEYOND the creatures' own lifts
(count dummies next to presence terms, grouped CV). The draft never sees that composition value.
Change to the fit: ranged-count columns are added — for k in {0,1,2,3,5,6} the difference of indicators "this army
holds exactly k natively ranged creatures" (4 is the reference; lambda 4); their conservative values (pp, relative
to 4) are stored with the prior as `rangedCountPp`.
Third selection arm: `…-v6-w16-r4-sv-rc` = the `-sv` arm plus, for a ranged creature, the step in `rangedCountPp`
from the army's current ranged count to one more. The three arms (v6, v6-sv, v6-sv-rc) all play 2000 games on seed
99460001; the rule is unchanged (best draw-aware arm, only if >= 52.0%).

## Amendment 2026-09-24 ~18:02Z, before any data game finished or was read — selection seed moved
A run of N games draws its boards from the 3·N/4 seed preimages after its base seed, so the data (16000-game index
space) occupies 99450001-99462000 and the selection seed 99460001 would have shared preimages with it (no whole
board repeats, but seeds should be disjoint). Selection moves to seed 99465001; confirmation 99470001 and robustness
99480001 are unaffected.

## Correction 2026-09-24 18:31Z (factual, before any P17 data was read)
The ranged-count figures in the 18:05Z amendment were the LEFT drafter's armies only (BASE's first 1000 games).
Over both drafters, all 2000 BASE armies: 1 ranged 0.7%, 2 ranged 19.6%, 3 ranged 39.6%, 4 ranged 36.2%, 5+ 4.1% —
64% of armies still end below the floor's target of four. The design is unchanged.

## Amendment 2026-09-24 ~19:08Z, before any robustness game of P15, P17 or P18 — one shared robustness seed
All three proposals' robustness cells use seed 99480001 (2000 games per `reference` opponent, fidelity options on), so
the incumbent's cell (the live stack vs pool `reference`) is played once and read by every verdict; each candidate
still plays its own cell on that seed. The seeds 99580001 (P15) and 99590001 (P18) are released unused.

## RESULT — fit (2026-09-24 20:18Z, all 16 data shards: 8000 fights, 7907 decisive, 3997 boards; before any selection game)
v6 conservative creature lifts correlate 0.943 with v4; the largest moves are down for the two L4 shooters
(Gargantuan 27.6 -> 19.0, Tsar Cannon 16.8 -> 8.8 — part of their value now sits in the ranged-count terms) and up for
Arachna Queen (-16.1 -> -8.4), Trent (+2.1 -> +6.8). Ranged count vs four (conservative pp): 0: -11.9, 1: -12.5,
2: -0.7, 3: +0.1, 5 and 6: 0. Synergy residuals (conservative, levels 1 / 2+): Life supply 1.95 / 10.92; Life morale
1.08 / 4.36; Nature board units -2.24 / -2.71 (the split slots cost, consistent with P15's NOSPLIT +1.1pp); Nature fly
armor 0 / 0; Chaos movement **6.45 / 25.93**; Chaos break 0.64 / 0; Might aura range 0 / 0; Might abilities 1.11 /
4.88. Registered as common 5722eb5 (research ids v6-w16-r4, -sv, -sv-rc); selection started 20:19Z on seed 99465001.

## RESULT — selection (2026-09-24 21:40Z; seed 99465001, 2000 games per arm vs policy:v4-w16-r4, fidelity on) → STOP
- `v6-w16-r4`: 959W 1013L 28D, draw-aware **48.65%** [47.01, 50.29] (board-clustered), 0 rejections; maps 48.9 / 48.4 / 48.7.
- `v6-w16-r4-sv`: 983W 977L 40D, draw-aware **50.15%** [48.25, 52.05], 0 rejections; maps 50.1 / 51.3 / 48.9.
- `v6-w16-r4-sv-rc`: 993W 972L 35D, draw-aware **50.52%** [48.64, 52.41], 0 rejections; maps 50.1 / 51.1 / 50.4.
Paired on the same games: -sv over plain v6 +1.50pp [-0.26, +3.26]; -sv-rc over plain v6 +1.88pp [-0.06, +3.81];
-sv-rc over -sv +0.38pp [-0.86, +1.61]. Best arm 50.52% < the 52.0% bar → no confirmation; P17 stops.
Reading: the re-fit alone is worse than v4 (the lifts correlate 0.94 and the fit moved ranged value into count terms
that the plain arm does not read), and the variant-aware synergy term plus the ranged-count step recover about two
points on top of it — roughly back to v4, not past it. Drafting for the drawn synergy variant is real but small at
this weight; the large Chaos-movement level-2 residual rarely becomes reachable through the offers. The prediction
(v6 within ±2pp, the variant arm +1-3pp more, 52-55%) was right about the pieces and wrong about the total.
