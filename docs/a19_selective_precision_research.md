# Selective precision for A19 R2

Registered October 26, 2026. This is an isolated research arm, not a shipped policy.

## Locked candidate

Keep the current H64/complementary R2 controller, its six-action shortlist, ranked draft/setup,
material-tie arbitration, native stack supply, rolled synergies and tactical splits. After an ordinary
R2 scoring pass, refine only when its highest returned score is exactly 0.5 and at least two actions
share that maximum. Recompute the complete retained shortlist with eight independent samples using
the original reference seed bank. Do not reuse the complementary R2 prefix. The normal policy gates
and final arbitration consume the refined evidence. Every other root keeps its original R2 results.

The midpoint is an explicitly tested acquisition signal, not a calibrated probability or a confidence
interval. More samples do not establish more intelligent play without fresh complete-game outcomes.
This candidate does not change horizon, candidate enumeration, leaf weights, placement or setup.

`src/simulation/a19_selective_precision.ts` has no production registration, environment switch or
import-time patch. Its wrappers exist only during an explicit synchronous research call and restore
the original driver method on failure. The observe-only and forced-R8 modes are controls, not proposed
production policies.

## Engine and functional prerequisites

The frozen base is common `e1b56f87b9df56e8fa263405fec0d40c90058f0c` plus the independently owned,
validated shared-aura rollback repair. Snapshot module SHA-256:
`784e95bf78a4c47350f530b81901e11b12199b3649f6638212e690c75abd4fa6`.
The repair was subsequently published independently as common
`6cb91b96d9b1b87daf47b006fd3813abebfa5522`. This task does not relabel historical results as
repaired-engine results.

The repaired production sources match the separately admitted research actor. That actor's Linux
checkpoint/full-snapshot comparison completed 96 replays with 2,564 root witnesses and zero state,
reference-graph or trajectory mismatches. The selective-precision capsule passed 7,182 common tests,
TypeScript and the build's generated/JSON copy steps.

Before strength data, twelve observe-only full games exactly reproduced twelve plain R2 games.
Twelve forced-refinement games exactly reproduced twelve actual independent-R8 teacher games.
These 48 replays compare full turn/action, committed-event and final-result hashes across all three
live maps and the canonical draft-seat/battle-mirror cases. Eight focused predicate/rollback tests
passed locally and on Linux. A separate import-isolation regression protects ordinary play.

The first preflight request used an invalid four-game request capacity. Canonical normalization
rejected it before any match. The request capacity was corrected to eight while retaining the four
canonical game indices per board; the candidate, gates and reserved strength seeds were unchanged.
An initial exported-source build lacked Git provenance required by five unrelated audit tests.
Adding the original shallow Git identity, without changing source bytes, produced the passing build.

## Fresh complete-game gates

The frozen registration uses one candidate and disjoint seed channels, excluding 35,469 previously
recorded or reserved channels. Each independent offer/army board contains four canonical games.
The confidence unit is the whole board, stratified across Normal, Lava and Block; individual seats,
turns and rollout samples are not independent observations.

| Phase                 | Independent boards |               Games | Required result                                                                            |
| --------------------- | -----------------: | ------------------: | ------------------------------------------------------------------------------------------ |
| Functional smoke      |                  3 |                  12 | Legal complete games; excluded from strength estimates                                     |
| Screen                |                192 |                 768 | Score at least 52.5%, lower 95% board interval above 50%, refinement on at least 30 boards |
| Qualification         |              1,500 |               6,000 | Score at least 53%, lower interval above 50%, worst map at least 48%                       |
| Cost, two fresh banks |        24 per bank | 96 per arm per bank | Elapsed and process CPU ratios no greater than 1.25 in each bank, reversed arm order       |
| Confirmation          |              1,500 |               6,000 | Same strength gate as qualification, on untouched boards                                   |

Win/draw/loss scores are 1/0.5/0. The registered analysis uses 20,000 stratified whole-board bootstrap
resamples, seeds 2730269001, 2730269002 and 2730269003. An independent NumPy implementation reconstructs
the uint32 sampling stream, every outcome, every paired seat/map allocation and the complete sorted
bootstrap distribution. Any rejected or censored game fails the phase. A failed gate closes the candidate;
later phases cannot rescue it. There is no outcome-based threshold tuning or intermediate-score stopping.

Puffalo execution is CPU-only: at most six processes with four workers each, two GC markers and
Bun 1.4.4. The registered nice increment was 10; both the controller launch and worker commands added
that increment, giving effective Linux worker nice 19. No active process was reprioritized. The
controller stops its own workers if another simulation appears, a phase fails or its
eight-hour campaign budget expires. Raw completed games, failed attempts and source/tool fingerprints
remain outside Git in the `a19-selective-precision-20261026` research package.

Passing these research gates would still require live-path latency qualification and a published,
admitted repaired engine before any general-default change. No deployment is authorized by the study.

## Result: closed after the screen

The twelve-game smoke passed. The complete fresh screen produced **379 wins, 376 losses and 13 draws**
over **768 games from 192 independent offer boards**: **50.1953%** draw-aware score, with a whole-board
95% bootstrap interval of **48.5026–51.9531%**. The independent NumPy audit reproduced every outcome,
seat/map allocation, interval endpoint and the complete sorted bootstrap distribution hash.

The rule refined 611 of 17,195 searched roots (3.55%), spanning 136 boards. Normal scored 48.4375%,
Lava 51.1719% and Block 50.9766%; each map contributed 64 boards and 256 games. There were zero rejected
actions and zero censored games. The frozen source and tool fingerprints remained unchanged.

The screen took **577.39 seconds (9 minutes 37 seconds)** on Puffalo at six processes with four workers
each, consuming **13,773.57 process CPU seconds**. These are complete screen execution measurements,
not an A/B speed comparison or production latency qualification. The complete smoke/screen controller
ran for 10 minutes 47 seconds, including startup and analysis.

Both strength gates failed: score below 52.5% and lower confidence endpoint below 50%. The candidate is
closed. Qualification, timing and confirmation banks remain unopened; no threshold retuning, subgroup
promotion or additional replication batch rescues this rule. **General-default R2 stays unchanged.**
