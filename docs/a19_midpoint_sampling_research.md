# Actual R2 midpoint sampling

Registered on 2026-10-25. Status: **complete and independently verified; confirmation did not qualify the sampling rule**.

The [previous actual-continuation study](a19_actual_continuation_research.md) found that nineteen of twenty-four sampled baseline positions produced only wins or only losses over sixteen combat worlds. This experiment tests whether a present-state sampling signal produces more informative terminal labels while holding the army, actor side and battle phase together. It does not test a new action selector or an all-turn AI policy.

## Frozen comparison

The source remains `80180ef46464daf3b580e98a2e7f1ebad92a3d87`, with the isolated actual-continuation observer, its target-memory identity fix and the new pure `selectMidpointActualContinuationPair` sampler. No production module imports the sampler. Captured server search/draft/setup files match the current checkout and its common pin. Both seats retain actual H64/complementary R2 search, material tie arbitration, certified/tight bounds, current ranked draft/setup, fully funded Battle Trance, live supply, rolled synergies, tactical splits and side-oriented placement. The M4 uses twelve simulation workers.

The pilot requests 36 independent offer boards, base seed `2720300000`. One game per board uses index `4 * board + floor(board / 3) % 4`: twelve boards per map and three of every pick-seat/battle-mirror combination per map. Three separate smoke boards use `2720290000`. Conditional confirmation requests another 36 independent boards at `2720310000`; it never reuses a pilot family.

A root is eligible when the selected R2 baseline has a finite returned score and its retained catalog has at least two distinct finite-scored action signatures. The midpoint sampler restricts the selected baseline score to exactly 0.5, then uses the existing actor-side/phase/stable-hash selection rule. A returned R2 score may contain certified pruning bounds. The midpoint is therefore a named acquisition signal being tested, not an assumed win probability or proof of search uncertainty.

The matched control comes from all eligible positions in the chosen midpoint root's actor team and phase. Phases remain opening (laps one/two), middle (three through five) and late (six onward). A separate stable hash chooses the control without inspecting any terminal outcome. It may select the same position. If a family has no midpoint, both roles use the original unfiltered sampler. Missing positions receive no replacement. No-midpoint, identical-root and unavailable-family cases contribute zero acquisition gain while remaining in the requested-family denominator.

## Labels and primary metric

Each unique root gets eight post-root combat seeds. The two roles share those eight seeds within their army family; different families and cohorts use distinct seeds. All 600 registered seeds, including smoke and conditional confirmation, are checked for global uniqueness and exclusion from the earlier two continuation seed domains. The original match/search seed, exact pre-action prefix, unit IDs and UUID counter remain fixed. The baseline action is unchanged; all later eligible turns on both teams use actual R2 search.

Before any cohort's label collection, every unique root and all eight planned seeds must pass a native-reference versus observer post-action witness. It compares complete battle state, target memory, damage statistics, UUID counter and the next eight combat draws. Source/tool drift, mismatched prefixes and rejected actions invalidate the cohort. Only terminal elimination supplies win/draw/loss labels, scored 1/0.5/0 for the root actor's side. Censoring blocks the gate. Identical role roots reuse one set of actual records rather than being counted as independent observations.

For each root, terminal disagreement is the mean absolute score difference across all 28 unordered pairs of its eight outcomes. With decisive outcomes this estimates the chance that two independent continuations disagree. An always-winning, always-losing or always-drawing root has zero disagreement. This measures terminal-outcome diversity. Higher stochastic variation alone does not establish better action-ranking labels or a training benefit; those require a separate counterfactual-action or learned-model comparison.

The primary statistic is the midpoint-minus-control disagreement difference, averaged equally over all 36 requested families. The registered percentile interval resamples whole families 20,000 times, with bootstrap seeds `2720329000` for the pilot and `2720339000` for confirmation. Combat replicates and the two positions within an army never become separate independent families. Exact paired sign-flip evidence and counts of roots containing both decisive wins and losses are secondary diagnostics.

The pilot advances only with complete valid labels, at least twelve distinct matched pairs, mean disagreement gain at least 0.05 and a registered 95% interval whose lower endpoint exceeds zero. Otherwise confirmation stays unstarted. Confirmation applies the unchanged rule and the same gate on its own fresh families. Cohorts cannot be pooled to reverse a failed gate. Passing qualifies only a research acquisition rule; a learned game policy still needs separate representative full-match strength and timing qualification.

## Input and implementation checks

All nine targeted tests passed, including exact post-action state/RNG parity, replay rejection and restoration, input-order/outcome independence, matched actor/phase selection, the unchanged fallback and distinct finite-score eligibility. The frozen complete common build passed 7,182 tests and TypeScript.

The pilot selected 24 families with midpoint roots and 23 distinct matched pairs, totaling 59 unique roots. The other twelve families remain as the registered fallback. An independent Python implementation reproduced every eligibility decision, stable hash, role assignment, map/seat/mirror stratum and feature dimension before any return-label files existed. Its independent implementations also matched 1,000 canonical RNG draws and all 600 registered seed hashes before outcome inspection.

The same verifier reconstructed every raw score and pairing, all exact state witnesses, rational terminal disagreement, an integer-scaled whole-family bootstrap, paired sign-flip evidence and the gate. Its state-return export separates present inputs from the eight terminal labels and groups both acquisition roles by offer-board family. These are native baseline state returns; retained alternative actions do not acquire terminal labels merely by appearing in the catalog. The legacy feature flag `isNativeIncumbent` is explicitly mapped to `isR2Selected`.

## Pilot result and confirmation

The pilot passed its registered gate. Matched controls averaged terminal disagreement 0.13392857, versus 0.19146825 under midpoint acquisition. The mean difference was **+5.75397 disagreement points**, with the registered 95% whole-family interval **[+0.54563, +11.40873] points**. The exact paired sign-flip p-value was 0.04754639. Ten family differences were positive, five negative and twenty-one tied. Roots containing both decisive wins and losses increased from twelve to seventeen out of the same 36 requested families.

All 472 baseline continuations completed by elimination with zero rejected actions or censoring. They performed 16,547 actual searched turns after the selected roots. All 472 native/observer state witnesses passed before label collection. The independent verifier reproduced every raw score, exact rational disagreement, integer-scaled bootstrap endpoint, paired p-value, count and gate. The role averages required 31.03 future R2 decisions per control continuation and 35.52 per midpoint continuation; these describe simulation work rather than a live timing benchmark. Both roles cover twenty-nine opening, six middle and one late position.

The pilot result triggered the unchanged 36-family confirmation. Its input audit also passed before any confirmation labels existed: 24 families had midpoint positions, 22 had distinct pairs, and 58 unique roots were retained. All 464 confirmation state witnesses passed. The two cohorts have 72 distinct match seeds, and every map remains represented in the midpoint-available population. The confirmation result below is evaluated separately from the pilot; the cohorts are not pooled to reverse a failed gate.

## Confirmation result and decision

Fresh confirmation did **not** pass. Matched controls averaged disagreement 0.15575397, versus 0.19494048 for midpoint acquisition: **+3.91865 points**, with the registered 95% whole-family interval **[−0.09921, +8.23413] points**. The exact paired sign-flip p-value was 0.08105469. Eight family differences were positive, three negative and twenty-five tied. Roots with both decisive wins and losses increased from thirteen to nineteen, a secondary descriptive result.

| Cohort             | Independent families | Mean disagreement gain | Registered 95% interval | Gate   |
| ------------------ | -------------------: | ---------------------: | ----------------------- | ------ |
| Pilot              |                   36 |        +5.75397 points | [+0.54563, +11.40873]   | Passed |
| Fresh confirmation |                   36 |        +3.91865 points | [−0.09921, +8.23413]    | Failed |

The fresh estimate falls below the five-point minimum and its interval includes zero. The rule therefore remains outside the default collector. The predeclared threshold, seeds, sampling and analysis were unchanged. A positive pilot and higher mixed-outcome counts do not replace confirmation, and no AI-strength improvement is claimed from either cohort.

All **936 terminal label branches** completed by elimination with zero rejected actions or censoring. Including 26 smoke matches and 261 native/recording/identity controls, the campaign completed **1,223 full-match replays**. Every one of the **936 exact post-action comparisons** passed before its cohort's label collection; their 1,872 stopped prefixes are counted separately from full fights. Actual searched turns after roots totaled **32,925**.

The two development corpora contain **117 unique baseline-state records across 72 independent army families**, each with eight terminal worlds. Identical acquisition roles share one record. Independent verification reproduced both cohorts' input selection, raw terminal labels, family grouping, rational disagreement, bootstrap endpoints, exact paired evidence, counts and qualification decisions. The confirmation role averages required 32.28 future R2 decisions per control continuation and 33.73 per midpoint continuation. These descriptive work counts do not establish live latency or training efficiency.

Keep the original acquisition default and serving R2 unchanged. The experiment suggests a possible association between a midpoint returned score and less saturated outcomes, but the registered acquisition qualification failed. Higher stochastic variation also does not demonstrate larger, more predictable action-value differences. Further learner work should use these records as development data, measure actual counterfactual action signal or predictive accuracy, and reserve new representative families for full-policy qualification.

A self-contained `report.html` displays both gates, intervals, all family comparisons and source/verification links. Each corpus uses a distinct state-return schema and explicitly labels its purpose; retained alternative candidates remain unlabeled metadata. No trained policy or serving snapshot is enabled by the report.

Generated recipes, source capsule, receipts, raw records and reports remain outside Git under the client repository's `game/core/tmp/premium-r2-midpoint-20261025`. All inspected families are development data for future models. No premium serving snapshot, production strategy, unit rule or deployment is changed.
