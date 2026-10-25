# Doctrine scouting draft research

Candidate: `visible-continuations-map-residual-v1`, frozen before the first deciding game on 2026-10-24.
It compares the current ranked pick with its next-ranked alternative. A blocked odd faction path costs
0.08; historical v2 map residuals are clipped to ±5 points, weighted 0.02 on the roster and 0.01 on
possible faction continuations. The current recommendation wins differences of 0.04 or less.
Opening bundles use the same continuation calculation. No hidden map, bans, picks or offers enter it.
The historical map fit is an experimental feature, not evidence of current strength.

The control is `ranked-unit-strength-a19-side-v4-w16-r4`. Both use the live v0.8 A19 deterministic
fight, side board, rolled synergies, tactical splits and `artifact-fit-v6:conditional-v1:sniper+t2a19`.
The pilot uses 120 games per doctrine (`see-none`, `three-reveals`, `see-all`), balanced across three
maps, both draft seats and both battle mirrors. Seeds are 260104001, 260204001 and 260304001.
This pilot can reject a candidate; it cannot promote one. Negative or inconclusive results retain
the current bot and are not followed by tuning on the same games.

A promising pilot requires a separately funded comparison of at least 6,000 games, a clustered
95% lower score bound above 50%, zero rejected actions, worst map at least 49%, reference-opponent
checks and fresh held-out confirmation. Changing the bot's doctrine also requires comparing its
5/6/7-point setup budgets under the updated visibility. Until all relevant gates pass, this candidate
stays in simulation only. Production profiles do not import the experiment.

Raw records, source bundles and summaries remain outside Git. The runner reuses
`playRankedDraftGame` and `summarizeRankedDraftRecords`; each record retains the existing seeds,
army/setup identities, action rejections and behavior hashes.
