# Placement research: promotion decision

Status on 2026-10-16: **none of the October 14–16 paid-corner or screen-repair experiments is approved for production.** Negative and inconclusive results remain research only. Do not wire their helpers, spending plans, or outcome-selected matchup exceptions into a shipped profile.

The latest completed study used 2,160 fights across 72 fresh army matchups, both physical seats, three enemy formations, and Black Dragon, Thunderbird, and Griffin opponents. It preserved Armor 3 and paid for Placement 2 by removing Might 1 and one level of Sniper or Empower. Both packed-corner and spread formations were tested. Observed score differences were:

| Cohort                                   | Paid formation | Versus matched free | Versus current behavior |
| ---------------------------------------- | -------------- | ------------------: | ----------------------: |
| At least four shooters                   | Corner         |            +2.78 pp |                −9.49 pp |
| At least four shooters                   | Spread         |            −2.78 pp |                −9.72 pp |
| Three direct-damage casters, no shooters | Corner         |            −7.87 pp |                +3.47 pp |
| Three direct-damage casters, no shooters | Spread         |           −11.81 pp |                −0.69 pp |

All eight family-adjusted 95% intervals included zero. **Neither formation in either cohort qualified for fresh confirmation.** Paid formations gained one rear cell, and spread formations had no adjacent carry pairs, but those geometric benefits did not establish an overall score gain. These results do not prove every Placement policy harmful; they leave these candidates unqualified.

The preceding study used 1,728 fights across another 72 fresh army matchups and preserved offense instead of Armor. Against the matched free corner, observed score differences were:

| Cohort                                   | Placement 1 | Placement 2 |
| ---------------------------------------- | ----------: | ----------: |
| At least four shooters                   |    −6.25 pp |    −1.85 pp |
| Three direct-damage casters, no shooters |    −1.39 pp |    −8.80 pp |

All eight family-adjusted 95% intervals (paid levels against both the free control and current behavior) included zero. No policy passed. Placement 2 increased early attacks on average; that is not evidence of a final fight-score improvement. The preceding 48-army Thunderbird screen confirmation also failed: its equal-formation mean was +0.09 pp with an interval spanning zero, and the spread-opponent point estimate was negative. A favorable original matchup or subgroup does not override failed confirmation.

The generated reports and raw results remain untracked under the client repository's `game/core/tmp/placement-armor-spread-20261016`, `game/core/tmp/placement-heavy-20261016`, and `game/core/tmp/placement-thunderbird-20261015`. Latest study source: `d78b0441eba7b1f6dfa4c2ad6113067a617ae0fd`; frozen source SHA-256: `d2f503cd6681139e868c8a3161f1ec8841eeb2f7803db3a386e09e8465ffdcda`. Its completion receipt records validation, source identities, and artifact hashes. The latest source and own-roster-only artifact sampler differ from the preceding study; scores must not be pooled across these waves.

A read-only audit of 163 saved test-server reports found just two current-board seats matching the four-shooter/flyer population and none matching three damage casters against a flyer. Neither of those two seats was AI-controlled. Two- or three-shooter mixed armies appeared in 13 flyer-facing seats, including five AI seats. This identifies a more common population for separate research; it is not evidence for enabling any Placement rule.

## Requirements for a future promotion

1. Register the candidate, population, sample size, controls, seed allocation, and multiplicity correction before evaluating its outcomes. Freeze source and record configuration. A changed rule is a new candidate.
2. Compare fully funded paid plans against **both** current behavior and a matched free formation. Keep paired opponents, artifacts, rosters, and combat seeds fixed. Account for extra splits and conserved spell resources.
3. Use independent armies as the confidence unit; mirrored seats and repeated seeds are not extra independent army samples. Check both seats, the live maps, relevant threats, and varied opponent deployments.
4. Require a positive adjusted confidence interval against both controls on the prespecified target population, followed by fresh held-out confirmation. Inconclusive results are not permission to promote. More early attacks, a positive point estimate, or a favorable post-hoc slice is insufficient.
5. Verify that the intended conditions occur in actual games and can be selected from information legally available when the bot acts. Test the authoritative server path and existing controls before enabling anything.
6. Record the completed evidence and explicit promotion decision when changing the default. Do not weaken the gate, silently expand a passing subgroup, or reuse confirmation data to tune and qualify the same rule.

`test/ai/placement_research_isolation.test.ts` checks that the rejected screen helpers are unreachable through the public game API and battle engine, and that the shipped setup policy retains its no-purchase behavior for representative shooter/caster armies against the three flyers. The existing default-profile tests pin the production strategy chain and source ledger. These checks guard the current decision; they do not make experimental helpers safe to promote.
