# One ranged exchange correction per battle

The completed fresh comparison found **no overall gain**: +0.00 score points, 95% family interval
**-0.69 to +0.69**, across 864 battles. One loss became a win, and one win became a loss. The rule
failed its gain gates and remains inactive. The current default is unchanged.

`ranged-countershot-once-20261117-fresh-v1` is a distinct inactive candidate following the failed
[conservative counter-shot screen](ranged_countershot_safety_research.md). The earlier source, all
432 battles and its failed gates remain unchanged.

The earlier one-shot diagnostic changed one loss and two draws into wins across 14 eligible cases,
without worsening a result. Those are selected reused cases, not independent strength evidence.
The automatic policy has reproduced all 14 complete forced-branch traces exactly, with exactly one
correction per battle. That establishes implementation parity, not promotion.

The three development gains illustrate the hypothesis:

| Actor at the decision | Original shot                          | Replacement                               | Replayed result |
| --------------------- | -------------------------------------- | ----------------------------------------- | --------------- |
| Orc, 164 HP           | 17 damage to Monk; Orc dies            | 23 damage to Battle Mage; Orc survives    | Draw to win     |
| Beholder, 57 HP       | 15 damage to Arbalester; Beholder dies | 50 damage to Scavenger; Beholder survives | Draw to win     |
| Zena, 107 HP          | Dryad plus Cyclops splash; Zena dies   | Gargantuan plus splash; Zena survives     | Loss to win     |

Both original draws ended through elimination, not a simulation turn cap. These are fixed-future
diagnostics; changing an action also changes subsequent random consumption, so they do not by
themselves establish an expected-strength gain.

## Frozen policy

Only the candidate army can receive a correction, at most once per battle. At its first qualifying
root, both existing full R2 samples must kill the ranged actor, with enemy XP damage less than one
quarter of allied XP lost. Select an already fully scored ranged alternative that survives both
samples, deals positive enemy damage, and loses no more allied XP than the enemy loses. Rank eligible
alternatives by full-search mean, immediate net XP, then catalog order. Unlike the closed rule, the
alternative's forecast may be lower than the original choice. Spend the budget only on an actual
correction; every later decision uses the default.

No forecast model, neural weights, chance samples, search slots, draft, paid Setup, placement or
opponent policy changes. Inputs are public combat state and the ordinary engine's existing hypothetical
search results. The prototype is offline; any future serving implementation would need a durable budget
across controller recreation or server restarts.

Source SHA-256: `9f200185188d38a805fd48ab274b86dc8d8a6c39c7e7287b7386f900e37ce1b6`.
The frozen common and server revisions are `997490ee10c64f7379396c869c4d7976fddb04dc` and
`51b2f9530d28557337a0acd62b6d65d3f86b8837`. The comparator is the current adopted v10 A19 profile.
The pre-outcome [registration and seed ledger](evidence/ranged_countershot_once_registration_20261117.json)
preserve registration SHA-256 `c204e5c4c03543fb8e80dffe84b270fb53feba56d4f8ea93ad63376cfee1610b`.

## Fresh measurement

The first two natural ranged-vs-ranged drafts per map / own doctrine / opponent doctrine / pick order
yield 108 families after examining 109 drafts, without opening combat outcomes. All three maps,
every 5/6/7-point doctrine pair and both pick orders are represented. Both physical seats and two
combat futures produce 432 matched cases, **864 battles**. All arms retain native legal draft,
fully funded public Setup, splits and placement.

The primary statistic is equal-weight whole-family mean match-score gain, with 0/0.5/1 scoring.
Use 20,000 whole-family xorshift32 bootstrap resamples, seed `17112026`, sorted indices 500/19500,
and independent integer half-point verification. Fixed gates require at least +0.5 percentage points,
a strictly positive lower 95% bound, 12 changed families, and no map, own-doctrine or opponent-doctrine
mean below -1 point. Inspect strength only after every matched case completes. No favorable-slice rescue.

All 108 families run on the shared 9800X3D host using four nice19 workers. Other jobs and live services
are untouched. Three fixed development cases reproduce across hosts before fresh combat; three fixed
fresh cases, both arms, repeat in new local processes afterward. The fixed cutoff is November 17,
20:41:38 UTC, with no automatic retry, reallocation or extension. Incomplete evidence cannot pass.

A positive screen would still need separately registered independent confirmation and quiet full-fight
and complete-decision runtime within +10%. This study does not authorize a default change or deployment.
Do not assume its result transfers to the peer's separate forecast-model mixture; any combination
requires a fresh comparison against the then-current default.

## Preservation

The ignored client capsule is `game/core/tmp/ranged-countershot-once-20261117`. It contains exact
frozen runtime copies, source seals, functional fixtures, full traces and analysis scripts.
Reserve every scanned preimage in namespace `ranged-countershot-once-20261117-fresh-v1`, counters
1 through 20,480, using the first four SHA-256 bytes as unsigned little-endian and expanding 32 raw
plus 32 native-permuted channels. Rejected and unused seeds remain reserved. The allocator checked
192 existing ledgers, including the entire conservative study and peer-mixture allocation.
An independent verifier checked all 34,560 used raw/permuted channels against those ledgers and found
zero intersections.

Formatting the conservative evidence after allocation changed its file hash but no data. The exact
pre-format ledger was reconstructed byte-for-byte, verified against the allocation receipt and retained
inside this capsule. No reserved channel changed.

## Completed fresh result

All 864 battles completed, with 432 matched cases across 108 independent draft families. Both arms
finished **211 wins, 4 draws and 217 losses**. The policy corrected 21 decisions across 18 families:
19 changed trajectories retained their original outcome, one improved, and one worsened. The remaining
411 cases reproduced exactly. Every changed case matched the complete original action prefix up to
the single correction, and no battle exceeded the one-correction budget.

All six fresh cold executions reproduced across the Linux and Mac hosts. Every raw/compressed result
hash and battle-quality receipt passed, with zero engine rejections or neural errors. Independent Bun
integer half-point calculations reproduced the Python result and 20,000-resample interval. The mean
gain and positive lower-bound gates failed; activity and subgroup gates passed. No confirmation or
quiet cost campaign was opened after this failed screen.

| Outcome flip | Decision                                   | Default forecast / alternative | Result      |
| ------------ | ------------------------------------------ | ------------------------------ | ----------- |
| Regression   | One Elf, 14 HP, lap 1: Arbalester to Satyr | 0 / 0                          | Win to loss |
| Improvement  | Elf, 106 HP, lap 2: Zena to Orc            | 1 / 1                          | Loss to win |

The regression preserves an important counterexample to a blanket survival rule. The default used
the one-Elf stack to consume Arbalester's response. The following Centaur shot dealt 293 damage with
no damage to the Centaur. After the correction saved the Elf, the Centaur still attacked Arbalester:
it dealt 341 damage but took **285 damage**, losing 19 creatures. Saving 14 HP removed useful response
bait. This is a directly recorded local exchange; the final win/loss also includes the changed future
trajectory and random consumption.

Both fresh outcome flips occurred on exact full-forecast ties. Do not claim that the fresh evidence
validated overriding lower forecasts, or advertise the earlier selected-case gains as general strength.
The next distinct hypothesis is to value response consumption for ready allies and distinguish cheap
bait from valuable shooters. Do not simply remove the losing case, exempt its creature, or tune and
retest this closed bank as fresh evidence.

The [closed result and witnesses](evidence/ranged_countershot_once_result_20261117.json) preserve every
family, both outcome flips, all 21 corrections, exact analysis source, cross-host controls, source seals
and independent verification. A read-only monitor exceeded its helper's 45-second timeout; detached
workers continued, with no battle restarted or dropped. All research workers completed normally.
