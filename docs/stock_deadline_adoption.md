# Stock search deadline 2,500 ms — adopted as A19 profile v30

Adopted on 2026-11-24 under the owner's standing instruction ("always lock in wins please"; "make sure we lock in wins as we
go"), for the owner's question of 2026-11-23: "There is no way we can optimize how much it can do in 4 seconds on this
specific instance?" Policy id `a19-stock-deadline-v1`; the driver is still `a19-deep-fit-v1`
(`src/simulation/v0_8_a19_deep_fit.ts`). The bot seat's stock search gets a live decision deadline of 2,500 ms and a
circuit breaker of 3,750 ms (`V08_A19_DEEP_FIT.stockBudget`) instead of the A19 profile's 1,000 / 1,500 ms. The deep
search, the deep-fit gate, the 4,000-turn budget, the 4,000 ms think deadline and Premium advice are unchanged. Offline
deterministic work has no clock, so no offline result changes.

## Why

The stock search's 1,000 ms deadline is older than the deep fit: it was set when the stock search was the whole think.
On the production host (Intel Skylake, 2 vCPU, about 0.48 rollout turns per ms on the capacity reference board) it cuts
the stock search on big boards. A per-move probe at production speed (499 moves) found 10% of moves played with no
completed search at all, after a mean 3.6 s: the cut stock search reported a truncated turn count, the deep-fit gate then
started a deep search that could not finish either, and the native move was played. 37% of all think time went into deep
searches that were thrown away. With `SEARCH_A19_ADAPTIVE_BUDGET=1`, a stock decision over its 1,500 ms breaker also
degraded the next three decisions to one rollout and a shortlist of two. In a real-time clash on the production CPU
itself, the production bot's stock search was cut on 13.6% of its decisions.

A 2,500 ms deadline lets the stock search finish (it then reports its real work, so the gate skips a deep search that
cannot fit), and the 3,750 ms breaker stops the degradation. The rollouts of the stock search cannot be reused by the deep
search: the stock search's two rollouts use complementary chance streams (`SEARCH_A19_COMPLEMENTARY_R2`).

Development (not registered; real-time clashes, every task in both seat orientations, time limits scaled to the production
host's speed): owner-shaped pool on the Mac, 804 games, 53.2% (95% 51.1 to 55.3) for the candidate head to head, stock
fallbacks 7.3% to 0.0%, mean think 2.02 to 1.88 s. A mirror-pool run on the shared x3d host measured 50.9% (49.2 to
52.5) but drifted to about twice its calibrated speed (the production bot's stock fallbacks 1.6% instead of 13.6%), so it
reads as a fast-host result, where the fix has little to remove.

## Evidence

Registered confirmation SD (`docs/evidence/stock_deadline_registration_20261124.json`, sha256
`0861b6ac1fa9f09ad5831b15ddcdf3103a9bb79f328fa7a8128a42ab8c20eef1`), registered before any of its games was played.
A real-time clash: both seats search with live timing in the same ranked game (tree prod28c: exact v28 production with
research seams, both arms at profile v29's 4,000 turns), the candidate in one seat and the production bot in the other.
Every time limit is divided by the host's time scale F, its rollout turns per ms on the capacity reference board over the
production host's 0.4756, so each arm gets the search work it would get on the production host. Every task is played in
both seat orientations. Host: basenode (Ryzen 9 3900X, no other workload), 20 processes, F 0.8364. Banks: fresh families
800-919 of namespace `decoy-path-20261123-v1`, never drafted or played before (360 tasks per population). Results:
`docs/evidence/stock_deadline_confirmation_20261124.json`.

Candidate score head to head against the production bot, seat-balanced (mean of its two orientation scores; win 1, draw
0.5, loss 0); 95% percentile interval from 20,000 bootstrap resamples of the 120 draft-root families.

| Population              |   Tasks |     Games | Candidate score | 95% interval       |
| ----------------------- | ------: | --------: | --------------: | ------------------ |
| **Pooled (primary)**    | **720** | **1,440** |      **53.12%** | **51.56 to 54.76** |
| Owner-shaped strikers   |     360 |       720 |          52.71% |                    |
| Mirror (the default AI) |     360 |       720 |          53.54% |                    |
| Map 1                   |     240 |       480 |          51.88% |                    |
| Map 3 (lava)            |     240 |       480 |          54.06% |                    |
| Map 4                   |     240 |       480 |          53.44% |                    |

At production speed the production bot played the native move on 6.1% of its decisions because the stock search hit its
1,000 ms deadline; the candidate on 0.0%. Deep searches played 76.0% and 76.4% of decisions. Mean think 2.42 s and 2.38 s
(production seconds); decisions over 4.5 s 8.02% and 7.69%, longest 14.4 s and 14.8 s (the WAIT comparisons, which have
no wall clock: a separate confirmation, WC, measures putting them under it). No game had a quality error.

All seven registered gates passed:

- SD1 strength: lower bound 51.56% above 50%.
- SD2 every population at least 49% (owner-shaped 52.71%, mirror 53.54%).
- SD3 every map at least 49% (lowest map 1, 51.88%).
- SD4 quality: 0 games with a quality error.
- SD5 latency: mean think 2.381 s against 2.419 s (+0.10 s allowed); over 4.5 s 7.69% against 8.02% (+1.0 point allowed).
- SD6 timing drift: the time scale recalibrated after the run was 0.8206 against 0.8364 (within 10%).
- SD7 production-speed fidelity: the production bot's stock-deadline fallbacks 6.11% (at least 5%; the real production CPU
  showed 13.6% on the mirror pool, so the production host has more for the fix to remove).

## What the estimate is and is not

- Head to head against the production bot, both playing AI-drafted armies; not a win rate against people.
- It is measured at the production host's speed by time scaling on another host; the production CPU itself was slower
  in every comparison (more stock cuts), so the fix should matter at least as much there.
- A faster host gains less: the faster the host, the fewer stock searches the 1,000 ms deadline cut.
