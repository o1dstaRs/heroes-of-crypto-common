# WAIT comparisons under the clock — adopted as A19 profile v31

Adopted on 2026-11-24 at the owner's request ("Keep v29, confirm cap", 2026-11-24) under the standing instruction ("make
sure we lock in wins as we go"). Policy id `a19-wait-clock-v1`; the driver is still `a19-deep-fit-v1`
(`src/simulation/v0_8_a19_deep_fit.ts`). The bot seat's stock and deep searches both get `SEARCH_WAIT_DEADLINE_POLICY`
`profile` (`V08_A19_DEEP_FIT.waitBudget`) instead of the A19 profile's `operation_bounded`. A WAIT comparison now stops at
the same deadline as every other comparison: the stock search's 2,500 ms decision deadline, then the think time left for
the deep search. The deep-fit gate, the 4,000-turn budget, the 4,000 ms think deadline and Premium advice are unchanged.
Offline deterministic work has no clock, so no offline result changes.

## Why

The production A19 profile exempts aggressive WAIT comparisons from the wall clock
(`SEARCH_WAIT_DEADLINE_POLICY=operation_bounded`). When the incumbent move is a WAIT, the challengers' rollouts run until
the rollout-turn budget is spent, however long that takes. On a fast host that is harmless. On the production host (Intel
Skylake, 2 vCPU, about 0.48 rollout turns per ms on the capacity reference board) such moves run long, and profile v29's
4,000-turn budget made them longer. In confirmation SD's production arm (v29 at production speed, 37,085 decisions)
8.0% of decisions took over 4.5 s and the longest 14.4 s. In a 514-game real-time clash on the production CPU itself
(v29, 4 s against 10 s) the longest 4 s move took 25.6 s. The owner approved 4 s per move ("4s is fine"), and when asked
about the long moves chose to keep the current strength and confirm the cap ("Keep v29, confirm cap").

Development (not registered; Mac, owner-shaped pool, 804 games, both arms v29 with the 2,500 ms stock deadline): 48.9%
(95% 47.3 to 50.6) for the capped bot head to head. The production bot's moves over 4.5 s were 10.2% and 11.8% by seat
orientation, the longest 21.4 s; the capped bot's 0.02% and 0.00%, the longest 4.55 s. So the cap was expected to cost
about one point head to head, and the registered non-inferiority margin decides.

## Evidence

Registered confirmation WC (`docs/evidence/wait_clock_registration_20261124.json`, sha256
`2820fe568be7bda58822bca3ab62bb14233dd84d648a93b68e81a96feb98ec0e`), registered before any of its games was played. A
real-time clash as in confirmation SD (`docs/stock_deadline_adoption.md`): both seats search with live timing in the
same ranked game (tree prod28c, exact v28 production with research seams, both arms at 4,000 turns and the 2,500 ms
stock deadline of profile v30), the candidate in one seat and the production bot in the other. Every time limit is
divided by the host's time scale F, so each arm gets the search work it would get on the production host. Every task is
played in both seat orientations. Host: basenode (Ryzen 9 3900X, no other workload), 20 processes, F 0.8235. Banks:
fresh families 920-1099 of namespace `decoy-path-20261123-v1`, never drafted or played before (540 tasks per population).
Results: `docs/evidence/wait_clock_confirmation_20261124.json`.

Candidate score head to head against the production bot, seat-balanced (mean of its two orientation scores; win 1, draw
0.5, loss 0); 95% percentile interval from 20,000 bootstrap resamples of the 180 draft-root families.

| Population              |     Tasks |     Games | Candidate score | 95% interval       |
| ----------------------- | --------: | --------: | --------------: | ------------------ |
| **Pooled (primary)**    | **1,080** | **2,160** |      **49.05%** | **47.89 to 50.19** |
| Owner-shaped strikers   |       540 |     1,080 |          49.58% |                    |
| Mirror (the default AI) |       540 |     1,080 |          48.52% |                    |
| Map 1                   |       360 |       720 |          49.03% |                    |
| Map 3 (lava)            |       360 |       720 |          47.92% |                    |
| Map 4                   |       360 |       720 |          50.21% |                    |

Latency at production speed (production seconds, 55,407 and 55,498 decisions):

| Arm                    | Mean think | Over 4.5 s | Over 6 s | Longest | Deep played | Deep cut |
| ---------------------- | ---------: | ---------: | -------: | ------: | ----------: | -------: |
| Production bot (v30)   |     2.31 s |      7.22% |    2.69% | 11.00 s |       77.4% |    22.1% |
| Candidate (wait clock) |     2.18 s |      0.00% |    0.00% |  4.09 s |       73.7% |    25.9% |

No game had a quality error. All seven registered gates passed:

- WC1 non-inferiority: lower bound 47.89%, at least 47.5%.
- WC2 every population at least 47% (owner-shaped 49.58%, mirror 48.52%).
- WC3 every map at least 47% (lowest map 3, 47.92%).
- WC4 quality: 0 games with a quality error.
- WC5 latency: the candidate's decisions over 4.5 s 0.00% (at most 0.5%), its longest 4.09 s (at most 5.0 s).
- WC6 timing drift: the time scale recalibrated after the run was 0.8468 against 0.8235 (within 10%).
- WC7 production-speed fidelity: the production bot's decisions over 4.5 s 7.22% (at least 3%).

## What the estimate is and is not

- A non-inferiority result, not a strength gain: the capped bot scores 49.05% head to head, about one point below the
  production bot (95% 47.89 to 50.19). What it buys is the owner's 4 s per move: no move over 4.5 s at production speed,
  where the production bot took up to 11 s (and up to 25.6 s on the production CPU itself).
- The capped searches stop WAIT comparisons early: deep searches were cut on 25.9% of decisions against 22.1%.
- Head to head against the production bot, both playing AI-drafted armies; not a win rate against people.
- Measured at the production host's speed by time scaling on another host. A faster host loses less: the faster the
  host, the fewer WAIT comparisons reach the deadline.
