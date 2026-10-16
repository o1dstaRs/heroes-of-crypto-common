# Placement research: promotion decision

Status on 2026-10-16: **none of the October 14–16 Placement spending or screen-repair experiments is approved for production.** Negative and inconclusive results remain research only. Do not wire their helpers, spending plans, or outcome-selected matchup exceptions into a shipped profile.

The latest completed primary comparison used 2,592 fights across 108 fresh mixed-army matchups with exactly two or three native shooters. Own budgets were five, six and seven; maps were Normal, Lava and Block; opponents included Black Dragon, Thunderbird and Griffin. Both physical seats and three enemy formations were tested. Our army retained the normal server formation in every arm, so the frozen baseline and the matched free-formation control were the same arm, counted once. Paired score differences, averaged within each independent army, were:

| Paid plan                                         | Difference versus baseline / matched free | Family-adjusted 95% interval |
| ------------------------------------------------- | ----------------------------------------: | ---------------------------: |
| Placement 1; retain Sniper 3                      |                                  −4.55 pp |           −10.50 to +1.39 pp |
| Placement 2; retain Sniper 3                      |                                  −6.48 pp |           −13.70 to +0.74 pp |
| Placement 2; retain baseline Armor, reduce Sniper |                                 −15.43 pp |           −22.27 to −8.59 pp |

The intervals adjust for all three planned comparisons. **No plan qualified for fresh confirmation; the Armor-preserving plan showed a supported loss.** Placement 2 retaining Sniper increased main ranged actions before direct carry melee from 5.27 to 5.77, while its final score fell from 58.26% to 51.77%. More early attacks do not override the score result. Favorable descriptive slices, including shooters that ignore range falloff, remain exploratory and do not qualify a rule.

Another 216 diagnostic fights on a prespecified subset of 18 of those armies compared extra split slots, expanded space and the removed combat stats. All four descriptive intervals included zero. The full paid plan's estimate on that small subset was +7.41 pp, with a 95% interval of −10.62 to +25.44 pp; this does not override its failed 108-army comparison. These diagnostics neither identify a reliable component gain nor provide another independent qualification sample.

A separate 432-fight follow-up on 54 fresh armies was registered before either study's combat scores were inspected. It tested Placement 2 retaining Sniper against two seven-point Movement 2 enemy builds, using normal server formations and both seats:

| Enemy plan                         | Our Placement 2 versus baseline / matched free | Family-adjusted 95% interval |
| ---------------------------------- | ---------------------------------------------: | ---------------------------: |
| Armor 3 + Might 2 + Movement 2     |                                       −1.39 pp |           −11.89 to +9.11 pp |
| Placement 2 + Armor 3 + Movement 2 |                                      −12.96 pp |           −25.97 to +0.04 pp |

The intervals adjust for both planned comparisons across 54 independent armies. **Neither qualified for fresh confirmation.** The positive three-shooter estimate against the first enemy build (+8.33 pp, unadjusted interval −5.92 to +22.59 pp) remains an inconclusive descriptive slice, not a new rule.

This follow-up addressed a measured coverage gap: 10 of 13 historical mixed-army/flyer opponents bought Movement 2, whereas none of the primary study's 108 bot-controlled opponents bought Movement or Placement. Hidden opponent augments are not legal inputs to the setup policy; an experimental opponent-plan condition is not itself an implementable dispatch rule. Opening movement and aura probes did show possible geometric protection, but the controlled fight scores did not establish a net benefit from either spending plan.

All 3,240 study fights completed without rejected actions. The 48 primary and 16 follow-up smoke fights reproduced their full recorded results, excluding elapsed time. Independent checks rebuilt all 432 paired army differences across the five planned comparisons. The 216 diagnostic fights reuse 18 primary armies; there are 162 fresh army matchups in total, not one independent sample per fight. A separate historical audit checked 620 accepted actions from all 13 matching saved games; five concessions and two abandonments prevent treating those records as a controlled win-rate comparison.

The mixed-army source was frozen at `7296ea9dc1a03d826df8186b93f2f814ee43a6e4` (source SHA-256 `cba83f0ade4765db6a812284ba938c266c514f0e97e1853b683b196ca931426b`). Mainline tactics and terrain handling changed after that freeze, so any promising candidate would require fresh confirmation on current code. Research output stays untracked under the client repository's `game/core/tmp/placement-mixed-stock-20261016`; the fast-opponent follow-up is separate within that directory. No experimental runtime policy was enabled.

The preceding Armor-preserving study used 2,160 fights across 72 fresh army matchups, both physical seats, three enemy formations, and Black Dragon, Thunderbird, and Griffin opponents. It preserved Armor 3 and paid for Placement 2 by removing Might 1 and one level of Sniper or Empower. Both packed-corner and spread formations were tested. Observed score differences were:

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

The earlier generated reports and raw results remain untracked under the client repository's `game/core/tmp/placement-armor-spread-20261016`, `game/core/tmp/placement-heavy-20261016`, and `game/core/tmp/placement-thunderbird-20261015`. Armor-preserving study source: `d78b0441eba7b1f6dfa4c2ad6113067a617ae0fd`; frozen source SHA-256: `d2f503cd6681139e868c8a3161f1ec8841eeb2f7803db3a386e09e8465ffdcda`. Its completion receipt records validation, source identities, and artifact hashes. That source and own-roster-only artifact sampler differ from the preceding study; scores must not be pooled across these waves.

A read-only audit of 163 saved test-server reports found just two current-board seats matching the four-shooter/flyer population and none matching three damage casters against a flyer. Neither of those two seats was AI-controlled. Two- or three-shooter mixed armies appeared in 13 flyer-facing seats, including five AI seats. This identifies a more common population for separate research; it is not evidence for enabling any Placement rule.

## Requirements for a future promotion

1. Register the candidate, population, sample size, controls, seed allocation, and multiplicity correction before evaluating its outcomes. Freeze source and record configuration. A changed rule is a new candidate.
2. Compare fully funded paid plans against **both** current behavior and a matched free formation. Keep paired opponents, artifacts, rosters, and combat seeds fixed. Account for extra splits and conserved spell resources.
3. Use independent armies as the confidence unit; mirrored seats and repeated seeds are not extra independent army samples. Check both seats, the live maps, relevant threats, and varied opponent deployments.
4. Require a positive adjusted confidence interval against both controls on the prespecified target population, followed by fresh held-out confirmation. Inconclusive results are not permission to promote. More early attacks, a positive point estimate, or a favorable post-hoc slice is insufficient.
5. Verify that the intended conditions occur in actual games and can be selected from information legally available when the bot acts. Test the authoritative server path and existing controls before enabling anything.
6. Record the completed evidence and explicit promotion decision when changing the default. Do not weaken the gate, silently expand a passing subgroup, or reuse confirmation data to tune and qualify the same rule.

`test/ai/placement_research_isolation.test.ts` checks that the rejected screen helpers are unreachable through the public game API and battle engine, and that the shipped setup policy retains its no-purchase behavior for representative shooter/caster armies against the three flyers. The existing default-profile tests pin the production strategy chain and source ledger. These checks guard the current decision; they do not make experimental helpers safe to promote.
