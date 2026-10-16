# Preregistration — re-fit the ranked unit-strength prior on current balance and current armies (P7, "v4")

Written 2026-09-23 ~05:40Z before any data was collected. Base: common 6f67b22 (= c3bdc78 + docs; r4 shipped).

## Why
The r4 draft scores creatures with the v1 prior, fitted 2026-09-13 on armies drafted by the old live policy (~1 shooter)
and on the balance of that day. Mining ~29,700 decisive r4 games (vs r3, v1-w12, r5; measured on d83dc34 balance):
- own shooters dominate (r4 wins 35.8% with 2, 47.5% with 3, 61.9% with 4);
- the prior's ratings disagree with r4's own results: Hydra (−16.2pp presence lift, drafted in 12% of r4 armies),
  Black Dragon (−18.9), Goblin Knight (−12.2) are liabilities it still takes; Wandering Mage, rated the worst level-1
  unit (−13), shows +9.5pp for r4 and −15.0pp against it — it gained Fireball on 2026-09-20, after the fit;
- balance moved since the fit (Goblin Knight ×3, Wandering Mage attack 1-3, Mantis, Smoke 3×3, Fireball, Fire Wall).
Presence lifts are confounded (a Hydra pick is a slot not spent on a shooter), which is exactly what a proper fit with
all creatures in one model controls for. Prior art to respect: the v3 on-policy refit (2026-09-14) correlated 0.91 with
v1 and LOST to a higher v1 weight; weight, not re-fitting, was the lever then. The environment has since changed far
more (armies went from ~1 to ~2.9 shooters, and balance moved), which is the case for trying again — and the reason
the comparison below holds weight and floor fixed so only the prior differs.

## Data (fixed now)
`collect_ranked_draft_strength_data.ts --policy ranked-unit-strength-a19-side-v1-w4-r4 --exploration 0.5`, both seats,
live draft rules, live setup v07-nonfight, side board, deterministic a19 — on common 6f67b22 (current balance).
8 shards × 500 boards (two games per board = 8,000 games), seeds 99800001 + 5000·k, k = 0..7 (pick-seed ranges
do not overlap). Shards are concatenated; nothing is filtered.

## Fit (fixed now)
`fit_ranked_draft_unit_strength.ts --id ranked-unit-strength-a19-side-v4 --lambda 4 --bootstrap 200 --commit 6f67b22`
(the v1 fit's settings). Registered as `…-v4-w4-r4` (v4 prior, weight 4, shooter floor 4 — r4's exact structure) and
`…-v4-w8-r4` (weight 8, floor 4).

## Evaluation (the draft protocol; incumbent = policy:ranked-unit-strength-a19-side-v1-w4-r4)
- Selection: v4-w4-r4 vs r4 (seed 99720001) and v4-w8-r4 vs r4 (seed 99730001), 2000 games each. Continue with the
  better draw-aware only if it exceeds 0.505.
- Confirmation: 8000 games, seed 99740001. Robustness: candidate and r4 vs pool `reference`, seed 99750001.
- Gates: the eight of verdict.py (draw-aware > 0.50, clustered LCB > 0.50, 0 rejections, worst map >= 0.49, robustness
  cells >= r4 − 2pp, distinct creatures >= 80% of r4, top share <= r4 + 10pp).
PASS -> propose v4 as the default. Seeds are never re-rolled.

## Also queued (not a gate of this proposal)
Replication of r4 vs r3 on current balance, 2000 games, seed 99760001: P4 was measured on d83dc34, before the
Goblin Knight / Wandering Mage / Fire Wall commits. Reported whatever it says.

## Data and fit (as preregistered)
Collected 2026-09-23 05:19–08:06Z on the shared node (8 shards × 500 boards, 4 workers each, Bun 1.3.14, common
6f67b22). Concatenated in shard order with offerBoard renumbered to 500·k + board so bootstrap clusters stay distinct
(each shard numbers its boards 0..499). 8,000 games, 4,000 boards × 2 mirrors, 3,956 W / 3,971 L / 73 D, 0 rejections,
0 duplicate (pickSeed, battleSeed, mirror); sha256 5a616526d30b3259b9953488afc711e4682f9140d9c17676ef1ec39af5927a3a.
Fit: 7,927 decisive games over 3,999 boards; conservative lifts correlate r = 0.750 with v1 (v3's was 0.91). Biggest
moves, all in the direction the mined r4 games pointed: Wandering Mage −11.4 → +10.4, Gargantuan +11.5 → +27.6, Medusa
+9.6 → +16.4, Cyclops +4.4 → +11.2, Tsar Cannon +11.3 → +16.9; Hydra +7.6 → −2.8, Nightmare −5.3 → −14.5, Black Dragon
−9.4 → −14.6, Arachna Queen −10.6 → −16.1, Crusader 0 → −5.3. Registered outside main (a copy of 6f67b22) for
measurement; committed to main only if it passes. Selection started 08:09:07Z.

## RESULT — selection v4-w8-r4 vs r4 (seed 99730001, 2000 games): decisive 63.51% [59.20, 67.61], draw-aware 63.40%,
LCB 59.20, 0 rejections; maps NORMAL 62.2 / LAVA 67.1 / BLOCK 61.2. Note: this arm changes the prior AND the weight
(4 -> 8); the v4-w4-r4 arm isolates the prior.

## RESULT — selection v4-w4-r4 vs r4 (seed 99720001, 2000 games): games 2000 W1078 L893 D29 | decisive 54.69% CI [50.31,59.00] | LCB 50.31 | draw-aware 54.62% | maps [(1, 49.4), (3, 55.3), (4, 59.5)] | rej 0.
The prior ALONE is worth ~+4.6pp at r4's weight (unlike v3); doubling its weight adds ~+9pp more. Selected v4-w8-r4
(0.6340 > 0.5463). Confirmation 99740001 + robustness 99750001 + r4-vs-r3 replication 99760001 started 09:34:05Z.
Execution note 09:45Z: four concurrent runs on the shared node (24 physical cores) put the confirmation at ~0.16
games/s. The two robustness cells and the r4-vs-r3 replication were stopped there (killed at <100 games; this harness
writes records only at the end, so nothing partial exists) and restarted on hft with the SAME seeds and an identical v4
tree — deterministic search makes the games identical wherever they run. Their log lines on the shared node read
exit=143. The confirmation (seed 99740001) continues alone on the shared node. No seed changed.
Execution note 10:09Z: the single-process confirmation ran at 0.29 games/s (8 workers on a 24-core node, ~7 h left at
517 games). It was stopped and restarted as 3 shards × 8 workers of the SAME task list (index % 3), merged by
ranked_draft_merge.ts, which re-sorts records canonically and summarises them with the harness's own
summarizeRankedDraftRecords. A 16-game identity check (seed 12340001) produced a byte-identical report and records
against a single CLI run. Same seed (99740001), same games, same gates.
Execution note 10:16Z: the shared node was 57% idle under 3 shards, so the confirmation was stopped once more (~7
minutes in; the shard files are written only at the end, so nothing partial existed) and restarted as 6 shards × 8
workers of the same task list (index % 6). Same seed, same games, same merge. Measured rate went from 0.55 to 0.88
games/s.

## Amendment 2026-09-23 10:53Z, before the confirmation or any robustness result is known
P6 shipped `conditional-v1` as the v0.8 setup (server 13bca49) after this preregistration was written, so every P7
cell above measures the drafts under the previous live setup (v07-nonfight). Added as a ship condition, not a gate
replacement: a stack check, v4-w8-r4 vs r4 with BOTH seats set up by `conditional-v1`, 2000 games, seed 99770001.
If its draw-aware point estimate is not above 0.50, v4 is not shipped until the difference is explained, even if the
eight gates pass. The eight gates themselves are unchanged.
Execution note 10:55Z: the stack check started at 10:54:00Z as one 3-worker process on hft, was stopped about a minute
in (no output written) and restarted at 10:55:12Z as 2 shards × 4 workers of the same task list, merged by
ranked_draft_merge.ts. Same seed, same games.

## RESULT — replication r4 vs r3 on current balance (seed 99760001, 2000 games, informational)
1193W 794L 13D; decisive 60.04% [55.69, 64.24], draw-aware 59.98%, clustered LCB 55.69, 0 rejections; maps NORMAL
59.0 / LAVA 60.8 / BLOCK 60.3. P4's r4-over-r3 result (57.09% on d83dc34 balance) holds on current balance.

## RESULT — confirmation v4-w8-r4 vs r4 (seed 99740001, 8000 games, merged from 6 shards)
4993W 2927L 80D; decisive 63.04% [60.90, 65.13], draw-aware 62.91%, clustered LCB 60.90, 0 rejections on either
seat; maps NORMAL 63.33 (LCB 59.61) / LAVA 62.10 (58.36) / BLOCK 63.70 (59.98). Gates 1-4 PASS. Diversity: 48 vs 50
distinct creatures (0.96 of r4's), top creature share 37.5% vs 37.2% (+0.3pp) — gates 6a/6b PASS. Gate 5 pending.

## RESULT — stack check (amendment; seed 99770001, 2000 games, both seats conditional-v1)
1220W 753L 27D; decisive 61.83% [57.50, 65.99], draw-aware 61.68%, clustered LCB 57.50, 0 rejections; maps NORMAL
60.9 / LAVA 60.8 / BLOCK 63.8. The ship condition (draw-aware > 0.50) holds: the v4 prior keeps its advantage under
the setup the v0.8 bot now uses.

## RESULT — robustness (seed 99750001, 2000 games per opponent)
v4-w8-r4: untrained heuristic ranged stack 63.58% [59.3, 67.7], round-3 exploiter 86.68% [83.4, 89.4]; r4: 52.20%
[47.8, 56.5] and 86.10% [82.8, 88.9]; 0 rejections. Gate 5 PASS (+11.37pp and +0.58pp). r4 had closed the live ranged
exploit to about even; v4 beats it.

## VERDICT (verdict.py over confirm_v4 + robust_v4_candidate + robust_v4_r4): PASS on all 8 gates; stack check PASS
→ v4-w8-r4 becomes the ranked draft default.
