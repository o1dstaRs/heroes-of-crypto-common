# Public-terrain formation default adoption

On November 17, 2026, after the terrain-placement screen, the user requested:
“plesae add it to the default strategy for sure”. This explicitly adopts the exact
`public-terrain-formation-reflection-v1` candidate in the A19-backed v0.8 default.
The production profile advances from v10 to **v11**. The locked v0.9 V3/contextual draft,
learned setup, combat neural weights, H64/R2 search and other adopted behaviors remain intact.
The wire AI version remains v0.8.

This instruction supersedes the historical non-activation decision for this candidate only.
It does not convert the exploratory confidence gate into a pass. The original
[research record](terrain_placement_research.md), registration, reserved seeds and result fixtures
remain unchanged evidence: **+7.638889 match-score points**, family-adjusted 95% interval
**0 to +16.666667**, across 36 independent draft families / 72 paired seats. Its strictly
positive lower-bound requirement failed; independent strength confirmation remains unopened.

## Serving behavior and boundaries

`src/ai/placement/terrain_reflection.ts` contains the serving implementation. After normal
splitting and all preceding formation layers, and before placing own artifact barrels, it
compares the current formation with its complete vertical reflection. It uses the tested
blocked-ray and terrain-only walking-detour costs with the original weights and strict tie rule.
The public game id reconstructs the actual neutral scattered barrels; no enemy deployment,
private augments, hidden artifact-barrel positions, or future combat outcomes enter the helper.

Reflection preserves forward depth, each rectangular footprint, stack amounts, and all
relative ally distances. Only a complete legal layout may replace the incumbent. Unknown,
partial or invalid inputs retain a detached incumbent. Normal, Water, Lava and legacy-axis
placement remain unchanged. This adoption does not add a new lava policy or change which
units are split.

The authoritative server invokes this after learned/support and ranged-setup formation,
covering default AI re-placement and Premium automatic/formation actions. Incremental human
placement keeps its existing behavior. Premium undo restores the preceding formation.
The existing transaction snapshot still protects the complete army if native placement fails.
The server strategy revision is
`a19-neural-r2-placement-v2-unit-support-v2-barrel-v1-nightmare-v1-terrain-v1`.

Default side-oriented A19 simulations also apply the choice after own setup and before combat
and deployment barrels. Explicit strategy overrides retain ownership of their layouts, including
native-server replay fixtures; their caller must opt into the new serving rule when constructing
a new default opening. Meta formation collection observes the terrain-aware default before its
selector runs, then applies that explicit selection exactly. An identity selector therefore matches
ordinary default play, and labels describe the cells actually played. A13 rollback and other AI
versions do not receive this policy. The result's placement records reflect the positions actually used.

The source ledger pins the new helper and changed simulation routing. Profile v11 is the baseline
for subsequent default-strategy research. Existing studies keep their frozen comparator. This
adoption does not regenerate historical Premium SQLite observations or deploy live services.

## Integration verification

The versioned `test/ai/fixtures/a19_terrain_placement.json` retains all 72 public own-army
inputs from the completed screen. The serving helper reproduces every expected cost and
position exactly, including all **34 changed formations**. Tests verify native legal occupancy,
rectangular reflection, idempotence, unchanged RNG and input objects, unsupported-map fallback,
and the public-only context contract.

The separate ignored client capsule `game/core/tmp/terrain-default-adoption-20261117` overlays
only the adopted serving sources on the original frozen runtime, excluding peer work in progress.
It holds the opponent on the registered comparator for integration checks. All **144 opening
comparisons** match the saved native/candidate battle inputs. Fourteen full replay executions
cover the first changed formation for each own-doctrine/physical-team combination plus an
unchanged control; selection uses geometry only. Complete results, turn traces, events and
health reproduce exactly. These executions add no independent strength evidence.

Server checks cover both physical sides of Premium automatic/formation/undo, default AI
re-placement, and non-activation during incremental human placement or explicit a13 rollback. Simulation routing tests
capture the actual pre-combat engine state, verify that the final choice is used, and preserve
explicit formation overrides. They intentionally test placement without running redundant combat;
the full replay checks above cover combat equivalence.
