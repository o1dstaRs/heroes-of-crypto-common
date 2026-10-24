# A19 decision audit

`src/simulation/measure_a19_decision_audit.ts` diagnoses local decision errors without changing the played policy. It reuses the ranked draft simulator, candidate enumerator, search scorer, battle snapshots, and persistent worker pool. Importing it does not install instrumentation.

Run from the common package with a fresh output directory outside Git:

```bash
bun src/simulation/measure_a19_decision_audit.ts \
  --games 72 --workers 12 --seed 2026101701 \
  --out "$AUDIT_OUT"
```

`--server-root` or `HOC_SERVER_LOC` can select the sibling server checkout. Otherwise the runner resolves that sibling relative to this package. It reads the server's search, draft, and setup defaults as source data; it never imports server configuration or credentials. Unsupported computed profile definitions fail closed.

Freeze source before collecting a study. The manifest records source hashes, server-profile hashes, runtime, sampling rules, budgets, and game ordinals. A source change during collection prevents a completed report. Use a frozen source copy when peers are editing the shared main checkout. Runtime dependencies resolve from the existing installation; this is a diagnostic, not a deployment qualification.

## Sampling and controls

Games must be divisible by six. Each independent ranked draft board supplies both physical battle seats; Normal, Lava, and Block receive equal game counts. Both armies use the server's default draft and funded setup, public synergy variants, tactical splits, and side-oriented placement.

Every game first records its ordinary deterministic-work A19 trajectory. The audit selects decisions by a seeded hash within team and fight-phase strata: laps 1–2, 3–5, and 6+. It does not inspect outcomes or whether a shortlist pruned candidates. `--per-stratum` defaults to one.

The second execution returns exactly the ordinary A19 choices while probing sampled positions. Complete action trajectories and outcomes must match the first execution, and played actions must have zero rejections. Each position also verifies that counterfactual scoring restored its captured battle state. Compressed states, original scenarios, trajectories, and seed banks are retained.

## Discovery and independent validation

1. Capture the real final choice, filtered production catalog, shortlist, and actual score passes, including outer arbitration.
2. Enumerate a wider public action catalog with movement and attack caps removed. Score it through the existing engine at H64 with four paired rollouts. The declared catalog safety limit fails rather than silently truncating.
3. Evaluate all production finalists, the best discarded proposal, and the best missing proposal under 16 terminal continuations. These continuations use native policies; they are not recursively searched A19.
4. Select one challenger per disjoint category using that discovery bank. Compare them with the original final choice on an independent 32-rollout terminal bank. Record the H64 value along those same validation continuations too.

The categories are **missing** (absent from the filtered production catalog), **shortlist** (present but discarded), and **scoring** (a production finalist). Missing includes both generation caps and policy filters. Scoring can reflect finite sampling, horizon/evaluator behavior, or final arbitration; it does not establish a defective value representation by itself.

The HTML report retains negative validation differences and applies Holm correction to paired sign-flip tests across every tested position/category. Nonterminal continuations cannot supply win/draw/loss evidence. Discovery is bounded: missing and discarded alternatives are screened at H64 before terminal evaluation, so this is not an exhaustive oracle.

Outputs include `report.html`, `summary.json`, `manifest.json`, per-game JSONL evidence, original scenarios, control trajectories, and compressed decision states. Gains describe these local counterfactuals under native continuations. They are not full-match strength gains or authorization to change production. A proposed fix still needs fresh army-clustered, seat-balanced, live-map and production-latency confirmation.
