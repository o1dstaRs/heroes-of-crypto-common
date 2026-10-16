# Preregistration — live synergy variants, the split pass, and what they make worth changing (P15)

Written 2026-09-24 ~17:25Z, before any P15 game (the first shard started 17:30:45Z). Base: common main c0157ad plus the harness options below (common
dev clone `hoc-common-p15`, not yet pushed). Goal set by the owner for tonight: at least +10pp head-to-head over the
current v0.8 a19 stack (v4-w16-r4 draft, `conditional-v1:sniper+t2a19` setup, SEE_NONE doctrine).

## Why — two live mechanics the harness never played
1. **Synergy variants.** The ranked server draws ONE variant per faction from the game id
   (`synergyVariantsForSeed`, play_session.ts) and maps every setup-policy synergy choice onto it
   (`setupSynergiesForTeam`); the level then follows the army's distinct creature count. `ranked_draft_eval` never
   sets `synergyVariants`, so every harness fight so far played DEFAULT_SYNERGY_VARIANTS (Life supply, Nature fly
   armor, Chaos movement, Might aura range) plus whatever the setup policy picked, and only when that list was
   non-empty. Half of live games field the other variant of each faction, which no measurement has seen.
2. **The split pass.** When a seat has more stack slots than stacks — the Nature board-units variant gives +2/+3/+4
   slots at levels 1/2/3, each Placement augment point +1 — the live server splits one-model stacks off with
   `planTacticalStackSplits` and lays them out with `applyTacticalSplitPlacement` (bots included, a19 included). The
   harness never split, and it deployed every army in the 3-deep zone whatever Placement bought. That is also why
   Placement 2 "cost 4.5pp" in PREREGISTRATION_SETUP_R4: in the harness it bought nothing.

## Instrument (common, research-only; all default off, so every earlier result reproduces)
- `--live-synergy-variants`: each board draws the variants from its pick seed (`ranked-draft-${pickSeed}`) and each
  army fields the drawn variant for every faction it holds two or more distinct creatures of — what the server does.
- `--tactical-splits` (needs the above): each seat's stack capacity is computed as
  FightProperties.getNumberOfUnitsAvailableForPlacement would (6 + Placement + Nature board units), the server's
  planner splits into it (`materializeTacticalSplitRoster`, the replay harness's exact split materialization), and
  Placement re-deploys in the widened zone (`placementAugmentTiming: setup-before-placement`).
- `--candidate-skips-splits`: the candidate leaves its extra slots empty; the opponent still splits.
- `--candidate-search-env <json>`: the candidate's promoted search runs with these V08_A19_SEARCH_ENV_OVERRIDES
  (the battle engine's `searchEnvOverrideTeams` seam; the stock driver never sees them).
Smoke (16 games, seed 12345): runs, 0 rejections, splits appear exactly on boards whose Nature variant is board units
and whose army holds 2+ Nature creatures. Harness tests pass (28/28).

## Stage 1 — paired arms, one seed (99560001), both seats v4-w16-r4 + `conditional-v1:sniper+t2a19` + SEE_NONE,
## live draft rules, side board, deterministic a19, live synergy variants and the split pass ON for both seats
- BASE: no override, 4000 games. By construction the two seats are identical, so it must read exactly 50.00%; it is
  the pairing reference for every arm and the data set for the variant analysis below.
- PL1: candidate plays Sniper 3 / Armor 3 / Placement 1 (the seventh point to Placement instead of Might), 4000.
- NOSPLIT: the candidate skips the split pass, 4000 — is the live bot's split behaviour worth having at all?
- PL2: Sniper 3 / Armor 2 / Placement 2, 2000.
- MS2: `{"SEARCH_MAX_MOVE_SHOTS":"2"}` on the candidate's search (move-then-shoot challengers; armies now field 4+
  shooters), 2000.
Each arm is scored game by game against BASE (the same boards, armies and seeds; only the arm's change differs).

## Stage 2 — decisions, fixed now
- An arm is promoted when its paired draw-aware score beats BASE by at least 1.5pp. The best promoted arm (at most
  one setup arm and one fight arm) is confirmed as a named change against the live stack with fidelity ON: 8000
  games, seed 99570001, plus robustness vs pool `reference` (2000 games per opponent, seed 99580001). The eight
  gates of verdict.py, unchanged.
- NOSPLIT above +1.5pp means the live split pass hurts the bot: the change to confirm is "a19 seats do not split".
  NOSPLIT below −1.5pp means splitting is real value, which makes Placement and the Nature variant worth drafting for.
- Variant analysis (BASE records, reported, not a gate): logistic model of the result on the per-creature presence
  difference plus, per faction and variant, the synergy-level difference; it parameterizes a variant-aware draft
  preregistered separately (P16) before any of its games.

Seeds are never re-rolled; every arm is reported whatever it says.

Prediction, written down so it can be wrong: BASE 50.00% exactly; PL1 within ±1.5pp of BASE; NOSPLIT −1 to −4pp
(splitting helps a little); PL2 below BASE (an Armor point is worth more than a split); MS2 within ±1pp.

## Amendment 2026-09-24 ~17:37Z, before any P15 result was read (no shard had finished)
To free compute for P17's data (PREREGISTRATION_FIDELITY_REFIT.md): MS2 is dropped entirely and PL2 is cut to the two
shards already running (games 0-999 of seed 99560001, i.e. 1000 games, still paired with BASE game by game). BASE,
PL1 and NOSPLIT are unchanged. Throughput measured at launch: hft 0.42 games/s per 7-worker shard, the shared node
0.10-0.11 games/s per 8-worker shard.
Correction recorded at the same time: NOSPLIT was launched at 2000 games (games 0-1999), not the 4000 written above —
a transcription slip in the launch queue, found while writing this amendment and before any result. It stays at 2000.

## Amendment 2026-09-24 ~17:42Z, before any P15 result was read
With the same policy on both seats, a board's games 4b+2 and 4b+3 replay games 4b and 4b+1 exactly (same drafts —
both seats run one policy off one pick seed —, same battle seed, same sides; only the candidate label moves), which
the smoke run shows record for record. BASE therefore runs only its shards 0, 1, 4 and 5 (games 4b and 4b+1); games
4b+2 and 4b+3 are reconstructed from them by relabeling (result and side flipped, armies swapped). The arms still run
all four games of a board, since the candidate's change makes the seats differ.

Timestamp note (17:50Z): the times in this file were first written as estimates that ran ahead of the clock; they are
corrected here to the host clock (queue.log start lines are authoritative).

## Amendment 2026-09-24 ~18:55Z, before any PL1/PL2/NOSPLIT result was read
Compute goes to P17 first (its data is the critical path). PL1 is cut to the three shards that ran on the shared node
(shards 5-7 of 8: 1500 games of seed 99560001, every one paired with BASE game by game); hft's PL1 shards 0-4 are
not run. NOSPLIT keeps its 2000 games and runs on hft after P17's data. The promotion rule (+1.5pp paired) and the
confirmation design are unchanged.

## RESULT — stage 1, Placement arms (2026-09-24 19:02Z; all paired game by game with BASE, seed 99560001)
- BASE: 4000 games (2000 played, 2000 by relabeling), 1966W 1966L 68D — exactly 50.00%, 0 rejections. Integrity PASS.
- PL1 (Sniper 3 / Armor 3 / Placement 1): 1500 games, paired vs BASE **−2.07pp** [−4.66, +0.53], 0 rejections;
  results changed in 529 games. Below the +1.5pp promotion bar → NOT promoted.
- PL2 (Sniper 3 / Armor 2 / Placement 2): 1000 games, paired vs BASE **−9.75pp** [−13.51, −5.99], 0 rejections.
Reading: even with the live split pass and the widened zone modelled, the seventh point is worth more as Might than as
Placement, and an Armor point is worth far more than two extra split stacks and a deeper zone. The human Placement
habit does not transfer to a19; the prediction (PL1 within ±1.5pp) was slightly optimistic, PL2's direction right.
NOSPLIT (2000 games) runs on hft after P17's data.
Operational note 19:03Z: NOSPLIT's four shards moved from hft to the shared node's idle capacity (same tree
f86e236, same flags and seed); hft goes straight from P17's data to P17's selection.

## Amendment 2026-09-24 ~19:08Z, before any robustness game of P15, P17 or P18 — one shared robustness seed
All three proposals' robustness cells use seed 99480001 (2000 games per `reference` opponent, fidelity options on), so
the incumbent's cell (the live stack vs pool `reference`) is played once and read by every verdict; each candidate
still plays its own cell on that seed. The seeds 99580001 (P15) and 99590001 (P18) are released unused.

## RESULT — NOSPLIT (2026-09-24 20:11Z; paired game by game with BASE, seed 99560001, games 0-1999)
The candidate leaves its extra slots empty while the opponent splits as live: 2000 games, 1012W 967L 21D, 0 rejections;
paired vs BASE **+1.12pp** [−0.05, +2.30]; results changed in 177 games (splits touch ~40% of games, but few
outcomes). Below the +1.5pp promotion bar → NOT promoted, so no confirmation runs. Reading: the live split pass is
at best neutral for a19 and probably costs it about a point — worth remembering if the split planner is ever
revisited, not worth a change on this evidence. The prediction (−1 to −4pp, splitting helps) had the sign wrong.

## P15 CLOSED — no stage-1 arm reached the bar (PL1 −2.07, PL2 −9.75, NOSPLIT +1.12; MS2 not run)
