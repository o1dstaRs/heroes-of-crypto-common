# Nightmare route preservation: corrected selection integration

This is the manually reviewed corrected execution `nightmare-route-selection-corrected-20261117`.
It implements the unchanged `nightmare-route-preserving-wall-v1` policy after the
[first admission run](nightmare_route_preservation_research.md) caught a selection integration failure.
Neither helper is imported by serving code. The accepted A19 model pair, adopted barrel correction,
default 0.9 and Premium routing remain unchanged.

## Why a separately recorded execution is necessary

The first run stopped after 284 old-case executions, before opening any fresh games. Its hook returned
a masked score copy, but native material arbitration retained the original unmasked array and could
reselect a disallowed wall. Twenty of its 24 new-wall selections violated the intended opportunity gate.
The complete failed capsule, first registration and invalid-arm records are preserved; they supply no
qualified strength evidence.

The new adapter, `src/simulation/nightmare_wall_selection_evidence_research.ts`, masks the original
selection array in place and saves a separate raw-forecast copy. That shared array reaches native
material arbitration and final neural correction. The hook asserts shared-array identity when material
evidence exists, records its actual values, and the independent verifier checks every selected new wall
against the unchanged full-R2 opportunity gate. Ordinary candidates and their forecasts remain intact.

The route helper and its tests retain their exact original bytes. The wall geometry, direct-attack
guard, current-route coverage proxy, allied-route protection, strict 0.01 productive margin and complete
sample requirement are unchanged. This repairs execution of the registered policy rather than fitting
a new rule to admission outcomes.

Four additional regression tests exercise the real material and neural selector functions. All
**530 tests / 4,203 assertions**, targeted TypeScript and ESLint checks pass. Eight end-to-end canary
executions use two already-opened admission cases: a previously blocked wall stays blocked, a permitted
wall remains selectable, and controls/observers match their original traces. They contain zero fresh
outcomes and are not strength samples.

## Frozen corrected registration

Registration SHA-256: `a2a5e57a790f1e9376f75c63aa3389df88175693038de179c7f006cccd0b1dba`.
The capsule is `game/core/tmp/nightmare-route-selection-corrected-20261117` relative to the client root.
The original first-run registration remains
`3ed06ee12097d7e63ff7079e853f7b015f95017343144ffd5846b193c35b0887`.

Inherit the exact **216 reserved, still-unopened families**, selected before the first registration.
All 20,480 scanned preimages and their 1,310,432 distinct raw/permuted channels remain reserved in the
[first evidence fixture](evidence/nightmare_route_preservation_20261117.json). No fresh outcomes were
available for policy, roster or host assignment. This bank is not redrawn or retrospectively called a
holdout after exposure.

The complete four-arm protocol is repeated: default off, observation only, immutable original v1 and
guarded v2. All 65 old changed cases and six cold cases require **284 admission executions**. Fresh
families use both seats and two combat futures: **864 paired comparisons / 3,456 executions**, followed
by 72 fixed cold repetitions. The corrected registered total is **3,812 executions**; previous failed
admission and the eight canaries are separate. Every arm reconstructs its own legal ranked draft/setup.

The two primary contrasts remain v2 versus default and v2 versus original v1. Four differences are
averaged within each family. The fixed 20,000-draw whole-family bootstrap uses Python Random 73117720
and simultaneous 95% Bonferroni intervals for the two primary contrasts. Independent raw-score, integer
family-score and exact empirical bootstrap verification are required. Original v1 versus default is
reported separately as a diagnostic replication.

The unchanged development gates require complete quality, at least ten v2 trajectory changes and three
selected new walls across two maps, positive estimates and positive simultaneous lower bounds for both
primary contrasts, and nonnegative means in every own doctrine for both. No extra half-point minimum
is introduced. Passing development only permits independent confirmation and serial serving-cost
validation within +10%; it cannot automatically promote a default.

## Host allocation and original resource limit

The corrected execution adds **four nice-19 local M4 Max workers** while retaining **six nice-19 Puffalo
workers**, with no GPU. Local disk space recovered before launch, and Puffalo has concurrent workloads.
This resource change was frozen before fresh outcomes. The original cutoff remains
**2026-11-17 09:51:21 UTC**, with a 2 GiB free-space floor on each host, no automatic retry and no extension.

For each map/own-doctrine/opponent-doctrine/pick-order group, the first two of the four selected families
run locally and the remaining two run on Puffalo. Each host therefore gets 108 fresh families, balanced
across those strata. All four arms and every cold repetition of a family stay on the same host. Old
admission cases alternate hosts. Every raw record declares its host, and the verifier checks it against
the sealed allocation. This is paired within-host evidence, not a comparison of policies on different
machines. Earlier checks reproduced all 130 old Mac/Puffalo off/v1 traces exactly.

Both hosts verify the same 5,411 runtime file hashes, all registered input hashes, Bun 1.4.4 and package
identity. Source archives remain frozen common `bf38acba` and server `82336c69`, plus the separately
hashed inactive helpers and tests. Peer working-tree edits are excluded. Remote stage output is copied
only after successful completion, without overwriting local cases, and receives transfer/hash receipts.
Any failed shard, quality check, disk floor or original cutoff stops the coordinated pipeline.

## Execution status

The corrected coordinator launched at **2026-11-17 07:59:13 UTC**. Admission, fresh comparisons, cold
repeats, full verification and independent statistics run in sequence. Results are pending; no qualified
gain or default change is claimed. See the
[corrected evidence fixture](evidence/nightmare_route_selection_corrected_20261117.json) for the exact
registration, source hashes, inherited reservation reference and validation receipts.
