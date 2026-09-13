# Melee flyer backline priority — primary result (seed 98000001): FAIL

Preregistration: PREREGISTRATION_FLYER.md. Harness commit b4e7d3e. 450 live-drafted boards whose LEFT-drafted army
fields a melee flyer, both battle mirrors, baseline vs treatment: 1800 games, 900 pairs (304 played identically).

| | LEFT-drafted army decisive win rate |
|---|---|
| Baseline (search's choice) | 52.20% (463 W / 424 L) |
| Treatment (backline priority) | 48.76% (432 W / 454 L) |
| **Paired difference** | **-3.44pp, 95% board-bootstrap CI [-5.92, -1.07]** |

- Gate 1: lower bound > 0 — FAIL (the whole interval is below 0). Rejections: 0 in both arms.
- Per map (exploratory): NORMAL -4.1pp, LAVA -3.8pp, BLOCK -2.5pp. Per treated flyer: Black Dragon -5.5pp (304 pairs),
  Manticore -6.4pp (246), Griffin -6.8pp (236), Wyvern -4.3pp (176), Fairy -3.5pp (204), Efreet +0.3pp (136).
- Verdict: the seam stays off; no confirmation run; no re-roll. Forcing reachable backline strikes is worse than the
  search's front-line choices, so "flight not used" is not a simple misplay to override.
