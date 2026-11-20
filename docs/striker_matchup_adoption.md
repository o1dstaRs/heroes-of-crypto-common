# Striker matchup draft — adopted as A19 profile v17

Adopted on November 20, 2026 under the user's standing instruction of November 19, “always lock in wins
and continue”. Policy id `a19-striker-matchup-v1`. Nothing was deployed by the adoption.

## Why

Profile v15 made the default draft melee strikers and take fast ones first. That was fitted against a
default that fielded shooters. Fast strikers are what a rush needs, but against another melee army
nobody rushes, and the units that win a brawl are different ones. The owner put it this way: units
“are good with certain units or against certain units … we can't just sort by win rate”.

Two things were measured:

- A striker draft with uniformly random picks rushes the previous default at 61.8%, against 79.0% for
  fast-first. Which strikers are drafted matters as much as drafting strikers.
- The same creature has opposite worth in the two games. Griffin and Angel are among the best units
  in a rush and among the worst in a melee mirror. Crusader, Hydra and Arachna Queen are the reverse.
  A flyers-first draft scored 83.3% against the previous default and 39.9% against profile v15.

## The policy

Every striker has two values, in match-score points relative to the average striker of its level:
one for a rush against an army that is not melee, one for a fight against a melee army. At each pick
the seat estimates the probability `q` that the opponent's finished army will have four or more
strikers, the threshold from which the striker rush is off, and takes the striker on offer with the
highest `q × melee + (1 − q) × rush`.

`q` comes from the opposing creatures the seat may legally see at that pick: the server's own
visibility projection, nothing hidden. Two kinds of drafter are assumed with equal prior, one taking
a striker nine picks in ten and one a quarter of the time. What has been seen updates which kind this
is, and the unseen picks follow it. With nothing seen `q` is about one half; two revealed strikers
put it above 0.9; three revealed non-strikers make it 0.

The head runs after every earlier draft layer, on the striker rush head's choice, which it keeps
unless another striker is strictly better. It never takes a non-striker and never runs without the
striker rush head. With no striker on offer the earlier choice stands. For the opening bundle the
number of strikers still comes first; the matchup value of the pair breaks ties. Artifact choices are
unchanged. One-use draft budgets of the earlier layers are spent exactly as before.

`src/ai/setup/a19_striker_matchup.ts` holds the table and the choice; the server's draft decider
calls it. Upgrades, formation and the fight are untouched.

## The values

Fitted by ridge-penalised logistic regression on exploration drafts with uniformly random striker
picks, so the current ranking did not select the data: 1,925 rush games against the profile v14 army
and 1,260 striker-mirror games, all on development families that took no part in any evaluation.
Points are 16 × logit for the rush and 25 × logit for the melee game. Standard errors are about 0.14
and 0.12 logit, roughly two and three points. Full table with standard errors:
`docs/evidence/striker_matchup_table_20261120.json`.

| Level | Rush / melee value of each striker, best combined first                                                                                                                                                      |
| ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|     1 | Fairy +6.8/+4.2 · Leprechaun +0.9/+5.4 · Scavenger +1.0/+3.9 · Peasant +3.1/+1.6 · Squire −1.4/+1.9 · Troglodyte −4.4/+4.2 · Wolf Rider +2.7/−4.9 · Berserker −0.4/−2.1 · Wolf −4.7/−0.8 · Mermaid −2.4/−5.4 |
|     2 | Wyvern +7.5/+0.5 · Pikeman +0.5/+5.7 · Nomad +1.9/+2.3 · Harpy +4.3/−3.6 · Trent −2.9/+2.9 · Hyena −1.4/+0.5 · White Tiger −2.6/−0.2 · Troll +0.5/−3.5 · Manticore +1.2/−6.9                                 |
|     3 | Crusader +0.5/+12.9 · Pegasus +0.6/+4.2 · Goblin Knight −2.4/+3.3 · Mantis +2.1/−3.8 · Griffin +6.8/−11.1 · Unicorn −6.8/+0.9 · Efreet −0.8/−6.3                                                             |
|     4 | Hydra +3.0/+14.2 · Arachna Queen −2.5/+12.9 · Champion +7.0/−1.4 · Angel +9.3/−8.1 · Thunderbird +4.5/−6.1 · Frenzied Boar −3.4/−0.7 · Black Dragon −6.4/−4.0 · Abomination −11.5/−6.9                       |

These numbers describe games played by the AI on three maps with its own setups. They are not a
balance statement about the creatures.

## Evidence

Registered before any game of the bank was played:
`docs/evidence/striker_matchup_registration_20261120.json`
(sha256 `764d9b96b46a323f2ffc3542bf1d39107babbbc43268f33a69b70e3b256db593`). Results:
`docs/evidence/striker_matchup_confirmation_20261120.json`.

The bank is 540 tasks from a pool allocated for this study with no development use (namespace
`matchup-draft-20261120-v1`, families 0–59). Four cells, one game per task from the candidate seat.

| Candidate seat | Opponent    | Tasks | Profile v16 | Matchup draft | Difference | 95% interval     |
| -------------- | ----------- | ----: | ----------: | ------------: | ---------: | ---------------- |
| **Primary**    | profile v16 |   540 |       52.2% |         80.3% | **+28.06** | +22.96 to +33.06 |
| Normal         | profile v16 |   180 |       53.3% |         76.7% |     +23.33 | +13.89 to +32.78 |
| Lava centre    | profile v16 |   180 |       51.1% |         82.8% |     +31.67 | +23.33 to +39.72 |
| Block centre   | profile v16 |   180 |       52.2% |         81.4% |     +29.17 | +20.83 to +37.22 |
| **Guard**      | profile v14 |   540 |       78.0% |         81.5% |      +3.52 | −0.83 to +7.96   |

By the candidate seat's own doctrine against profile v16: Scout +29.44, Spymaster +30.28, Battle
Trance +24.44. Against profile v14 the map estimates are Normal −2.22 (−9.17 to +4.72), Lava +8.89
and Block centre +3.89.

All six registered gates passed:

| Gate                                                                 | Result                             |
| -------------------------------------------------------------------- | ---------------------------------- |
| G1 lower bound against the current default above zero                | passed, +22.96                     |
| G2 no map with a negative point estimate against the current default | passed, lowest is Normal at +23.33 |
| G3 not worse against the previous default, lower bound above −5      | passed, −0.83                      |
| G4 candidate games with a quality error not above the control cells  | passed, 2 against 4                |
| G5 thirty candidate tasks reproduce on a second host                 | passed, 30 of 30 digests           |
| G6 candidate CPU per game at most 1.25 times the control             | passed, 1.07                       |

The registered analysis ran unamended.

The production functions reproduced every decision the research draft head made while drafting the
two candidate cells, 5,693 of 5,693, of which 3,403 differ from the fast-first head, and all 2,097
decisions of the development drafts. The production server replayed 30 confirmation games on the
candidate's armies with identical digests.

## What the estimate is and is not

- The primary estimate is against **a default that does not adapt**. Two seats that both use the
  matchup draft meet at 50% by symmetry: the gain is what the previous draft was giving away to an
  opponent who answered it, which is what a player does.
- Against the shooter-fielding profile v14 the candidate is at least as good as profile v16; the gain
  there is not established (the interval includes zero).
- It is not a win rate against people.
- The development estimate (+28.3 and +3.8 on 198 tasks) was the best of three variants run once
  each, so it was expected to be optimistic. The registered result came out the same.
- Rejected on development tasks: fitted Tier-1 artifact values in the bundle choice (+27.8 / +1.8)
  and matchup values at the level 3 and 4 picks only (+24.5 / −0.3).

## Switches

`HOC_A19_STRIKER_MATCHUP=off` on the server restores the fast-striker-first draft of profile v15.
Switching the striker rush off (`HOC_A19_STRIKER_RUSH=off`) or the A19 context policies off
(`HOC_A19_CONTEXT_POLICY=off`) switches this off too.
