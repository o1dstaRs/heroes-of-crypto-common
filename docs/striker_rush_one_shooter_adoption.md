# Striker rush from one shooter — adopted as A19 profile v19

Adopted on November 20, 2026 under the user's standing instruction of November 19, “always lock in wins
and continue”. Policy id `a19-striker-rush-one-shooter-v1`. Nothing was deployed by the adoption.

## The rule

Profile v18 rushes an army with exactly four strikers only when it has at least two creatures with a
ranged attack. Profile v19 rushes it from **one** shooter. Casters without a ranged attack still do not
count, so four strikers with casters only, the shape of the army the rush was learned from, keeps the
native setup against it. `isA19StrikerRushSetup` in `src/ai/setup/a19_striker_rush.ts` takes the
threshold; `A19_STRIKER_RUSH_MIXED_V18_MIN_SHOOTERS` keeps the v18 value for the rollback.

## Why

On development tasks, against an army with exactly four strikers, rushing measured −12.8 with no
shooter (98 games), +16.4 with one (61 games) and +18.4 with two (223 games). The one-shooter result
was post hoc, and on the consumed bank of the profile v18 confirmation it measured only +3.7 (108
games), so it was given a fresh sealed bank of its own.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/striker_rush_one_shooter_registration_20261120.json` (sha256 `8654e5a54721df0c4ccd74ecc6bbfd31c404203b36bd295c82669febaa241b62`).
Results: `docs/evidence/striker_rush_one_shooter_confirmation_20261120.json`.

The bank is a pool allocated for this study (namespace `rush-shooter-20261120-v1`, 2,691 tasks,
audited against every earlier ledger and both earlier pools). Four opponent populations draft on the
same seeds; only the tasks where the rule changes the setup are played, both arms on identical armies.

| Primary: tasks where the setup changes, three opponents | Games | Difference | 95% interval    |
| ------------------------------------------------------- | ----: | ---------: | --------------- |
| **All**                                                 |   927 |  **+4.64** | +0.91 to +8.40  |
| Normal                                                  |   299 |      +6.69 | +0.50 to +13.04 |
| Lava centre                                             |   293 |      +6.83 | +0.17 to +13.53 |
| Block centre                                            |   335 |      +0.90 | -5.57 to +7.29  |

| Opponent                          | Changed tasks |   v18 | One-shooter rush | Difference | 95% interval     |
| --------------------------------- | ------------: | ----: | ---------------: | ---------: | ---------------- |
| Owner-shaped (strikers + casters) |           453 | 71.5% |            74.7% |      +3.20 | -1.99 to +8.28   |
| Strikers early, natives late      |           199 | 48.7% |            64.1% |     +15.33 | +6.78 to +23.87  |
| Natives early, strikers late      |           275 | 60.4% |            59.6% |      -0.73 | -7.82 to +6.36   |
| Profile v18 (guard)               |            21 | 42.9% |            42.9% |      +0.00 | -23.81 to +23.81 |

| Gate                                                              | Result     |
| ----------------------------------------------------------------- | ---------- |
| G1 strength on the changed tasks: lower bound above zero          | passed     |
| G2 no map with a negative estimate, no population below -5        | passed     |
| G3 mirror guard: difference over all mirror tasks at least -1     | passed     |
| G4 candidate games with a quality error not above the control arm | **failed** |
| G6 candidate CPU per changed game at most 1.25x control           | passed     |
| G5 thirty changed owner tasks reproduce on a second host          | passed     |

**G4 failed and stays recorded as failed.** Do not waive, re-run or relabel it. The candidate arm had two
games with a declined scripted melee proposal (`attack_not_available`) against one in the control arm:
the known incoherent approach of `docs/coherent_melee_approach_research.md`, the same message behind the
failed quality gates of profiles v15 and v18.

The registered analysis ran unamended. The production implementation reproduced the research runner on
108 of 108 replayed tasks.

## What the estimate is and is not

- It is the gain on the games the rule changes: armies with exactly four strikers and one shooter, about
  10–17% of games against these AI-drafted opponents and about 1% of default-against-default games. It is
  not a win rate against people.
- Four strikers with no shooter keep the previous behavior.

## Switches

`HOC_A19_STRIKER_RUSH_ONE_SHOOTER=off` on the server restores the two-shooter rule of profile v18;
`HOC_A19_STRIKER_RUSH_MIXED=off`, `HOC_A19_STRIKER_RUSH=off` and `HOC_A19_CONTEXT_POLICY=off` switch it
off together with the rules it extends.
