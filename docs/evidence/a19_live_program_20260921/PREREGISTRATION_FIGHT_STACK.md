# Preregistration — stack the small, precise fight-side gains (P21)

Written 2026-09-24 ~22:16Z, before any P20 result was read.

## Why
Tonight's draft and setup levers closed (P15, P17). What remains are fight-side effects of about one point each,
measured with the property that makes them precise: when both seats draft with one policy, a board's four games
cancel the armies, so a candidate-only change reads with a board-clustered interval of about ±0.8pp at 4000 games
(P18: 50.92% [50.11, 51.74]). Two such effects are already on the books below their proposals' bars: P18's refit
leaf (+0.92pp) and P15's NOSPLIT (+1.12pp [−0.05, +2.30], paired). Each bar was set for draft-sized effects; a
stack of them is its own proposal, measured fresh.

## Composition (a rule fixed now, applied to P20's paired results)
- Leaf: the best of LFULL, L30, L300 by paired effect over BASE, included if that effect is at least +0.5pp;
  otherwise the production leaf.
- Gate: G2 or G5, whichever is better, included if at least +0.5pp over BASE and its interval clears zero.
- LRF4 included if at least +0.5pp and its interval clears zero.
- NOSPLIT (the candidate skips the live split pass) included: +1.12pp paired in P15.
Nothing else. Components are applied together on the candidate seat only.

## Confirmation (the eight gates of verdict.py)
Candidate = the live stack with the composed fight settings; opponent = the live stack. `ranked_draft_eval`, live
draft rules, side board, deterministic a19, live synergy variants + split pass, 8000 games, seed 99360001 (its 6000
seed preimages end at 99366001, clear of 99350001's run below it and 99410001 above).
Robustness vs pool `reference` on the shared seed 99480001. PASS -> each component ships as a default: the leaf in
V08_A19's sealed environment, a gate change in V08_A19_SEARCH, LRF4 in V08_A19_SEARCH_RULES, and "a19 seats do not
split" in the server's AI split pass; each keeps its previous value as the rollback.

## Reporting
The confirmation doubles as P19's overnight stack check (PREREGISTRATION_OVERNIGHT_STACK.md): the owner's goal of
+10pp is read off it, with its interval, whatever it says.

Prediction, written down so it can be wrong: the stack lands at +2 to +3pp (52-53%), passes, and falls far short of
+10pp.

## Composition by the rule (2026-09-25 00:42Z, from P20's complete screen)
Leaf: L30 (+1.80pp, the best of LFULL/L30/L300, >= +0.5) — IN. Gate: G2 +0.27pp < +0.5 — OUT. LRF4 -0.22pp — OUT.
NOSPLIT — IN. Candidate = the live stack + the L30 leaf on its search + no split pass on its seat.
Launched 2026-09-25 00:42Z (tree common 5722eb5): P21 confirmation (seed 99360001, 8000 games, 32 shards) and its
robustness cell, alongside P20's own confirmation of L30 alone (seed 99820001) and its robustness cell; the shared
incumbent cell on 99480001 is finishing on both nodes.

## VERDICT (2026-09-25 03:12Z; verdict.py over results/verdict_P21) — FAIL on gate 2
Confirmation, seed 99360001, 8000 games: 4060W 3835L 105D, decisive 51.42%, draw-aware **51.41%**, harness clustered
95% [49.23, 53.61]; maps NORMAL 51.18 / LAVA 51.54 / BLOCK 51.56; 0 rejections. Robustness on 99480001: vs the
untrained heuristic +0.42pp, vs the round-3 exploiter −0.60pp over the incumbent (both within the −2pp bound).
Diversity identical (48 vs 48 distinct; top share 37.7% both — the drafts do not change).
Gates 1, 3, 4, 5, 6a, 6b PASS; **gate 2 (clustered LCB > 0.50) FAILS at 0.4923** → nothing ships.
Why the gap between this interval and the tight paired ones: the harness bound takes the lower of a cluster-robust
normal interval and a Wilson interval that counts each 4-game board as ONE observation (n = 2000). For a fight-side
change the Wilson term dominates (±2.19pp at 8000 games) even though the board means are far less noisy (the
board-mean interval here is [50.67, 52.14]); passing it at a +1.4pp effect would take ~49,000 games. The gate was
set for draft-sized effects and is kept as written.
P19's overnight stack check reads off this confirmation: **+1.41pp** over the live v0.8 a19 — the owner's +10pp goal
is not met.
