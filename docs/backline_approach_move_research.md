# Backliner approach movement — November 15, 2026

This is a distinct, inactive combat candidate following the closed guarded draft/free-forward study.
It does not change drafting, spending, placement, support splits, default version or Premium data.
The reference is locked V3 plus adopted contextual draft `063a888e`, public-ranked setup/ranged selector
`d786f4e9`, native placement/support, and v0.8/A19 H64/R2/K6 combat.

## Read-only discovery

The `ranged-combat-catalog-audit-20261115` capsule froze common `dd8aff092c926089edad6508d12705c5fcc271cd`
and server `d98f259caf4e2a4b663fb67c94020c83b06a8b65`. Registration
`cf239932e35cb8ff0118677fbb42ee3733b467ff4f7616d5f49b8ff3fc99965e` selected 18 reused cases by board index,
without looking at results. All 36 off/observer fights matched complete inputs and action/event traces.
All 5,155 sealed files were rechecked.

Across 187 eligible move-enumeration observations, 122 omitted a legal move nearer some visible backliner.
Sixty-one observations on 15 cases had a move at least one cell nearer the **nearest** such enemy before
lap seven than every ordinary retained move and pure-move incumbent. These are enumeration observations,
not necessarily unique decisions. Footprint Euclidean distance is a diagnostic proxy, not exact path reach.
Across 48 observed final-shortlist calls, there was no case with available melee attacks on backliners but
none retained. No outcome or win-rate claim is inferred from this diagnostic bank.

## Fixed candidate

The offline helper is `src/simulation/backline_approach_move_research.ts`, ID `backline-approach-move-v1`.
On a root decision in laps 1–6, a pure-melee stack with more than one body and flight or at least five
actual movement steps can propose one already-enumerated legal pure move. Its footprint must be at least
one cell nearer the closest visible enemy with remaining ammunition or a usable offensive damage spell
than every retained move and a pure-move incumbent, and closer than its present position. Stable catalog
order breaks exact ties. Runtime spell classification includes melee/magic hybrids; support-only spells,
spent charges and Hidden enemies do not qualify.

The proposal passes every native role, cohesion and action filter. A19 may compare it by replacing the
last ordinary shortlist slot, retaining the incumbent, leading challenger and ordinary slot count, before
existing Vine/barrel/Rapid Charge/Gravechain/Last Fuse reservations. The selected move is never forced.
The helper neither predicts silence from melee contact nor reads future random outcomes. No extra
pathfinding, RNG, model, spending or army mutation is introduced. Serving entry-point import isolation is
tested; the copied research hooks exist only in the ignored capsule.

## Registration and admission

Capsule: client's `game/core/tmp/backline-approach-move-20261115`. Registration
`1b884ae79e13b177e63504ca59f1a9811126cb41ae812bfd1fc9ea9b663797d3` seals 5,164 files and the full protocol.
It uses the same current engine/server freeze as the read-only audit, materialized dependencies, identical
package/direct RNG and FightStateManager modules, seeded server identities, independently reconstructed
native openings and deterministic offline A19 work. The current helper adds a TypeScript non-null
assertion after a typecheck diagnostic; Bun's emitted JavaScript is byte-identical to the immutable
registered helper (`ad42493d01a55be478a6422d9dc165f9b5664dbb528e5b49787f261345ba7e28`).

The 54 off/observer/treatment admission fights produced 44 proposals, 35 native-filter admissions,
five chosen proposals and seven changed trajectories, covering all three maps. All 18 unchanged controls
matched the independent read-only audit. Nine further cold replays on each of local and Puffalo hosts
matched complete inputs, actions and results. No action rejection, missing neural start or model/helper
error occurred. These 72 correctness executions do not add independent strength evidence.

## Development protocol

The registered trial has 216 fresh offer-board families, both draft orders and physical seats: 864 paired
cases and 1,728 fights. The primary population is 162 families equally divided among current, shooter
and damage-caster opponents. Another 54 fast-melee pressure families are a control. All maps and own/enemy
five-/six-/seven-point doctrine combinations are balanced. No eligibility filtering or outcome refill.
Eight nice-19 local workers handle cases with index modulo four unequal to three; eight nice-19 Puffalo
workers handle the remaining cases alongside the independent peer geometry confirmation.

The single fixed candidate advances only with primary gain at least 0.5 percentage points, nonnegative
means for every own budget and each primary opponent style, pressure-control gain at least −1 pp, and
clean legality/source/input checks. Report draw-aware scores and 10,000 whole-family bootstrap intervals.
No subgroup rescue, tuning or optional stopping is permitted. A development pass is not promotion: it
requires separately registered fresh 6,000-plus-game confirmation with a positive whole-family 95% lower
bound, doctrine/target-style checks, current serial serving overhead within 10%, and native
state/Undo/deadline qualification. No confirmation bank has been allocated.

Seed namespace: `backline-approach-move-20261115-fresh-development-v1`. For counters **1 through 223
inclusive**, SHA-256 UTF-8 `namespace:counter`, take the first four bytes as little-endian uint32, and
reserve that preimage plus offsets 0–7 **and** all eight `permuteRankedDraftSeed` values, including the seven
rejected scans. The accepted bank has 3,456 channels disjoint from 11,108,126 prior channels. Preserve
`allocate-seeds.py`, `seed-admission.json`, `exclusion-ledgers.json`, compressed exclusions and accepted
reservations in the capsule. All preceding failed candidates and their unopened banks remain closed.

## Completed development: no finalist

All 1,728 scheduled battles finished. On the 648 primary paired cases, current won 391, drew 10 and lost
247; the candidate won 392, drew 10 and lost 246. Draw-aware score rose from 61.111111% to 61.265432%:
**+0.154321 pp**, with registered whole-family 95% interval **−1.388889 to +1.620370 pp**. One extra win
does not establish a strength improvement and falls below the fixed +0.5 pp advancement gate.

| Primary group          | Paired cases |  Gain, pp | Whole-family 95% interval, pp |
| ---------------------- | -----------: | --------: | ----------------------------- |
| Five-point doctrine    |          216 | +1.388889 | −0.462963 to +3.240741        |
| Six-point doctrine     |          216 | +0.231481 | −2.546296 to +3.240741        |
| Seven-point doctrine   |          216 | −1.157407 | −3.703704 to +1.620370        |
| Current opponent       |          216 | +0.925926 | −1.620370 to +3.703704        |
| Shooter opponent       |          216 | +0.231481 | −2.777778 to +3.240741        |
| Damage-caster opponent |          216 | −0.694444 | −2.777778 to +1.388889        |

The separate fast-melee control lost 0.925926 pp (95% −3.240741 to +1.388889), within its fixed −1 pp
limit. The primary, doctrine and target-style gates failed. Every displayed interval crosses zero.
Neither the five-point nor Lava slice is a qualified policy. No confirmation was allocated, no gate was
relaxed, no recipe was retuned, and no default/Premium setting changed.

The candidate generated 1,285 proposals, 1,186 native admissions and 734 last-slot replacements. It was
actually selected on 206 distinct turns, changing 227 trajectories. In a posthoc first-divergence audit,
162 games first differed by selecting the proposed move; 91 of these replaced an incumbent melee attack
(77 move-and-strike, 14 stationary). The other 65 first differences selected an ordinary action after
the catalog changed. All 227 first differences changed the chosen action: no identical-action/different-
event divergence preceded a choice change. These observations describe opportunity cost and candidate
competition, not causal proof that a new rule would win. Do not rescue or tune this closed candidate on
these outcomes.

Independent verification reconstructed every full consumed-input SHA, matched both arms' openings,
recomputed every draw-aware score and advancement gate, and verified all 5,164 registered files. Separate
exact bootstrap-distribution convolution gave −1.388889 to +1.697531 pp for the primary contrast,
consistent with the registered 10,000-sample interval; the original sampled interval remains the result.
Canonical seed-permutation reconstruction checked all 223 scanned preimages and 3,568 scanned channels.
Remote output hashes matched the off-node copies. The shared current source changed only documentation
after the freeze. The complete common build passed 8,004 tests; targeted lint and typecheck passed.

The ignored capsule retains `analysis.json`, `independent-verification.json`, `independent-seed-verification.json`,
`source-overlay-verification.json`, `transport-verification.json`, all raw records and the completion receipt.
The standalone `backline-approach.html` report is also copied to Downloads as
`heroes-backline-approach-20261115.html`; all 96 filter combinations were checked. Preserve this failed
development result and its immutable source. Further combat work requires a distinct registered candidate.
