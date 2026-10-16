# Deep search for melee-flyer decisions only — preregistration

Written 2026-09-13, before any game of this experiment was played.

## Motivation (exploratory)

- Melee flyers are the largest group of weak fitted units (Black Dragon -10.4pp, Harpy -10.2, Griffin -8.0,
  Manticore -7.5, Thunderbird -7.4, Mantis -6.8, Wandering Mage -12.8). They die in 84-95% of games at lap ~3,
  killed by melee past the midline.
- Hand-written fixes for them did not help: forcing backline targets failed (-3.44pp); releasing the Queen/Angel
  guard rule, the Blacksmith Craft rule, the Healer rule and the Wandering Mage Smoke rule all failed.
- a19 is sample-starved: a deeper budget (SEARCH_ROLLOUTS 4, SEARCH_SHORTLIST 6, SEARCH_MAX_MELEE 10) beat stock
  v7 by +5.1pp per seat at deterministic work, at about 4x CPU per searched decision (owner decision pending).
- A flyer can reach far more cells than a ground unit, so its candidate set is widest and a fixed budget covers
  it worst. Hypothesis: the deep budget spent only on melee-flyer decisions recovers a real part of that gain for
  a fraction of the CPU.

## Arms

Research seam: `IMatchConfig.searchEnvOverrideUnitFilter` narrows the existing `searchEnvOverrideTeams` arm (a
second A19 driver with `V08_A19_SEARCH_ENV_OVERRIDES` merged in) to the units the filter accepts. Deep budget =
`{"SEARCH_ROLLOUTS":"4","SEARCH_SHORTLIST":"6","SEARCH_MAX_MELEE":"10"}`.

- **B (baseline):** stock a19 for both armies.
- **F (treatment):** the treated army's melee-flyer decisions use the deep budget; its other units and the
  opponent use stock a19. Melee flyer = a unit whose `canFly()` is true and whose attack type is MELEE.
- **A (reference):** every decision of the treated army uses the deep budget.

## Design (paired)

- Boards: ranked draft harness, seed 98500001, deployed draft genome under live draft rules in both seats, live
  setup, side board, deterministic a19, live map rotation. Boards scanned in index order (up to 4000); the first
  450 whose LEFT-drafted army fields at least one creature with `movement_type` FLY and `attack_type` MELEE in
  creatures.json are used; the LEFT-drafted army is treated (the opponent may also field flyers, untreated).
- Each board: both battle mirrors, each game played in all three arms. Nothing else differs.
- Primary metric: the treated army's decisive win rate, F minus B, over the game pairs; 95% interval by resampling
  boards (2000 resamples).

## Gates

1. PASS if the lower bound of F minus B is > 0 and F adds 0 engine rejections.
2. Reported, not gated: A minus B with its interval; the share of the treated army's searched decisions routed to
   the deep driver in F; the child process CPU seconds per game in each arm; per-map differences.
3. On PASS, the same F vs B design on fresh seed 98510001 must also have a positive point estimate before
   flyer-only deep search is proposed. Shipping it also needs a live-host latency probe (wall-clock deadline and
   fallback rate), which is outside this experiment. On FAIL, report it; no re-roll.

## Amendments before any game of seed 98500001

A 12-game smoke run on throwaway seed 11 (never used for analysis) found two problems, fixed before launch:

1. **Treatment was inert.** The draft harness copies the sealed a19 settings into the environment, and they include
   `V07_SEARCH=1`, so `shouldUseDefaultV08A19Search` is false and battle_engine never builds the override driver:
   all three arms played identical games. Fix: every arm runs with `V08_A19_SEARCH=1`, which builds both the stock
   and the override driver from the hermetic sealed profile. Check: the four seed-11 baseline games reproduced the
   unforced harness digests exactly (70122cf649, 0079a26d6d, bc8b2f6b1c, c781d80fe1), and the F and A arms then
   diverged from baseline.
2. **Melee flyer definition missed Harpy.** Harpy, Angel and Valkyrie have attack type MELEE_MAGIC, not MELEE, so
   the rule above excluded Harpy although the motivation names it. Melee flyer now means FLY movement with a MELEE
   or MELEE_MAGIC attack, both for board selection (creatures.json) and for routing (`canFly()` and
   `getAttackType()`). The set is Angel, Black Dragon, Efreet, Fairy, Griffin, Harpy, Imp, Magic Dragon,
   Manticore, Mantis, Pegasus, Phoenix, Thunderbird, Valkyrie, Wandering Mage, Wyvern.

Arms, seeds, metric and gates are unchanged.
