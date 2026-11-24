# Deep fit at 4,000 rollout turns — adopted as A19 profile v29

Adopted on 2026-11-23 under the owner's standing instruction ("always lock in wins please"; "make sure we lock in wins as we
go"). The owner approved about 4 s per AI move ("4s is fine", 2026-11-21) and, on 2026-11-23, ruled out a longer think on
the production host ("on the prod server we cant think longer really"). Policy id `a19-deep-fit-4000-v1`; the driver is
still `a19-deep-fit-v1` (`src/simulation/v0_8_a19_deep_fit.ts`), with the same deep search (8 rollouts, shortlist 10,
max melee 16), the same 4.07 prediction ratio and the same 4,000 ms think deadline.

## Why

Profile v23 sized the deep-fit budget at 2,800 rollout turns as "about 4 s on the 2-vCPU game host". Live, it uses less:
two owner games on the test host (AMD EPYC-Rome, 2 vCPU) took about 930 ms per decision at the median, about 2.1 s at the
90th percentile and at most 2.7 s; the production host (Intel Skylake, 2 vCPU) at most 3.3 s over 40 decisions. So
2,800 turns spend about two thirds of the approved 4 s. 4,000 turns fill it on the test host. The deadline still stops
any deep search a slower or busier host cannot finish, counted from the start of the decision, and the stock choice is
played, as it already is for an overrun: the live think time stays at most about 4 s.

A development budget curve on 1,206 v28 drafts (deterministic turn budgets, so the host does not matter; not registered)
measured production deep fit against stock +3.07 (95% +0.91 to +5.21) and 5,600 turns against 2,800 +2.40 (+0.17 to
+4.67): the decisions the 2,800-turn budget skips are the big early boards (stock work above 552 turns), and the gain
needs the full deep search there; a 4-rollout middle level inside 2,800 turns measured −0.33 (−2.32 to +1.67).

## Evidence

Registered confirmation U (`docs/evidence/deep_fit_4000_registration_20261123.json`, sha256
`6f7431f0fb0d533eb3c9604e331bdc891b338ff32655b2f8a03c9007a2568729`), registered before any bank row existed. Tree: exact v28
production (server 18928e9 + common d7ea9af8) with the research entrant seam; the entrant seat plays the production
bot-seat driver, the other seat the stock driver (as confirmation M); both seats keep the v28 setup. Banks: the unplayed
cfDP drafts of namespace `decoy-path-20261123-v1` (drafted for confirmation DP, which was never registered or played).
Results: `docs/evidence/deep_fit_4000_confirmation_20261123.json`.

Candidate minus control, entrant score in points per task (win 100, draw 50, loss 0); 95% percentile intervals from
20,000 bootstrap resamples of the draft-root families, drawn jointly across populations.

| Population                                |     Tasks | Families |  Estimate | 95% interval       |
| ----------------------------------------- | --------: | -------: | --------: | ------------------ |
| **Pooled (primary)**                      | **7,950** |  **800** | **+2.48** | **+1.67 to +3.28** |
| Mirror (the default AI drafts both seats) |     1,575 |      175 |     +3.81 | +1.49 to +6.13     |
| Owner-shaped rush opponent                |     1,575 |      175 |     +0.98 | −0.73 to +2.70     |
| Native shooter-army opponent              |     4,800 |      800 |     +2.53 | +1.64 to +3.43     |
| Map 1                                     |     3,450 |          |     +2.54 | +1.39 to +3.65     |
| Map 3 (lava)                              |     3,450 |          |     +2.33 | +1.15 to +3.53     |
| Map 4                                     |     1,050 |          |     +2.76 | +0.67 to +4.86     |

6,883 of the 7,950 games played differently; the candidate won 599 of them and lost 392 against the control. The deep
search was played on 94.1% of the entrant's decisions (control 78.5%). CPU per game rose by about a third (mirror 21.2 to
26.8 s, native B 100.3 to 138.0 s).

All five registered gates passed:

- U1 strength: lower bound of the pooled interval above zero (+1.67).
- U2 every population at least −2 points (lowest: owner-shaped rush, +0.98).
- U3 every map at least −2 points (lowest: map 3, +2.33).
- U4 quality: games with a quality error, candidate 0 and control 0.
- U5 second host: the 30 G5 candidate tasks replayed on basenode reproduce all 30 candidate digests.

## What the estimate is and is not

- Against AI-played armies in deterministic work mode; not a win rate against people.
- The estimate is for turn budgets; live, the host's speed decides how much of it arrives. The 4,000 ms deadline stops
  any deep search a host cannot finish and the stock choice is played, so a slow host gets only part of the gain. The
  production host is slow: about 0.48 rollout turns per ms on the search-capacity reference board (the test host about
  0.80), and in a real-time clash on its own CPU the production bot's deep search is cut on 30% of decisions. The exact
  search speedup of common 5bdc5fad (8.5% less CPU, decisions identical) narrows that gap only a little.
- The wait comparison has no wall clock (`SEARCH_WAIT_DEADLINE_POLICY=operation_bounded`), so a WAIT incumbent's deep
  search stops at the turn budget, not at 4,000 ms. On the production host such decisions (about 2–3% of moves) already
  took up to about 7 s at 2,800 turns; at 4,000 turns they can take up to about 9 s.
- The tournament tier study multiplies `V08_A19_DEEP_FIT.rolloutTurnBudget`; its tiers now scale from 4,000 turns.
