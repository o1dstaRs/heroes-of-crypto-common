# Abomination protector release — primary result (seed 97900001)

Preregistration: PREREGISTRATION_ABOMINATION.md. Harness commit 83f7ed7. 450 live-drafted boards with exactly one
Abomination army, both battle mirrors, baseline vs release: 1800 games, 900 pairs.

| | Abomination-army decisive win rate |
|---|---|
| Baseline (protector contract) | 33.15% (295 W / 595 L) |
| Release | 37.35% (332 W / 557 L) |
| **Paired difference** | **+4.20pp, 95% board-bootstrap CI [+0.97, +7.31]** |

- Gate 1: lower bound > 0 — PASS. Engine rejections added by release: 0 (baseline 0, release 0) — PASS.
- Per map (exploratory): NORMAL +5.7pp (322 pairs, 26.2% -> 31.9%), LAVA +4.4pp (296, 38.6% -> 43.0%), BLOCK
  +2.2pp (282, 35.5% -> 37.6%).
- 97 of 900 pairs played identically (the protector intent never bound). Outcome flips: 122 loss->win, 89
  win->loss.
- Gate 3 (fresh seed 97910001, positive point estimate required before proposing a default): running.

Note: even released, a live-drafted Abomination army wins only ~37%; the release is a partial fix.
