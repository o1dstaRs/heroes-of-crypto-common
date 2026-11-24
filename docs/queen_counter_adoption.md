# Queen counter — adopted as A19 profile v33

Adopted on 2026-11-24 at the owner's request, after the owner's drafts against the default AI: "They never pick tsar
cannon, magic dragon, zena or anything to counterbalance me". Policy id `a19-queen-counter-v1`:
`src/ai/setup/a19_queen_counter.ts`, applied last by the server's draft decider (`pick_decider.ts`). Server switch
`HOC_A19_QUEEN_COUNTER` (on unless `off`).

## Why

The owner beats the default AI with an Arachna Queen web: 4 of the owner's last 9 games against the AI fielded the
Queen, and the AI won none of them. The counter draft (profile v26) answers the Queen with Magic Dragon only once it
sees two opposing creatures that read melee. Against a shooter army with a Queen, the striker heads keep drafting
strikers.

## The rule

At the seat's level-4 pick, once the opposing Arachna Queen is visible to it, the seat takes Magic Dragon if Magic
Dragon is offered. Otherwise the live decider's choice stands. Visibility is the live projection every draft layer uses:
doctrine reveals and hidden-pick collisions. The rule keeps no state and spends none of the other layers' one-use
budgets. Premium draft advice goes through the same decider and advises the same pick.

## Path to adoption

| Step                                      | Seeds              | Result                                                                                                                    |
| ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Draft hedge screen (development)          | 8 owner games × 32 | An unconditional level-4 hedge +0.20 (95% −31.05 to +34.77): the two Queen games +73.4 and +71.9, three others −40 to −55 |
| Confirmation QV, registered before a game | see below          | Passed all four gates (below)                                                                                             |

The rule was narrowed to the Queen after the screen's result, so QV measured it on fresh seeds, on a held-out game
(b2016809, played after the screen's games were chosen) and on AI-versus-AI drafts.

## Evidence

Registration: `docs/evidence/queen_counter_registration_20261124.json` (sha256
`e208b2f6a36d20fa2c86aa310d451a96d6b55a34b77e3b8163a54e23169efc12`) holds the decision rule verbatim, written and hashed
before the first game, with the plan and seal hashes. Results: `docs/evidence/queen_counter_confirmation_20261124.json`.

Part A, primary: the owner's exact setups. In the two owner games where the rule fires, the AI seat re-drafts with the
rule or with the live decider against the owner's real picks, and the owner's seat replays the owner's real setup
(upgrades, cells, splits and game id); both seats fight with the bot-seat driver with deep fit. 64 fresh seeds per game;
each game weighted equally; 95% interval from resampling seeds within each game.

| Game                 | Production |  Rule |                        Difference |
| -------------------- | ---------: | ----: | --------------------------------: |
| 3a611eda (Queen web) |      32.0% | 96.9% |                             +64.8 |
| b2016809 (held out)  |      18.8% | 71.9% |                             +53.1 |
| **Part A (primary)** |            |       | **+58.98 (95% +49.61 to +68.36)** |

Part B, AI versus AI (300 drafted families in which the opponent takes the Arachna Queen when offered; a 150-family
mirror with the candidate on each side). Paired by case, family bootstrap, 10,000 samples, 95%.

| Population    | Difference             | Rule fired |
| ------------- | ---------------------- | ---------: |
| Visible Queen | +1.00 (−1.33 to +3.33) |         32 |
| Mirror        | +0.00 (+0.00 to +0.00) |         12 |

In the mirror the rule changed 12 picks and no result.

Gates, all required: QV1 part A above 0 with its lower bound above 0; QV2 visible-Queen at least 0; QV3 mirror at least
−2; QV4 no more games with a quality error than production in either part. All four passed.

A level-4 battery measured the same two games on 16 other seeds, every level-4 option against the owner's setup: Magic
Dragon 90.6 against Champion 15.6 in 3a611eda, 56.2 against Frenzied Boar 12.5 in b2016809. In the eight other owner
games of that battery the rule does not fire. Scorecard (goals 2 and 4): on that battery QV moves production's level-4
score against the owner's setups from 37.2 to 49.1 points per game, and the cross-fitted headroom from +30.6 to +18.8.
Thunderbird scored above Magic Dragon on both games (93.8 against 90.6, 68.8 against 56.2): a Thunderbird-first revision
needs its own confirmation.

## What the estimate is and is not

- A gain on the owner's Queen setups, where the AI plays the owner's fight moves. Not a win rate against people.
- The rule fires only when the seat can see the Queen before its level-4 pick and Magic Dragon is on offer.
- Not claimed: strength beyond those setups.
