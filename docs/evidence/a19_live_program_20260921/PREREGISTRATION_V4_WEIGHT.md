# Preregistration — the v4 prior's weight above 8 (P11)

Written 2026-09-23 ~15:50Z, before any P11 game. Base: common 711f1c4, with two measurement-only policy ids
registered outside main: `ranked-unit-strength-a19-side-v4-w12-r4` and `…-v4-w16-r4` (the v4 prior at weight 12 and
16, shooter floor 4 — the shipped default's structure with only the weight changed).

## Why
In P7 the v4 prior alone was worth 54.69% against r4 at weight 4, and weight 8 took it to 63.51% (selection) and
63.04% (8,000-game confirmation): doubling the weight was worth about as much again as the re-fit itself. Nothing
above 8 was tried. With the v1 prior, weight 12 was the strongest unfloored draft measured (it beat r3 58.5% and tied
r4), so the region is plausible, and too high a weight must eventually hurt (the prior overrides coherence and
variety). Only a measurement says where.

## Design
`ranked_draft_eval.ts`, candidate vs `policy:ranked-unit-strength-a19-side-v4-w8-r4` (the ranked default since
server 304b333), both seats set up with `conditional-v1` and take SEE_NONE (the live v0.8 stack), live draft rules,
side board, deterministic a19.
- Selection: w12 (seed 99650001) and w16 (seed 99660001), 2000 games each. Continue with the better draw-aware
  only if it exceeds 0.505.
- Confirmation: 8000 games, seed 99670001. Robustness: candidate and v4-w8-r4 vs pool `reference`, 2000 games per
  opponent, seed 99680001.
Gates (verdict.py, unchanged): draw-aware > 0.50, clustered LCB > 0.50, 0 rejections, worst map >= 0.49,
robustness cells >= incumbent − 2pp, distinct creatures >= 80% of the incumbent's, top creature share <= incumbent
+ 10pp. The two diversity gates matter here: a higher weight concentrates the draft on the prior's favourites.

PASS -> the winning id is registered on main and becomes the server default, rollback
`HOC_DRAFT_WEIGHTS=ranked-unit-strength-a19-side-v4-w8-r4`. Seeds are never re-rolled.

Prediction, written down so it can be wrong: w12 edges w8 by 1–4pp; w16 is no better than w12 and loses on the top
share gate or on robustness.

## RESULT — selection (2000 games each, v4-w8-r4 incumbent, both seats conditional-v1 + SEE_NONE)
w12 (seed 99650001): 1016W 961L 23D; decisive 51.39% [47.02, 55.74], draw-aware 51.38%, 0 rejections; maps NORMAL
49.7 / LAVA 52.5 / BLOCK 52.0. w16 (seed 99660001): 1104W 872L 24D; decisive 55.87% [51.49, 60.16], draw-aware 55.80%,
0 rejections; maps 56.9 / 54.7 / 56.0. Selected w16 (0.5580 > 0.505 and > w12). The prediction above was wrong about
w16. Confirmation 99670001 and robustness 99680001 queued behind P9's stage 3 on each host.
