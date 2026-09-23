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

## The Tier-2 table t2a19 vs conditional-v1's old table (P9, shipped for v0.8 seats)

Both seats draft v4-w8-r4 and take SEE_NONE; the seats differ only in the Tier-2 rule.

```
run: confirm_t2a19 vs incumbent:ranked-unit-strength-a19-side-v4-w8-r4
head-to-head: 4238W 3652L 110D over 8000 games; decisive 53.71% CI [51.52, 55.89]
  grid 1: 53.38% (LCB 49.59)
  grid 3: 54.24% (LCB 50.44)
  grid 4: 53.52% (LCB 49.72)
diversity: candidate 48 distinct, incumbent 48; top share 37.8% vs 37.8% over 4000 drafts
informational: tier-2 synergy reach candidate 5.8% vs incumbent 5.8%
PASS  1 draw-aware head-to-head > 0.50: 0.5366
PASS  2 clustered 95% LCB > 0.50: 0.5152
PASS  3 candidate rejections == 0: 0
PASS  4 worst map (grid 1) >= 0.49: 0.5338
PASS  5 vs untrained-heuristic: candidate - incumbent >= -0.02: 0.0356
PASS  5 vs league-round3-exploiter: candidate - incumbent >= -0.02: 0.0039
PASS  6a distinct creatures >= 80% of incumbent: 1.0000
PASS  6b top creature share <= incumbent + 10pp: 0.0000
VERDICT: PASS
```

Stage 2 (twelve paired forced-artifact arms, seed 99970001):

```
games per arm 2000; ranged cohort 1998
ranged table (draw-aware score of the forced arm against the policy's artifact, 0.5 = even):
   5 Crown of Command         56.53  maps 1:56.8 3:56.0 4:56.8  old table 32.6
   6 Giant's Maul             54.30  maps 1:56.9 3:53.3 4:52.7  old table 37.9
   4 Clover of Fortune        53.55  maps 1:52.2 3:53.1 4:55.4  old table 66.5
   8 Farsight Quiver          53.23  maps 1:51.6 3:53.4 4:54.7  old table 88.8
   7 Pendant of Vitality      52.43  maps 1:53.4 3:52.4 4:51.4  old table 28.2
   2 Titan Plate              51.33  maps 1:53.1 3:50.5 4:50.4  old table 67.2
   1 Warlord's Edge           50.78  maps 1:51.5 3:50.4 4:50.5  old table 65.3
   9 Berserker's Bond         47.57  maps 1:50.0 3:46.0 4:46.8  old table 27.2
  13 Archmage's Ring          46.55  maps 1:46.9 3:46.1 4:46.6  old table none
  11 Rime Charm               43.69  maps 1:43.9 3:42.5 4:44.7  old table 38.6
  10 Tome of Amplification    42.29  maps 1:43.0 3:41.1 4:42.7  old table 71.3
  12 Lava Striders            41.84  maps 1:42.6 3:40.6 4:42.4  old table 37
policy picks (ranged cohort): Farsight Quiver 27.5%, Tome of Amplification 19.7%, Titan Plate 15.8%, Clover of Fortune 12.2%, Warlord's Edge 8.7%, Rime Charm 7.1%, Giant's Maul 4.4%, Lava Striders 2.4%, Crown of Command 1.3%, Pendant of Vitality 0.8%
new rule picks (ranged cohort): Crown of Command 24.6%, Giant's Maul 19.0%, Clover of Fortune 16.0%, Farsight Quiver 14.7%, Pendant of Vitality 10.4%, Titan Plate 6.3%, Warlord's Edge 4.7%, Berserker's Bond 2.5%, Archmage's Ring 1.0%, Rime Charm 0.7%
predicted effect, cross-fitted: 3.88pp (fit even -> odd 4.90pp on 570/1000 changed games; fit odd -> even 2.85pp on 652/1000)
in-sample (optimistic, for reference only): 4.78pp on 1328/2000 changed games
stage-3 decision: CONFIRM with 8000 games
TABLE_JSON {"1":50.78,"2":51.33,"4":53.55,"5":56.53,"6":54.3,"7":52.43,"8":53.23,"9":47.57,"10":42.29,"11":43.69,"12":41.84,"13":46.55}
```
