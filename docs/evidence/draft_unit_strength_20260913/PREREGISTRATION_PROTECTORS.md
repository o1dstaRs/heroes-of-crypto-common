# Arachna Queen and Angel protector release — preregistration

Written 2026-09-13 ~16:30, before any release game for these units was played.

## Motivation (exploratory, training panel 97100001 only)

The Abomination protector release passed on two seeds (+4.20pp, +5.35pp). Digest-verified replays of 240 training
games measured how often the backline-protector intent binds the other protector kinds and what they do:

- Arachna Queen (fitted -12.4pp): intent binds 57% of decisions; bound -> melee 21%, move 31%, wait 35%, defend
  12%; unbound -> melee 57%.
- Angel (fitted -9.5pp): intent binds 30%; bound -> melee 17%, spell 13%, wait 27%, defend 12%; unbound -> melee 51%.
- Abomination for scale: binds 87%; bound -> melee 15%; unbound -> melee 60%.

## Treatment

Research seam `V08_PROTECTOR_RELEASE_<LEFT|RIGHT>` = comma list of protector kinds (`angel`, `arachna_queen`,
`abomination`); listed kinds get no backline-protector intent for that seat. Treatment arm sets
`angel,arachna_queen` for the treated army. The Abomination seam stays off in both arms. Default off.

## Design (paired)

- Boards: ranked draft harness, seed 98100001, deployed draft genome under live draft rules in both seats, live
  setup, side board, deterministic a19, live map rotation. Boards scanned in index order (up to 4000); the first
  450 where exactly one army fields an Arachna Queen or an Angel are used; that army is treated.
- Each board: both battle mirrors, each game played twice (baseline, treatment). Nothing else differs.
- Primary metric: the treated army's decisive win rate, treatment minus baseline, over the game pairs; 95% interval
  by resampling boards (2000 resamples).

## Gates

1. PASS if the lower bound of the paired difference is > 0 and the treatment adds 0 engine rejections.
2. Per-unit (Queen-only boards vs Angel-only boards) and per-map differences are exploratory.
3. On PASS, the same design on fresh seed 98110001 must also have a positive point estimate before the release is
   proposed as a default. On FAIL, report it; no re-roll.
