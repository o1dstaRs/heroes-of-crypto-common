# Abomination protector release — preregistration

Written 2026-09-13 ~14:50, before any release game was played.

## Motivation (exploratory, training panel 97100001 only)

Replaying digest-verified training games showed v0.8/a19 plays Abomination passively: on NORMAL its army won 2 of
24 games, it spent 95% of its turns moving/waiting/defending, dealt 11 damage per game and died by lap ~4. The
backline-protector contract (v0_8_backline_protector.ts) keeps it inside Flesh Shield range of the most valuable
ranged/caster ally and treats melee that invites a response as hard risk; the a19 search only lifts that contract
in Abomination mirrors.

## Treatment

Research seam `V08_ABOMINATION_RELEASE_<LEFT|RIGHT>=1`: that seat's Abomination has no backline-protector intent,
so native v0.8 and the a19 search treat it as an ordinary melee unit. Placement is unchanged. Default off.

## Design (paired)

- Boards: ranked draft harness, seed 97900001, live draft rules both seats (deployed genome, no exploration), live
  setup policy, side board, deterministic a19 search, live map rotation. Boards are scanned in index order; the
  first 450 whose two armies contain exactly one Abomination are used.
- Each used board is played in both battle mirrors, and each game twice: baseline (no seam) and release (seam on
  for the Abomination army's team only). Nothing else differs between arms.
- Primary metric: the Abomination army's decisive win rate, release minus baseline, over the 900 game pairs.
  95% interval by resampling boards (2000 resamples).

## Gates

1. PASS if the lower bound of the paired difference is > 0 and 0 engine rejections were added by the release arm.
2. Per-map differences are reported; they are exploratory. A map-conditional release would need its own run.
3. On PASS, the same design on fresh seed 97910001 must also have a positive point estimate before the release is
   proposed as a default. On FAIL, report it; no re-roll.
