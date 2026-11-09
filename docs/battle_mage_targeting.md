# Battle Mage target coverage

`battle-mage-impact-coverage-v1` repairs a target omission in the shared A19 combat path. Previously,
Meteorite offered only the area with the largest non-overkill HP damage. Search could not select an
isolated valuable target or exclude a neighboring reflector if that meant dealing less total HP damage.

Battle Mage now offers each distinct visible Meteorite impact to the existing engine-backed search.
The historical greatest-damage choice remains first. Equivalent anchors are deduplicated by ordered
victim IDs, preserving reflection order and counting multi-cell bodies once. Water Shield breaks remain
available even when they initially deal zero HP damage. Entirely immune groups are omitted. Hidden
enemies do not supply anchors or ranking information. Other casters retain their historical catalogs.

The normal A19 factory and native v0.8 fallback/continuation policy share this coverage. Search keeps
the existing six-candidate shortlist, complementary R2, horizon 64 and one-second live allowance.
`V08_BATTLE_MAGE_TARGETS=off` restores the previous target coverage; `green` and `red` enable it on
one physical seat for matched comparisons. This is a combat targeting change, not a trained model,
placement change or modification to the locked V3 draft.

Exact-engine regressions cover both physical seats, a lethal fire-immune shooter versus a larger decoy
cluster, an unnecessary adjacent Magic Mirror, overkill, multi-cell targets, magic resistance, shield
breaks, earth immunity, hidden information, spent charges, stack-power eligibility and snapshot/RNG
rollback. Existing Fire Strike obstruction and charge-conservation regressions remain required.
These constructed tactical cases demonstrate the repaired decisions; they are not an overall ranked
win-rate estimate. Source publication and production deployment must be reported separately.
