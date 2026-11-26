# Native rollouts in the search driver

`HOC_NATIVE_ROLLOUTS` lets `SearchDriver.scoreCandidates` play its rollout banks in libhocsim (the Zig engine and the
v0.8 policy port under `zig/`, ABI 3, `zig/BRIDGE.md`) instead of TypeScript. A native bank leaves the driver exactly as
the TypeScript loop leaves it, so searched decisions are identical; only the time changes. The switch is off by
default, and with it off nothing in the search changes (the TypeScript loop is the same code).

The adapter is `src/simulation/native_rollouts.ts` with its seam in `src/simulation/search_driver.ts`
(`scoreCandidatesWithNative`); the integration design is the coordinator's `design.md` (sections 2 to 7).

## Switches

| Variable                     | Meaning                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOC_NATIVE_ROLLOUTS`        | read when a driver is built: `0` (default) TypeScript only; `1` native banks where in scope; `shadow` TypeScript decides and sampled banks are replayed natively and compared |
| `HOC_SIM_LIB`                | the library (default `zig/zig-out/lib/libhocsim.{dylib,so}`)                                                                                                                  |
| `HOC_SIM_COMMON_SHA`         | the common commit the library must be built from (`-Dcommon-sha`); unset: not checked                                                                                         |
| `HOC_NATIVE_SHADOW_RATE`     | shadow sampling, a fraction of banks (default 1, every bank)                                                                                                                  |
| `HOC_NATIVE_SHADOW_DUMP_DIR` | shadow mismatches: the root's export and the bank's requests (20 per process at most), for `hoc-sim rollout-trace`                                                            |
| `HOC_NATIVE_FIXTURE_DIR`     | shadow mode writes the library's self-test fixture (`zig/src/selftest`) from the first root whose two H64 banks matched                                                       |
| `HOC_NATIVE_SENTINELS`       | `count` or `throw`: reads a native bank does not reproduce (a draw from the stream a TypeScript bank leaves installed, the active unit between banks)                         |

The library is loaded once per process on first use through `zig/ffi/bridge.ts`'s fail-safe loader (self-test included,
about 150 ms). A missing library, another ABI or commit, a failed self-test, or a runtime without Bun's
`import.meta.require` logs one line and every bank runs in TypeScript. An unexpected native error turns the backend off
for the rest of the process. Nothing imports the bridge or `bun:ffi` at module load, so browser bundles and `tsc` never
see it.

## When a bank is native

Per root (one `chooseSearchDecision`; refusals are counted by reason in `nativeRolloutStatistics.rootFallback`):

- both teams' rollout strategies are exactly `StrategyV0_8` (under any chain of the A19 placement layers, which only
  place) or exactly `StrategyV0_1`;
- the AI environment is the A19 profile's: every variable in the policy namespaces (`A19_`, `B2_`, `Q2_`, `V0n_`,
  `AI_AURA_ZONE_EXACT`) holds the profile's value or is unset where the profile unsets it, as the bot seat scopes it
  around each decision (the library implements the production values only; a research arm with a changed switch stays
  in TypeScript). The root-only flyer backline priority and the search routing variables are exempt;
- the library's scope manifest (`zig/ffi/precheck.ts`: creatures, cards, spells, artifacts, terrain) passes, and the
  export and the loader accept the board.

Per bank (counted in `fallback`): no rollout cache, opponent model, research or per-team leaf, team scope or observe-only
mode, a leaf the library plays (the A13 v2 weights, the v0.7 v1 weights, or material), a harness that tells how summons
are named (`ILookaheadDeps.nativeHarness`), and no veto: the A19 neural correction vetoes the banks of any decision it
would correct (`a19NeuralCorrectionEngages`), since it was measured on TypeScript rollouts.

A request the library refuses ("unsupported request") marks the root; a rollout it cannot play refuses that bank only;
either way the bank runs in TypeScript from the untouched state.

The harness also names the engine path the rollouts reproduce (`INativeHarness.engine`): runMatch's (`"match"`, the
default, which the request then leaves out) or the server's bot-seat deps (`"server"`, with summon ids
`"uuidSequence"`). Until a library lists `"server"` in `supportedEngines`, it refuses such a request, so those roots stay
in TypeScript; the bot seat's deps set the field when the server builds its native harness.

## What a native bank leaves

Rollout turns (an aborted rollout included) and the turn-budget throw, the deterministic uuid counter, `rolloutEnemyTeam`,
the A19 material evidence, and the means, replayed from the library's per-pair records with the TypeScript loop's
bookkeeping (the `-Infinity` break, tail bounds per candidate offline, the selection bounds and the best finished mean).
The leftover random stream and active unit of the last rollout are not reproduced; the sentinels count any read.

## Checking it

`bun scripts/native_rollouts_identity.ts <battles> <firstSeed> [keepRate] [out.jsonl]` plays production-like battles
(both seats on the bot seat's deep-fit search in the server's bot-search environment, offline deterministic work) once
per mode in `NATIVE_MODES` (default `0,1`) and compares every searched decision, its rollout turns, the winner and the
laps; `NATIVE_MODES=shadow` compares every bank rollout by rollout. `KEEP` picks the creatures that keep their cards
(presets `B13`, `B14`, `B15`, `B14C`, `B15C`, `ALL`, `NONE`), `LIVE=1` runs the live code path, `BUDGET_STRESS=1` cuts the
deep search's budget to a third.

Shadow mode with `HOC_NATIVE_FIXTURE_DIR` and `LIVE=1` regenerates the library's self-test fixture: on seed 24300000
(`KEEP=B13`, rate 0.4) it reproduces `zig/src/selftest/{state,requests,expected}.json` byte for byte.

## Verification (2026-11-26, M4 Max, offline deterministic work, sentinels throwing)

Library built from common 1e8a0f50 (ABI 3; src/v08 covers batches 1-5, the wave-1 casts and the live artifacts):

| Run (seeds)                       | Battles | Decisions identical, with their rollout turns | Banks native | Search time TS -> native |
| --------------------------------- | ------: | --------------------------------------------: | -----------: | -----------------------: |
| `B14C`, rate 0.5 (47500000)       |   8 / 8 |                                     318 / 318 |    855 / 855 |          82.7 s -> 5.3 s |
| `B15C`, rate 0.5 (47600000)       |   8 / 8 |                                     336 / 336 |    868 / 868 |          84.6 s -> 5.4 s |
| `B15C`, live code path (47800000) |   6 / 6 |                                     322 / 322 |    857 / 857 |         102.2 s -> 7.2 s |

Before that, on the ABI 3 prototype library (common 3538ee55): `B14C` 471 / 471 (145.8 s -> 8.4 s), the live path 299 /
299, the budget stress 284 / 284 with 77 turn-budget stops, and shadow mode 694 banks and 14,540 rollouts with no
mismatch. No sentinel fired in any run, and no root passed the pre-check and then failed to load.

Shadow mode on `B15C` (47700000, 722 banks, 16,084 rollouts) matched every bank but 37 of one battle (seed 47700003, an
Arachna Queen beside a Centaur's Boost Health): the engine's known stolen Boost Health health difference, which the
engine owner's batch-6b port fixes. Identity runs are the gate, and shadow mode is the coverage report.
