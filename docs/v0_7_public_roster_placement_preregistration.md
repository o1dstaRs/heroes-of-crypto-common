# v0.7 public-roster placement promotion preregistration

Recorded at `2026-07-17 21:21:10 PDT`, before opening any targeted-cohort
result. This guard asks whether v0.7 should replace its partial draft-reveal
placement context with the complete roster that is public to both ranked seats
once placement begins. It does not authorize opponent private state, a setup
counter-pick, or an automatic deployment.

## Frozen behavior

- Control: frozen `v07-nonfight-4eda84635fe7` with placement
  `legitimate-reveal`.
- Candidate: the same artifact with only placement changed to `public-roster`.
  Its canonical behavior is `v07-nonfight-0847c0fa7739`, SHA-256
  `0847c0fa77398a806f1e67da0760b619dde4ae5210304cdcfaad1d8daa2ead84`.
- Both arms use the same shipped draft, artifacts, augments, synergies, v0.7
  combat policy, map, roster, pick seed, battle seed, and 60-lap cap.
- Candidate information is limited to deduplicated opponent creature ids. It
  excludes opponent positions, amounts, stats, perk, artifacts, augments,
  synergies, turn flags, and all live engine objects.
- Each board is crossed over both pick seats and both battle colors. The board
  is the independent statistical cluster.

## Frozen panels

- Natural guard: 5,000 unfiltered boards (20,000 games per arm), base
  `97171710`, panel `guard`. It ran from behavior source
  `33c9d6f5a47afbb8e29290426684f079215bf4b2`; the later commit below adds
  target allocation and tests without changing either arm's placement logic.
- Target guards: 1,000 outcome-blind accepted boards (4,000 games per arm) for
  each of `ranged`, `mage`, `melee-magic`, `aura-heavy`, and `melee-other`,
  base `97171710`, panel `guard`, source
  `af5cf74b35d76fcbac3397e12b2f8cb4ae84cee8`.
- Target allocation inspects draft composition only. No fight outcome is
  observed while accepting boards.
- The three live maps are `NORMAL`, `LAVA_CENTER`, and `BLOCK_CENTER`.

The raw reports and their byte hashes must be retained. A derived promotion
report may summarize them, but may not replace or rewrite them.

## Promotion bars

All bars must pass:

- Natural paired score gain is at least `+0.50pp` and its clustered 95% lower
  bound is strictly above zero.
- The natural actionable slice has at least 5,000 games, paired score gain at
  least `+2.00pp`, and clustered 95% lower bound strictly above zero.
- Every live map has a nonnegative paired point estimate and a clustered 95%
  lower bound above `-0.25pp` on the natural guard.
- Each of the five targeted groups has a nonnegative paired point estimate and
  a clustered 95% lower bound above `-1.50pp`.
- Candidate and control each have zero rejected actions. No failed game may be
  omitted.
- In the natural panel and each target, candidate draw incidence and
  Armageddon incidence may not exceed matched control by more than `1.00pp`.
  Candidate average duration may not exceed control by more than one lap.
- A replay sample must reproduce the same setup and complete behavior-trace
  hashes. Public-context hidden-state invariance tests must pass.

Failure remains research evidence and leaves the incumbent unchanged. Passing
permits review, a separately committed immutable artifact, full common/server/
client gates, and a staged deployment in which code is deployed before the
production policy environment is changed.

## Mainline rebalance amendment

Before the targeted result was used for promotion, common commit
`99360a273ed30c6aab4415f8f7ba77b18795e183` changed the combat effects of three
Tier-2 artifacts. The panels above are therefore retained as historical
diagnostic evidence only. They cannot promote a policy on or after that commit.

A replacement guard keeps every bar above and changes only the source and seed
stream:

- Behavior source starts at `99360a273ed30c6aab4415f8f7ba77b18795e183`.
  Later source commits are allowed only when their diff is limited to this
  preregistration, setup-context types/constructors, the explicit frozen
  placement candidate, and research/test plumbing. No combat, draft, scoring,
  placement, artifact-effect, or roster-generation change is allowed.
- Replacement base seed is `232221694`, panel `guard`. Under the panel's
  modulo-`2^30` permutation this is the old base advanced by exactly
  300,000,000 board indices. Replacement natural and target lanes therefore
  occupy the old stream's bounded ranges starting at 300m, 350m, 400m, 450m,
  500m, and 550m, disjoint from every opened range above.
- Sample sizes remain 5,000 natural boards and 1,000 accepted boards for each
  target. Sharding may change execution order but not the board ledger.
- Target qualification is calculated only from the candidate-seat records
  whose reconstructed drafted roster carries the requested inclusive
  diagnostic tag. `melee-other` remains the exact exclusive setup cohort.
  Draft reconstruction is outcome-blind and must match every persisted board,
  pick seed, pick seat, and control record before scoring.

No replacement outcome may be opened until this amendment is committed and
pushed. The replacement becomes ineligible if its final source diff exceeds the
allowlist above.
