# Tier-2 pick for a striker army — adopted as A19 profile v20

Adopted on November 21, 2026 under the user's standing instruction of November 19, “always lock in wins
and continue”. Policy id `a19-tier2-striker-v1`. Nothing was deployed by the adoption.

## The rule

For an army with **fewer than two ranged stacks** among the seat's known creatures at the Tier-2
decision (the five picks before level 4):

1. **Crown of Command** when it is offered and the opponent's melee probability is below **0.8**. The
   probability is `a19OpponentMeleeProbability`, the striker matchup head's estimate that the opponent
   ends with four or more strikers, read only from the opposing creatures this seat may legally see.
2. Otherwise an **established** artifact outranks the five that artifact-fit-v8 scores with a forecast
   (Archmage's Ring, Aegis of the Arcane, Quiver of Echoes, Gravechain, Last Fuse): when v8 picks one
   of them and an established usable artifact is on offer, the shipped policy picks among the
   established ones by its table.

Armies with two or more ranged stacks, the beneficiary rule, the draft, setup and fight are unchanged.
The rule is `a19Tier2StrikerDecision` / `a19Tier2StrikerArtifact` in `src/ai/setup/a19_tier2_striker.ts`;
the server applies it in the A19 setup policy's `pickArtifactT2`.

## Why

Since the striker draft (profile v15) the default fields armies with zero or one ranged stack. Those read
`TIER2_ARTIFACT_WINRATE_MELEE`, a v0.7-era table measured before the rush existed, in which Crown of
Command (+1 movement, +1 armor, +8 morale) is the **lowest** entry. The A19 table that puts Crown first
applies only to ranged-heavy armies. The five newer artifacts get forecast scores instead of a
measurement. The shipped choice took one of those five in about 30% of drafts and Crown in 2%.

Development played **every usable offered artifact** on each of 198 development tasks in five opponent
populations (2,650 games, same armies and seeds, only the artifact differs). Swaps into Crown measured
+16.0, +8.2, +30.0 and +16.3 points against owner-shaped, strikers-early, natives-early and native
shooter armies, and **−18.0 in the melee mirror**: Crown is a rush artifact. Swaps out of the forecast
five into established artifacts measured 0 to +18.6 in every population. The melee probability at the
decision averages 0.94 in the mirror and 0.25 against native shooters. The rule and its threshold were
chosen after seeing these data, so they were given a fresh sealed bank.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/tier2_striker_registration_20261121.json` (sha256 `3e1c94aead03725988f8fc298aeb0e960eb873c1fbb04abc57c31f204112a3b4`).
Results: `docs/evidence/tier2_striker_confirmation_20261121.json`.

The bank is a pool allocated for this study (namespace `tier2-striker-20261121-v1`, 1,080 tasks per
population, audited against 453 ledgers, every earlier pool, the development tasks and the seeds of the
running Premium collection). Five opponent populations draft on the same seeds; only the tasks where the
rule changes the artifact are played, both arms on identical armies.

| Primary: tasks where the artifact changes, five opponents | Games | Difference | 95% interval    |
| --------------------------------------------------------- | ----: | ---------: | --------------- |
| **All**                                                   | 1,693 |  **+7.06** | +4.39 to +9.76  |
| Normal                                                    |   551 |      +4.63 | +0.46 to +8.80  |
| Lava centre                                               |   601 |     +12.23 | +7.32 to +17.11 |
| Block centre                                              |   541 |      +3.79 | -0.83 to +8.60  |
| Scout seat                                                |   661 |      +8.40 | +3.97 to +12.79 |
| Spymaster seat                                            |   515 |      +6.99 | +2.25 to +11.96 |
| Battle Trance seat                                        |   517 |      +5.42 | +0.78 to +10.27 |

| Opponent                          | Changed tasks | Profile v19 | v20 rule | Difference | 95% interval    | Over all tasks |
| --------------------------------- | ------------: | ----------: | -------: | ---------: | --------------- | -------------: |
| Owner-shaped (strikers + casters) |           340 |       74.0% |    74.3% |      +0.29 | -5.15 to +5.74  |          +0.09 |
| Strikers early, natives late      |           337 |       65.6% |    74.8% |      +9.20 | +4.01 to +14.54 |          +2.87 |
| Natives early, strikers late      |           370 |       70.9% |    83.5% |     +12.57 | +7.70 to +17.43 |          +4.31 |
| Native shooter armies             |           374 |       76.1% |    85.8% |      +9.76 | +5.88 to +13.77 |          +3.38 |
| Profile v19 (also a guard)        |           272 |       49.1% |    50.7% |      +1.65 | -5.33 to +8.64  |          +0.42 |

| Gate                                                              | Result     |
| ----------------------------------------------------------------- | ---------- |
| G1 strength on the changed tasks: lower bound above zero          | passed     |
| G2 no map below -2, no population below -5                        | passed     |
| G3 mirror guard: difference over all mirror tasks at least -2     | passed     |
| G4 candidate games with a quality error not above the control arm | **failed** |
| G5 thirty changed owner tasks reproduce on a second host          | passed     |
| G6 candidate CPU per changed game at most 1.25x control           | passed     |

**G4 failed and stays recorded as failed.** Do not waive, re-run or relabel it. The candidate arm had two
games with a declined scripted melee proposal (`attack_not_available`) against one in the control arm,
the same message behind the failed quality gates of profiles v15, v18 and v19.

The registered analysis ran unamended. One execution deviation is recorded in the results: the
natives-early population ran both arms on the Mac tree instead of the second host, which was saturated by
other users; both arms of every population ran on one host and tree. The production rule reproduced all
2,293 recorded decisions of the bank (1,693 changed, 600 sampled unchanged;
`test/ai/fixtures/a19_tier2_striker_decisions.json`).

## What the estimate is and is not

- It is the gain on the games the rule changes, about a third of the default's drafts; over all tasks of
  the four opponent populations other than the mirror it is about +2.7 points. It is not a win rate
  against people.
- Against the owner-shaped army the rule changed a third of the games and did not move the score.
- Armies with two or more ranged stacks keep the previous choice.

## Premium

Premium's Tier-2 advice ranks an offer by asking the default policy repeatedly, so it now follows the
same rule for a player with fewer than two ranged stacks. The Premium evidence snapshot is not affected:
its cohort runner samples Tier-2 artifacts itself.

## Switches

`HOC_A19_TIER2_STRIKER=off` on the server restores the artifact-fit-v8 choice; `HOC_A19_STRIKER_RUSH=off`
and `HOC_A19_CONTEXT_POLICY=off` switch it off together with the rules it was measured with.
