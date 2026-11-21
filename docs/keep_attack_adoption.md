# Keep-attack fix — adopted as A19 profile v21

Adopted on November 21, 2026 at the owner's request. Policy id `a19-keep-attack-v1`. Nothing was deployed
by the adoption.

The owner reported on November 21: “units dont attack from time to time, just move close”. In test game
`8e073b88` the search replaced the Hydra's move and attack with a plain move. After confirmation J of the
first rule alone failed its strength gate, the owner said: “i need fix on that”. This is a behaviour fix the
owner asked for, so its registered gate was non-inferiority. Its strength is reported, not required.

## The rule

The rule applies to every non-ranged unit's searched decision, before selection. The search driver applies it right
after the primary candidate means (`applyA19KeepAttack` in `src/ai/keep_attack.ts`):

1. `SEARCH_A19_KEEP_MELEE_ATTACK`: when the native choice is a melee attack, every challenger that does not
   attack is lowered by one full unit. A melee, ranged, area-throw or obstacle attack counts as an attack, and
   so does a cast.
2. `SEARCH_A19_KEEP_CONTACT_ATTACK`: when any scored candidate attacks, every challenger that moves the unit
   next to (or diagonal to) an enemy without attacking is lowered by one full unit.

Only an attack or a cast can then beat such a challenger. The native choice itself is never lowered, illegal
candidates stay illegal, and ranged units are left alone. Both switches are sealed on in
`V08_A19_SEARCH_RULES`. The draft, setup, other search settings, models and budgets are unchanged.

## Why

A melee unit's search takes the best of a few two-playout means. A plain move next to the enemy wins that
noisy maximum about as often as an attack does, so players see a unit walk up and not attack. The diagnosis
covered three runs of 48 games and found 121 contact moves chosen by the search. An attack was available in
118 of them, and only 61 replaced a native attack. Rule 1 alone covers only those 61.

Confirmation J (`keep-melee-attack-20261121-v1`, registration sha256
`a2a225a8fcd1764c90ddd4efe0a75e4036aff9cb9fa5cc0e6ccd39e500e3eb68`) tested rule 1 alone for strength. It
measured +0.33 points (95% −1.19 to +1.94) in the mirror and **failed** its strength gate. It stays recorded
as failed.

Development ran 144 v20 mirror tasks. Plain moves into contact without an attack, out of about 3,850 entrant
melee decisions:

| Arm         | Plain moves into contact |
| ----------- | -----------------------: |
| Off         |                      149 |
| Rule 1 only |                       36 |
| Rules 1 + 2 |                        2 |

Scores: rule 1 +5.21, rules 1 + 2 +5.56. Both intervals crossed zero on 144 tasks.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/keep_attack_registration_20261121.json` (sha256
`01cec0b5e01e328838864415a1884e7ddf35abbe879ff74ed42c3ffca15e0999`). Results:
`docs/evidence/keep_attack_confirmation_20261121.json`.

The bank is a fresh pool allocated for this study: namespace `keep-attack-20261121-v1`, 1,674 tasks per
population, families 0000–0185 of a 208-family pool. It was audited against 850 ledgers before any bank file
was written, with 0 intersections. Both arms played the same tasks. The candidate rule ran on the entrant seat
of the production tree: server `700527a`, common `fa886ab5`, plus the rule.

| Primary: mirror (both seats the v20 default) | Games | Difference | 95% interval   |
| -------------------------------------------- | ----: | ---------: | -------------- |
| **All**                                      | 1,674 |  **+1.34** | −0.39 to +3.05 |
| Normal                                       |   558 |      +1.70 | −1.43 to +4.75 |
| Lava centre                                  |   558 |      +3.58 | +0.18 to +6.90 |
| Block centre                                 |   558 |      −1.25 | −4.48 to +2.06 |
| Owner-shaped opponent (guard), all tasks     | 1,674 |      +2.15 | +0.69 to +3.58 |

| Behaviour                                        | Control | Keep-attack |
| ------------------------------------------------ | ------: | ----------: |
| Plain moves into contact without attack (mirror) |   1,831 |          35 |
| Plain moves into contact without attack (owner)  |   1,668 |          49 |
| Games with a quality error (both populations)    |       5 |           5 |

| Gate                                                                      | Result |
| ------------------------------------------------------------------------- | ------ |
| N1 non-inferiority: primary 95% lower bound at least −2                   | passed |
| N2 no map of the mirror below −2                                          | passed |
| N3 owner guard: difference over all owner tasks at least −2               | passed |
| N4 candidate games with a quality error not above the control arm         | passed |
| N5 candidate plain moves into contact at most 10% of the control arm      | passed |
| N6 thirty candidate mirror tasks reproduce their digests on a second host | passed |

The registered analysis ran unamended. CPU per game was 8.2 s in both arms.

## What the estimate is and is not

- The fix removes 98% of the plain moves into contact. Strength is not worse: the primary lower bound is
  above −2. A gain in the mirror is **not established**, because the interval crosses zero. The owner-shaped
  population is a guard, so its positive interval is reported, not claimed.
- It is not a win rate against people.
- All ten quality-error games, five in each arm, are one known problem: a declined scripted melee proposal
  (`proposal declined: type=melee_attack reason=attack_not_available`). The native decision moves the unit,
  then strikes along a path that starts at the old cell, and the engine refuses that strike. The fix only
  changes which candidate the search picks, so a declined native strike can still leave a unit standing next
  to the enemy. That cause is fixed separately.

## Switches

The rules are search settings sealed in the profile. A research run can override them per seat with the
`SEARCH_A19_KEEP_MELEE_ATTACK` / `SEARCH_A19_KEEP_CONTACT_ATTACK` search overrides (`"0"` or `"1"`).
