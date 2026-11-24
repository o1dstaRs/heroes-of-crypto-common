# Carrier cohesion — adopted as A19 profile v32

Adopted on 2026-11-24 at the owner's request, as a behaviour fix with a non-inferiority gate (the keep-attack precedent,
profile v21). Policy id `a19-carrier-cohesion-v2`: `src/ai/carrier_cohesion.ts`, applied in
`src/simulation/search_driver.ts`. Per-seat switch `A19_CARRIER_COHESION_<LEFT|RIGHT>`, on unless `0`.

## Why

The owner, after test game e94392e8: "loosing crusader at the beginning is a mistake, AI needs to be more cautious. As it
gives important scaled with luck (leprechaun) blessing to the whole army". In lap 2 the AI's Crusader moved from 1 cell of
an ally to 7 cells from the nearest ally, hit the Black Dragon and died the same lap; the Manticore, which had already
waited that lap, flew to 4 cells from every ally, attacked and died in lap 2. The army lost Sharpened Weapons and Warding
Mane for the rest of the fight.

A blessing carrier is a unit whose blessing lasts only while it lives: every mass buff whose description begins "While
this unit is alive" (Angelic Host and Arrows Wingshield of the Angel, Arcane Ward of the Squire, Luck of the Leprechaun,
Sharpened Weapons of the Crusader, Sylvan Focus of the Satyr, Tie up the Horses of the Champion, Warding Mane of the
Manticore, Wolf Trail of the Wolf Rider). Its principal carrier is the largest living stack of its creature on its team;
a one-creature split is not one. A test pins the list to `abilities.json`.

## The rule

In laps 1–3 a principal carrier that walks does not make a move, with or without an attack, that takes it from at most 3
cells of its nearest ally to at least 4 cells and at least 2 cells farther (Chebyshev distance between footprints). When
the native choice is such a move it becomes a wait while the hourglass allows one, else a defend; such challengers are
removed from the search. A carrier already away from its army is not held back.

A carrier that flies (the Manticore, the Angel) is never held. The first version, R6, held flyers too and lost on armies
with a Manticore (below), so this rule does not stop the Manticore's flight of e94392e8; it stops the Crusader's walk.

A seat that bought the striker rush plan (Placement at least 2 and Movement at least 2, `a19_striker_rush.ts`) is exempt:
the plan charges with every striker, and every carrier except the Satyr is a striker.

The rule runs in every v0.8 search of the A19 driver: bot seats (stock and deep fit), the tournament tiers, and
Premium's fight advice, which runs the same search and so advises the same caution. `A19_CARRIER_COHESION_<seat>=0`
switches it off for one seat.

## Path to adoption

| Step                                               | Tree | Bank seed  | Result                                                                                                                              |
| -------------------------------------------------- | ---- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Two-rule screen (development)                      | v28  | 2611241201 | Failed. The isolation rule −0.80 (95% −4.26 to +2.66), natural armies −4.17; a narrower move-and-attack rule −2.39 (−5.05 to +0.00) |
| R6 screen: the isolation rule with the rush exempt | v28  | 2611241801 | Passed all five checks: +0.66 (−1.97 to +3.51); all 114 rush seats played the same game                                             |
| Confirmation K2: R6                                | v28  | 2611241501 | Passed all seven gates                                                                                                              |
| Confirmation CC: R6                                | v29  | 2611242101 | **Failed gate CC2**: forced-Manticore armies −2.50 (−6.67 to +1.67) against the −2 bar                                              |
| Confirmation CF: R7, flying carriers exempt        | v30  | 2611243001 | Passed all seven gates (below)                                                                                                      |

After the two-rule screen's result, the isolation rule's decided games split by the striker rush: rush armies 0 better
and 6 worse, every other army 6 better and 4 worse. That split, found after the result, is why R6 was screened on a fresh
bank before any confirmation. Neither failed rule is re-run.

Profile v29 (deep fit at 4,000 rollout turns) became the default while K2 ran. It runs the deep search on the big early
boards, where the carriers' isolating moves happen, so CC measured R6 again on the v29 tree, on a fresh bank. CC passed
every gate but CC2: the forced-Manticore population lost 2.50 points, and it had been negative in K2 too (−1.25), while
the owner matchup gained in both (K2 +1.56, CC +5.47). CC2 stays recorded as failed; R6 is not adopted and CC is not
re-run. The owner chose to revise and retest: R7 leaves flying carriers alone, and CF measured it on a fresh bank on the
v30 tree. Profile v30 (the stock search's 2,500 ms deadline) changes live timing only; offline work has no clock. So does
profile v31 (WAIT comparisons under the clock), adopted while CF ran, so CF's result holds on v31, and R7 is v32.

## Evidence

Registration: `docs/evidence/carrier_cohesion_registration_20261124.json` (sha256
`1f2adb866f41bf506f147df36d08f23e909d6990b8f31c0a722c9f5c19124b2a`) holds the three decision rules verbatim, each
written and hashed before its first game, with the plan and seal hashes. Results:
`docs/evidence/carrier_cohesion_confirmation_20261124.json`.

Each confirmation: the rule on the candidate seat against the production bot seat (deep fit), the opponent unchanged;
904 cases, 1,808 games; populations natural (300 families of draft-shaped random armies, both seats), owner (64 seeds of
the e94392e8 matchup, the candidate playing the AI's army), forced-crusader (120 families) and forced-manticore (120
families). Paired by case; family bootstrap, 10,000 samples, 95%. Points per game (win 100, draw 50, loss 0).

| Population        | K2: R6 on v28              | CC: R6 on v29              | CF: R7 on v30              |
| ----------------- | -------------------------- | -------------------------- | -------------------------- |
| **All (primary)** | **−0.17 (−1.61 to +1.28)** | **+0.00 (−1.41 to +1.41)** | **+0.41 (−0.33 to +1.24)** |
| Natural           | +0.33 (−1.08 to +1.67)     | +0.50 (−0.67 to +1.83)     | −0.50 (−1.33 to +0.17)     |
| Owner matchup     | +1.56 (+0.00 to +4.69)     | +5.47 (+0.00 to +12.50)    | +2.34 (+0.00 to +6.25)     |
| Forced Crusader   | −1.25 (−4.17 to +0.83)     | −1.67 (−5.00 to +1.67)     | +1.67 (+0.00 to +4.17)     |
| Forced Manticore  | −1.25 (−6.67 to +4.17)     | −2.50 (−6.67 to +1.67)     | +0.42 (−1.25 to +2.50)     |

| Behaviour, all cases: production → rule                        | K2           | CC           | CF           |
| -------------------------------------------------------------- | ------------ | ------------ | ------------ |
| Early isolating moves chosen, seats without the rush           | 170 → 2      | 168 → 1      | 63 → 2       |
| Principal carriers dead in laps 1–3                            | 493 → 455    | 506 → 463    | 477 → 461    |
| All carrier stacks dead in laps 1–3                            | 679 → 641    | 673 → 629    | 636 → 621    |
| Crusader dead in laps 1–3                                      | 56 → 47      | 65 → 51      | 56 → 51      |
| Rush seats, games changed                                      | 395 seats, 0 | 358 seats, 0 | 370 seats, 0 |
| Games with a quality error                                     | 0 and 0      | 0 and 0      | 0 and 0      |
| Second host (x3d, linux-x64): natural cases with equal digests | 20 of 20     | 20 of 20     | 20 of 20     |

CF counts the isolating moves of walking carriers only, the moves R7 holds (CF4). The seven gates of each confirmation:
non-inferiority (primary lower bound at least −2), every population at least −2, quality not above production,
isolating moves outside the rush at most 10% of production's, early principal-carrier deaths not above production's, 20
natural cases replayed with identical digests on a second host, and every rush seat playing the same game in both arms.
K2 passed all seven gates, CC failed CC2, CF passed all seven.

## What the estimate is and is not

- A non-inferiority result: the rule removes the isolating moves and loses fewer carriers early without a measurable cost.
  It is not claimed as a strength gain (no primary lower bound is above zero).
- The AI opponents of these studies do not focus fire on carriers the way a person does. In a development screen against
  a research opponent that attacks principal carriers whenever it can (seed 2611241701, 288 cases, R6 on the v28 tree),
  R6 measured −1.04 (−3.33 to +1.04) and lost 261 principal carriers early against production's 271. Caution alone does
  not save a carrier that an opponent hunts.
- In the same screen a deployment rule that stepped a front-column principal carrier one column back lost −5.21 (−10.21
  to −0.21); with R6, −5.83 (−11.04 to −0.62). It is not adopted.
- On the v29 tree the deep search already avoids some isolating moves: native isolations held per case 0.302 in CC
  (K2 on v28: 0.294). CF holds walking carriers only: 0.105 per case.
- Not claimed: strength against people.
