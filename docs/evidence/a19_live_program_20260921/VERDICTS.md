# Verdict-script output for the three confirmed draft comparisons

Produced by `scripts/verdict.py` over each confirmation plus its two robustness cells (gates from
PREREGISTRATION_RANGED_FLOOR.md, identical to the 2026-09-14 draft protocol).

## r3 vs v1-w4 (the first shipped floor)

```
run: confirm_vs_w4 vs incumbent:ranked-unit-strength-a19-side-v1-w4
head-to-head: 5357W 2567L 76D over 8000 games; decisive 67.60% CI [65.52, 69.62]
  grid 1: 66.33% (LCB 62.65)
  grid 3: 62.25% (LCB 58.52)
  grid 4: 74.24% (LCB 70.79)
diversity: candidate 50 distinct, incumbent 52; top share 51.3% vs 44.7% over 4000 drafts
informational: tier-2 synergy reach candidate 2.8% vs incumbent 0.4%
PASS  1 draw-aware head-to-head > 0.50: 0.6744
PASS  2 clustered 95% LCB > 0.50: 0.6552
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 3) >= 0.49: 0.6225
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.1348
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.1051
PASS  6a distinct creatures >= 80% of incumbent: 0.9615
PASS  6b top creature share <= incumbent + 10pp: 0.0662
VERDICT: PASS
```

## r4 vs r3 (the shipped default)

```
run: confirm_r4_vs_r3 vs incumbent:ranked-unit-strength-a19-side-v1-w4-r3
head-to-head: 4526W 3402L 72D over 8000 games; decisive 57.09% CI [54.91, 59.24]
  grid 1: 54.88% (LCB 51.09)
  grid 3: 55.89% (LCB 52.10)
  grid 4: 60.49% (LCB 56.73)
diversity: candidate 50 distinct, incumbent 50; top share 44.4% vs 43.7% over 4000 drafts
informational: tier-2 synergy reach candidate 4.2% vs incumbent 2.7%
PASS  1 draw-aware head-to-head > 0.50: 0.5703
PASS  2 clustered 95% LCB > 0.50: 0.5491
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 1) >= 0.49: 0.5488
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.0589
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0259
PASS  6a distinct creatures >= 80% of incumbent: 1.0000
PASS  6b top creature share <= incumbent + 10pp: 0.0070
VERDICT: PASS
```

## r5 vs r4 (the lever closes)

```
informational: tier-2 synergy reach candidate 2.9% vs incumbent 2.8%
PASS  1 draw-aware head-to-head > 0.50: 0.5203
FAIL  2 clustered 95% LCB > 0.50: 0.4986
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 4) >= 0.49: 0.5157
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.0209
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0041
PASS  6a distinct creatures >= 80% of incumbent: 1.0000
PASS  6b top creature share <= incumbent + 10pp: 0.0005
VERDICT: FAIL
```
