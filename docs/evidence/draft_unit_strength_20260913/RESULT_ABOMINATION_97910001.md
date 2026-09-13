# Abomination protector release — fresh-seed confirmation (seed 97910001)

Preregistration gate 3: the same paired design on a fresh seed must have a positive point estimate before the release
is proposed as a default. Harness commit 83f7ed7. 450 live-drafted boards with exactly one Abomination army, both
battle mirrors, baseline vs release: 1800 games, 900 pairs.

| | Abomination-army decisive win rate |
|---|---|
| Baseline (protector contract) | 38.67% (343 W / 544 L) |
| Release | 44.02% (394 W / 501 L) |
| **Paired difference** | **+5.35pp, 95% board-bootstrap CI [+2.15, +8.46]** |

- Gate 3: positive point estimate — PASS (the interval also excludes 0). Rejections: 0 in both arms.
- Per map (exploratory): NORMAL +11.5pp (320 pairs, 30.7% -> 42.1%), LAVA +2.3pp (296), BLOCK +1.8pp (284).
- Combined with the primary run (seed 97900001: +4.20pp [+0.97, +7.31]), the release is proposed as the v0.8
  default. Flipping it changes live fight behavior, so it waits for the owner's call.
