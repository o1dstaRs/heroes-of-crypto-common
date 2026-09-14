# Deep search for high-mobility decisions (7+ steps) — confirmation (seed 98610001)

Preregistration: `PREREGISTRATION_STEPS_SEARCH.md`, gate 3 ("the same design on fresh seed 98610001 must also have a
positive point estimate before the steps rule is proposed"). Identical design, code and scripts to
`RESULT_STEPS_SEARCH_98600001.md`: 450 boards, both mirrors, baseline and treatment, 1800 games, 900 pairs, 1800
unique rows.

| Slice  | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| ------ | ----- | -------- | --------- | --------------------------- | ---------------- |
| All    | 900   | 52.88%   | 53.15%    | +0.27pp [-2.27, +2.88]      | 154              |
| NORMAL | 310   | 55.92%   | 54.93%    | -0.99pp [-5.69, +3.63]      | 63               |
| LAVA   | 278   | 50.73%   | 52.00%    | +1.27pp [-3.68, +6.12]      | 56               |
| BLOCK  | 312   | 51.79%   | 52.43%    | +0.64pp [-3.09, +4.42]      | 35               |

Engine rejections for the treated army: baseline 0, treatment 0. Deep decisions 31.2% of the treated army's searched
decisions (8,638 of 27,658); CPU per game 2.84 s baseline, 3.68 s treatment (+30%).

**Gate 3: met as written** (point estimate +0.27pp > 0).

Pooled over both seeds (1800 pairs, bootstrap over boards within each seed): **+1.74pp [-0.06, +3.67]**.

Reading: the primary run's +3.23pp was the optimistic draw; the pooled effect is about +1.7pp with an interval that
touches zero. That is close to what deepening ~30% of decisions would be expected to buy if the deep-search gain is
proportional to the decisions deepened (every decision: +5.64pp on seed 98500001; melee flyers, 25% of decisions:
+1.91pp). So the steps rule is a modest gain for roughly +25-30% CPU per game, not evidence that high-mobility
decisions benefit more than others. It is reported as meeting its preregistered bar, but it is not recommended as a
standalone ship; it belongs to the owner's pending think-time decision, alongside deep search on every decision, and
any ship needs a live-host latency probe first.
