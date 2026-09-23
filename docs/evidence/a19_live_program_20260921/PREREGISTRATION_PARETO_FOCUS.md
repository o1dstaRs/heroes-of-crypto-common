# Preregistration — a19 Pareto No-Melee focus on mixed boards (SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS, any_board)

Written 2026-09-22 ~16:10Z before any deciding game. Base: common c3bdc78 (r4 is the ranked default).

## Why now
The arm is default-off and was built and measured on ALL-RANGED boards, when the ranked bot drafted ~1.0 natively
ranged creature. The shipped r4 draft now fields 2.88, so the distribution those measurements were taken under no
longer describes live play, and the `any_board` scope (mixed boards, exact Pareto, v0.8 selection) becomes reachable
on ordinary ranked boards for the first time.

## What it does
Before lap nine, an exact Through Shot or Large Calibre shooter may redirect a positive stationary shot onto a living
enemy No Melee stack (in practice the enemy Tsar Cannon) only when the redirect is Pareto-dominant: kill estimate,
total enemy damage and net damage may not drop and friendly fire may not rise. Every redirect still passes the real
engine probe. Risk is therefore bounded to target choice among otherwise equal-or-better shots.

## Design (the established paired harness, treated seat only)
`edge_child.ts` with `EDGE_DRAFT_POLICY=ranked-unit-strength-a19-side-v1-w4-r4`, per-seat
`V08_A19_SEARCH_ENV_OVERRIDES={"SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS":"1",
"SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_VERSIONS":"v0.8","SEARCH_PURE_RANGED_PARETO_NO_MELEE_FOCUS_SCOPE":"any_board"}`.
Paired seat-swapped boards, deterministic a19 both seats, side board, live maps, both armies drafted by r4.
- Cohort A `mirror`, 450 boards / 900 pairs, seed 99510001. PRIMARY.
- Cohort B `vsranged` (opponent = untrained-heuristic stack, the live exploit), 450 boards, seed 99520001.
Gates: (1) A delta CI low > 0 and point >= +1.0pp; (2) B point > -1.0pp; (3) 0 treated rejections in both;
(4) CPU ratio <= 1.20. PASS -> ship as a default a19 rule with the ledger re-pinned. Seeds never re-rolled.
A null here closes the "a19 plays the new ranged armies badly" hypothesis for this arm.

## WITHDRAWN before any deciding game (2026-09-22 16:20Z) — incidence too low to matter
Draft incidence measured first (1000 boards each, live rules, r4 drafts): the arm needs an exact Through Shot or
Large Calibre actor (Tsar Cannon / Cyclops) AND a living enemy No Melee stack (Tsar Cannon). Actor present on 37.2%
of mirror boards and 40.9% vs the heuristic; enemy target on 36.2% / 30.1%; **BOTH on only 6.4% / 5.7%** — and within
those the redirect must still be exactly Pareto-dominant on a positive stationary shot, which is rarer again. A
smoke board confirmed identical digests (arm did not fire). Even a +10pp in-cohort effect would be ~+0.6pp pooled,
below the +1pp advance bar, so the 900-pair battery was cancelled rather than run to a foregone null. This repeats
the 2026-07-16 gap-#5 lesson (area_throw: +15.4pp in-cohort, ~0% incidence, pooled ≈ 0): price incidence first.
