# Arachna Queen and Angel protector release — primary result (seed 98100001)

Preregistration: `PREREGISTRATION_PROTECTORS.md`. Frozen common 9967e26, worktree `hoc-common-protector-eval`.
450 boards (first 450 of seed 98100001 where exactly one army fields an Arachna Queen or an Angel), both battle
mirrors, each game played baseline and treatment (`V08_PROTECTOR_RELEASE_<seat>=angel,arachna_queen` for the
treated army): 1800 games, 900 pairs.

| Slice                | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| -------------------- | ----- | -------- | --------- | --------------------------- | ---------------- |
| All                  | 900   | 44.94%   | 44.92%    | -0.02pp [-1.78, +1.83]      | 58               |
| NORMAL               | 258   | 37.89%   | 39.92%    | +2.03pp [-2.16, +6.36]      | 24               |
| LAVA                 | 316   | 50.32%   | 48.06%    | -2.26pp [-5.66, +1.26]      | 28               |
| BLOCK                | 326   | 45.37%   | 45.82%    | +0.45pp [-1.10, +2.15]      | 6                |
| Angel armies         | 650   | 42.28%   | 42.25%    | -0.02pp [-0.86, +0.69]      | 7                |
| Arachna Queen armies | 250   | 51.81%   | 51.82%    | +0.01pp [-5.94, +6.82]      | 51               |

Metric: treated army decisive win rate. Engine rejections for the treated army: baseline 0, treatment 0.

**Gate 1: FAIL** (lower bound -1.78pp is not > 0). No re-roll and no confirmation run, as preregistered.

Reading (exploratory): releasing Angel from guard duty almost never changes a game (7 of 650 pairs), so the
protector intent is not what holds Angel back. Queen games do change (51 of 250 pairs) but in both directions
with no net effect. Unlike Abomination, the weak fitted ratings of these two units are not explained by the
backline-protector rule.
