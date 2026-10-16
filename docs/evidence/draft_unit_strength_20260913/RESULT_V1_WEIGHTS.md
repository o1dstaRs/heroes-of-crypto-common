# Unit-strength draft, higher weights — result

Preregistration: `PREREGISTRATION_V1_WEIGHTS.md`. Frozen common 4f247b7, worktree `hoc-common-weights-eval`, pipeline
`run_weights_pipeline.sh`. Raw outputs: `RESULT_WEIGHTS_VERDICT.txt`, `RESULT_WEIGHTS_SELECTION_CHOICE.txt` and the
`RESULT_selection_*`, `RESULT_confirm_vs_w4`, `RESULT_headline_vs_live`, `RESULT_robust_*` JSON summaries.

## Stage 1 — selection (seed 98700001, each weight vs the previous live draft, 2000 games)

| Weight       | Draw-aware | Decisive [95% CI]     | NORMAL | LAVA  | BLOCK | Distinct | Top creature |
| ------------ | ---------- | --------------------- | ------ | ----- | ----- | -------- | ------------ |
| w4 (shipped) | 79.45%     | 79.75% [76.00, 83.04] | 78.4%  | 75.9% | 85.0% | 51       | Zena 51.4%   |
| w6           | 84.28%     | 84.53% [81.10, 87.44] | 83.6%  | 81.8% | 88.2% | 48       | Zena 73.2%   |
| w8           | 86.48%     | 86.68% [83.42, 89.38] | 85.5%  | 83.9% | 90.6% | 45       | Zena 75.2%   |
| w12          | 89.53%     | 89.70% [86.73, 92.07] | 87.7%  | 88.3% | 93.2% | 45       | Zena 75%     |

0 rejections in every run. Rule: highest draw-aware score, ties within 0.5pp to the smaller weight → **w12**.

## Stage 2 — confirmation of w12

1. **Head-to-head vs the shipped w4** (seed 98710001, 8000 games): 6251W 1701L 48D, draw-aware **78.44%**, decisive
   78.61% [76.76, 80.35], clustered lower bound 76.76%; NORMAL 79.53%, LAVA 75.80%, BLOCK 80.49%; 0 rejections.
2. **Headline vs the previous live draft** (seed 98720001, 8000 games): 7206W 755L 39D, draw-aware **90.32%**,
   decisive 90.52% [89.15, 91.72], clustered lower bound 89.15%; NORMAL 90.85%, LAVA 88.24%, BLOCK 92.45%; 0 rejections.
   For reference, the shipped w4 scored 78.47% [76.62, 80.22] against the same opponent on seed 97300001.
3. **Robustness** (seed 98730001, 2000 games per reference): w12 vs untrained heuristic 49.77%, vs League round-3
   exploiter 93.07%; w4 28.75% and 75.92%.

## Gates (vs the shipped w4)

| Gate                                                  | Value   | Result |
| ----------------------------------------------------- | ------- | ------ |
| 1 draw-aware head-to-head > 0.50                      | 0.7844  | PASS   |
| 2 clustered 95% lower bound > 0.50                    | 0.7676  | PASS   |
| 3 candidate rejections = 0                            | 0       | PASS   |
| 4 worst map (LAVA) >= 0.49                            | 0.7580  | PASS   |
| 5 vs untrained heuristic: w12 − w4 >= −2pp            | +21.0pp | PASS   |
| 5 vs round-3 exploiter: w12 − w4 >= −2pp              | +17.2pp | PASS   |
| 6a distinct creatures >= 80% of w4's (46 / 52)        | 0.8846  | PASS   |
| 6b top creature share <= w4's + 10pp (51.6% vs 50.0%) | +1.6pp  | PASS   |

**VERDICT: PASS.** `ranked-unit-strength-a19-side-v1-w12` is proposed as the next ranked default; the owner decides
the ship.

## Caveats reported with the proposal (exploratory, not gated)

- **Variety against non-strength drafters.** Gate 6 is measured in the head-to-head, where both drafts chase the same
  high-lift units and split them. Against the previous live draft, which is closer to how other opponents draft, w12
  took Zena in 74% of drafts, Dryad 59%, Battle Mage 55%, Gargantuan 45%, Tsar Cannon 31% (44 distinct creatures vs
  the opponent's 54). The variety policy only swaps within 0.02 normalized score at the level-3 pick, while w12 adds
  about +2.6 for Zena's fitted lift, so weight concentrates the level-3 pick.
- **A ranged stack still ties it.** The untrained heuristic reference drafts Cyclops 66%, Arbalester 52%, Elf 51%,
  Beholder 35%, Orc 31% and splits evenly with w12 (987W 996L 17D), while the melee-tank round-3 exploiter loses 93%.
  A human who drafts ranged-heavy is the likely counter.
- **Strength had not plateaued at w12;** higher weights were not tested.
