# Striker rush against mixed armies — adopted as A19 profile v18

Adopted on November 20, 2026 under the user's standing instruction of November 19, “always lock in wins
and continue”. Policy id `a19-striker-rush-mixed-v1`. Nothing was deployed by the adoption.

## The rule

The striker rush (Placement 2, Movement 2, strikers on the edge of the zone) is used by a seat with at
least four strikers when the enemy has

- at most three strikers, as since profile v15, **or**
- exactly four strikers and at least two creatures with a ranged attack.

Nothing else changes: the plan, the formation, the draft. `isA19StrikerRushSetup` in
`src/ai/setup/a19_striker_rush.ts` holds the condition.

## Why

The threshold of three was set from games in which the opposing army had at most three strikers (the
shooter-fielding default) or five to six (striker mirrors). Armies in between were never sampled, and
they are what people bring: of 64 recorded armies played by people against the AI, 20 have exactly
four strikers, 8 of them with two shooters.

Against such an army the profile v17 seat sees strikers early, drafts for a melee fight, and then
keeps its stock setup while two shooters fire at it. On development tasks it scored 53.0% and 63.4%
against two kinds of mixed army, where it scores about 80% against either pure kind.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/striker_rush_mixed_registration_20261120.json`
(sha256 `ad387b7c4c3e815a1432b3f853b0895dfcd2b0a567e3a9a9c1ad9d9e579d715a`). Results, with the failed
predecessor: `docs/evidence/striker_rush_mixed_confirmation_20261120.json`.

The bank is the last sealed reserve of namespace `matchup-draft-20261120-v1` (576 tasks, families
120–183). The candidate seat is profile v17 with the new condition; the control is profile v17. Two
mixed opponents: one drafts strikers in the bundle and at levels 1–2 and the shipped pick at levels
3–4 (`mixB12`), the other the reverse (`mixB34`), both on the shipped setup. Only the tasks where the
rule changes the setup are played; on every other task the two arms are the same game and count as a
zero difference.

|                                         | Tasks | Difference | 95% interval     |
| --------------------------------------- | ----: | ---------: | ---------------- |
| **Primary, both mixed opponents**       |   576 |  **+9.20** | +6.81 to +11.68  |
| Normal                                  |   192 |     +11.20 | +7.29 to +15.36  |
| Lava centre                             |   192 |      +7.29 | +3.12 to +11.59  |
| Block centre                            |   192 |      +9.11 | +4.82 to +13.54  |
| `mixB12`, tasks where the setup changes |   293 |     +23.21 | +16.55 to +30.03 |
| `mixB34`, tasks where the setup changes |   288 |     +13.19 | +6.77 to +19.79  |

On the changed tasks the seat goes from 38.6% to 61.8% against `mixB12` and from 62.2% to 75.3%
against `mixB34`.

| Gate                                                                | Result                                             |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| G1 lower bound against mixed armies above zero                      | passed, +6.81                                      |
| G2 neither mixed opponent and no map with a negative point estimate | passed, lowest is Lava at +7.29                    |
| G3 mirror guard: difference over all mirror tasks at least −1       | passed, −0.17 (6 changed tasks: better 1, worse 2) |
| G4 candidate games with a quality error not above the control arm   | **failed**, 4 against 1                            |
| G5 thirty changed tasks reproduce on a second host                  | passed, 30 of 30 digests                           |
| G6 candidate CPU per changed game at most 1.25 times the control    | passed, 1.07                                       |

**G4 failed and stays recorded as failed.** All five games carry the same message, a declined scripted
melee proposal (`attack_not_available`): the incoherent move-then-strike proposal described in
`docs/coherent_melee_approach_research.md`, whose repair is inactive. The candidate seat won all four
of its games. In the predecessor confirmation the same two arms had no candidate game and one control
game with it, in 676 changed games each.

The registered analysis ran unamended. The production implementation, with the rule on both seats and
no research seam, reproduced the research runner on 60 of 60 replayed tasks.

## The wider rule that failed

The first registered candidate was simpler: rush any army with at most four strikers
(`docs/evidence/striker_rush_threshold4_registration_20261120.json`, 540 tasks, families 60–119). It
passed on strength, +13.24 points (95% +10.56 to +15.97), and **failed its mirror guard**: against
the default's own armies with exactly four strikers it changed 12 tasks and lost on them, 66.7% to
16.7%. It was not adopted.

Its changed tasks split cleanly by the enemy's shooters:

| Enemy has exactly four strikers and           |     Tasks |       Difference | 95% interval   |
| --------------------------------------------- | --------: | ---------------: | -------------- |
| two or more shooters, mixed opponents         |       567 |            +24.5 | +19.7 to +29.4 |
| one shooter, mixed opponents                  |       108 |             +3.7 | −6.5 to +14.4  |
| no / one / two shooters, default's own armies | 3 / 5 / 4 | −100 / −20 / −50 |                |

A decision rule written before any result of that bank said to adopt only the measured part: four
strikers and at least k shooters, with k = 1 if the one-shooter tasks had at least 40 games and a
non-negative estimate. They had, so the rule pointed at one shooter. Two were registered instead, the
narrower scope: the one-shooter estimate is not distinguishable from zero and went the other way on
the five mirror tasks. Because that choice was made after seeing the first bank, the narrower rule
was given a bank of its own, above.

## What the estimate is and is not

- It is the gain **against mixed armies drafted by the AI** on its shipped setup. It is not a win
  rate against people, though the army shape is the one people bring most.
- Against the default's own armies that happen to have four strikers and two shooters the rule lost
  more than it won: 10 changed mirror tasks over both banks, better 1, worse 4. Such armies are about
  1% of default-against-default games, which is why the guard passes. It is a known cost.
- Armies with four strikers and fewer than two shooters keep the previous behavior. Four strikers and
  two casters, which is the army the rush was learned from, is not rushed.
- Against the shooter-fielding profile v14 nothing changes: its armies never have four strikers.
- The draft's matchup probability keeps its four-striker boundary. Moving it to five together with
  the wider rule was tried on development tasks and was not better.

## Switches

`HOC_A19_STRIKER_RUSH_MIXED=off` on the server restores the three-striker rule;
`HOC_A19_STRIKER_RUSH=off` and `HOC_A19_CONTEXT_POLICY=off` switch it off with the striker rush.
