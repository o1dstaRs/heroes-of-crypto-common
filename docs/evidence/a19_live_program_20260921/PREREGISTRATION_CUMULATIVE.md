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
