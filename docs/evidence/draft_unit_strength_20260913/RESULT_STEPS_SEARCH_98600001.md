# Deep search for high-mobility decisions (7+ steps) — primary result (seed 98600001)

Preregistration: `PREREGISTRATION_STEPS_SEARCH.md`. Frozen common eb62054, worktree `hoc-common-flyer-search-eval`,
both arms with `V08_A19_SEARCH=1`. 450 boards (first 450 of seed 98600001 whose LEFT-drafted army fields a creature
with base steps >= 7 and no AI Driven ability), both battle mirrors, each game played baseline and treatment: 1800
games, 900 pairs. Treatment: a decision of the treated army uses the deep budget (SEARCH_ROLLOUTS 4, SEARCH_SHORTLIST
6, SEARCH_MAX_MELEE 10) when the acting unit's live `getSteps()` is at least 7.

Operational note: workers append each finished game and restart every 40 games; 1800 unique rows, no duplicates.

| Slice  | Pairs | Baseline | Treatment | Delta [95% board bootstrap] | Outcomes changed |
| ------ | ----- | -------- | --------- | --------------------------- | ---------------- |
| All    | 900   | 50.00%   | 53.23%    | +3.23pp [+0.63, +5.84]      | 164              |
| NORMAL | 298   | 48.60%   | 55.17%    | +6.57pp [+2.10, +11.04]     | 63               |
| LAVA   | 308   | 53.14%   | 54.13%    | +0.99pp [-4.28, +6.44]      | 76               |
| BLOCK  | 294   | 48.08%   | 50.34%    | +2.26pp [-0.86, +5.44]      | 25               |

Metric: treated army decisive win rate. Engine rejections for the treated army: baseline 0, treatment 0.

Cost: decisions routed to the deep budget were 28.7% of the treated army's searched decisions (8,003 of 27,924).
Child process CPU per game: baseline 2.88 s, treatment 3.58 s (+24%).

**Gate 1: PASS** (lower bound +0.63pp > 0, 0 added rejections). As preregistered, the same design on fresh seed
98610001 must also have a positive point estimate before the steps rule is proposed; that run was launched right
after this result. Shipping would also need a live-host latency probe.

Context (not a head-to-head comparison, different boards): the melee-flyer rule on seed 98500001 gave +1.91pp
[-0.67, +4.39] for 25% of decisions deepened, and deep search on every decision gave +5.64pp [+2.27, +8.84]. The two
selective rules' intervals overlap; this result alone does not show the steps rule is better than the flyer rule.
