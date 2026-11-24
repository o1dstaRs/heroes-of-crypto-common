# Closing pick v2 — adopted as A19 profile v34

Adopted on 2026-11-24 under the owner's standing instruction ("always lock in wins and continue"), for the owner's
request "We need a stronger AI that is able to catch and close picks" (asked what they meant: draft counters) and "Draft is
super important. Especially last lvl4 pick". Policy id `a19-closing-pick-synergy-v1` ("closing pick v2"):
`src/ai/setup/a19_closing_pick.ts`, applied by the server's draft decider (`pick_decider.ts`) before the Queen counter.
Server switch `HOC_A19_CLOSING_PICK` (on unless `off`).

## Why

The level-4 pick is the seat's last creature pick. Against the owner's recent setups the level-4 choice decides many
games: a battery that replayed the owner's 10 recent games with every level-4 creature on offer found a cross-fitted
headroom of +30.6 points per game for production, +18.8 after the Queen counter (v33). The counter draft (profile v26)
already answers an opposing army that reads melee with the matchup model of creature counters; against armies that read
ranged or magic its gate stays shut and the striker heads choose, so the seat never asks the model what closes the draft.

## The rule

At the seat's level-4 pick, when the counter-draft gate is shut (`a19CounterDraftGateOpen` false) but the seat sees at
least one opposing creature (the live visibility: doctrine reveals and hidden-pick collisions), every creature on offer is
scored with the counter draft's matchup model (`a19CounterDraftScore`, fitted on 40,040 production games) plus a synergy
bonus: +0.04 when the creature would be its faction's second distinct creature in the army; as the fourth, Life +0.045,
Might +0.0175, Nature +0.0075, Chaos +0.005. The best offer replaces the earlier layers' choice when it scores at least
0.05 above it (bonus included); otherwise that choice stands. The Queen counter still runs last: with the opposing
Arachna Queen visible and Magic Dragon offered, Magic Dragon. The rule keeps no state and spends none of the other
layers' one-use budgets. Premium draft advice goes through the same decider and advises the same pick.

## Path to adoption

| Step                                            | Data                               | Result                                                                              |
| ----------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Level-4 battery, 10 recent owner games          | every L4 offer × 16 seeds          | on top of v33: +5.00 points per game (2 games change, 0 worse)                      |
| Level-4 battery, 49 more human games (held out) | every L4 offer × 8 seeds           | +1.79 (95% −0.26 to +5.61; 4 changes: 2 better, 2 ties, 0 worse)                    |
| Other level-4 rules on the same 59 games        | half B (25 games) as holdout       | Thunderbird first, a creature prior and legal-feature models all failed the holdout |
| AI-vs-AI development screen (seed 2)            | 195 changed of 4,000 drafted cases | +2.3 per changed case (95% −6.2 to +10.8; 37 better, 32 worse)                      |
| Confirmation CPC, registered before a game      | see below                          | Passed all three gates (below)                                                      |

The rule was written before the 49 held-out games were measured and was not changed after the development screen.

## Evidence

Registration: `docs/evidence/closing_pick_registration_20261124.json` (sha256
`c994f2e56535f430cfd8fc1cdac01029e47e4f423c09ec9c3ba6aa505a00b38e`) holds the decision rule verbatim, written and hashed
before the first game, with every input hash. Results: `docs/evidence/closing_pick_confirmation_20261124.json`.

Part A, primary: the 6 human games where the rule changes v33's level-4 pick. Control is the battery's production army,
the candidate the same army with the rule's level-4 creature; the human seat replays its real setup (upgrades, cells,
splits, barrels and game id); both seats fight with the v33 bot-seat driver with deep fit. 64 fresh seeds per game, both
arms on the same seeds; each game weighted equally; 95% interval from resampling seeds within each game.

| Game                         | Level 4                  |   v33 |  Rule |                      Difference |
| ---------------------------- | ------------------------ | ----: | ----: | ------------------------------: |
| 1a785955 (recent owner game) | Angel → Magic Dragon     | 32.0% | 92.2% |                           +60.2 |
| 9208870e (recent owner game) | Champion → Arachna Queen | 50.0% | 35.9% |                           −14.1 |
| 76f5f3d5 (held out)          | Angel → Thunderbird      | 56.2% | 60.2% |                            +3.9 |
| 909e7898 (held out)          | Angel → Arachna Queen    | 51.6% | 76.6% |                           +25.0 |
| 3fd7b865 (held out)          | Champion → Thunderbird   | 95.3% | 59.4% |                           −35.9 |
| 974d9737 (held out)          | Angel → Thunderbird      | 98.4% | 95.3% |                            −3.1 |
| **Part A (primary)**         |                          |       |       | **+5.99 (95% +0.52 to +11.33)** |

Part B, AI versus AI: the draft-guard mirror families of plan seed 2611245501, 3,000 families (6,000 cases, the candidate
on each side), screened by drafting only; the 339 cases (5.65%) whose drafted game changes were fought in both arms.
Paired by case, family bootstrap, 10,000 samples, 95%.

| Population                                  | Cases        | Difference per changed case | Better / worse |
| ------------------------------------------- | ------------ | --------------------------- | -------------- |
| Draft-guard mirror, drafts the rule changes | 339 of 6,000 | +7.23 (95% +0.59 to +14.01) | 84 / 60        |

Across all 6,000 drafted cases that is +0.41 points per game (activation 5.65%).

Gates, all required: CPC1 part A above 0 with its lower bound above 0; CPC2 part B at least −5 points per changed case;
CPC3 no more games with a quality error than production in either part. All three passed; no game of either part had a
quality error.

The per-game effects moved a lot from the battery, which used the v29 driver and 8 to 16 seeds: on the v33 driver with
64 fresh seeds, 3fd7b865 (a tie at 100 in the battery) loses 35.9 points and 9208870e loses 14.1, while 1a785955 and
909e7898 gain 60.2 and 25.0. The gain is an average over the six setups, not a gain in each.

Scorecard (goals 2 and 4): by battery lookup, production's level-4 score against the owner's ten recent setups goes
37.2 (v32) → 49.1 (v33) → 54.1 (v34) points per game, and 83.7 → 86.1 on the 59-game battery; on the confirmation's
fresh seeds and the v33 driver the two owner games the rule changes give +4.6 points per owner game.

## What the estimate is and is not

- A gain on the human setups where the rule changes the level-4 pick, with the AI playing the human seat's fight moves.
  Not a win rate against people.
- The rule fires only at level 4, with at least one opposing creature visible and the counter draft's gate shut: about one
  draft in eighteen against the default AI, one in ten in the human battery.
- The effect varies by setup: in two of the six confirmation games the rule's pick loses.
- Not claimed: strength where the rule does not fire.
