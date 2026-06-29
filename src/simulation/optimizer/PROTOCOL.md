# v0.3 AI optimizer — one-cycle protocol (the cron/loop prompt)

Each cycle is a self-contained agent run. It reads state from files, makes **one** change, and lets
`cycle.mjs` measure + gate + commit/revert. Run this on the dedicated **`ai-optimizer`** branch only,
with the other agent paused (so **v0.2 stays frozen** — it is the benchmark and must never change).

## Hard rules
1. **Only edit `src/ai/versions/v0_3.ts`.** Never touch `v0_2.ts`, `v0_1.ts`, the engine, or tests.
2. **One selective change per cycle** — a single, well-reasoned idea, not a grab-bag.
3. The change must keep the AI **stable**: it may not cause any engine-rejected action. (`cycle.mjs`
   reverts on `> 0` rejected actions, no matter the win rate.)
4. Acceptance gate: a change is kept only if v0.3's decisive win rate vs v0.2 rises by **≥ 1.0 pp**
   over the current baseline **and** rejected actions stay **0**. Otherwise it is reverted.

## Steps
1. `cd` to the `ai-optimizer` worktree/branch.
2. Read `sim-out/optimizer/state.json` (current `baselinePct`) and `sim-out/optimizer/log.md`
   (what's already been tried — do **not** repeat a reverted idea).
3. Read the newest `sim-out/*.analysis.json` (or run `node src/simulation/optimizer/analyze.mjs <newest jsonl>`).
   It ranks **where v0.3 is weakest** by mirror-roster composition (ranged/flying/caster heavy, level),
   game length, end reason, and board side.
4. Pick the **weakest bucket** and form one hypothesis for a v0.3 code change that should help it —
   drawn from the tactical dimensions:
   - **Placement** (`placeArmy`): front/back rows, screening, flank/corner for snipers, flyer staging.
   - **Range advantage**: when our ranged out-guns theirs — hold/kite, don't feed melee; when out-gunned — close fast.
   - **Flying advantage**: coordinate flyers to hit the back line together; don't dive solo.
   - **Synergy / composition**: focus-fire, finish wounded stacks, avoid provoking counters, target the
     unit whose removal most weakens the enemy (casters/healers/snipers first).
   - **Late game**: commit to a decisive finish before armageddon (lap 12) — v0.3 is currently weakest in long games.
5. Implement the change in `v0_3.ts` (override a `StrategyV0_2` method or add a guarded branch in
   `decideTurn`/`placeArmy`). Keep it readable and commented.
6. Run the cycle gate (it does tsc + tests + a 10000-game tournament + the 1pp / 0-rejection gate +
   commit-or-revert + logging):
   ```
   node src/simulation/optimizer/cycle.mjs "<one-line change summary>" 10000 1.0
   ```
7. Read the printed decision + fresh analysis. Done — the next cron firing starts a new cycle.

## Success criteria (what "substantially better by morning" means)
- `state.json` `baselinePct` climbs well above the starting ~50.2%.
- Rejected actions remain **0** every accepted cycle (stable, never-stuck AI).
- `log.md` shows a trail of accepted/reverted changes with reasons.

## Measurement is now DETERMINISTIC (read this before tuning the gate)
Combat randomness is seeded in simulation (`battle_engine.runMatch` installs a deterministic source per
match via `setDeterministicRandomSource`; production stays crypto-secure). So at a **fixed concurrency**,
the same `(versions, baseSeed, games)` reproduces **exactly** — there is no run-to-run noise. Consequences:
- The gate can be **fast and sensitive**: `cycle.mjs` now defaults to **12000 games / +0.2pp** (was the
  noisy 30k / 0.6pp). A measured `+0.2pp` on the same fixed scenario set is a *real, repeatable* gain.
- **Guard against overfitting one seed set.** A change that helps `baseSeed=1` should be re-validated on a
  2nd seed (e.g. run the tournament with `baseSeed 2`) before you trust it as a general win. Big structural
  wins reproduce on any seed; marginal ones often don't.
- A tiny residual drift exists *across different concurrency levels* (per-worker engine state); always
  measure at the same concurrency (the default), and it's a non-issue.

## Lessons from the v0.2 -> v0.3 run (to make the v0.4 loop faster + better)
v0.3 reached **66.5%** vs v0.2 (+16.5pp) in 36 cycles via 3 wins. The leverage ranking we discovered:
1. **Decision-time MOVEMENT coordination is the top lever** — "army cohesion" (a detached melee straggler
   on a pure-move turn rejoins the all-ally centroid) alone was **+9.7pp**. Implemented in `v0_3.decideTurn`
   by post-processing v0.2's `GameAction[]` and using `pathHelper.getMovePath` for valid (0-rejection) moves.
   **Front-load this class of idea** instead of grinding micro-tweaks.
2. **Placement (`placeArmy`) is the second lever** — cornered ranged battery (+6.0) and a forward flyer wing
   (+1.0). Big, structural placement changes pay; micro-variants sit at the noise floor and don't stack.
3. **Targeting-weight tuning is a local optimum** — every range/melee/kill/finish weight reverted. Skip it.
4. **Core `findTarget` (in `src/ai/ai.ts`) is off-limits**, but you can do a lot by post-processing its
   output in the version subclass. That's where both big levers live.

### Starting the v0.4 loop
- Freeze **v0.3** as the new benchmark (it is the champion). Create `StrategyV0_4 extends StrategyV0_3` and
  optimise that; never edit v0.3 during the run. Update the registry default only when promoting.
- Re-baseline once (`cycle.mjs "init" 12000 0`) to record v0.4==v0.3 ≈ 50% before the first real change.
- New strategy code MUST have unit tests (see `test/ai/v0_3_strategy.test.ts` for the pattern) — keep the
  common package at its coverage bar.
