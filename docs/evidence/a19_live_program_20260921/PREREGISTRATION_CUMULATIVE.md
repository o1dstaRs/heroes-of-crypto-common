# Preregistration — the cumulative headline: what this program's shipped stack is worth (P13)

Written 2026-09-24 ~05:15Z before either cell ran. Owner's goal: at least +10 percentage points of win rate over
the a19 v0.8 strategy as it stood. No cell here changes any default; both are measurements of already-shipped work.

## Cells (ranked_draft_eval, live draft rules, side board, deterministic a19 both seats, live maps, 3000 games each)
1. `cumulative_now_vs_pre`, seed 99860001 — CANDIDATE = everything shipped by this program (v4-w8-r4 draft +
   conditional-v1 setup + SEE-NONE doctrine) against OPPONENT = the configuration that was live when the program
   started on 2026-09-21 (v1-w4 draft + frozen v07-nonfight setup + ranked-variety doctrine). This is the number
   the goal asks for.
2. `since_floor4`, seed 99870001 — the same candidate against the floor-4 draft with the OLD setup and doctrine,
   attributing everything that landed after the shooter floor.

## Reading it (fixed now)
The goal is met if cell 1's decisive win rate is at least 60% with a clustered lower bound above 60%, which is
+10pp over an even split. Rejections must be 0 on both seats. Cell 2 is attribution only and carries no bar.
Both cells run at concurrency 4 because a parallel agent's data collection owns that host; deterministic search
makes the result host- and load-independent, so contention costs wall time only.

## AMENDMENT 1 (2026-09-24 05:58Z, before either amended cell ran)
Two changes, both declared before any of their data existed.
1. Execution moves from puffalo to hft: puffalo is oversubscribed by a parallel agent's data collection and cell 1
   was pacing at 0.09 games/s (a nine-hour estimate). Deterministic search makes the result host-independent, so
   only wall time changes. Seeds are unchanged; the puffalo attempt is discarded without being read.
2. A third cell is added because the parallel agent's P11 confirmed the v4 prior at WEIGHT 16 over weight 8
   (54.60% decisive, clustered LCB 52.41, 8000 games), so the strongest known configuration is no longer the one
   cell 1 names. `cumulative_w16_vs_pre`, seed 99880001, 3000 games: v4-w16-r4 + conditional-v1 + SEE-NONE against
   the same pre-program opponent. Cell 1 stays exactly as preregistered so the shipped-today figure is reported on
   its original terms; cell 3 is labelled as the best-known configuration, which is not yet the ranked default.
The +10pp bar applies to cell 1 as written and is reported for cell 3 as well.

## AMENDMENT 2 (2026-09-24 06:05Z, before any cell produced a result)
Games per cell drop from 3000 to 1200. Reason is wall clock only: hft is pacing at 0.15 games/s while a parallel
agent's stacking check shares it, so 3000-game cells could not all finish before morning. No result has been read;
only the pacing line was. Power is still sufficient for the question asked: the expected effect is large (the old
draft loses heavily to every later one), and at a 75-85% win rate a 1200-game cell gives a 95% interval of roughly
±2.5pp, so a 60% bar with its lower bound above 60% remains decidable. Cell order is fixed now: the two cumulative
cells first, `since_floor4` last as attribution that may be cut short. The decision rule is unchanged.

## AMENDMENT 2 RETRACTED (2026-09-24 06:12Z) — it never took effect and is no longer needed
The restart that would have applied it died with a dropped connection before the edit landed, so the original
3000-game cells have been running throughout, unaltered, from 05:55:47Z. Pacing then improved to 0.26 games/s as
the parallel agent's stages retired, which puts both cumulative cells inside the morning window at full size, so
the reduction is withdrawn rather than re-applied. `since_floor4` may be cut short; it is attribution only and
carries no bar. Every cell therefore runs exactly as first preregistered, at 3000 games, on the amended host.

## RESULT — cell 1 `cumulative_now_vs_pre` (seed 99860001, 3000 games): GOAL MET, more than three times over
The stack this program shipped (v4-w8-r4 draft + conditional-v1 setup + SEE-NONE doctrine) against the configuration
that was live when it started (v1-w4 draft + frozen v07-nonfight setup + ranked-variety doctrine):

    2471W 489L 40D over 3000 games
    decisive 83.48%  CI [80.65, 85.97]  clustered LCB 80.65  draw-aware 83.03%
    grid NORMAL 82.37% (LCB 77.17) | LAVA 78.84% (73.36) | BLOCK 89.19% (84.73)
    0 rejected actions on either seat

That is **+33.48pp over an even split, with the 95% lower bound at +30.65pp** — the preregistered bar was 60% with a
lower bound above 60%, i.e. +10pp. Every live map clears it independently. Cell 3 (`cumulative_w16_vs_pre`, the
peer's confirmed weight-16 prior, not yet the default) follows, and `since_floor4` last.

## Execution incident, recorded for the reader (2026-09-24 09:09Z)
The pipeline parent was killed at ~06:00Z by my own aborted restart attempt (the one whose edit never landed). The
already-spawned cell-1 evaluator survived as an orphan, ran to completion and wrote its result — 3000 games with
2471+489+40 accounted for, so the cell is whole and is reported as such — but no DONE line was logged and cells 3 and
2 never started. They were relaunched at 09:09Z with the weight-16 cell first, since it is the decision-relevant one;
`since_floor4` follows and may not finish before morning. Seeds, candidates, opponents and the decision rule are
unchanged. No result was read before this relaunch other than cell 1, which was already final.

## RESULT — cell 3 `cumulative_w16_vs_pre` (seed 99880001, 3000 games): the best-known configuration
v4-**w16**-r4 + conditional-v1 + SEE-NONE against the same pre-program opponent:

    2521W 453L 26D over 3000 games
    decisive 84.77%  CI [82.02, 87.16]  clustered LCB 82.02  draw-aware 84.47%
    grid NORMAL 83.04% | LAVA 81.88% | BLOCK 89.42%
    0 rejected actions on either seat

+34.77pp over an even split, lower bound +32.02pp. Against cell 1's shipped stack (83.48%) the two intervals overlap
heavily, so this pair does NOT by itself establish w16 over w8 — the peer's own 8000-game head-to-head does that
(54.60%, LCB 52.41). Read cell 3 as: the goal is met on either configuration, and w16 is at least as good.
`since_floor4` started 11:45:57Z as the last, unbarred attribution cell.
