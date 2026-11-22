# Decoy-aware targeting — adopted as A19 profile v25

Adopted on November 22, 2026 under the owner's standing instruction ("always lock in wins please"). Policy id
`a19-decoy-aware-v1`.

## Why

The owner beat `ai:v0.8:brutal` with a checkerboard wall of one-creature Fairy splits in front of a corner fort with two
shooters (game 9a1003ec on the 10 s arena, "won with this cool strat"). Zone of control stops an attacker at the first decoy it
touches, and the AI spent many strikes on those decoys while it could have hit a real stack: in development 8.8% of the
AI's melee strikes against the checkerboard fort were such avoidable decoy strikes.

## The rule

`src/ai/decoy_aware.ts`. A one-model decoy is a one-creature stack whose creature has a bigger living stack in its
army. The candidate generator drops every challenger that melee-strikes a decoy while another candidate strikes a real
stack (the native decision, candidate 0, always stays), and the server redirects a native decision that strikes a decoy
to the real-stack strike that hits the most cumulative HP (`decoyAwareIncumbent` in `src/ai/decoy_aware_redirect.ts`, inside a private random stream).
Per-seat switch `A19_DECOY_AWARE_<LEFT|RIGHT>`, on unless `0`.

## Evidence

Development (300 tasks each): checkerboard fort +8.17 (95% +3.00 to +13.17), avoidable decoy strikes 8.8% → 0.4% of
strikes; ring fort +0.83; mirror +1.50. Registered confirmation Y (`docs/evidence/decoy_aware_registration_20261122.json`,
sha256 `9e2d00ea2bfdd5b610d2f2cf54f661b58c2aa541c929d42bc6850e3f62f1f146`) on a fresh sealed bank (namespace `decoy-aware-b-20261122-v1`, 2,016 tasks audited against 984 ledgers,
0 intersections; every population spread over all 224 families). Results:
`docs/evidence/decoy_aware_confirmation_20261122.json`.

| Population                              | Tasks | Difference | 95% interval    |
| --------------------------------------- | ----: | ---------: | --------------- |
| **Owner's checkerboard fort (primary)** |   600 |  **+6.33** | +2.59 to +10.05 |
| Ring decoy fort (guard)                 |   300 |      +8.33 | +3.00 to +13.77 |
| AI mirror (guard)                       |   400 |      +1.62 | −1.13 to +4.43  |
| Owner-shaped armies (guard)             |   400 |      +0.75 | −0.99 to +2.54  |

Every gate passed: strength, the ring-fort, mirror and owner guards, quality and the second host.

## What the estimate is and is not

- Against AI-played forts and armies in deterministic work mode; not a win rate against people.
- The confirmation ran on the v22 base; with profiles v23 and v24 the combination was not measured as a whole.
