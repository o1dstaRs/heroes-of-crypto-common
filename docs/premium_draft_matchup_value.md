# Historical matchup value for final picks

The [occupancy observer](premium_draft_memory.md) estimates what an opponent may already hold.
This separate model values complete armies from historical fight outcomes. It is opt-in research;
the adopted V3/contextual draft and A19 default remain unchanged.

`PremiumEvidenceSnapshot.trainingMatchups(cohorts)` enforces the original training partition in SQL,
keeps both armies in each family together, validates complementary seat-paired scores, and separates
targets from public input. Export with pinned source/database hashes:

```sh
bun src/simulation/export_premium_matchups.ts SNAPSHOT SOURCE_SHA256 SNAPSHOT_SHA256 NEW_OUTPUT_DIRECTORY
```

`draftMatchupFeatures` takes complete own/enemy creature identities, public map and own doctrine.
It excludes hidden enemy doctrine, artifacts, purchases, positions, seeds and family IDs. The baseline
uses signed unit identities, map/unit terms, own-doctrine/unit terms and a doctrine intercept. The
interaction model adds allied pairs and directional enemy matchups. These remain associations under
historical setup/combat, not causal effects of changing a pick; hidden setup is averaged over.
This prediction screen uses completed rosters for all doctrines. It does not claim that Scout or
Battle Trance can observe those rosters during an ordinary draft; the adviser refuses partial views.

The fixed November 17 screen used ridge penalty 100, no scaling, half weight per army, five whole-family
folds and a full refit. Sources stayed separate; all seven cohorts train each model, while ranked-draft
prediction is primary. There were 24 CPU linear solves, zero new battles and no GPU work.

| Source                  | Training families, all cohorts | Ranked families in grouped cross-validation | Relative squared-error reduction | Absolute reduction, descriptive 95% interval |
| ----------------------- | -----------------------------: | ------------------------------------------: | -------------------------------: | -------------------------------------------- |
| November 9              |                         11,230 |                                       1,586 |                            4.37% | 0.006842 [0.001276, 0.012283]                |
| November 16 exploratory |                          1,587 |                                         224 |                            4.07% | 0.006558 [−0.002466, 0.015542]               |

The older source passed the prediction screen. The newer source was inconclusive and failed it.
All own-doctrine mean prediction contrasts were nonnegative. Intervals resample whole families of
fixed out-of-fold predictions; overlapping fold fits make these descriptive development intervals,
not fresh policy qualification or win-rate gains. Historical balance and headless setup may differ
from current ranked serving. Sources and prior failed studies are never pooled.

`createDraftMatchupValue(model)` compiles immutable inference without SQLite or RNG.
`createHistoricalFinalPickAdvisor(model)` accepts the actual public draft view and incumbent. It
requires the final level-4 phase, five own units, six visible enemy units and the exact legal offer set.
It compares complete six-unit armies and retains the incumbent unless estimated gain reaches 0.03.
Partial visibility, malformed inputs and unsupported phases return no advice. It changes no earlier
picks or existing override state, and is not imported into a serving profile.

The client capsule `game/core/tmp/premium-matchup-value-20261117` preserves registration
`3d5048604f96aec3016a629d43d722387452f7c3a9c8f0bfa1308760b96bbeee`, sources, all fold/full models,
targets, receipts and independent checks. SQL reconstruction verified 12,817 training families.
Python/Bun reproduced 51,268 out-of-fold values exactly; a separate implementation reproduced 603
historical final-pick choices. Those are correctness/coverage observations, not alternative games.

Fresh qualification must freeze this candidate and current sources, use new full-ranked families,
random doctrines, authoritative public Setup, both physical seats and full A19 combat. Retain current
adopted draft and locked V3 controls. Qualify and confirm separately against both: at least 0.5 score
points, positive whole-family 95% lower bounds and nonnegative own-doctrine means. Deadline, state,
persisted draft state and replay qualification remain necessary before serving adoption. A prediction
gain alone does not authorize changing the default.
