# Unit-strength draft, on-policy refit (v3) — preregistration

Written 2026-09-14 ~07:10 UTC, before any game of this round was played. Owner goal: "Continue driving it into
80%+ area overnight". Round 1 (`PREREGISTRATION_V1_WEIGHTS.md`) tries higher weights of the same v1 prior; this
round refits the prior itself.

## Motivation

The v1 prior was fitted on armies drafted by the previous live draft `ranked-versatile-a19-v3` with 50% uniform
exploration (seed 97100001). The shipped bot now drafts with `ranked-unit-strength-a19-side-v1-w4`, whose armies
differ (e.g. Battle Mage over Satyr), so a unit's marginal value inside them may differ too. One policy-iteration
step: fit the same model on data drafted by the shipped policy.

## Stage 1 — data

`collect_ranked_draft_strength_data.ts --policy ranked-unit-strength-a19-side-v1-w4 --boards 4000 --seed 98800001
--exploration 0.5 --chunk 250`, common e83c8a6 or later with identical harness code: both seats draft with v1-w4 plus
50% uniform legal exploration, live draft rules, live setup, side board, deterministic a19, live map rotation; two
games per board (8000 games).

## Stage 2 — fit

`fit_ranked_draft_unit_strength.ts --id ranked-unit-strength-a19-side-v3 --lambda 4 --bootstrap 200`, the v1 model
unchanged (ridge logistic presence difference with side and drafting-seat intercepts, board bootstrap,
conservative lift = point shrunk by one standard error). The prior is committed with provenance before any
selection game, and policies `ranked-unit-strength-a19-side-v3-w2`, `-w4`, `-w8` are registered with the same
overlay as v1.

## Stage 3 — selection (seed 98810001)

v3-w2, v3-w4, v3-w8 and the control v1-w4 each vs the previous live draft (`--pool live`), 500 boards (2000 games)
each. Rule: highest draw-aware score among the v3 policies; a tie within 0.5pp goes to the smaller weight. If the
chosen v3 policy does not beat v1-w4's score on this seed by at least 0.5pp, the round ends with no confirmation.

## Stage 4 — confirmation of the chosen v3 policy P

Incumbent I = the round-1 winner if round 1 passed all its gates, else `ranked-unit-strength-a19-side-v1-w4`.

1. P vs `policy:I`, seed 98820001, 2000 boards (8000 games) — gates 1-4 and 6.
2. P vs `--pool live`, seed 98830001, 2000 boards (8000 games) — reported headline (the 80% question).
3. P and I each vs `--pool reference`, seed 98840001, 500 boards per reference — gate 5.

## Gates (vs I)

Identical to `PREREGISTRATION_V1_WEIGHTS.md` gates 1-6 with I as incumbent. PASS makes P the proposed next default;
the owner decides the ship. FAIL is reported as a fail, no re-roll of any seed above.

## Amendments before any v3 game was recorded

- 2026-09-14 01:43: the first launch of the data script stopped on a shell error before playing a game (an empty
  argument array under `set -u` in macOS bash 3.2); fixed.
- 2026-09-14 01:46: the relaunched collector crashed inside Bun 1.4.2 (`panic: Bus error`, exit 138) after 89 s at 12
  workers, with system swap at 39.5 of 39.9 GB; no chunk had finished, so no record exists. The data stage now runs 8
  workers and 100-board chunks, and resumes after the last complete chunk for up to 30 attempts. Every game is seeded
  by its index, so chunk size, concurrency and restarts do not change any record. Seeds, boards, exploration, policy,
  fit, selection, confirmation and gates are unchanged.
