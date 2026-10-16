# Deep search for high-mobility decisions (7+ steps) — preregistration

Written 2026-09-13 ~22:35, before any game of this experiment was played. Owner suggestion: "We can enable deeper
search from certain amount of steps mb 7+".

## Motivation

Same as `PREREGISTRATION_FLYER_SEARCH.md`: a19 is sample-starved, the deep budget (SEARCH_ROLLOUTS 4, SEARCH_SHORTLIST
6, SEARCH_MAX_MELEE 10) gains +5.1pp per seat at ~4x CPU per decision, and a unit that can move far has the widest
candidate set. A steps threshold is the production-friendly form of that idea: one live number at decision time,
which also covers future creatures and follows buffs and debuffs (`Unit.getSteps()` = base steps + steps_mod,
fractional).

Catalog creatures with base steps >= 7: Angel 8.8, Phoenix 8.5, Efreet 8.4, Fairy 8.0, Black Dragon 8.0,
Thunderbird 8.0, Mantis 7.7, Manticore 7.6, Pegasus 7.5, Wandering Mage 7.5, Valkyrie 7.3, Wyvern 7.2, Harpy 7.1,
Frenzied Boar 7.0 (AI Driven, never searched). Compared with the running melee-flyer rule it drops Griffin (3.5),
Magic Dragon (3.4) and Imp (6.0).

## Arms

Research seam `IMatchConfig.searchEnvOverrideUnitFilter` (common eb62054) with the deep budget
`{"SEARCH_ROLLOUTS":"4","SEARCH_SHORTLIST":"6","SEARCH_MAX_MELEE":"10"}`. Every arm runs with `V08_A19_SEARCH=1`
(see the amendment in `PREREGISTRATION_FLYER_SEARCH.md`; baseline digests are identical to the unforced harness).

- **B (baseline):** stock a19 for both armies.
- **S (treatment):** a decision of the treated army uses the deep budget when the acting unit's `getSteps()` is at
  least 7 at that moment; every other decision, and the opponent, uses stock a19.

## Design (paired)

- Boards: ranked draft harness, seed 98600001, deployed draft genome under live draft rules in both seats, live
  setup, side board, deterministic a19, live map rotation. Boards scanned in index order (up to 4000); the first
  450 whose LEFT-drafted army fields a creature with base `steps` >= 7 in creatures.json and without the "AI Driven"
  ability are used; the LEFT-drafted army is treated.
- Each board: both battle mirrors, each game played in both arms. Nothing else differs.
- Primary metric: the treated army's decisive win rate, S minus B, over the game pairs; 95% interval by resampling
  boards (2000 resamples).

## Gates

1. PASS if the lower bound of S minus B is > 0 and S adds 0 engine rejections.
2. Reported, not gated: share of the treated army's searched decisions routed to the deep driver; child process CPU
   seconds per game in each arm; per-map differences; the melee-flyer run's result for context (different boards,
   so not a head-to-head comparison).
3. On PASS, the same design on fresh seed 98610001 must also have a positive point estimate before the steps rule is
   proposed. Shipping also needs a live-host latency probe. On FAIL, report it; no re-roll and no threshold sweep.
