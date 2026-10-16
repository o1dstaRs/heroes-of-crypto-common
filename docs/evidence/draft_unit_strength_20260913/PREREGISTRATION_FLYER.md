# Melee flyer backline priority — preregistration

Written 2026-09-13 ~16:10, before any treatment game was played.

## Motivation (exploratory, training panel 97100001 only)

Digest-verified replays: weak melee flyers (Black Dragon, Harpy, Griffin, Manticore, Efreet, Mantis, Thunderbird,
Angel, Valkyrie) die in 84-95% of games around lap 3, killed in melee, after striking the enemy front line (56% of
melee-flyer attacks hit ground melee, 11% shooters). At the decision level, a shooter/caster was a legal melee target
on 39.6% of melee-flyer decisions, yet the flyer hit the front line (35%) or waited (31%) on most of them.

## Treatment

Research seam `V08_FLYER_BACKLINE_PRIORITY_<LEFT|RIGHT>=1` (common, applied at the end of SearchDriver.chooseDecision,
the step both the simulator and the ranked server take): when a melee flyer of that seat can legally melee-attack an
enemy shooter or caster, it takes the best such attack (kill, then expected damage, then target output) instead of
the chosen decision. Decisions that already strike the backline or cast are kept. Default off; with it off the
self-play decision fingerprint is unchanged.

## Design (paired)

- Boards: ranked draft harness, seed 98000001, deployed draft genome under live draft rules in both seats, live
  setup policy, side board, deterministic a19, live map rotation. Boards scanned in index order; the first 450
  whose LEFT-drafted army fields at least one melee flyer (flies, melee, no ranged attack, not a caster) are used.
- Each board: both battle mirrors, each game played twice — baseline and treatment (seam on for the LEFT-drafted
  army's team only). Nothing else differs between arms.
- Primary metric: the LEFT-drafted army's decisive win rate, treatment minus baseline, over 900 game pairs; 95%
  interval by resampling boards (2000 resamples).

## Gates

1. PASS if the lower bound of the paired difference is > 0 and the treatment arm adds 0 engine rejections.
2. Per-map and per-flyer-creature differences are reported as exploratory.
3. On PASS, the same design on fresh seed 98010001 must also have a positive point estimate before the priority is
   proposed as a default. On FAIL, report it; no re-roll.
