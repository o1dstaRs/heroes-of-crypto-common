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

## User-accepted default and fixed comparison

The user explicitly requested “lock it into strat and continue further making it better” after the
independent 250-game comparison. Keep `battle-mage-impact-coverage-v1` enabled in the shared default
and retain common commit `1111040539bb0a35fbbfd1639d418ddac0c65e33` as the fixed research comparator.
Client and server pins already include this implementation. This acceptance does not establish a strength
gain or mean that a production deployment occurred.

The complete new bank scored 126 wins, 2 draws and 122 losses: 50.8% draw-aware score over 125
independent board families, whole-board 95% interval 47.2–54.4%. All 250 fights completed with zero
rejected actions. The earlier 96-game pilot remains separate. Both use prescribed armies containing
Battle Mage and headless formations; they do not exercise ranked drafting. Compact identities and
reserved seeds are retained in `evidence/battle_mage_targeting_20261109.json`.

Further experiments must preserve this accepted baseline, use separate policy IDs, and exclude these
boards from fresh confirmation. The continuation-policy experiment in
`battle_mage_target_research.ts` is explicitly scoped research and does not activate on import.

## Continuation-policy follow-up

The posthoc audit of all 125 original families found that every one of the nine negative pairs first
diverged on another unit's turn. Ten of eleven positive pairs did too. Broader Mage choices inside
simulated continuations can change other units' plans; that observation alone does not make those
indirect effects harmful.

The separately registered `battle-mage-root-coverage-legacy-rollouts-v1` candidate kept accepted
coverage on actual turns, but restored the former native Mage choice inside its team's continuations.
On 250 new fights using all 125 reused development boards, it scored 121 wins, 3 draws and 126 losses
against the accepted policy: 49.0% score. The descriptive whole-board bootstrap interval was
45.6–52.2%; these reused boards are not fresh strength evidence. Its fixed 51% progression threshold
failed, so the reserved 250-game fresh bank remained unopened. The accepted default is unchanged.

All 250 games had zero rejected actions and restored the research scope. Independent verification
checked every raw receipt, paired opening and frozen source, plus two exact candidate replays. The
696 original source files were unchanged; only the import-inert research module was added. No GPU,
model fitting or optimizer steps were used. Registration SHA256:
`cf749c7245926470ae8afb8012c32d0ad95b06bf344a37a3fad0c325ed5e4a68`.

This experiment does not support reverting the accepted continuation coverage. Further targeting
work should retain it as the comparator and examine the actual rejected or selected targets, spell
charges and post-cast exposure in matched traces. Do not select a map-specific rule from this bank
or reopen its failed fresh gate.
