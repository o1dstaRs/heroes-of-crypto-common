# Neutral cemetery barrel strikes

The user asked to continue the "stop attacking barrels when it is unnecessary" work and to establish
a measurable gain over the default. The [confirmed melee barrel
correction](melee_barrel_deliberation.md) covers one case: a melee strike on a **deployment**
barrel. Its eight forecast and predictor follow-ups are closed or incomplete and stay unchanged.
This study covers the cases that correction left alone.

**Status, November 19, 2026.** Comparing neutral barrel strikes instead of returning them is stronger
on Cemetery by **+3.58 match-score points (95% +2.44 to +4.75)** on a registered held-out bank of
2,700 fresh families, under the most adverse reading of six rejected games. The switch exists and is
**off**. Two registered gates failed: quality, on one rejected game, and serial cost, by 0.14
points. Adoption therefore needs an explicit user decision.

## Where the remaining strikes come from

`prioritizeV08CemeteryObstacleAttack` runs last in the native v0.8 policy. Whenever a turn has no
committed attack or cast and a one-hit stone stands, it replaces the native move, wait or hold with
an obstacle strike. A shooter spends a shot on the nearest standing stone. A melee stack walks to a
stone and hits it. A19 then returns that strike without comparing anything, except for the adopted
melee deployment-barrel case.

Every ranked Cemetery board carries nine to twelve neutral barrels, so the rule fires in every
Cemetery game. Default play on 1,080 fresh draft families (2,160 games, 4,320 seat-games) shows:

| Measure per seat-game                   |       Value |
| --------------------------------------- | ----------: |
| Searched root decisions                 |       26.01 |
| Neutral barrel strikes                  |        3.27 |
| Share of all root decisions             |       12.6% |
| Melee / ranged strikes                  | 2.85 / 0.43 |
| Strikes that replaced a native **move** |        1.91 |
| Strikes that replaced a native **wait** |        1.36 |

One turn in eight is a barrel strike. Essentially all of them return without a comparison: six of
14,138 strike proposals took a special path. A separate observation of 45 games classified each
struck barrel with the engine's projectile ray: about 30% block only the striker's own army's
available shots, 26–40% block both armies, about 14% shield only the striker's army from enemy
shots, and about 30% block nobody. These descriptive shares do not price any strike.

## Candidate

`a19-neutral-barrel-deliberation-v1` widens the adopted comparison. At an actual A19 root whose
native incumbent strikes a standing **neutral** stone, melee or ranged, the strike enters the same
deliberation the v9 switch gives melee deployment-barrel strikes: no cemetery fast return, legal
wait and defend challengers, no forced-productive tier, and the unchanged H64/R2/K6 search, value
gate, scored and material arbitration and neural tie correction. The strike remains candidate zero
and survives ties and deadline fallbacks.

Nothing else changes. The native cleanup still proposes the strike at roots and inside every
forecast. Deployment barrels keep the adopted handling, including the ranged fast return. Classic
mountains, draft, setup, splits, placement, models and budgets are untouched. Boards without a
standing neutral stone cannot change.

An instrumented 40-game observation explains what the comparison does. At 79% of melee and 90% of
ranged strike roots the two forecasts tie exactly between the strike and its best alternative, so
A19's existing material and neural tie arbitration picks the action. The strike is strictly worse in
16% and 8% of roots and strictly better in 5% and 3%. On the development bank the entrant kept 32.5%
of 10,074 strike proposals and replaced the rest with a move (29.1%), a wait (26.1%), a defend
(7.9%), a spell (4.1%) or a shot (0.3%). Its executed barrel strikes fell from 3.27 to 1.51 per
game.

## Development

Every bank is Cemetery only and uses actual V3/contextual/exclusive-delivery drafts, real paid
setup, splits and final placement, all nine own-by-opponent doctrine pairings, balanced pick order
and both physical seats. No eligibility filter selects families: drafts are taken in scan order. The
named entrant runs the candidate; the opponent runs the unmodified default. A family is one draft in
both seats, and intervals resample whole families.

An exposed reconnaissance on 72 Sniper-study Cemetery families came first. The comparison gained
+4.17 points (95% −1.39 to +9.72). Never striking, at roots and inside the entrant's forecasts,
scored −0.69 (−7.64 to +6.25).

The fresh development bank has 1,080 families and 2,160 games per arm. The two alternative arms ran
on one host's share of it, 717 families; one of their shards stopped at the native refusal described
under the amendment below.

| Arm against current v13                          | Families | Gain, points | 95% family interval |
| ------------------------------------------------ | -------: | -----------: | ------------------: |
| **Compare every neutral strike** (the candidate) |    1,080 |    **+3.31** |      +1.57 to +5.07 |
| Compare melee strikes only                       |      717 |        +2.93 |      +0.80 to +5.02 |
| Never take the scripted strike at the root       |      716 |        +2.48 |      +0.10 to +4.85 |

The candidate improved 242 game outcomes and worsened 160. Every own-doctrine, opponent-doctrine and
seat mean was positive (+2.36 to +5.14). The three arms are not separable from one another:
melee-only minus the candidate is −0.24 (−1.05 to +0.52) on 717 shared families, and the root-only
removal minus the candidate is -0.70 (−2.72 to +1.29). All three give those turns back to A19's
search, and that is where the gain comes from. A separate exploration switched search off for both
seats on the same bank: removing the scripted strike from the plain native policy scored −0.82
points (−2.52 to +0.86, 1,070 families), and keeping only strikes on barrels that block a friendly
shot scored +0.23 (−0.89 to +1.36). The strike itself is therefore not measurably worse than the
native move or wait it replaces. What cost strength was returning it without the comparison A19
makes on every other turn. The widest scope was registered because it is the direct extension of the
adopted switch and leaves the native policy and every forecast untouched.

## Registered confirmation

Registration `8d4a618a9f3533b6a9a91e1784cfe197725996aa97c0a0284529a969badefc81` was written before
any confirmation game. It fixes the single candidate, the source manifest `bb61fb601966126c…` (1,438
files), the bank, the analysis and every gate. The bank is 2,700 fresh Cemetery families, both
seats, two arms: 10,800 games on three hosts. Scores were not inspected before collection finished.

10,794 games completed and verified. 6 games ended with a native quality error and were rejected as
the rules require; they are described under the amendment below. The headline is the most adverse
reading: every family that contains any rejected game is scored as lost by the candidate and won by
current in both seats, whatever the anomaly and whichever arm it occurred in.

| Arm         |  Wins | Draws | Losses | Match score |
| ----------- | ----: | ----: | -----: | ----------: |
| Current v13 | 2,710 |    90 |  2,600 |     51.019% |
| Candidate   | 2,897 |   103 |  2,400 |     54.602% |

The candidate gained **+3.583 points**, whole-family 95% **+2.435 to +4.750** (all 2,700 families,
20,000 resamples, seed 2026111902). It improved 633 game outcomes and worsened 444; 2,588 families
changed trace. Slice means were +2.89 to +4.25 by own doctrine, +2.06 to +5.22 by opponent doctrine
and +2.56 to +4.61 by seat; slices are descriptive. Other treatments of the rejected families give a
larger gain: dropping them +3.814 (+2.673 to +4.965), their recorded outcomes +3.796 (+2.657 to
+4.954), and the registered Amendment 1 analysis +3.622 (+2.464 to +4.789) on the 2,699 families it
can score.

| Registered gate                                   | Result                   |
| ------------------------------------------------- | ------------------------ |
| Gain at least +0.5 points                         | passed                   |
| 95% lower bound above zero                        | passed                   |
| At least 1,350 changed families                   | passed (2,588)           |
| No doctrine, opponent or seat mean below −1       | passed (lowest +2.06)    |
| Independent Python and Bun reconstruction         | passed                   |
| Off-map inertness                                 | passed (80/80 identical) |
| Capsule control equals the unpatched server       | passed (48/48)           |
| Cross-host cold replay                            | passed (452/452 rows)    |
| Quality: inputs, winners, manifest, no rejections | **FAILED**               |
| Serial cost within +10%                           | **FAILED**               |

**Every strength and control gate passed, also under the most adverse reading of the rejected games.
Two registered gates failed:** quality, on one rejected game outside the amended class, and cost, by
0.14 points. The candidate is measurably stronger than the default on Cemetery, but it is **not
qualified for automatic progression**: it stays off, and adopting it is an explicit user decision
that weighs those two facts.

The inputs, manifest and journal winners of all 10,794 completed games verify, and the manifest
verifies on all three hosts after collection. The 80 off-map pairs are Normal and Lava games, 38 of
them with a Barrel Barricade: current and candidate traces are identical, so the rule is inert
wherever no neutral barrel stands. The cold replay recomputed shards 0 and 47 on a different host.

The serial cost study played 72 fixed development cases in both arm orders, one process per pass,
144 games per arm. Complete adapter CPU changed **+10.14%** (962 to 1059 CPU-seconds) and CPU per
authoritative decision **+3.93%** (128.3 to 133.3 ms). Order AB measured +8.40% complete CPU and
order BA +13.34%. The per-decision limit holds; the complete-CPU limit of +10% is **exceeded by 0.14
points, so the registered cost gate failed**. It is not waived and the study was not repeated. The
candidate plays longer games: these 72 cases took +6.0% more decisions, against +3.8% on the whole
development bank and +3.0% on the confirmation bank. A compared strike costs a normal search where
the fast return cost nothing, and a wait gives the unit a second decision in the lap. Two larger
paired measurements are descriptive only: +6.5% complete CPU on the development bank and +7.4% on
the confirmation bank. They ran concurrently and always played the current arm first, and the two
serial orders differ by about 2.3% in each direction, so they understate by about that much. The
cost passes themselves ran on hosts that were also collecting the confirmation. The honest reading
is a complete-CPU cost of about ten percent per Cemetery game: restoring the search on one turn in
eight is not free. The registered gate was conditional on Cemetery. The rule is inert on Normal and
Lava, so averaged over the three ranked maps the measured change is about +3.4% complete CPU and
+1.3% per decision. That three-map reading was not registered; it informs the adoption decision and
does not turn the failed gate into a pass. These are whole-simulation costs on shared hosts, not
production latency.

One runtime crash occurred before registration: a Bun abort in a control shard that did not recur on
restart. The registered rule restarts a crashed shard process and resumes after its last completed
row. No shard process crashed during collection.

Amendment 1 (`86854dcb3d0af1606d3daa28c961b6c0cbad589ba3ed100bcaa9353cc481d3ac`) was written at
19:42 UTC, with 1,224 of 10,800 rows collected and no score, digest comparison or aggregate
inspected. A development game of another arm had just been rejected for a known native anomaly of
the default policy: the engine declines a stale native melee proposal (`strategy v0.8 proposal
declined: type=melee_attack reason=attack_not_available`). The original quality gate required zero
rejected games. The amendment keeps every family: a confirmation game rejected only for that warning
has its whole family scored as the worst completion for the candidate, for at most 13 families, and
any other rejection still fails quality. The first confirmation rejection was recorded three minutes
later. Collection ended with 6 rejected games. 5 are that certified class, four in the current arm
and one in the candidate arm. The sixth is a different anomaly in a candidate-arm game: a mindless
Berserker, which is pinned to the v0.1 policy and never reaches A19 search, had its move and attack
proposals declined twice and the turn was closed by the non-policy timeout. It is outside the
certified class, so **the registered quality gate failed on that one game**. No second amendment was
written after seeing data. The headline above already scores that family, like the other five, as a
double loss for the candidate.

Evidence is in the [registration](evidence/neutral_barrel_deliberation_registration_20261119.json)
and [results](evidence/neutral_barrel_deliberation_results_20261119.json) fixtures.

## Implementation status

`SEARCH_A19_NEUTRAL_BARREL_DELIBERATION` implements the candidate in `SearchDriver`. It is **off**
in A19 profile v13: the sealed environment pins it to `"0"` and the a13 rollback environment leaves
it unset, so no shell variable can enable it. Twelve driver tests cover melee and ranged neutral
strikes against move, wait and defend, retained strikes on equal forecasts, the unchanged
deployment-barrel and classic-mountain paths, real-forecast state restoration and switch validation.

The committed code, with the switch off, was replayed against its parent commit through the stock
ranked adapter: 212 games (132 Cemetery, 40 Normal, 40 Lava; 125 with a Barrel Barricade) and 11,387
decisions. Every score, behavior digest and decision count is identical, so adding the switch
changed no default play.

An integration replay ran 36 development cases twice with the comparison on both seats: once through
the research seam, once through the real engine source with the switch enabled by the profile rules
and the stock ranked adapter. All 36 complete outcomes, digests and decision counts match, across
406 compared strike roots. Adoption is therefore one profile rule; it needs an explicit user
decision, a profile version bump and re-pinned fingerprints. That edit was applied to a scratch copy
of the committed source (`63c8e6b5`): the complete common suite passes with profile schema v14 and
behavior fingerprint `397a2fc8dc8d3145…`. The server's production revision string and the client
guidance change in the same step.

## Seeds

Namespace `barrel-strike-necessity-20261119-v1` reserves four roles (`draft`, `setup`, `reverse`,
`terrain`), counters 1 to 24,000 each: 1,631,768 unique channels, with zero intersections against
428 audited ledgers. The preimage is the first four bytes, little endian, of
SHA-256(`<namespace>:<role>:<counter>`). Draft reserves raw offsets 0 to 31 and their native
permutation, setup and reverse reserve their root, and terrain reserves its root and canonical
search channel. Every scanned counter stays excluded, including rejected and unallocated ones. [The
reservation fixture](evidence/neutral_barrel_deliberation_seed_reservation_20261119.json) lists all
of them. Scan index 0 to 119 per doctrine cell is the development bank, 120 to 419 the confirmation
bank, and 420 to 573 (1,386 families) was never played and stays reserved.

## Limits

The result is conditional on the Cemetery map, the only board with neutral barrels. It is a match
score against the unmodified default with one seat changed, not a global ranked win rate. Offline
search is operation-bounded: production wall-clock latency is not certified, although a compared
strike costs the same as any other searched root. Ranged strikes on deployment barrels still return
without comparison; they occur about 0.05 times per seat-game on Cemetery and were not studied. The
searchless native policy, used by difficulty tiers without A19 search, is unchanged and still
strikes barrels. The consumed confirmation bank must not tune another candidate.
