# Deep search when it fits — adopted as A19 profile v23

Adopted on November 22, 2026 under the user's standing instruction, “always lock in wins and continue”, at the
think budget the owner approved on November 21: “4s is fine” (per AI move). Policy id `a19-deep-fit-v1`. Nothing
was deployed by the adoption.

## The rule

A bot seat's A19 search first runs the stock search, exactly as before: 2 complementary rollouts, shortlist 6,
max melee 10, a 1,000 ms deadline and a 1,500 ms breaker, with neural correction. Then:

1. If the stock search's rollout turns × (1 + 4.07) exceed **2,800**, the stock choice is played.
2. Otherwise the **deep search** runs: 8 rollouts per candidate, shortlist 10, max melee 16, the same 64-turn
   rollouts. It may simulate at most 2,800 minus the stock search's turns. Under live timing it also stops
   **4,000 ms** after the decision started.
3. The deep choice is played only when the deep search completed within that budget. Otherwise the stock choice is
   played.

Rollout turns are the deterministic work clock. 2,800 turns is about 4 s on the 2-vCPU game host (about 1.4 ms per
turn). `V08_A19_DEEP_FIT` and `createV08A19DeepFitSearchDriver` are in `src/simulation/v0_8_a19_deep_fit.ts`. The
per-decision limits are `SearchDriver.chooseDecisionWithinBudget`. The server gives this driver to bot seats only,
through `createBotSeatSearchDriver(..., { deepFit: true })`, and raises its circuit breaker to 6,000 ms. Premium
advice, the draft, setup and placement are unchanged.

## Why

Confirmation I measured the deep search on every decision at +6.57 points in the v20 mirror (95% +3.76 to +9.44),
registration sha256 `3a16878fa06cbaa2fb5600d7a97e9f53db7bd32ff565f6cb6dbea29be9bf3b5c`. It needs about four times
the search work, so it cannot fit the live 1 s deadline. Confirmation K ran the deep search when it fits 1,400
rollout turns, about 2 s, which covers about 55% of decisions. Registration sha256
`cf8653ce3dc1308908d2c60fc4a76c1a2423e5e4062d45fca05d15b95e85b9cf`. Its strength gate **failed** at +1.22 points
(97.5% −1.64 to +4.03) and stays recorded as failed. In development the gain needed about 85% coverage: 2,800 turns
gave +7.42 with 84% of decisions deep. The owner then approved about 4 s per move.

## Evidence

Registered before any game of its bank was played:
`docs/evidence/deep_fit_registration_20261121.json` (sha256 `aa99e261a3d7ee4f33fbe95d3cc349aa0651e01a1c1539b8e59f4a7084122616`). Results:
`docs/evidence/deep_fit_confirmation_20261122.json`. The bank is fresh: namespace `deep-fit-4s-20261121-v1`, 186
families, 1,674 tasks per population, audited against 855 ledgers before any bank file was written. The candidate
was the production driver on the entrant seat of the production tree: server `700527a`, common `fa886ab5`, plus
the port. The control was the matched stock search.

| Primary: mirror (both seats the v20 default) | Games | Difference | 95% interval    |
| -------------------------------------------- | ----: | ---------: | --------------- |
| **All**                                      | 1,674 |  **+5.35** | +2.72 to +8.06  |
| Mirror, Normal                               |   558 |      +4.84 | +0.63 to +9.05  |
| Mirror, Lava                                 |   558 |      +5.29 | +0.54 to +10.04 |
| Mirror, Block centre                         |   558 |      +5.91 | +1.52 to +10.30 |
| Owner-shaped opponent (guard), all tasks     | 1,674 |      +3.67 | +1.52 to +5.85  |

Deep choices were played in 82% of decisions in the mirror and 81% against the owner-shaped
army. CPU per game for both seats: mirror 7.8 → 19.9 s, owner-shaped
13.1 → 34.8 s.

| Gate                                                              | Result     |
| ----------------------------------------------------------------- | ---------- |
| G1 strength in the mirror: lower bound above zero                 | passed     |
| G2 no map of the mirror below −2                                  | passed     |
| G3 owner guard: difference over all owner tasks at least −2       | passed     |
| G4 candidate games with a quality error not above the control arm | **failed** |
| G5 thirty mirror candidate tasks reproduce on a second host       | passed     |

**G4 failed and stays recorded as failed.** Do not waive, re-run or relabel it. The candidate arms had
10 games with a quality error against 6. Every one was a refusal cause that profile v22 fixes: the
declined native melee strike (6 against 1 in the mirror, 3 against 4 against the owner-shaped army) and the
Frenzied Boar's route through a zone of control (1 in each mirror arm). The confirmation ran on the v20 base.

## What the estimate is and is not

- The estimate is against the v20 default in AI-drafted games, in deterministic work mode. Production adds deep fit
  on top of profiles v21 and v22. That combination was not measured as a whole, and the estimates do not add.
- It is not a win rate against people. It does not certify live latency. As registered, the live think time and the
  share of deep decisions are measured on the test host after the owner approves the deploy.
- The bank (namespace `deep-fit-4s-20261121-v1`) is consumed.
