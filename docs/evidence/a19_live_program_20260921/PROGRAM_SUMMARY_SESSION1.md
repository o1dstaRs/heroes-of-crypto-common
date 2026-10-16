# a19 improvement program from live test-server games — 2026-09-21/22

Five preregistered proposals, each measured before it could ship. Two shipped, three failed honestly.

## Where the losses actually were
125 terminal match reports from test.heroesofcrypto.io; 27 decisive human-vs-AI fights, the bot won 11 (39%).
The bot fielded ZERO natively ranged creatures in 22 of those 27 while humans brought 2-5. Behaviourally the bot
charged on 63% of its melee attacks where humans struck in place on 84-90%. The mechanism in code: a19 enumerates
only the nearest advance (a13 `maxMoves: 1`) and drops every generated wait/defend challenger, so "receive the
charge" was never a candidate it could score.

## Results
| # | proposal | measurement | outcome |
|---|---|---|---|
| 1 | edge-of-reach advance candidate | 900 pairs: -0.68pp [-3.19, +1.69] | FAIL, seam default-off |
| 2 | wait challenger when the policy moves | 900 pairs: -0.16pp [-1.72, +1.33] | FAIL, seam default-off |
| 3 | draft shooter floor 2/3 | r3 vs w4, 8000 games: 67.60% [65.52, 69.62], all 8 gates | SHIPPED common 832f8fc |
| 4 | draft shooter floor 4 | r4 vs r3, 8000 games: 57.09% [54.91, 59.24], all 8 gates | SHIPPED common c3bdc78 |
| 5 | draft shooter floor 5 | r5 vs r4, 8000 games: 52.05% [49.86, 54.23], 7 of 8 gates pass, gate 2 FAIL | FAIL, lever closed |
Withdrawn before any deciding game: the any_board Pareto No-Melee focus arm, because its actor and target co-occur
on only 6.4% of boards, so even a +10pp in-cohort effect would be under +0.6pp pooled.

## What shipped
`ranked-unit-strength-a19-side-v1-w4-r4` is the ranked default (server default flip + pin). The floor is soft: it
narrows an offer only when the remaining picks could no longer reach it, so armies realise 2.88 shooters, not 4.
Rollback without code: `HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v1-w4-r3` (or `-w4` for the original).
Calibration note: r4 beats the untrained-heuristic ranged stack 52.77% on seed 99330001 and 50.43% on 99430001, so
that claim is "r4 has closed the exploit to about even", not "r4 dominates it".

## The draft optimum is now bracketed and tight
r3 (2.12 shooters) proven worse than r4; r5 (3.14) not better; the untrained heuristic stack (4.21) proven worse.
Floors 5 and 6 draft identically because the offers stop containing shooters. The optimum is ~2.9 and r4 realises it.
Going further needs a re-fit of the unit-strength prior, not a higher floor.

## And the fight AI plays the new armies well
Per-unit turn-mix census (10 mirrored deterministic a19 games per unit): Medusa attacks on 90% of turns for 141
damage/turn, Beholder 84% / 117, Dryad 85% / 74, against the melee control Peasant at 29% / 14 dead by lap 2. That
matches the live human benchmark (63-88% ranged action share) and a peer's independent census finding that the
passive-turn problem is gone. Composition, not tactics, was the lever — which is why both fight seams measured null.

## Open for the owner
The test server still runs a common from before the deep-budget a19 AND before both draft changes; neither host has
been deployed. Evidence, preregistrations and verdicts: `~/Workplace/hoc-a19-live/`.
