# Terrain awareness during splitting and final placement

Subsequent user instruction explicitly adopted this candidate as the default; see
[the adoption record](terrain_placement_adoption.md). The screen status and evidence below remain historical and unchanged.

Status, November 17, 2026: **a placement information gap is reproduced. The first terrain-aware candidate has a positive exploratory estimate but did not pass its registered lower-bound gate. The default is unchanged.**

## What the current pipeline knows

Ranked placement initially receives the grid and path helper through the server's `placementContextForTeam`. Action-engine validation still enforces legal placement. Combat pathfinding, ranged interception, and the adopted A19 barrel policy use terrain. This is not evidence that the whole AI ignores barrels or walks through lava.

The later formation stages have a narrower view:

- `src/ai/tactical_split_placement.ts` plans splits from own-stack utility and available slots. Its placement context contains the map identifier and legal deployment cells, but no actual neutral-barrel coordinates or per-unit terrain routes. Its `mountainUtility` branch still favors a fixed middle corridor for aura/support/shield children on `BLOCK_CENTER`; the current Cemetery map uses 9–12 scattered barrels instead of the historical fixed mountains.
- `src/ai/placement/adapter.ts` and `layout.ts` pass map identity, own bodies/setup, public enemy roster identities, and legal deployment cells to the frozen final-placement models. They do not encode the actual neutral-barrel layout or terrain-adjusted movement routes. The envelope also lacks per-unit lava traversal as an explicit feature. Do not add untrained input dimensions to the frozen models or alter their qualification evidence.
- Server `strategyPlaceTeam` rotates the legacy layout, overlays split positions, seats ranged stacks on corners, and applies the utility repair. `applyLearnedFinalPlacement` then applies the learned/support/ranged-setup formation. `placeMissingArtifactBarrels` runs afterward. Neutral map barrels already exist; artifact deployment barrels are a different stage.

These shared authoritative methods also serve Premium automatic/formation actions. A future production fix must cover that route and simulation parity, using only visible terrain and own units. Hidden opponent placement and deployment barrels must not become placement features.

## Mechanical reproduction

The audit freezes common `997490ee10c64f7379396c869c4d7976fddb04dc` and server `51b2f9530d28557337a0acd62b6d65d3f86b8837`. Common's committed runtime remained identical at `12874c10`; subsequent differences were research evidence. Peer uncommitted unit-stat work was excluded.

Six native Cemetery draft families cover all three own doctrines and both pick orders, against seven-point enemy doctrine. Each uses its original barrel layout and four alternative seeded layouts, holding draft, paid setup, stack amounts, own setup RNG, and map identifier fixed. Both teams' final formations are compared.

**All 48 changed-layout comparisons retained identical positions and stack bodies.** Setup receipts also remained identical. The 30 Cemetery openings contained 420 placed stack observations, including 60 one-creature small stacks; these are repeated observations, not independent strength samples. No unit was unplaced or overlaid a neutral barrel.

Six separate Lava openings were also inspected. Lava's fixed center geometry is represented indirectly by the map feature, so the audit does **not** establish complete lava blindness. It confirms the absence of explicit per-unit route/traversal features. Terrain-only detours and blocked-ray counts are diagnostic proxies, not proof that a particular formation loses or that a shorter route is strategically better.

## Frozen exploratory candidate

Policy: `public-terrain-formation-reflection-v1`. Its exact capsule source is retained in the registration fixture's `frozenCandidateSource`; preserve the source hash.

After native splitting and final placement, before own artifact barrels, compare the incumbent formation with its complete vertical reflection. Reflect each rectangular footprint correctly, retain its forward depth, and require every resulting footprint to remain legal. Reflection preserves all distances between allied bodies, as well as roster, amounts, splits, upgrades, artifacts, synergies and opponent formation.

For Cemetery only, reconstruct the neutral terrain from the public game seed. Do not read enemy units, positions, aggression, augments or deployed barrels. Cost is:

- For each physical ranged stack, its `amount × experience / 1000` times the fraction of 14 canonical engine rays blocked by neutral barrels. Targets are fixed cells on the opposite deployment front, not actual enemies.
- For each grounded non-spellbook melee stack, the same weight times its terrain-only shortest-route excess to the far edge of the neutral band, divided by four. Use the native rectangular-footprint pathfinder and own traversal capabilities, without enemy aggression or units.

Choose the reflection only on strict cost improvement; ties retain the incumbent. Normal and Lava are unchanged by this candidate. It is deliberately limited: this does not solve split-slot selection, individual lane assignment, or lava-aware formation learning.

Twelve mechanical fixtures passed native placement validation, opponent/setup/split preservation, relative-distance checks, and a restricted-input proxy that rejects unexpected session reads. Two of the six sampled Cemetery candidate formations changed. No battle outcomes were used to choose weights or thresholds.

## Registered comparison and result

Registration SHA-256: `544219357e1afd504597dc571d157fe71b64aba9c1b0bf59aebe4e43bb0cc871`.

The fixed screen uses **36 fresh native draft families**: Cemetery, three own doctrines × three enemy doctrines × both pick orders × two families per stratum. Both physical seats and one paired combat future yield 144 logical battles. Both sides retain the adopted v10 A19 H64/R2 combat, locked V3/contextual draft, native fully funded setup, split policy, and final placement v2.

| Arm                | Wins | Draws | Losses | Match score |
| ------------------ | ---: | ----: | -----: | ----------: |
| Current default    |   32 |     1 |     39 |  45.138889% |
| Terrain reflection |   37 |     2 |     33 |  52.777778% |

Candidate minus default: **+7.638889 percentage points**, whole-family bootstrap 95% interval **0.000000 to +16.666667**. Draws score one half; both seats are averaged within each independent family. The interval uses 20,000 fixed-seed family resamples. It is not a 144-independent-game interval.

The candidate changed 34/72 seat formations. There were **106 actual screen executions** and 38 exact-input reuses. Reuse required identical complete battle inputs: configuration, both teams, terrain, scoring seat and combat seed. The four smoke and eight cross-host reproducibility executions are additional checks, not additional independent evidence.

All quality checks passed: native legal opening reproduction, unchanged opponent setup, zero rejected actions/model errors, both-team search activity, valid health ledgers, and exact opening/results/turns/events/health reproduction across HFT and M4. Four additional cold checks explicitly covered changed formations on both physical teams; their additive quality amendment did not change the policy, bank or inference. An independent integer-score reconstruction verified all 144 payload receipts and reproduced the point estimate and interval. Existing targeted tests passed: 65 common and 10 server tests.

The registered exploratory gate required at least +1 pp and a **strictly positive** 95% lower bound. The lower bound is zero, so **the gate failed**. This is an encouraging small-screen estimate, not a confirmed gain or production qualification. No subgroup rescues, extra seeds appended until significance, default activation, or new model promotion occurred. Confirmation remains unopened.

## Preservation and next research boundary

Preserve [registration](evidence/terrain_placement_registration_20261117.json) and [result](evidence/terrain_placement_result_20261117.json), including the exact candidate source and every reserved preimage. Exclude counters 1–20,480 of `terrain-placement-audit-20261117-fresh-v1`, including rejected/unused preimages, plus the separate mechanical-audit preimages. Each reserves 32 raw and 32 native-permuted channels. The 210-ledger admission check found no admitted-channel overlap.

The full reproducible capsule and interactive board report remain outside Git at client-relative `game/core/tmp/terrain-placement-audit-20261117`; the frozen worker/results copy is on HFT under its matching research directory. Normal outputs and screenshots stay untracked.

The useful retained finding is the missing actual-terrain input. Any subsequent terrain-aware placement model or different lane/split policy needs a separately registered experiment against the current adopted default, legal public-data projection, funded setup, and fresh confirmation before a strength claim. Preserve the existing placement promotion gate and frozen model tensors.
