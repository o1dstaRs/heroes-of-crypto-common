# Unit-strength draft, on-policy refit (v3) — result

Preregistration: `PREREGISTRATION_V3_REFIT.md` (with its pre-data amendments). Data and fit from frozen common
78b15d4 (`hoc-common-v3-data`), evaluation from 83abbb1 (`hoc-common-v3-eval`), pipelines `run_v3_data.sh` and
`run_v3_eval_pipeline.sh`. Raw outputs: `RESULT_V3_VERDICT.txt`, `RESULT_V3_SELECTION_CHOICE.txt` and the
`RESULT_V3_*.json` summaries.

## Stages 1-2 — data and fit

4000 boards drafted by `ranked-unit-strength-a19-side-v1-w4` with 50% exploration, seed 98800001: 8000 games, 7927
decisive, collected in one attempt (8 workers, 100-board chunks). The v1 model refitted as
`ranked-unit-strength-a19-side-v3` correlates 0.91 with v1. Largest moves: Gargantuan +11.5 → +18.3pp, Tsar Cannon
+11.3 → +18.3pp, Zena +20.0 → +16.8pp, Dryad +17.5 → +14.0pp, Arachna Queen −10.6 → −15.3pp, Thunderbird −5.3 →
−9.9pp, Abomination −11.7 → −6.8pp (the data already ran with Abomination released from guard duty), Harpy −8.6 →
−2.2pp, Griffin −6.7 → 0.0pp.

## Stage 3 — selection (seed 98810001, vs the previous live draft, 2000 games each)

| Policy          | Draw-aware | Decisive |
| --------------- | ---------- | -------- |
| v3-w2           | 58.05%     | 58.21%   |
| v3-w4           | 72.97%     | 73.15%   |
| v3-w8           | 87.28%     | 87.44%   |
| v1-w4 (control) | 78.23%     | 78.58%   |

v3-w8 chosen; it beats the control by 9.05pp, so the round continued. On the same seed v3-w4 is 5.3pp below v1-w4:
weight for weight the refit is not stronger.

## Stage 4 — confirmation of v3-w8 against the round-1 winner v1-w12

1. Head-to-head (seed 98820001, 8000 games): 3167W 4726L 107D, draw-aware **40.26%**, decisive 40.12% [38.00,
   42.29]; NORMAL 42.87%, LAVA 40.02%, BLOCK 37.49%; 0 rejections.
2. Headline vs the previous live draft (seed 98830001, 8000 games): draw-aware 87.85%, decisive 88.13% [86.64,
   89.47]; 0 rejections. (v1-w12 scored 90.32% on the same kind of test, seed 98720001.)
3. Robustness (seed 98840001, 2000 games per reference): v3-w8 42.76% vs the untrained heuristic and 90.48% vs the
   round-3 exploiter; v1-w12 47.78% and 93.57%.

## Gates (vs v1-w12)

| Gate                                   | Value   | Result |
| -------------------------------------- | ------- | ------ |
| 1 draw-aware head-to-head > 0.50       | 0.4026  | FAIL   |
| 2 clustered 95% lower bound > 0.50     | 0.3800  | FAIL   |
| 3 candidate rejections = 0             | 0       | PASS   |
| 4 worst map (BLOCK) >= 0.49            | 0.3749  | FAIL   |
| 5 vs untrained heuristic: >= −2pp      | −5.0pp  | FAIL   |
| 5 vs round-3 exploiter: >= −2pp        | −3.1pp  | FAIL   |
| 6a distinct creatures >= 80% (50 / 49) | 1.0204  | PASS   |
| 6b top creature share <= +10pp         | −10.1pp | PASS   |

**VERDICT: FAIL.** The on-policy refit does not beat the higher v1 weight. `ranked-unit-strength-a19-side-v1-w12`
remains the proposed next default. No re-roll.

Also recorded: v1-w12's robustness on this fresh seed (47.78% / 93.57%) replicates round 1 (49.77% / 93.07%).
