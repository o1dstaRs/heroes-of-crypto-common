# Blacksmith Craft role release — primary result (seed 98200001)

Preregistration: `PREREGISTRATION_ROLES.md`, run 1. Frozen common 94978dc, worktree `hoc-common-role-eval`.
450 boards (first 450 of seed 98200001 where exactly one army fields a Blacksmith), both battle mirrors, each game
played baseline and treatment (`V08_ROLE_RELEASE_<seat>=blacksmith_craft` for the treated army: no Craft turn
router, no Craft opening cluster): 1800 games, 900 pairs.

| Slice  | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| ------ | ----- | -------- | --------- | --------------------------- | ---------------- |
| All    | 900   | 37.51%   | 33.22%    | -4.29pp [-7.86, -0.72]      | 266              |
| NORMAL | 274   | 34.94%   | 32.97%    | -1.98pp [-7.95, +4.41]      | 78               |
| LAVA   | 336   | 39.94%   | 37.20%    | -2.74pp [-8.32, +3.02]      | 101              |
| BLOCK  | 290   | 37.15%   | 28.87%    | -8.28pp [-14.51, -2.21]     | 87               |

Metric: treated army decisive win rate. Engine rejections for the treated army: baseline 0, treatment 0.

**Gate 1: FAIL** (lower bound -7.86pp is not > 0). No re-roll and no confirmation run, as preregistered.

Reading (exploratory): the release is harmful, and its whole interval is below zero. v0.8's Craft rule is worth
about +4pp to the Blacksmith's army, most on BLOCK. The test-server gap (AI casts Craft, humans cast runes) is not
evidence that the AI should play like the humans. Blacksmith's weak fitted rating needs another explanation.
