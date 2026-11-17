# Premium snapshots for policy learning

`premium-ranked-v4` is the default **new collection** contract. It does not change the ranked bot,
publish a snapshot, fit a model, or rewrite an older study. Explicit v1/v2/v3 collection remains available.
The existing `v09-draft-a19-work` profile retains its declared locked V3 draft anchor and full v0.8/A19
combat. This capture adds exploration; it must not be described as an unchanged default-policy tournament.
Later contextual draft/setup overlays are not implicitly added to that historical profile.

The reviewed 28,224-fight snapshot contains 2,016 ranked-draft families, including 1,586 training families.
Its hybrid draft selected alternatives with probability zero. Final-army associations cannot identify the
value of changing those decisions. Its full indexed traces retain augment sampling data, but the ordinary
SQLite lacked a normalized learning table. V4 addresses collection support and data routing, not strength.

## Recorded decisions

- Draft: 80% anchor / 20% uniform among the actual visible legal choices, including bundles and Tier-2
  offers. Every alternative has positive probability. Bundle keys are local indices whose full tuples
  remain in the observation. Own doctrine is independently uniform; its probability is 1/3. A hidden-pick
  collision remains a recorded attempt with its original observation, distribution and eventual outcome.
- Augments: the complete funded 5/6/7-point six-axis domain, including Empower. The table retains the
  pre-spending public roster context, exact selected plan, and full marginal probability. The latter includes
  both exploration and exploitation paths when exploration draws the preferred action.
- Formation: after the existing split placement, 80% incumbent / 20% uniform over deduplicated legal
  incumbent, depth reflection, flank reflection and both reflections. Whole rectangular footprints are
  reflected; quantities, spending and split roles are preserved. No hidden opponent setup or combat seed
  enters the selector. The independent sampling stream uses the setup seed. Illegal or incompletely applied
  choices fail collection instead of silently labeling a fallback as the selected action.

The four reflections are a limited geometry action space, not every legal placement. Split strategies,
optional bans and unplayed combat actions are not explored. The setup execution contract is explicitly
`headless-meta-ranked-sides-not-server-qualified`. Funding and actual engine application are checked, but
this does not reproduce the authoritative server's complete setup policy. Any learned serving policy still
needs current native server formation/barrel/spellbook, live deadline and state-restoration qualification.

## SQLite and training boundaries

New snapshots include `learning_decision`, indexed by stage and family, with capability
`policy-learning-decisions-v1`. Each row retains its exact public pre-decision observation separately from
its selected action, complete behavior distribution and observed label. Formation rows also retain all
candidate coordinates. Draft and augment labels average the two physical seats; formation labels refer
to the specific fight actually using that formation. The family remains the split and uncertainty unit.
Never count the two armies or multiple decisions as independent boards.

`PremiumEvidenceSnapshot.trainingDecisions(cohort, kind)` streams only training rows and requires an
explicit cohort and stage. It cannot opt into validation or test. Only ranked-draft provides draft examples;
the other six cohorts use prescribed rosters. Keep these populations separate during fitting and evaluation.
Source identity is checked when opening the immutable read-only snapshot. The canonical finalizer hashes
the completed file and audits every normalized observation, action, probability and label against raw files.
Corruption or missing rows prevents completion. Training data is usable without indexed full fight traces.

## Training export and support inspection

Use `export_premium_training.ts` on an independently audited snapshot. It requires both the recorded
source hash and the audited SQLite file hash, and refuses to overwrite an existing output directory:

```sh
bun src/simulation/export_premium_training.ts \
  /path/to/premium.sqlite SOURCE_SHA256 SNAPSHOT_SHA256 /path/to/new-training-export
```

This performs no simulations or fitting. `training.jsonl.gz` contains only training families, and
`readiness.json` reports coverage separately by cohort, decision stage and doctrine at that decision.
Unselected doctrine is recorded as zero rather than leaking the subsequently chosen doctrine backward.
The report does not read validation/test payloads or select a policy from outcomes. The reader verifies
that each payload matches its indexed family, army, stage, selected action and probability.

Each example separates five fields:

- `input`: the strict public observation and all candidate actions. Supply only this object to the model.
  Bundle indices resolve to their offered tuples; augment IDs resolve to complete funded plans. Formation
  units and every proposal use stable local slots instead of seed-derived UUIDs. Unknown observation fields
  fail the export. Research cohort labels, future results, selection status and behavior scores stay outside.
- `logged`: the chosen action, collision/acceptance status and full marginal action probabilities.
- `target`: the observed score and whether it averages physical seats or belongs to one fight.
- `audit`: family/cohort/side/decision identifiers and the recorded execution contract; never model inputs.
- `weighting`: each family's rows sum to one within a cohort and decision stage, so extra picks or hidden
  collisions do not implicitly give that family more total weight. This is a bookkeeping weight, not an
  inverse-propensity estimator or a recommendation to mix all tasks in one loss.

Coverage counts include every offered action key, even if it was never selected. Keys may be context-local
(bundle indices), so those counts do not establish efficacy. The fewer-than-five-family count is a sparsity
diagnostic, not a statistical qualification gate. Keep marginal probabilities separate from any future
trajectory-probability calculation; the exporter deliberately does not apply inverse-propensity weighting.

The first complete 4,032-fight acceptance snapshot exported 12,998 training rows from 1,587 families.
Only 224 were ranked-draft families. That cohort supplied 2,132 creature attempts including 340 collisions,
448 artifact decisions and 896 formation decisions. Of 783 possible augment keys across doctrine budgets,
674 were never selected in ranked-draft training and 765 appeared in fewer than five families. Some selected
plans had marginal probability 1/1,650. This is useful collection evidence, but insufficient for treating
arbitrary exact-plan rankings as reliable counterpick or upgrade advice.

The next data experiment should target ranked drafting and a compact, prospectively defined action set,
with independently matched alternatives on the same public decision state. Keep all three doctrines
independently uniform, preserve current controls, reserve whole-family held-out/fresh banks before outcomes,
and use authoritative public Setup for any intended serving placement policy. The existing four-reflection
capture cannot support new split policies. This is a follow-up design, not authorization to run a new bank,
fit a model, alter this completed snapshot or replace a ranked default.

## Prepared matched-upgrade follow-up

The distinct, inactive `premium-one-point-upgrades-v1` helper in
`src/simulation/premium_upgrade_neighborhood.ts` starts from the actual authoritative bot's purchases.
It enumerates every legal one-point transfer between Armor, Might, Sniper, Movement and Empower,
retaining the complete doctrine budget and exactly the same Placement level. An outcome-independent
selection stream samples three distinct neighbors without replacement. The four recorded arms are the
incumbent and those three neighbors; every arm is played, rather than treating an unplayed alternative
as if its outcome were known. Inclusion probability is `3 / neighborhoodSize`, **not** the probability
that a serving policy would choose the action.

The proposed collection is **252 new ranked families × four arms × two physical seats × two matched
futures = 4,032 fights**. Use 180 training and 72 validation families, allocated before any outcome.
Balance maps and pick order within each split. Sample both doctrines independently and uniformly, and
report actual assignments and all nine matchups. There is no strength confirmation bank or fit in this
collection proposal. A later model needs a separate frozen recipe, admission and fresh comparison.

Each family must retain the current draft, artifacts, opponent behavior, funded support splits and
incumbent free formation. The changed budget is applied through the native public Setup purchase path,
then the exact incumbent geometry is restored legally. Any changed body quantities, illegal placements,
unfunded purchase or changed opponent setup is an admission failure, not a case to replace or drop.
Fixing geometry makes the incumbent the matched free comparator as well as the current control for these
labels. This does not qualify a later policy that changes formations, Placement spending or splits.

`premium_matched_upgrade_snapshot.ts` prepares the separate SQLite contract. It requires all 16 outcomes
per registered family, exact arm/seat/future identity, matching source/runtime/profile hashes, a global
pre-outcome lock, full-A19 and native-application receipts, and matching geometry/body/opponent hashes.
Its `training_comparison` view contains only training-family candidate-minus-incumbent labels for the same
seat and future. Validation remains outside that view. The artifact is explicitly development data and
cannot open as a normal Premium evidence snapshot or replace production SQLite. Partial and duplicate
banks fail; existing files are never overwritten.

The helper and artifact tests are exhaustive over all 783 funded plans and use synthetic outcomes for
SQLite checks. They are **not** a completed native serving audit. Before launch, a separately recorded
admission must verify current server purchase/formation/barrel/spellbook application, exact zero-intervention
controls, complete local/remote replays, dependency identity, excluded historical/peer seed channels,
pre-outcome lock chronology and the source of every raw-fight hash. The SQLite validator verifies the
declared receipts; it cannot establish the truth of a receipt without that independent raw/native audit.

This follow-up remains preparation until a new compute window is authorized. The previous collection,
its held-out families, source capsules and production snapshot remain immutable. No follow-up simulation,
learner, automatic confirmation, promotion or deployment is started by these modules.

These are **logged policy outcomes**, not paired counterfactual outcomes. Positive action probability
permits a separately specified off-policy analysis, but does not make arbitrary probability-weighted estimates
reliable: inspect overlap, effective sample size, family dependence and downstream policy changes. The full
joint setup space is large; sparse support requires abstention or new controlled labels. Never choose the
largest conditional SQL win rate and call it a validated counterpick. Actor IDs, seeds, source locations,
future outcomes and concealed fields must not become model features.

## Small acceptance run

Use the canonical runner with 576 fights per cohort: seven cohorts, **4,032 fights / 2,016 seat-paired
families**. This is a pipeline and coverage check, not a policy-strength test. Require all maps, actual
independent doctrine assignments and nine doctrine matchups, exact registered families, zero rejected
actions, conserved stacks, correct probabilities, legal pre-decision observations, train/test separation,
raw-to-SQLite parity, and a complete `ai-meta.outputs.json` receipt. Preserve original sources and failed
attempts. Smoke and A/A cases stay outside the bank.

On worker failure the collector finishes the gzip stream before propagating the error, preserving all
completed pair records. Rectangular formation anchors are checked by exact coordinates before normal
placement fallback; packed cell hashes must not alias an off-board anchor into the deployment zone.
Recover incomplete cases only through an explicit fixed-case admission that preserves original IDs,
seeds, observations, source lineage and successful raw records. Replayed correctness cases and technical
repeats do not add independent evidence.

```sh
AI_META_STUDY_PROFILE=premium-ranked-v4 bun src/simulation/measure_ai_meta_cohorts.ts \
  576 3161604032 /path/to/fresh-output 6 \
  ranked-draft,uniform-mixed,ranged-heavy,ground-melee,flyer-heavy,caster-support,cross-archetype \
  1 v09-draft-a19-work
```

The process-sharded meta wrapper is preferred on Puffalo. Snapshots remain development artifacts. The
candidate-publication gate explicitly rejects learning captures; the existing reviewed production snapshot
and bot stay unchanged. Qualification of a learned policy requires separately frozen models and independent
current-engine comparisons, including each own doctrine and authoritative serving checks.

## Historical draft memory preparation

The separate [draft-memory pipeline](premium_draft_memory.md) reads captured ranked training histories
from either v3 or v4 snapshots, reconstructs opponent-state targets, fits a fixed compact occupancy
estimator and evaluates it by whole-family folds. `export_premium_draft_memory.ts` is the reusable
entry point; the original snapshot and its held-out partitions stay unchanged. Its public-view observer
returns beliefs, not picks. A refreshed snapshot or a better prediction-error score does not activate a
new default drafter or establish stronger ranked play.
