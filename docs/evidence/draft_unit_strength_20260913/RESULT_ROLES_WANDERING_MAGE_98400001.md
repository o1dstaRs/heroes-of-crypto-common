# Wandering Mage Smoke role release — primary result (seed 98400001)

Preregistration: `PREREGISTRATION_ROLES.md`, run 3. Frozen common 94978dc, worktree `hoc-common-role-eval`.
450 boards (first 450 of seed 98400001 where exactly one army fields a Wandering Mage), both battle mirrors, each
game played baseline and treatment (`V08_ROLE_RELEASE_<seat>=wandering_mage_smoke` for the treated army): 1800
games, 900 pairs.

| Slice  | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| ------ | ----- | -------- | --------- | --------------------------- | ---------------- |
| All    | 900   | 31.40%   | 31.92%    | +0.52pp [-0.71, +1.79]      | 27               |
| NORMAL | 302   | 29.43%   | 31.00%    | +1.57pp [-0.42, +3.91]      | 9                |
| LAVA   | 312   | 34.19%   | 35.48%    | +1.29pp [-0.97, +3.86]      | 12               |
| BLOCK  | 286   | 30.42%   | 29.02%    | -1.40pp [-3.50, +0.00]      | 6                |

Metric: treated army decisive win rate. Engine rejections for the treated army: baseline 0, treatment 0.

**Gate 1: FAIL** (lower bound -0.71pp is not > 0). No re-roll and no confirmation run, as preregistered.

Reading (exploratory): the Smoke rule rarely decides a game (27 of 900 pairs changed). Wandering Mage's weak
fitted rating (-12.8pp) is not explained by it.

## Program summary (all preregistered release A/Bs of 2026-09-13)

| Release                           | Seed                | Delta [95% CI]                              | Verdict        |
| --------------------------------- | ------------------- | ------------------------------------------- | -------------- |
| Abomination protector             | 97900001 / 97910001 | +4.20 [+0.97, +7.31] / +5.35 [+2.15, +8.46] | PASS twice     |
| Melee flyer backline target       | 98000001            | -3.44 [-5.92, -1.07]                        | FAIL (harmful) |
| Arachna Queen + Angel protector   | 98100001            | -0.02 [-1.78, +1.83]                        | FAIL           |
| Blacksmith Craft router + cluster | 98200001            | -4.29 [-7.86, -0.72]                        | FAIL (harmful) |
| Healer Sustain router             | 98300001            | -1.05 [-4.54, +2.12]                        | FAIL           |
| Wandering Mage Smoke router       | 98400001            | +0.52 [-0.71, +1.79]                        | FAIL           |
