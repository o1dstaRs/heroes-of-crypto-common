# Valkyrie with the strikers — adopted as A19 profile v28

Adopted on 2026-11-23 under the owner's standing instruction ("always lock in wins please"; "make sure we lock in wins as we
go"), after the owner's arena game b02a58ce: "weird it puts valkyrie at the backline, and flying units usually should be in
the center to have equal change to catch any side". Policy id `a19-valkyrie-striker-v1`.

## Why

When a striker army rushes (Placement 2 + Movement 2), `a19StrikerRushFormation` moves the striker stacks to the front
column. Valkyrie casts Wind Flow, an amplifiable buff, so the striker test (`isA19DeliveryMelee`) leaves it out: in
b02a58ce its 27-creature stack kept its native back cell, 11 columns from the enemy front with 10.3 steps, and lost its
first turn. Valkyrie and Magic Dragon are the only melee flyers outside that test; Magic Dragon has ranged spell damage.

## What failed first

Registered confirmation P (`docs/evidence/flyer_centre_registration_20261122.json`) tested the owner's whole suggestion: Valkyrie with the strikers
and flying strikers in the middle rows. It failed its strength gate: against owner-shaped armies −0.49
points per task (95% −1.37 to +0.37). Inside P, armies with a Valkyrie gained (+6.94 on 108 tasks) and
the middle-rows ordering lost (−1.61 on 1710 tasks). P stays recorded as failed and is not adopted.

## The rule

`src/ai/setup/a19_valkyrie_striker.ts`: `isA19FormationStriker` marks the stacks the rush formation moves, a striker or a
melee flyer with no ranged attack and no ranged spell damage (only Valkyrie). The server's `strikerRushFormation` uses it
when the setup policy carries `valkyrieStrikerPolicy`; the formation itself and the rush eligibility are unchanged. Server
switch `HOC_A19_VALKYRIE_STRIKER` (on unless `off`; needs the striker rush).

## Evidence

Registered confirmation S (`docs/evidence/valkyrie_striker_registration_20261123.json`, sha256 `cb9274594d957678298c35f0569777cbb89a446068ade351e1efe4cdc98f3536`) on fresh families of the sealed namespace
`flyer-centre-20261122-v1` (800 and up). The rule changes only rush armies that field a Valkyrie, so the primary
populations draft the v27 default with a forced level-2 Valkyrie (RUSH_FORCE=2:Valkyrie); the natural drafts guard.
Differences are per can-change task. Results: `docs/evidence/valkyrie_striker_confirmation_20261123.json`.

| Population                                | Tasks | Families | Difference | W/L     | 95% interval    |
| ----------------------------------------- | ----: | -------: | ---------: | ------- | --------------- |
| Forced Valkyrie, owner-shaped (ownF)      |   750 |       84 |      +8.87 | 136/70  | +4.70 to +13.10 |
| Forced Valkyrie, shooter armies (nativeF) |  1356 |      152 |      +6.53 | 218/127 | +3.12 to +9.95  |
| Primary: ownF + nativeF                   |  2106 |      236 |      +7.36 | —/—     | +4.72 to +10.02 |
| Natural drafts, owner-shaped (own)        |   186 |       22 |      +3.49 | 27/20   | −1.67 to +9.14  |
| Natural drafts, shooter armies (native)   |   399 |       45 |      +1.00 | 37/34   | −4.76 to +6.36  |
| Guard: own + native                       |   585 |       67 |      +1.79 | —/—     | −2.48 to +5.90  |

Every registered gate passed: conditional strength (S1), natural guard (S2), quality (S3), parity (S4) and the second host
(S5). Both arms gave both seats v25's melee decoy rule, as production does.

## What the estimate is and is not

- Against AI-played armies in deterministic work mode; not a win rate against people.
- The gain applies only to rushing armies with a Valkyrie; across all games it scales with how often the default fields one.
