# Preregistration — re-measure the ranked augment spend for the new 3-shooter armies

Written 2026-09-23 ~00:20Z before any deciding game. Base: common c3bdc78 (r4 is the ranked default) plus the
research spec below. Target set by the owner: a change worth about +5pp over the current strategy.

## Why
The live ranked setup policy is a frozen v0.7 artifact whose augment head was fitted when ranked armies held ~0.2
natively ranged creatures. r4 now drafts 2.88. On r4 armies that frozen head spends **Armor 2 / Might 2 / Sniper 3**
on 84% of armies (Armor 3 / Might 1 / Sniper 3 on the other 16%), while the conditional rule shipped in the same
file spends Armor 3 / Might 1 / Sniper 3 on 100% of them — the two disagree by one point, and the 2026-07 evidence
recorded in setup_conditional.ts says Armor must be the second pick (Sniper3/Might3/Armor1 lost to Sniper3/Armor3/
Might1 by 21.7 to 78.3). Augments are army-wide multipliers, so one misplaced point is paid in every ranked game.
Nothing else in the setup policy has been re-measured since the composition moved either: the AI never buys the
Placement zone while humans bought it in 14 of 27 live fights.

## Change (common, research-only)
`v07-nonfight-aug:P-A-M-S-V` resolves to the frozen v0.7 non-fight policy with ONLY `augmentsByCohort` replaced by
that plan for every cohort; Tier-2, synergy, placement ("legitimate-reveal") and timing heads stay byte-identical.
The plan must spend exactly the optimized budget of 7. Verified: `aug:0-2-2-3-0` reproduces the live plan exactly
(the identity control) and `aug:0-3-1-3-0` differs only in the Armor/Might point. Nothing in production resolves
the prefix.

## Design
`ranked_draft_eval`, both sides drafting r4, live draft rules, side board, deterministic a19, live maps; the
candidate seat gets the override spec and the opponent seat keeps `v07-nonfight-4eda84635fe7`, so the ONLY
difference between the seats is the augment spend.
- Control (harness integrity): `aug:0-2-2-3-0` vs the live spec, 1000 games, seed 99700001. Must read ~50%.
- Screen, 2000 games each, all Sniper 3 retained (its ≥2-shooter evidence is not in question):
  A `aug:0-3-1-3-0` Armor 3 / Might 1 — the conditional rule's own answer — seed 99710001
  B `aug:1-2-1-3-0` buy Placement 1, keep Armor 2 — seed 99720001
  C `aug:0-2-1-3-1` Armor 2 / Might 1 / Movement 1 — seed 99730001
  D `aug:1-3-0-3-0` Placement 1 / Armor 3 / no Might — seed 99740001
- Confirmation: the best screen cell, 8000 games, seed 99750001, plus a robustness cell vs pool `reference`
  (seed 99760001, 2000 games) against the live spec's own reference numbers.
Gates: (1) confirmation draw-aware > 0.50 AND clustered LCB > 0.50; (2) no live map below 0.49; (3) 0 rejections;
(4) robustness cells no more than 2pp below the live spec's. A screen cell below 52% is not promoted. Seeds are
never re-rolled, and the control is reported whatever it says.

## WITHDRAWN before any deciding game (2026-09-23 16:55Z) — SUPERSEDED by a parallel agent's P6
A peer agent working the same program on the same node had already measured the whole `conditional-v1` setup policy
against the live frozen `v07-nonfight` setup on r4 armies: 8000 games, 55.58% decisive [53.39, 57.74], all gates
pass, shipped scoped to v0.8 seats (common 59a1de0, `docs/evidence/a19_live_program_20260921/`). conditional-v1
CONTAINS the Armor3/Might1/Sniper3 spend this preregistration set out to isolate, so cells A-D would have re-measured
a shipped change. My four cells never ran: the pipeline was politely waiting for the node's evaluators to drain and
was stopped once the collision was found. The `v07-nonfight-aug:P-A-M-S-V` research spec is kept (uncommitted, in
`~/Workplace/hoc-common-p3-ship`) because it isolates the augment head alone, which conditional-v1 does not — if the
augment point is ever to be attributed separately from placement/T2/synergy, that spec is the instrument.
Lesson recorded: on a shared node, read the other agents' committed evidence BEFORE preregistering a lever.
