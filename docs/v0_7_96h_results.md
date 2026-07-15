# v0.7 96-hour outcome: run d68490a

This is the historical result of the research-only run started at `2026-07-11T06:28:47Z`. It records
evidence; it does not authorize a bake, release, production configuration change, or deployment.

## Fixed-run terminal

The optimizer emitted its self-hashed terminal at `2026-07-15T06:18:49.473Z`, before the immutable
`2026-07-15T06:28:47.000Z` deadline. Its final status is `primary_incomplete_deadline`: the primary v0.6
panel closed as `not_evaluated_deadline`, the v0.4 transitivity panel was not opened, and the target gate is
false on observed cohorts, simultaneous certification, strict templates, integrity, and operations. The run
completed three generations with zero promotions.

- Raw terminal SHA-256: `8dd851a40930d5e1835646d4470535937a188c6e10e4c38e9cb03ff25e6665e7`
- Canonical terminal SHA-256: `e33647f3d1bb30f9c3246192f57f6bae6322f4027f6583eb324e26528db7da20`
- Frozen genome: `d8ab6a7d5fb8ed0eaef10ad919c1f12a5bd6e1bbdb43f7a09f9db72ff130344c`
- Gate decision: `bake=false`, `deploy=false`

## Bottom line

The frozen fight candidate did not meet the requested 90% target and is rejected. Its powered v0.6 final
panel did not complete before the fixed 96-hour deadline, and its completed checkpoints already contained an
irreversible sub-90 melee-magic utility result plus an irreversible fireline draw/Armageddon failure. No v0.4
transitivity final was opened.

A later, unfrozen candidate (`b9ce98a7…abaa`) is a useful research win: a clean-tree 2,048-game replay observed
all eight template point estimates above 90% and simultaneous cohort lower bounds above 90%. It is not a
release candidate. The replay reused a research panel, draw/Armageddon reached 85.16% in ranged precision,
and every game contained at least one search decision above the ranked server's 300ms circuit threshold.

The independent draft-policy lane did produce an accepted opt-in candidate. That draft PASS is preserved on
main, but it does not convert either fight result into a release PASS.

## Frozen candidate

- Genome: `d8ab6a7d5fb8ed0eaef10ad919c1f12a5bd6e1bbdb43f7a09f9db72ff130344c`
- Frozen revision: `d68490a4c1afbf10101baa746b8388cd031b8dca`
- Promotions: 0 across 3 completed generations
- Selection limiter: `melee_magic_utility` at 81.5631% decisive (95% low 79.1548%)
- Selection melee-mage cohort: 89.0799%; selection maximum draw/Armageddon: 90.00%
- Decision: rejected; no bake, release, or deployment

| Template              | Complete games | Decisive win | Best possible at 12k | Draw/Armageddon | Gate state                    |
| --------------------- | -------------: | -----------: | -------------------: | --------------: | ----------------------------- |
| `mage_frontline`      |         12,000 |      97.981% |              97.981% |          0.408% | complete                      |
| `mage_fireline`       |          5,800 |      99.116% |              99.587% |         72.897% | integrity impossible          |
| `melee_magic_utility` |          9,800 |      82.859% |              86.012% |          0.418% | 90% mathematically impossible |
| `melee_magic_brawler` |         12,000 |      97.097% |              97.097% |          0.117% | complete                      |
| `aura_support`        |          3,800 |      92.782% |              97.716% |          0.263% | partial                       |
| `aura_offense`        |          1,800 |      98.943% |              99.842% |          0.111% | partial                       |
| `ranged_precision`    |              0 |            - |             100.000% |               - | not started                   |
| `ranged_control`      |              0 |            - |             100.000% |               - | not started                   |

The checkpoint snapshot contains only complete, contiguous 200-game subshards. It is descriptive partial
evidence, not a substitute for the incomplete final or a target claim.

## Late research candidate

The exact normalized genome and replay seeds are stored in
`src/simulation/results/v0_7_96h_d68490a_outcome.json`. The replay ran on clean common revision `b909e52`,
with 256 games per template, paired side swaps, v0.6 as opponent, and concurrency 12.

| Cohort     | Equal-template decisive | Simultaneous lower bound |
| ---------- | ----------------------: | -----------------------: |
| Mage       |                 98.426% |                  97.065% |
| Melee Mage |                 95.294% |                  93.124% |
| Aura       |                 99.414% |                  98.571% |
| Ranged     |                 97.678% |                  95.965% |

| Template              | Decisive win |  95% low | Draw/Armageddon |
| --------------------- | -----------: | -------: | --------------: |
| `mage_frontline`      |      97.266% |  95.288% |          0.391% |
| `mage_fireline`       |      99.587% |  98.777% |         67.969% |
| `melee_magic_utility` |      90.588% |  87.183% |          0.391% |
| `melee_magic_brawler` |     100.000% | 100.000% |          0.000% |
| `aura_support`        |      99.219% |  98.140% |          0.000% |
| `aura_offense`        |      99.609% |  98.844% |          0.000% |
| `ranged_precision`    |      96.137% |  93.674% |         85.156% |
| `ranged_control`      |      99.219% |  98.140% |          1.953% |

Observed-90, strict-all-templates-90, and simultaneously-certified-cohorts-90 are all true on this research
replay. Release integrity is false: overall draw/Armageddon is 399/2,048 (19.482%), against a 1% ceiling.

Match-level search latency passed the research harness's 240-second budget (p95 18.434s, max 38.530s), but
that is not the live constraint. The turn audit measured searched-turn latency at p50 201.3ms, p95 927.3ms,
and max 5,472.7ms; 26,506/72,953 turns (36.33%) exceeded the server's 300ms circuit threshold, and all 2,048
games had at least one such turn. This is a Mac/concurrency diagnostic rather than production-host
certification, but it is sufficient to reject direct promotion without an exact live-profile replay.

## Independent draft win

The projected League round-3 candidate `br-52752642d16db7f4` is available through the explicit named spec
`league-r3-br-52752642`. A fresh 8,000-game v0.7 panel passed both preregistered draft gates:

- vs untrained heuristic: 64.1466% decisive, clustered low 61.1253% (required 55%)
- vs shipped default draft: 51.2639% decisive, clustered low 48.1670% (required 47%)

Its genome fingerprint is `92ee7737d5d31f4c1ef94299cb31180c3f9e3eb50eea5c1b80647eb12beff9eb`.
It is accepted for opt-in only. The default draft weights, production configuration, and deployment
authorization remain unchanged.

## Evidence ledger

- Exact terminal: raw SHA `8dd851a4…665e7`; canonical SHA `e33647f3…7da20`.
- Frozen selection: raw SHA `1eeccca4…8671`; report SHA `33244337…bde0`; audit SHA
  `472c3f78…4a87`.
- Deadline checkpoint snapshot: 226 contiguous 200-game shards, 45,200 games, 1,145,967 checkpoint bytes,
  and 22,432,013 audit bytes. The self-hashed index SHA is `bea653a9…d916`; each index entry retains the raw
  checkpoint, cell, and audit-fragment hashes.
- Seed ledger: committed manifest raw SHA `63440711…ff23`; all committed v0.7 manifests reserve 430,104
  unique paired-scenario seeds.
- Late discovery: artifact SHA `5783d50c…9481`; discovery audit SHA `cfe47faf…cbfb`.
- Clean late replay: report SHA `70c025ec…cf2a`; turn-audit SHA `e7feb2ba…4843`. The builder binds it to
  genome `b9ce98a7…abaa`, the committed `g3-deep` seeds, and clean stable main revision `b909e521…4bc4`.
- Draft opt-in: acceptance SHA `7c749194…3349`; projected genome fingerprint `92ee7737…f9eb`.
- Compact outcome: canonical SHA `65ac6642…25d7`.

The compact outcome is self-hashed and tested to have no seed-reservation or fight-candidate acceptance,
bake, release, or deployment authority. Raw multi-megabyte turn audit data is not committed; its exact
SHA-256 and the behavior-critical replay inputs are retained to reproduce the replay configuration and
compare a rerun.
