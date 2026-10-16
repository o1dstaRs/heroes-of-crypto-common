# Preregistration — augment plans for the caster-heavy armies the bot drafts now (P14)

Written 2026-09-24 ~09:30Z, before any P14 game. Base: common main plus the harness option
`--candidate-augments KIND:LEVEL[,…]` (the candidate's augment plan replaced after the draft; with it, each recorded
candidate army carries the plan it fought with and its setup policy's own).

## Why
- The v0.8 bot spends its 7 points Sniper 3 > Armor 3 > Might (conditional-v1's "sniper" rule), measured 2026-07-15
  on v0.7 armies holding one or two shooters and few casters. It never takes Empower (+7/15/24% to every source of
  magic damage).
- The v4-w16 draft builds around casters: 58.9% of its armies hold a magic-damage caster (Wandering Mage 29.5%, Battle
  Mage 25.3%, Magic Dragon 20.9%), and those casters are its biggest damage dealers under ranked stack sizing (Magic
  Dragon 219 spell damage per turn, Battle Mage 124, Wandering Mage's Fireball 469 per cast).

## Stage 1 — measurement (not a gate)
Five arms, each forcing one plan on the candidate: BASE Sniper 3 / Armor 3 / Might 1 (today's plan for these
armies), E1 Sniper 3 / Armor 3 / Empower 1, E2 Sniper 3 / Armor 2 / Empower 2, E3 Sniper 3 / Armor 1 / Empower 3,
E4 Sniper 2 / Armor 3 / Empower 2. Both seats draft v4-w16-r4, otherwise set up with `conditional-v1:sniper+t2a19`
and take SEE_NONE; live draft rules, side board, deterministic a19. 2000 games per arm, all arms on seed 99520001, so
they are paired game by game.

## Stage 2 — derivation (mechanical, p14_augment_table.ts)
Per cohort — armies with at least one magic-damage caster, and the rest — the arm with the best draw-aware score.
The rule's effect is predicted with even/odd-board cross-fitting against BASE, game by game. STOP if BASE is best in
both cohorts or the prediction is below +1.0pp; else confirm with 16,000 games below +2.5pp and 8,000 above.

## Stage 3 — confirmation (gated)
The derived plan as a named setup rule vs the live setup `conditional-v1:sniper+t2a19`, both seats v4-w16-r4 +
SEE_NONE, seed 99530001; robustness vs pool `reference`, 2000 games per opponent, seed 99550001. The eight gates.
PASS -> the v0.8 setup spec gains the rule; the previous spec is the rollback. Seeds are never re-rolled.

Prediction, written down so it can be wrong: swapping Might 1 for Empower 1 is a wash; in the caster cohort one of
the two-point Empower plans edges BASE by 1–2pp; the cross-fitted prediction lands under +1pp and P14 stops.

## RESULT — stage 1 (5 paired arms × 2000 games, seed 99520001) and stage 2 (p14_augment_table.ts) → STOP
Draw-aware score of each forced plan against the policy (BASE, a forced copy of the policy's plan, scored exactly
50.00% overall — the pairing check):
- magic-caster armies (1,196 games): BASE 50.63, E1 51.09, E2 44.48, E3 42.10, E4 41.35
- the rest (804 games): BASE 49.07, E1 47.33, E2 38.56, E3 35.07, E4 31.34
Rule from the data: Empower 1 for Might 1 in caster armies, the current plan otherwise; cross-fitted prediction
+0.28pp → STOP (below +1.0pp). Swapping the seventh point is a wash; every plan that pays for Empower out of Armor or
Sniper loses 6–18pp. Armor 3 and Sniper 3 stay essential on these armies, and the current plan holds. The prediction
was right about the wash and the stop and wrong about the two-point Empower plans, which are far worse, not better.
