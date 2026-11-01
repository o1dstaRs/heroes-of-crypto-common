# A19 rollback: preserve shared aura objects

Local engine repair based on common `80180ef46464daf3b580e98a2e7f1ebad92a3d87`. The repair changes `src/simulation/battle_snapshot.ts`; it does not change R2's search allocation, action rules, evaluator, learned weights, draft or setup profile. No AI win-rate improvement is claimed.

## Defect and repair

An ability granted during battle can share its `AuraEffect` with the unit's active aura list. The holder's projected aura cells also share the source's current property object. These references carry behavior: resetting or updating the source can reach several readers through the same object.

The old copy routine cloned each occurrence independently, including fields belonging to different battle objects. After rollback, the values could serialize identically while those links were broken. A later mutation then reached different objects in the live fight and the forecast. This explains why ordinary snapshot-value and complete-action checks did not detect the defect.

The repair uses one memo of original-to-cloned objects throughout a snapshot, throughout its restoration, and throughout a first-touch checkpoint. Repeated references resolve to the same clone. Separate equal-valued objects stay separate. Saved snapshots remain isolated from later live mutations, class methods survive cloning, and sparse arrays retain their holes.

First-touch checkpoints need an additional guarantee. Restoring only a source unit would detach it from an otherwise untouched aura cache; restoring only the cache would detach it from untouched sources. The unit and holder capture paths now capture aura owners together, using the same memo. The holder is marked captured before visiting sources, preventing recursion. A non-emitter's unrelated target change still captures only that unit, and the existing transient-terrain test confirms that this remains a partial checkpoint rather than a full battle copy.

The native/granted ability mechanics are unchanged. The repair preserves the reference relationships that exist at the start of the query instead of normalizing them or changing how auras are granted.

## Regression tests

Six tests in `test/simulation/battle_snapshot_aliases.test.ts` fail against the old implementation and pass against the repaired implementation:

- Full snapshot restoration preserves a stolen aura's card/source/projected-cell links through repeated restores, while keeping the saved snapshot immutable.
- A checkpoint preserves those links when unit and holder mutations are first encountered in either order.
- A unit-only checkpoint restores its links into an otherwise untouched aura cache.
- A holder-only checkpoint restores links to otherwise untouched aura sources.
- Class instances shared through arrays, map keys, sets and queues retain their methods and shared identity after cloning.
- Distinct equal-valued objects remain distinct, and sparse-array holes survive.

The existing first-touch test now explicitly chooses a non-emitter for its unit-only assertion. When the holder is touched, it permits the necessary aura-owner captures while checking that the whole army was not copied. Its checkpoint is consumed in `finally` so a failed assertion cannot leave another checkpoint active for later tests.

Run the focused tests from the common package:

```bash
bun test test/simulation/battle_snapshot_aliases.test.ts test/simulation/battle_snapshot.test.ts test/units/aura_refresh_invalidation.test.ts
```

The frozen final source passed **7,194 common tests with zero failures**, TypeScript and the build's generated/JSON copy steps. The focused suite passed 27 tests with 246 assertions. Validation uses a source export plus only this task's overlays; unrelated shared-tree work is excluded.

## Registered final validation

The final registration and immutable source/tool hashes live under ignored `game/core/tmp/a19-rollback-aliases-v2-20261025`. Its baseline is the same `80180ef4` engine; its only production-source difference is the repaired snapshot module.

The current server `a19-material-r2-v1` search, draft and setup sources were captured directly. Both replay modes use H64, complementary R2, shortlist six, material-tie arbitration, certified/tight bounds, current ranked draft/setup, Battle Trance, native supply, rolled synergies, tactical splits and side-board placement. No trial introduces a new strategic rule.

Fresh seed `2720480000` reserves 24 independent offer boards with four canonical draft-seat/battle-mirror games each. Every game runs once with incremental checkpoints and once with full snapshots: 192 complete replays. There are eight independent boards per live map, and both physical sides are covered. Each real search must preserve the complete recorded aura reference relationships. Across modes, compare every action-trace hash, winner, termination, laps, army/setup fingerprint, seeds, reference-graph trace and selected timing root. Any rejected action, censored battle or mismatch fails validation.

Timing uses exactly one declared game per board, `4 * board + floor(board / 3) % 4`. Select its first actual search in lap two or later, falling back to its first search only if it ends sooner. The canonical draft/setup generator and sanitized environment reproduce the exact original root digest before timing.

On that identical state, compare the old and repaired snapshot, restore and unit-plus-holder checkpoint operations. Each operator has eight warmups per arm followed by eight blocks in the fixed order baseline/candidate/candidate/baseline/candidate/baseline/baseline/candidate, 20 operations per block. Reset the original repaired snapshot outside each timed operation. All measurements run serially on the M4, with no heavy simulation batch running in parallel. A 20,000-resample whole-board bootstrap with seed `2720490000` summarizes paired log speed ratios. These are copy-operation measurements, not full AI turn latency, total game throughput or strength evidence.

## Final results

All **192 final replays** passed. The 96 checkpoint/full-snapshot pairs had identical complete action and reference-graph trajectories, results and selected timing roots, with zero rejected or censored battles. They checked **8,992 actual search calls** and **407,664 projected aura references**. No fresh match happened to exercise a shared granted card/source object; the six direct regressions and the separate old stolen-aura scenario cover that relationship explicitly.

The old ranged-heavy Fairy/Arachna scenario was rerun with the final source. Its root remained the same Fairy action at ordinal two, but the source's state digest changed, so the old source's digest was not treated as interchangeable. New private and real continuations matched their own exact root, UUID counter and actor/lap chance stream. Both samples matched every before/after state, native choice, target-memory/damage digest and UUID across **119 future turns and 6,002 random draws**. The former late aura-power mismatch was absent. The real observer lists strategy actions while private engine tracing also lists the loop's automatic end-turn; the audit permits only that exact accepted trailing manual `end_turn`, and records all 20 such observer-scope differences. It does not ignore arbitrary action differences. This is one reused scenario, not strength evidence.

The isolated server export used the identical repaired common source with one shared dependency tree. Server TypeScript and **890 ranked API tests** passed with zero failures; 45 existing integration tests remained skipped. No credentials were copied, and neither the real server checkout nor its manifest/lockfile was changed.

The serial timing study completed **11,520 measured operations** on all 24 declared roots:

| Operator                    |  Old mean | Repaired mean | Geometric speed ratio, old/repaired | 95% board-bootstrap interval |
| --------------------------- | --------: | ------------: | ----------------------------------: | ---------------------------: |
| Full snapshot               | 0.1353 ms |     0.1407 ms |                               0.944 |                  0.844–1.057 |
| Full restore                | 0.1018 ms |     0.1015 ms |                               1.009 |                  0.917–1.106 |
| Unit-plus-holder checkpoint | 0.0341 ms |     0.0462 ms |                               0.747 |                  0.705–0.789 |

The checkpoint kernel is slower because it now preserves the related aura owners as well as the cache: roughly **12 microseconds more per measured operation**, with a geometric cost increase of 33.9%. The arithmetic means and mean log ratios are different estimators; the table reports both rather than deriving one from the other. Snapshot and restore timing intervals cross parity. There is **no speedup claim** and no conversion of these kernel timings into a full AI turn estimate. Production deadline/latency qualification and an AI win-rate study were not performed.

A peer advanced common main to `e1b56f87b9df56e8fa263405fec0d40c90058f0c` during validation, adding certified bounds to offline cohort tooling. A separate integration export of that commit plus the same repair passed **7,195 tests with zero failures**, TypeScript and the full build. The server changes since the captured API source were dependency-pin updates only. The registered 80180-based replay and timing receipts retain their original source identity.

All final source/tool hashes and raw replay/timing records were independently verified. The complete source and statistical results remain in the ignored final artifact directory, separately from earlier attempts. **The validation run did not deploy code or change common pins or dependency lockfiles.**

## Preserved earlier attempts

The earlier `a19-rollback-aliases-20261025` source export is retained separately. Its 192 fresh replays passed, and it eliminated the old-case trace mismatch, but subsequent unit-only/holder-only checkpoint regressions exposed the missing capture closure. That implementation is superseded and supplies no final qualification. Its timing results are not pooled with the final repair.

The same directory retains an aborted unsealed attempt with 24 completed records; no outcome statistics were inspected and those records are excluded. Its first timing prefix also failed an exact-root guard before any measured operations because it skipped the canonical draft/setup initialization. The final runner uses that initialization and fresh seeds. Failed attempts, original logs and derivation receipts remain available rather than being overwritten.

Existing AI training corpora and policy experiments retain their original source identities. They must not be relabeled as outcomes generated by this repair. The old aura scenario is reused only as a mechanical diagnostic; it is neither another independent army sample nor strategic strength qualification.
