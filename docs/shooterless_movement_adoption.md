# Shooterless Movement — adopted as A19 profile v16

Adopted on November 20, 2026 under the user's standing instruction of November 19, “always lock in wins
and continue”. Policy id `a19-shooterless-movement-v1`. Nothing was deployed by the adoption.

## The rule

After the shipped upgrade selection, when the striker rush did not fire: if no drafted creature of the
seat attacks at range, and the selected plan buys Sniper but neither Placement nor Movement, the Sniper
levels are spent on Movement instead (on Placement once Movement is at 2).

In practice one plan changes. The anchor upgrade spend does not look at the army, so every seven-point
seat (Battle Trance) with fewer than two shooters bought Armor 3, Might 3 and Sniper 1. For an army
without a shooter that becomes Movement 1, Armor 3, Might 3. Five- and six-point plans hold no Sniper
and are untouched, and so is every army with a shooter.

Sniper only modifies units whose attack type is ranged (`units_holder.ts`). For a melee army the point
bought nothing. Since profile v15 the default drafts melee armies, so one seat in three was playing a
point short whenever it did not rush.

The rule is `a19ShooterlessAugments` in `src/ai/setup/a19_shooterless_setup.ts`; the server applies it
in `selectSetupAugmentsForTeam` to a full, fresh plan only. A plan that already buys Placement or
Movement is left alone: a funded delivery plan and a rush plan carry their own formation, which checks
the levels that were bought.

## Evidence

Registered before any game of the bank was played:
`docs/evidence/shooterless_movement_registration_20261120.json`
(sha256 `28ca93f78b560d0a8e5217e88f28f4dd8ca2077176fabd899ce676c9ec701945`). Results:
`docs/evidence/shooterless_movement_confirmation_20261120.json`.

The bank is the 540 tasks that the striker rush confirmation kept sealed (namespace
`rush-doctrine-20261120-v1`, families 127–186). Both seats draft as profile v15. The candidate seat's
doctrine is Battle Trance on every task, because the rule only acts on seven-point plans; the opponent
keeps the task's doctrine. Both arms play the same drafted armies, one game per arm.

|                           | tasks |   v15 | with the rule | difference | 95% interval    |
| ------------------------- | ----: | ----: | ------------: | ---------: | --------------- |
| All                       |   540 | 53.4% |         61.5% |  **+8.06** | +3.89 to +12.04 |
| Rule applied (no shooter) |   399 | 50.6% |         61.5% |     +10.90 | +5.39 to +16.29 |
| Normal                    |   180 | 58.6% |         62.2% |      +3.61 | −3.89 to +10.83 |
| Lava centre               |   180 | 52.2% |         63.1% |     +10.83 | +4.17 to +17.50 |
| Block centre              |   180 | 49.4% |         59.2% |      +9.72 | +3.06 to +16.39 |

On the 141 tasks where the army had a shooter the candidate arm replayed the control game exactly
(141 identical digests).

All five registered gates passed:

| Gate                                                              | Result                            |
| ----------------------------------------------------------------- | --------------------------------- |
| G1 lower bound of the interval above zero                         | passed, +3.89                     |
| G2 no map with a negative point estimate                          | passed, lowest is Normal at +3.61 |
| G3 candidate games with a quality error not above the control arm | passed, 1 against 1               |
| G4 thirty candidate tasks reproduce on a second host              | passed, 30 of 30 digests          |
| G5 candidate CPU per game at most 1.25 times the control          | passed, 0.96                      |

One amendment to the registered analysis: the script divided by zero in a descriptive breakdown by the
candidate seat's own doctrine, which is constant in this study. Before any result was seen the
breakdown was changed to the opponent's doctrine. Endpoint, interval and gate code are unchanged; both
versions of the script are hashed in the results file.

The production implementation, with no research seam and the rule on both seats, reproduced the
research runner on 75 of 75 replayed tasks.

## What the estimate is and is not

- It is the gain for a **seven-point seat against profile v15**, a melee mirror. Under the default's
  doctrine variety one seat in three has seven points, so the gain over all default-against-default
  games is about a third of it.
- Against an army the seat rushes, nothing changes: the rush plan already holds no Sniper.
- It is not a win rate against people, and armies with exactly one shooter were not measured: they
  keep Sniper 1.
- A seat without a ranged creature and with fewer than four strikers does not rush and falls under the
  rule by its own composition. Default seats essentially never draft such an army; it was not measured.

## Why Movement, and why only the spare point

Development, 198 tasks of the same namespace (families 0–21), same mirror:

| Plan for the candidate seat                                   | difference | 95% interval   |
| ------------------------------------------------------------- | ---------: | -------------- |
| Movement 1 in place of Sniper 1 (seven-point seats)           |       +7.8 | +2.0 to +13.9  |
| Placement 1 in place of Sniper 1 (seven-point seats)          |       +4.5 | −1.8 to +10.6  |
| One Movement level before the last Might level, every budget  |       −3.8 | −11.1 to +3.3  |
| One Movement level before the last Armor level, every budget  |       −4.8 | −11.6 to +2.0  |
| One Placement level first, every budget                       |      −11.4 | −18.9 to −3.5  |
| Armor 3, Movement 2, Might with the rest                      |      −14.9 | −21.7 to −7.8  |
| Placement 2 with a forward line, Armor 3, Might with the rest |      −17.9 | −25.5 to −10.4 |

Armor 3 and Might 3 stay first. Movement is only worth the point that was buying nothing.

## Switches

`HOC_A19_SHOOTERLESS_MOVEMENT=off` on the server restores the plan before the rule;
`HOC_A19_CONTEXT_POLICY=off` disables it together with the other A19 context policies. The rule is
independent of the striker rush and has its own switch.
