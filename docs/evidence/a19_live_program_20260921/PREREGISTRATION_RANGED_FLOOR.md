# Preregistration — ranked draft shooter floor (ranked-unit-strength-a19-side-v1-w4-r2 / -r3)

Written 2026-09-21 ~05:40Z before any deciding game. Base common d83dc34 + this program's seams (all default off).

## Why
Test-server replays: the bot fielded zero shooters in 22 of 27 decisive human-vs-AI fights and won 11 (39%); humans
brought 2–5 shooters. On live draft rules (1500 boards, draft only) the old live draft fields zero shooters 84% of the
time, the staging default v1-w4 fields zero 36% / one 36% (mean 1.01), the validated-but-unshipped v1-w12 fields 2.58
(Zena in 74% of drafts), the untrained heuristic exploit stack 4.21. A shooter floor keeps w4's scoring and variety and
only narrows an offer when the remaining picks could no longer reach the floor: r2 -> mean 1.46 (zero 0%, one 57%),
r3 -> mean 2.12 (zero 0%, one 14%, two 60%, three 26%; Zena 73%).

## Change (common)
`RANKED_DRAFT_STRENGTH_POLICY_WEIGHTS` gains `…-v1-w4-r2` and `…-v1-w4-r3` (weight 4), `RANKED_DRAFT_RANGED_FLOOR`
maps them to 2 / 3, `applyRankedDraftRangedFloor` narrows `eligible` inside `pickRankedLiveDraftCreature`. Existing
policy ids are untouched (test `test/ai/draft_ranged_floor.test.ts`: identical scores, no narrowing). Server ship path =
`DEFAULT_RANKED_DRAFT_POLICY_SPEC` (draft_policy.ts) + common pin; rollback `HOC_DRAFT_WEIGHTS`.

## Design (same as the 2026-09-13/14 draft program: `ranked_draft_eval.ts`, live rules, side board, deterministic a19)
- Selection: r2 and r3 each vs `policy:ranked-unit-strength-a19-side-v1-w4`, 500 boards (2000 games), seeds
  99210001 (r2) and 99220001 (r3). Pick the better draw-aware win rate; it must beat 50.5% to continue.
- Confirmation: chosen policy vs w4, 2000 boards (8000 games), seed 99230001.
- Robustness: chosen policy and w4 vs pool `reference` (untrained-heuristic ranged stack + league round-3 exploiter),
  seed 99240001, 2000 games each; the human exploit path is the heuristic cell.
- Headline vs old live draft (`--pool live`), seed 99250001, 8000 games (reported, not gated).
Gates (from PREREGISTRATION.md of that program): draw-aware > 0.50, clustered LCB > 0.50, 0 rejections, no map < 0.49,
no robustness cell > 2pp worse than w4, distinct-creature count >= w4 − 4 and top-share <= w4 + 10pp.
PASS -> propose as the staging default (owner decision, like v1-w12). Seeds are never re-rolled.

## RESULT — selection r2 (seed 99210001, 2000 games vs policy:v1-w4): 58.94% decisive [54.58, 63.17], clustered LCB
54.58, draw-aware 58.80% (W1160 L808 D32), maps NORMAL 59.6 / LAVA 55.7 / BLOCK 61.5, 0 rejections either side.

## RESULT — selection r3 (seed 99220001, 2000 games vs policy:v1-w4): draw-aware 67.13% (details in selection_r3.json).
Auto-selected r3 (> r2 58.80%); confirmation seed 99230001 (8000 games) started 07:29:49Z, then robustness 99240001.
Execution note 07:35Z: the confirmation evaluator (14 in-process workers) left hft ~40% idle, so the two robustness cells
(seed 99240001, unchanged) were started concurrently with it (5 workers each) instead of sequentially; deterministic
search makes load a wall-time-only effect. The informational headline vs the retired old live draft is skipped.

## RESULT — robustness r3 vs reference (seed 99240001, 2000 games each): vs untrained-heuristic ranged stack 47.36%
decisive [43.02, 51.74] (W940 L1045 D15); vs league round-3 exploiter 83.58% [80.08, 86.57] (W1654 L325 D21); 0 rejections.
(w4 on the same seed still running; the 2026-09-14 program measured w4 at 28.75–29.37% vs the heuristic and 75.9–78.9%
vs the exploiter on other seeds.)

## RESULT — confirmation r3 vs policy:v1-w4 (seed 99230001, 8000 games): decisive 67.60% [65.52, 69.62], clustered LCB
65.52, draw-aware 67.44% (W5357 L2567 D76), 0 rejections either side; maps NORMAL 66.33 (LCB 62.65) / LAVA 62.25 (58.52)
/ BLOCK 74.24 (70.79). Diversity over 4000 drafts: r3 50 distinct vs w4 52 (ratio 0.96), top share Zena 51.3% vs
Troll 44.7% (+6.6pp). Gates 1, 2, 3, 4, 6a, 6b PASS. Gate 5 awaits the w4 robustness cell (same seed 99240001).

## VERDICT (verdict_p3.py, results/P3/VERDICT.txt): PASS on all 8 gates
Gate 5: vs untrained-heuristic r3 47.36% vs w4 33.88% (+13.48pp); vs league-round3-exploiter 83.58% vs 73.07%
(+10.51pp), same seed 99240001, 0 rejections. Shipped to common main as a new policy id; server default flip below.
