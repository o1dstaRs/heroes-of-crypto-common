# v0.7 composed ranked ladder result (2026-07-16)

This is the sealed result of `v0.7-composed-ranked-20260716-v2-prereg`. It measures candidate-only v0.7
rollout search (`v0.7s`) against v0.6 under the current round-one draft/setup distribution, four independently
seat-conditioned ranked taxonomy cohorts, and eight fixed tactical templates. It is research evidence only and
does not authorize a bake, default change, or deployment.

## Seal

- Common revision: `a52564d339f89add5b9a5c501c7c2356af233579`
- Games: 38,000 total; 28,000 in 13 formal qualification cells
- Formal family: 26 cell-seat claims, Bonferroni two-sided Wilson, familywise confidence 95%
- Final verdict: `FAIL`
- Release instruction: `NO_AUTOMATIC_BAKE_OR_DEPLOY`
- Sealed at: `2026-07-16T12:50:58.570Z`
- Final report SHA-256: `acd3ab90e2d9434757ffa56e1c3ddfcda0922297b73d3d90f832b9116a90114b`
- Sealed run SHA-256: `4eaf8d7170d2eadeda902c8d43b99d25ed896ec1e1f509ed830143199c69a40b`
- Guard ledger: 295 contiguous entries; canonical replay and every archived evidence hash passed

All integrity gates passed. The outcome, decisive-fraction, draw/Armageddon, and latency families did not.
Across formal cells, the pooled diagnostic was 21,422 wins, 5,542 losses, and 1,036 draws (79.45% of decisive
games), but pooled evidence is not a qualification claim.

## Search envelope

| Profile                     | Overall decisive | Candidate green | Candidate red | Operational result                    |
| --------------------------- | ---------------: | --------------: | ------------: | ------------------------------------- |
| Search off alias control    |           50.00% |             n/a |           n/a | Exact paired symmetry                 |
| Uncapped                    |           87.74% |          94.18% |        81.27% | No fallback/circuit; not live latency |
| 300ms lower-bound emulation |           75.64% |          84.74% |        66.45% | 2,875/4,000 games opened circuit      |
| Conservative 200/275        |           82.73% |          90.68% |        74.71% | 26.87% fallback; 139 circuit games    |

The uncapped green-seat Wilson low was 92.33%, while red was 78.40%. The conservative green point estimate
exceeded 90%, but its corrected low was only 88.46%; red was 74.71%. A pooled score therefore hides a large,
repeatable seat deficit.

## Ranked taxonomy

Decisive win rates by physical candidate seat:

| Cohort     |  Green |    Red | Fallback | Circuit games |
| ---------- | -----: | -----: | -------: | ------------: |
| Mage       | 89.45% | 66.90% |   26.10% |            37 |
| Melee Mage | 90.55% | 77.95% |   30.35% |            72 |
| Aura       | 90.06% | 73.62% |   26.98% |            71 |
| Ranged     | 90.09% | 71.52% |   31.43% |            63 |

No taxonomy seat certified 90%. Every red seat was materially below target, and every cell failed the
operational gate.

## Tactical templates

| Template            |  Green |    Red | Draw/Arm green/red | Outcome note                       |
| ------------------- | -----: | -----: | -----------------: | ---------------------------------- |
| Mage Frontline      | 97.29% | 97.09% |        1.0% / 0.7% | Both seat outcomes certify 90%     |
| Mage Fireline       | 48.31% | 52.11% |      88.1% / 84.8% | Late-finish integrity failure      |
| Melee Magic Utility | 71.46% | 72.44% |        0.5% / 0.3% | Broad tactical weakness            |
| Melee Magic Brawler | 94.09% | 92.59% |        0.3% / 0.2% | Green certifies; red low is 89.59% |
| Aura Support        | 69.92% | 65.60% |        0.7% / 0.8% | Broad tactical weakness            |
| Aura Offense        | 93.88% | 95.59% |        0.4% / 0.8% | Both seat outcomes certify 90%     |
| Ranged Precision    | 52.02% | 49.52% |      47.8% / 49.2% | Strength and late-finish failure   |
| Ranged Control      | 89.35% | 76.65% |        2.0% / 6.4% | Red-seat weakness                  |

Even the strong templates failed the combined gate because deadline fallback and circuit opening remained
nonzero. The next optimizer must use the minimum of every cohort-seat claim, preserve Mage Frontline and Aura
Offense, and separately ratchet Fireline/Precision draw-Armageddon integrity while reducing search cost.

## Evidence

The byte-exact compact artifacts are archived in
`docs/evidence/v0_7_composed_ranked_result_20260716/`. The 135 MB raw/audit corpus remains at
`/Users/zolotukhin/Workplace/hoc-v07-composed-ranked-output-20260716/v0.7-composed-ranked-20260716-v2-prereg`;
`sealed-run.json` retains every file path, byte count, row count, and SHA-256.
