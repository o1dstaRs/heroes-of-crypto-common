# Premium snapshot draft memory

For fight-outcome valuation and the complete-information final-pick candidate, see
[historical matchup value](premium_draft_matchup_value.md). Occupancy beliefs alone do not value a pick.

`export_premium_draft_memory.ts` connects an audited historical SQLite snapshot to reusable draft
targets, a fixed-recipe CPU estimator, whole-family cross-validation and a compact inference artifact.
It does not refresh the incumbent draft weights or publish a strategy. The source default's frozen
interaction prior and V3/contextual heads remain unchanged. Updating SQLite alone does not update them.

## Prepare an artifact

From the common package, supply the independently verified **uncompressed SQLite** and its exact
source/file identities. The output directory must not exist:

```sh
bun src/simulation/export_premium_draft_memory.ts \
  /path/to/premium.sqlite SOURCE_SHA256 SNAPSHOT_SHA256 /path/to/new-memory-output
```

The command reads only `ranked-draft` training families through `trainingDraftHistory()`. It supports
captured v3 deterministic and v4 exploratory decisions with complete candidate distributions. It does
not join army scores or read original validation/test observations. Deterministic zero-probability
alternatives are retained as offers, never presented as alternative battle outcomes.

Each complete family's accepted chronology reconstructs the pre-action enemy roster, hidden occupied
offers, future accepted enemy picks and final enemy roster. An omitted decision, mixed family,
inconsistent collision, malformed probability, future visibility leak or incomplete army fails export.
The canonical public input remains separate from hidden/future targets, logged behavior and audit IDs.
Future picks describe the logged branch, not counterfactual replies to arbitrary other choices.

Outputs include `registration.json`, `opponent-targets.jsonl.gz`, `cross-validation.json`,
`validation-summary.json`, `model.json` and `readiness.json`. Registration fixes the recipe before any
fit. The snapshot is hashed before and after preparation, existing outputs are never overwritten, and
the original production snapshot remains untouched.

## What the model learns

`family-balanced-occupancy-v1` estimates whether a currently offered creature is already held by the
opponent. It uses smoothed phase/doctrine/unit counts plus separately supported public roster,
artifact, map and synergy context. Each family contributes at most one observation mass to each table
key. Retries and offered negatives do not create independent families. Sparse contexts shrink toward
the unit prior; source corpora are never silently mixed.

Five hash-defined folds keep every seat/retry from a family together. The primary diagnostic compares
the contextual estimate with the same-phase/doctrine/unit prior for Scout and Battle Trance, using
family-weighted Brier error and log loss. Spymaster's currently hidden occupancy is exactly zero.
There are five fold fits and one full-training fit, all closed-form frequency estimates with zero
gradient steps. The full fit is preserved regardless of the screen and remains unqualified research.
Neither classifier error nor collision frequency is a strategy win rate.

## Public count correction and runtime adapter

`draft_opponent_occupancy.ts` is a separate revision, `public-occupancy-count-v1`, added after the first
fit screen. Public phase/order determines how many enemy units of the current level were picked.
Subtracting visible enemies of that level determines exactly how many offered units are occupied.
This uses no concealed identities. The helper first verifies the entire offer set against the current
creature catalog, public bans, own roster and visible enemies. Unsupported input returns no forecast.

The helper projects probabilities onto the feasible set `0 <= p <= 1, sum(p) = occupied count`.
This corrects impossible probability mass, including positive occupancy for a level the enemy has not
picked yet. It changes neither the stored model nor its original screen. A smaller squared prediction
error after this projection does not demonstrate stronger picks or a match-score gain.

`createHistoricalDraftObserver(model)` in `src/ai/setup/draft_opponent_view.ts` compiles the explicit
artifact once and accepts only an acting player's projected view. It uses canonical phase-dependent map visibility,
preserves input/state, and returns beliefs or `null`. It reads no SQLite, changes no choices, consumes
neither existing override allowance and is not imported by a default profile. This is the tested
inference boundary for a future research selector, not a production-strength qualification.

## November 17 implementation evidence

The two historical sources were evaluated separately, using only their original training partitions:

| Source                                     | Ranked families | Pick contexts | Offered occupancy labels |
| ------------------------------------------ | --------------: | ------------: | -----------------------: |
| Published November 9, premium-ranked-v3    |           1,586 |        15,700 |                  122,856 |
| Exploratory November 16, premium-ranked-v4 |             224 |         2,132 |                   16,853 |

Every canonical export matched the earlier independent chronology audit. Independent Python
reconstruction checked all 19,842 retained full-model table entries and all 2,982 out-of-fold
family/doctrine score records. No original held-out observation, battle label or new strength game was
used. The original snapshot hashes and dirty-source/recovery provenance remain in each receipt.

The fixed contextual screen passed on the older corpus: family-weighted Brier error changed from
0.049206 to 0.049044 (improvement 0.000162, descriptive family-bootstrap interval 0.000140–0.000184).
It failed on the smaller exploratory corpus: 0.059476 to 0.059557 (improvement −0.000081, interval
−0.000208–0.000043). Do not rescue that failed screen using its Scout subset or merge the corpora.

The subsequent count check matched all 17,832 existing contexts and 96 synthetic native drafts.
Applied to the original out-of-fold predictions, its posthoc Brier reduction was 7.99% and 5.00%
respectively. Most of that improvement comes from public mechanics: against the equally constrained
unit prior, the contextual gain is much smaller, and exploratory Battle Trance still regresses.
These are development diagnostics. The original gates remain unchanged; no pick policy is qualified.

The two minified artifacts occupy approximately 545 KB and 160 KB. A warm local observer measured
median inference near 0.013 ms and p95 below 0.023 ms; the observed maximum was 4.04 ms. These are
local numerical benchmarks, not authoritative live deadline guarantees. Full-history observer parity also
caught and corrected a pre-admission adapter mistake: Spymaster sees the map early, but every doctrine
sees it from the first level-3 phase. The fit already used the correct historical public map; no model
or outcome changed. Both source snapshots and
generated artifacts stay outside Git in the client research capsule `premium-draft-memory-model-20261117`.

## Strength work still required

The next candidate must value whole-army counterplay and likely enemy completions, not blindly avoid
collisions: a collision can reveal information, and histories contain only the actual branch. Forecasts
are derived from bot self-play, not a demonstrated model of human opponent behavior. Spymaster needs
future-pick/army-value work rather than a fabricated hidden-current-roster prediction.

Use a distinct, prospectively frozen selector after the existing V3/contextual heads. Preserve their
choices and budgets; give any new override its own atomic persisted allowance. Compare complete new
ranked matches against the current default with identical authoritative setup/combat, uniform doctrines,
all collisions retained, whole-family uncertainty and independent confirmation. The user's useful-gain
floor remains +0.5 match-score points with positive lower bounds and nonnegative own-doctrine means.
No model changes, default integration, deployment or Premium publication follow from a belief screen
alone. Existing failed draft/upgrade/placement banks remain closed.
