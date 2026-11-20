# Neutral cemetery barrel deliberation default adoption

On November 19, 2026, the [study](neutral_barrel_deliberation_research.md) closed with a confirmed
strength gain and two failed registered gates. Its report recommended adopting the candidate as
profile v14 and listed both failures. The user answered: “continue, do what is needed”. The
A19-backed v0.8 production profile now includes `a19-neutral-barrel-deliberation-v1`. The profile
schema advances from v13 to v14; the global wire version remains v0.8.

This is explicit user adoption. The registered strength and control gates passed. The registered
quality and serial-cost gates **failed** and remain failed: neither was waived, re-run or relabeled,
and choosing the behavior does not turn either into a pass.

## Adopted behavior

The native v0.8 cleanup turns a turn without a committed attack or cast into a strike on a one-hit
stone. Through v13, A19 returned that strike without a search unless it was a melee strike on a
deployment barrel. In v14, at an actual A19 root whose native incumbent strikes a standing
**neutral** stone, melee or ranged, the strike enters the same deliberation: no cemetery fast return,
legal wait and defend challengers, no forced-productive tier, and the unchanged H64/R2/K6 search,
value gate, scored and material arbitration and neural tie correction. The strike remains candidate
zero and survives ties and deadline fallbacks, so a barrel is still struck when nothing compares
better. On the development bank the entrant kept 32.5% of its strike proposals.

Nothing else changes. The native cleanup proposes the same strikes at roots and inside every
forecast. Deployment barrels keep the adopted handling, including the ranged fast return. Classic
mountains, draft, setup, splits, placement, models and budgets are untouched. Boards without a
standing neutral stone cannot change, and of the ranked maps only Cemetery has them. Difficulty
tiers that play without A19 search keep the scripted strike.

The canonical profile seals `SEARCH_A19_NEUTRAL_BARREL_DELIBERATION=1` for live and deterministic A19
callers. An explicit `V08_A19_SEARCH_ENV_OVERRIDES` value of
`{"SEARCH_A19_NEUTRAL_BARREL_DELIBERATION":"0"}` restores the v13 behavior. Invalid values fail
closed. The a13 rollback leaves the switch unset, and native v0.9 does not use this A19 policy. The
profile records the decision as `neutralBarrelDeliberation`, with qualification
`strength-confirmed-quality-and-cost-gates-failed`.

The server uses the same factory for ranked bot turns and Premium fight search. Its strategy revision
advances to
`a19-neural-r2-placement-v2-unit-support-v2-barrel-v1-nightmare-v1-terrain-v1-delivery-v1-sniper-v1-neutral-barrel-v1`,
so new decision and Premium records identify the adopted comparator. This source adoption does not
regenerate historical data or claim that production has been deployed.

## Preserved evidence

The [research record](neutral_barrel_deliberation_research.md) and its
[registration](evidence/neutral_barrel_deliberation_registration_20261119.json),
[results](evidence/neutral_barrel_deliberation_results_20261119.json) and
[seed reservation](evidence/neutral_barrel_deliberation_seed_reservation_20261119.json) fixtures
remain the authority for the study and are unchanged. Registration SHA-256 is
`8d4a618a9f3533b6a9a91e1784cfe197725996aa97c0a0284529a969badefc81`.

| Evidence, entrant candidate minus v13 | Families |  Games | Match score, points | 95% family interval |
| ------------------------------------- | -------: | -----: | ------------------: | ------------------: |
| Fresh development                     |    1,080 |  4,320 |               +3.31 |      +1.57 to +5.07 |
| Registered held-out confirmation      |    2,700 | 10,800 |           **+3.58** |      +2.44 to +4.75 |

The confirmation figure is the most adverse reading of its six rejected games: every affected family
is scored as a double loss for the candidate. Every strength and control gate passed. Two gates did
not:

- **Quality failed.** The gate allowed rejected games only of the class named in the blind Amendment 1.
  One rejected game was outside it: a mindless Berserker, which plays the v0.1 policy and never
  reaches A19 search, had its proposals declined and its turn closed by the non-policy timeout. It
  happened in a candidate-arm game.
- **Serial cost failed.** Complete CPU rose 10.14% against a limit of 10% on 72 Cemetery cases in both
  arm orders. CPU per decision rose 3.93%.

The estimate changes one seat against v13, on Cemetery only. It is not a global ranked win rate, and
it does not describe two v14 seats facing each other, where both compare. Production latency is not
certified. A compared strike costs one ordinary searched decision under the unchanged deadlines.

The registered cost figure covers a whole two-seat game in which one seat changed, and that seat does
nearly all of the extra work. On the confirmation bank it searched 27.6 decisions per game against
22.8 (+21%), while its opponent searched 22.5 against 22.8. The added decisions are cheaper than
average: 113 ms of CPU each against 146 ms in the cost study. A live bot seat should therefore expect
roughly one sixth more search CPU in a Cemetery game, an estimated +16% to +18%, and nothing more on
other maps. This per-seat reading is derived from the stored decision counts and was not registered.

The consumed development and confirmation banks must not tune another candidate. The 1,386
never-played families (scan index 420 to 573) stay reserved, and every scanned seed channel stays
excluded.

## Integration checks

Profile tests pin the sealed rule for live and deterministic drivers, the a13 isolation, the explicit
rollback override, its fail-closed validation, the recorded qualification and the new behavior
fingerprint. The twelve driver tests of the study are unchanged.

One bank of 212 already-consumed development and control cases (132 Cemetery, 40 Normal, 40 Lava; 125
with a Barrel Barricade) was replayed through the server's ranked path in four configurations:

| Replay                                                   | Result                  |
| -------------------------------------------------------- | ----------------------- |
| Profile v14 against the measured candidate on both seats | 212/212 games identical |
| Profile v14 with the rollback override against v13       | 212/212 games identical |
| Profile v14 against v13 on Normal and Lava               | 80/80 games identical   |
| Profile v14 against v13 on Cemetery                      | all 132 games differ    |

The first row plays the committed profile source through the server's own driver factory and the
stock ranked adapter, and compares it with the research seam that produced the measurement, applied
to both seats over the study's frozen engine. Scores, behavior digests and decision counts are
compared; 11,692 authoritative decisions and 1,374 compared strike roots are covered. The second row
sets the override inside the server's bot search environment, because the server ignores that
variable from the process environment by design. No replayed game reported a quality error, and a
Python and a Bun implementation agree on every count. With the comparison on both seats the 132
Cemetery games took 7,468 decisions against 7,163 (+4.3%). These are integration checks on consumed
cases, not new strength samples, and a Cemetery game between two v14 seats carries no strength
reading. The [adoption fixture](evidence/neutral_barrel_deliberation_adoption_20261119.json) holds
the full receipt.

The profile source SHA-256 is `a6bbdba4877521b7ef9e91dd00d2010f208e1fb4c091d680964abc10df9bdf70`; the
canonical behavior environment is `397a2fc8dc8d3145ab4cbc5300818d9eb3a89edeb2aacb57739a0a38d0c5c004`.
`search_driver.ts` is unchanged from the commit that added the switch (`63c8e6b5`, SHA-256
`09f51dd48caee326017ae44597e738d7ee12994118ab343a0ba9cf88a53890e8`).

Future research uses profile v14 as its default comparator. Already-running studies keep their frozen
v13 comparator and original registration; any new default improvement needs an explicit comparison
against the adopted behavior. Do not silently add this policy to an in-flight baseline.
