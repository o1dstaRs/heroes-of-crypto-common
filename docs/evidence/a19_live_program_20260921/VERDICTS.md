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

## conditional-v1 setup vs the live v07-nonfight setup, both drafts r4 (P6, shipped scoped to v0.8)

The incumbent label names the draft policy both seats used; the two arms differ only in setup.

```
run: confirm_setup vs incumbent:ranked-unit-strength-a19-side-v1-w4-r4
head-to-head: 4410W 3525L 65D over 8000 games; decisive 55.58% CI [53.39, 57.74]
  grid 1: 55.59% (LCB 51.79)
  grid 3: 57.03% (LCB 53.24)
  grid 4: 54.12% (LCB 50.32)
diversity: candidate 51 distinct, incumbent 51; top share 38.0% vs 38.0% over 4000 drafts
informational: tier-2 synergy reach candidate 3.7% vs incumbent 3.7%
PASS  1 draw-aware head-to-head > 0.50: 0.5553
PASS  2 clustered 95% LCB > 0.50: 0.5339
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 4) >= 0.49: 0.5412
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.0487
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0130
PASS  6a distinct creatures >= 80% of incumbent: 1.0000
PASS  6b top creature share <= incumbent + 10pp: 0.0000
VERDICT: PASS
```

## v4-w8-r4 vs the floor-4 default r4 (P7, shipped as the ranked draft default)

```
run: confirm_v4 vs incumbent:ranked-unit-strength-a19-side-v1-w4-r4
head-to-head: 4993W 2927L 80D over 8000 games; decisive 63.04% CI [60.90, 65.13]
  grid 1: 63.33% (LCB 59.61)
  grid 3: 62.10% (LCB 58.36)
  grid 4: 63.70% (LCB 59.98)
diversity: candidate 48 distinct, incumbent 50; top share 37.5% vs 37.2% over 4000 drafts
informational: tier-2 synergy reach candidate 5.9% vs incumbent 3.8%
PASS  1 draw-aware head-to-head > 0.50: 0.6291
PASS  2 clustered 95% LCB > 0.50: 0.6090
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 3) >= 0.49: 0.6210
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.1137
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0058
PASS  6a distinct creatures >= 80% of incumbent: 0.9600
PASS  6b top creature share <= incumbent + 10pp: 0.0030
VERDICT: PASS
```

Ship condition added before any result (both seats on conditional-v1, seed 99770001): 1220W 753L 27D, decisive 61.83%
[57.50, 65.99]. Informational replication of r4 vs r3 on current balance (seed 99760001): 60.04% [55.69, 64.24].

## SEE_NONE vs the per-match doctrine variety for v0.8 seats (P8, shipped v0.8 only)

Both seats draft r4 and set up with conditional-v1; the seats differ only in how they take their doctrine.

```
run: confirm_doctrine vs incumbent:ranked-unit-strength-a19-side-v1-w4-r4
head-to-head: 4204W 3693L 103D over 8000 games; decisive 53.24% CI [51.04, 55.41]
  grid 1: 53.34% (LCB 49.54)
  grid 3: 53.58% (LCB 49.78)
  grid 4: 52.79% (LCB 48.99)
diversity: candidate 50 distinct, incumbent 50; top share 37.5% vs 37.5% over 4000 drafts
informational: tier-2 synergy reach candidate 3.7% vs incumbent 3.7%
PASS  1 draw-aware head-to-head > 0.50: 0.5319
PASS  2 clustered 95% LCB > 0.50: 0.5104
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 4) >= 0.49: 0.5279
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.0278
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0220
PASS  6a distinct creatures >= 80% of incumbent: 1.0000
PASS  6b top creature share <= incumbent + 10pp: 0.0000
VERDICT: PASS
```

Split by the doctrine the variety seat drew:

```
SEE_NONE vs SEE_ALL              games  2636  draw-aware 60.45%  decisive 60.54% ± 1.87 (games not clustered)
SEE_NONE vs SEE_NONE             games  2624  draw-aware 48.86%  decisive 48.84% ± 1.93 (games not clustered)
SEE_NONE vs THREE_REVEALS        games  2740  draw-aware 50.36%  decisive 50.37% ± 1.89 (games not clustered)
```

Informational cells (2,000 games each): SEE_NONE vs SEE_ALL 56.89% [52.51, 61.16]; SEE_NONE vs THREE_REVEALS 51.47%
[47.09, 55.82]. Replication with both seats drafting v4-w8-r4 (seed 99960001): 54.41% [50.02, 58.72].
