# Zig engine spike

A native port of a slice of the common battle engine and the v0.1 AI, built to measure how much faster AI research
could run on a native simulator. It is not wired into the package build, lint, tests or any shipped code.

## Scope

Zig plays whole battles that match the TypeScript `runMatch` step for step, for battles with:

- every creature's stats, sizes (1x1, 2x1, 2x2), walking and flying, melee and ranged;
- abilities and spells stripped, and no artifacts, augments, synergies or doctrines;
- the NORMAL grid, including board narrowing (holes, shoves, crushes) and the Armageddon waves;
- the v0.1 AI on both sides.

Ported:

- **Engine** (`engine.zig`, `combat.zig`): turn order and lap transitions, the morale and luck rolls, stack power and
  the stat refresh, move validation, melee with response, ranged line of fire with edge aiming, distance penalty,
  counter-shots and target switching, death cleanup.
- **Random stream** (`rng.zig`): `mulberry32` plus `getRandomInt` rejection sampling, bit for bit.
- **Path search** (`path.zig`): `PathHelper.getMovePath` as v0.1 uses it (the first-come FIFO walk, threat costs,
  diagonal sneak rules, the closest-move pass).
- **AI and match loop** (`ai.zig`): `StrategyV0_1.decideTurn`, `findTarget`, `doFindTarget`'s two passes, the melee
  target layers, target memory, the safer-move search, shooter line checks, and the `runMatchInner` loop for v0.1
  seats. The recovery net and `forceStalledLap` are not ported (never reached in the recordings or in a 2,000-battle
  probe of the TypeScript code); a battle
  that would need them stops with `unsupported` or `stuck`, which the parity check reports.

## How parity is checked

`parity/record.ts` runs real headless battles through `runMatch` and records every top-level engine call
(`GameActionEngine.apply` and `TurnEngine.advanceAfterNoActiveUnit`) and every AI decision (`decideTurn`). For each
it stores the random state before and after, the headless events, the decided actions, and a digest of every unit and
of the turn queues.

- `hoc-sim parity` replays each recorded engine call from its random state (engine only).
- `hoc-sim native` plays each battle in Zig from its start state with the Zig AI and checks every decision and engine
  call against the recording: the action, the random stream, accept/reject, the events and the digest.
- `hoc-sim paths` recomputes recorded `getMovePath` calls (record with `RECORD_PATHS=<file>`), comparing every route
  and weight.

```bash
# from the common package root
zig/parity/check.sh 200          # record 200 fresh battles (random seed), then run parity and native on them
cd zig && zig build test         # unit tests (random stream, JS number rounding)
```

Run `check.sh` after changing any rules or v0.1 AI code the port covers. Checked on 2026-11-25 against common
`19f3c39c` (300 battles, seeds 515000–515299, both modes), `b60b2ab6` and `a526c404`:

- engine replay: 3,805 battles identical (seeds 1–300, 1001–2000, 424242–424541, 777000–777199, 910000–911999);
- native play: 3,005 battles identical (seeds 1–5, 1001–2000, 910000–911999), plus seeds 1001–2000 again on the
  9800X3D against the profile v35 tree;
- 27,089 `getMovePath` calls identical (seeds 6000–6399).

## Benchmark

```bash
bun zig/parity/record.ts 1000 1001 zig/parity/out/bench1000.jsonl   # prints TypeScript engine and AI timings
cd zig && zig build -Drelease=true                                   # plain `zig build` is a debug build, ~10x slower
./zig-out/bin/hoc-sim bench parity/out/bench1000.jsonl --reps 20 --threads 1          # engine steps only
./zig-out/bin/hoc-sim native-bench parity/out/bench1000.jsonl --reps 5 --threads 1    # whole battles, AI + engine
```

For the 9800X3D: `zig build -Drelease=true -Dtarget=x86_64-linux-musl -Dcpu=znver5` (a static binary).

Results on 2026-11-25 for the same 1,000 battles (123,692 engine steps, 49,285 AI decisions). TypeScript is timed inside
the recorder, warmed up, and counts only the engine and AI calls, not the rest of `runMatch`. Both hosts were shared
with other jobs (M4 load average 40 to 110; 9800X3D at nice 10 beside eight nice-19 jobs), so absolute numbers are
pessimistic; each comparison ran back to back under the same load.

| | M4 Max | 9800X3D |
| --- | --- | --- |
| TypeScript engine step | 19.8 to 23.3 µs | 22.8 to 23.7 µs |
| TypeScript v0.1 decision | 90.6 µs | 92 to 94 µs |
| TypeScript battle (engine + AI) | 6.92 ms | 7.39 ms |
| Zig engine step, 1 thread | 0.66 to 1.05 µs | 0.55 to 0.65 µs |
| Zig battle (engine + AI), 1 thread | 298 to 327 µs | 336 to 408 µs |
| Zig battles per second, all cores | 24.5k (12 threads, before the layer bitmap) | 16.9k (8 threads), 19.5k (16) |

Engine steps run 22 to 43 times faster per core; whole battles run about 21 to 23 times faster on the M4 and 18 to 22
times on the 9800X3D. Both hosts produce the same results (identical run checksums). In these
battles the AI costs more than the engine (0.4 decisions per engine step, each about 4.5 engine steps' cost).

A battle state is a flat value of about 20 KB, so a search rollout's snapshot and restore is one copy.

Where Zig spends battle time (sampled, before the layer bitmap): `getMovePath` 31%, `doFindTarget` 14%, the melee
target layers 22%, the engine 20%. None of it is tuned beyond one bitmap for the layers.

## Not covered yet

- abilities, spells, auras, artifacts, augments, synergies, obstacles and other maps;
- move-then-strike melee (`melee_attack` with a path), wait and defend, which v0.1 never produces;
- the AI versions the research uses (v0.8 with the a19 search). The production rollout policy is the v0.8 chain, about
  67k lines of TypeScript.
