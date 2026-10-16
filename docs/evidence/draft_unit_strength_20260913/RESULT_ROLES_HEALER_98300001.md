# Healer Sustain role release — primary result (seed 98300001)

Preregistration: `PREREGISTRATION_ROLES.md`, run 2. Frozen common 94978dc, worktree `hoc-common-role-eval`.
The 4000-board scan of seed 98300001 found only 359 boards where exactly one army fields a Healer (the
preregistered target was the first 450, scanning up to 4000), so all 359 were used. Both battle mirrors, each game
played baseline and treatment (`V08_ROLE_RELEASE_<seat>=healer_sustain` for the treated army): 1436 games, 718
pairs.

| Slice  | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| ------ | ----- | -------- | --------- | --------------------------- | ---------------- |
| All    | 718   | 47.39%   | 46.34%    | -1.05pp [-4.54, +2.12]      | 164              |
| NORMAL | 182   | 40.45%   | 40.33%    | -0.12pp [-6.64, +6.21]      | 41               |
| LAVA   | 266   | 47.33%   | 43.89%    | -3.44pp [-8.99, +2.13]      | 67               |
| BLOCK  | 270   | 52.04%   | 52.81%    | +0.76pp [-4.41, +5.97]      | 56               |

Metric: treated army decisive win rate. Engine rejections for the treated army: baseline 0, treatment 0.

**Gate 1: FAIL** (lower bound -4.54pp is not > 0). No re-roll and no confirmation run, as preregistered.

Reading (exploratory): releasing the rule changes many games (164 of 718 pairs) but not the win rate, with a
negative point estimate. The Healer Sustain router stays on.
