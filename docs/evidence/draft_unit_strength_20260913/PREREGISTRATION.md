# Draft unit-strength prior — preregistration

Written 2026-09-13 before any training data was read. Owner ask: refit the draft's unit ratings from battle
results, "but we need to measurably understand it is better".

## Question

Does adding a battle-fitted per-creature strength term to the live ranked draft make the live bot win more
against today's live draft, without losing robustness?

## Fixed measurement conditions (all runs)

- Harness: common `src/simulation/ranked_draft_eval.ts` at or after `b793e89`.
- Draft rules: `liveDraftRules` (server faction-diversity tax), live pick reducer, random live auto-bans.
- Fight: a19 v0.8 both seats, `sideBoard`, `deterministicSearch`, live maps NORMAL / LAVA_CENTER / BLOCK_CENTER.
- Setup policy both seats: `v07-nonfight-4eda84635fe7` (server DEFAULT_RANKED_SETUP_POLICY_SPEC).
- Incumbent: `ranked-live-incumbent` = `ranked-versatile-a19-v3` (round-1 weights + interaction prior + variety).
- Offer boards of 4 games (both pick seats x both battle mirrors), board-clustered 95% intervals.

## Seeds (one use each)

| Stage | Seed | Size |
|---|---|---|
| Training data (exploration 0.5, both seats live policy) | 97100001 | 4000 boards, 8000 unique games |
| Weight selection | 97200001 | 500 boards (2000 games) per weight |
| Confirmation (selected weight only, run once) | 97300001 | 2000 boards (8000 games) |
| Robustness panel | 97400001 | 500 boards per reference, candidate and incumbent each |

Seed 97000001 was burned by a 48-game smoke run.

## Fit

Ridge logistic regression on decisive training games: outcome = candidate-seat win; features = per-creature
presence difference (own minus opponent) plus a battle-side term. Board-bootstrap intervals. Lift in pp at
p = 0.5. The prior uses the ridge point shrunk toward 0 by one bootstrap standard error.

## Candidate family

Live incumbent plus `strength affinity = w x conservative lift` added through the same post-score overlay channel
the interaction prior uses, for creature picks and bundle creature terms. Selection grid w in {1, 2, 4}; pick the
highest draw-aware score vs the incumbent on the selection seed (tie within 0.5pp -> smaller w).

## Gates (confirmation seed, selected weight, vs live incumbent)

1. Draw-aware head-to-head score > 0.50.
2. Board-clustered 95% lower bound of the decisive win rate > 0.50.
3. Candidate engine rejections = 0.
4. No live map with decisive win rate below 0.49.
5. Robustness: against `untrained-heuristic` and `league-round3-exploiter`, candidate decisive win rate >=
   incumbent's minus 2pp on identical seeds.
6. Diversity guard: distinct creatures drafted by the candidate >= 80% of the incumbent's over the confirmation
   drafts; the most-drafted creature's share <= incumbent's + 10pp.

## Deviations log

- 2026-09-13, after training data finished and BEFORE any fit was run on it: the LEFT drafting seat (which picks
  first) won 4158 of 7885 decisive training games (52.7%). The fit gains an unpenalized drafting-seat intercept
  next to the battle-side term so that first-pick edge cannot leak into creature effects. Nothing else changes.

All six pass -> recommend shipping behind HOC_DRAFT_WEIGHTS. Any fail -> report it as a fail; no re-roll of the
confirmation seed.
