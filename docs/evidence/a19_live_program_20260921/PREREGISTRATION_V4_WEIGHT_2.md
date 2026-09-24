# Preregistration — the v4 prior's weight above 16 (P12)

Written 2026-09-24 ~05:05Z, before any P12 game. Base: common main (v4-w16-r4 is the ranked default since server
2b169d5), with two measurement-only ids registered outside main: `ranked-unit-strength-a19-side-v4-w24-r4` and
`…-v4-w32-r4` (weight 24 and 32, shooter floor 4).

## Why
The weight axis kept paying: w4 < w8 (+9pp in P7's selection), w12 51.38% and w16 55.80% against w8 in P11's
selection, w16 confirmed at 54.60%. It must turn over somewhere — the prior eventually overrides coherence and variety
— and the top creature share rose from 38.0% to 41.2% between w8 and w16.

## Design
Candidate vs `policy:ranked-unit-strength-a19-side-v4-w16-r4`, both seats set up with `conditional-v1:sniper+t2a19`
(the live v0.8 setup since server 24a9a0e) and take SEE_NONE; live draft rules, side board, deterministic a19.
- Selection: w24 (seed 99690001) and w32 (seed 99700001), 2000 games each; continue with the better draw-aware only
  if it exceeds 0.505.
- Confirmation: 8000 games, seed 99710001. Robustness: candidate and w16 vs pool `reference`, 2000 games per
  opponent, seed 99780001.
Gates (verdict.py, unchanged), including distinct creatures >= 80% of w16's and top share <= w16's + 10pp.
PASS -> the winning id goes to main and becomes the server default; rollback `HOC_DRAFT_WEIGHTS=…-v4-w16-r4`.

Prediction, written down so it can be wrong: w24 edges w16 by 0–2pp and fails to confirm; w32 is no better.

## RESULT — selection (2000 games each, v4-w16-r4 incumbent, both seats conditional-v1:sniper+t2a19 + SEE_NONE)
w24 (seed 99690001): 1018W 946L 36D; decisive 51.83% [47.46, 56.18], draw-aware 51.80%, 0 rejections; maps 51.3 /
52.1 / 52.1; top share 38.1% vs 38.1%. w32 (seed 99700001): 1007W 965L 28D; decisive 51.06% [46.69, 55.42],
draw-aware 51.05%; top share 38.5% vs 37.9%. The weight curve flattens above 16. Selected w24 (0.5180 > 0.505) →
confirmation 99710001 and robustness 99780001 on hft.
Execution note 09:05Z: the robustness cells (seed 99780001) moved from hft's queue to the idle shared node; hft keeps
the confirmation (seed 99710001). A peer session's 5-worker run shared hft from 05:56Z; deterministic search makes
the sharing irrelevant to results.
