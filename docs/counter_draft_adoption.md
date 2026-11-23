# Gated counter draft — adopted as A19 profile v26

Adopted on November 22, 2026 under the owner's standing instruction ("always lock in wins please"). Policy id
`a19-counter-draft-v1`.

## Why

The owner's goal: "I need overall versatile strategy that beats me, which is able to leverage all the data it has", and
"The idea is not to find perfect combo, but to read what opponent is doing, what units are available to counter that
etc. Or build something that is very hard to counter". Replays of the owner's real games showed that the owner
out-drafted the AI: on the two armies alone a matchup model gave the AI 33-49% in the five games the owner won.

## The model

A logistic model of P(army A beats army B) under production play: one strength per creature, one counter value per
creature pair (antisymmetric), fitted on 40,040 production games (control arms of the confirmations, 39,842 distinct
matchups). Held-out log loss: strength only 0.58727, with counters 0.56896 (-0.0183, the same with folds grouped by
matchup or by army). `src/ai/setup/draft_models/a19_counter_draft_v1.json`.

## The rule

`src/ai/setup/a19_counter_draft.ts`. Once a seat sees at least two opposing creatures and their melee probability
(`a19OpponentMeleeProbability`) is at least 0.5, each creature on offer is scored by completing both armies: the
opponent's unseen slots from how often each creature appears in armies (32 samples) and from the opponent's best
counter to this seat's army; this seat's later picks are its best answers; the score is the mean of the two. Against
shooter armies the gate stays closed and the striker draft keeps the rush (an ungated version lost 33.67 points against
decoy forts in development). Only creatures the seat may legally see are read, including collision reveals.
The server's draft decider applies it after the striker matchup head (`HOC_A19_COUNTER_DRAFT`, on unless `off`).

## Evidence

Development: gated, matrix tasks (Spymaster entrants): default AI +13.00, owner rush +2.00, decoy fort -0.67, Queen
fort +5.33, caster brawler -3.33; on cx-tasks (Scout and Battle Trance entrants) against the default AI +5.50.
Registered confirmation Z (`docs/evidence/counter_draft_registration_20261122.json`, sha256 `7d5b23d507419eac1246f70e81916103c02ad577e0d04eb675db91e46e73bebb`) on a fresh sealed
bank (namespace `counter-draft-20261122-v1`, 963 tasks audited against 1,058 ledgers, 0 intersections). Results:
`docs/evidence/counter_draft_confirmation_20261122.json`.

| Population                | Tasks | Changed | Difference | 95% interval   |
| ------------------------- | ----: | ------: | ---------: | -------------- |
| **Default AI (primary)**  |   963 |     877 |  **+5.30** | +1.19 to +9.35 |
| Owner-shaped rush (guard) |   324 |     152 |      −0.31 | −4.01 to +3.40 |
| Decoy fort (guard)        |   324 |      48 |      +0.62 | −1.23 to +2.47 |
| Queen fort (guard)        |   315 |      49 |      +1.75 | −1.27 to +4.76 |
| Caster brawler (guard)    |   324 |     106 |      +2.01 | −0.62 to +4.78 |

Every gate passed: strength, the four guards, quality, parity of unchanged matchups and the second host.

## What the estimate is and is not

- Against AI-played armies in deterministic work mode; not a win rate against people.
- Production seeds the read samples from the game id; another random stream changes 5.3% of the picks.
