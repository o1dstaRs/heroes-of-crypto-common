# Peasant: cheap Bitter Experience retaliation

The user's proposed tactic is valid: deliberately attack an enemy with an unused, weak melee response
so the surviving Peasant stack earns permanent defense and mobility. The first bounded candidate did
**not** improve the measured AI. All 104 paired battle trajectories were identical. Keep the candidate
inactive; the observation that an immediate feature vector omits armor is not a measured strength gain.

## Verified mechanic and search limitation

`Unit.applyDamage` grants one Bitter Experience stack per hit that kills at least one creature while
leaving the stack alive. It grants **+1 base armor and +1 step**, regardless of how many creatures that
hit killed. A harmless hit, a fully absorbed hit, a fatal hit, or an active Break does not provide this
benefit. A partly wounded top creature can make a very small hit sufficient.

Ordinary melee retaliation is calculated before the initiating primary damage is applied. A defender
that the Peasant kills can still respond at its pre-hit strength. Do not estimate its response from
its projected surviving stack. `canUnitRespondToMelee` owns response availability, including both
replied flags, response restrictions and forced/forbidden targets.

A19's immediate `fillValueFeaturesV2` features do not change when only armor and steps increase. The
longer real-engine search does retain and simulate those bonuses. The regression test isolates the
feature omission without changing HP or other state, and an engine test confirms a cheap one-casualty
response grants the bonus even when the defender dies. This identifies a representation limitation;
it does not establish that the complete AI ignores the tactic.

## Closed candidate and fixed gates

`bitter-experience-cheap-response-v1`, in `src/simulation/bitter_experience_research.ts`, is an offline
research helper. It is not imported by serving AI or the shipped SearchDriver. It considers a legal
stationary melee from a root unit with active Bitter Experience, at least two creatures, an available
response, at least 50% projected proc probability, no possible fatal response, at most two casualties,
and worst-case response damage no greater than 5% of the current stack HP. Unsupported multi-hit,
reflection, shield, burn, Break and certain secondary-effect exchanges retain native behavior.

The proposal preserves every native full-horizon comparison, adding at most one existing legal action
if it was omitted. Existing extra reservations take precedence. A late target-priority extension must
beat every ordinarily eligible full score and the native action by at least 0.01. It adds no arbitrary
armor reward and does not force farming.

The pilot used the first Peasant-containing family in each represented map / own doctrine / opponent
doctrine stratum of the already completed action-aligned geometry qualification. There were 26 such
strata; Block / own five-point / opponent seven-point was absent. Both physical seats and two combat
futures gave 104 matched cases, each run off / observer / candidate: **312 fights**. Eighteen additional
cold replays brought the valid pilot to **330 executions**. This is reused diagnostic data, not fresh
qualification. No family was selected by its outcome and no new seed channels were allocated.

Fixed progression required at least ten qualifying roots across two maps, an added full comparison or
late-tier extension, a newly selected trade and changed trajectory, at least +0.5 score points overall,
and nonnegative own-doctrine means. It failed coverage and score. Do not lower these gates, rescue a
subgroup, or open the provisionally described fresh banks. None of those fresh banks was allocated.

## Results

| Check                                     |                 Result |
| ----------------------------------------- | ---------------------: |
| Peasant decision roots observed           |                    402 |
| Nominated cheap-response trades           |                      4 |
| Already included in native full search    |                  4 / 4 |
| Additional comparisons or tier extensions |                      0 |
| Changed full battle trajectories          |                0 / 104 |
| Paired score difference                   | 0.00 percentage points |
| Exact off / observer controls             |              104 / 104 |
| Exact historical native controls          |              104 / 104 |
| Exact cold replays                        |                18 / 18 |

All four nominations were already available to native full search. Three had full-search scores of
1.0 for every compared action; the fourth had scores of 0.0 throughout. Native behavior attacked the
nominated target in three cases, including the lap-seven Wandering Mage opportunity. The four Peasant
stacks had already earned 5–9 Bitter Experience bonuses. These observations do not support calling this
an absent tactic. All differences are zero because no policy decision changed; the degenerate zero-width
bootstrap interval is not evidence that every future Peasant modification has exactly zero effect.

The canonical pilot is in the client capsule `game/core/tmp/peasant-bitter-response-20261116/v2`.
Independent verification reconstructed all winner scores, checked compressed and raw hashes, source
seals, identical openings, native A19 use, zero rejections, complete event/turn traces and health ledgers.
Parallel timing was diagnostic only; no serial serving cost qualification was attempted.

## Forced single-turn continuation audit

A separate diagnostic forced each of the four nominated attacks exactly once, then resumed the complete
native policy. Four roots × native/forced × initial/cold gave **16 verified executions**. All four native
controls matched the pilot and all eight cold replays matched. The four scores remained **1, 1, 1, 0**
in both arms. In the disputed losing case, the forced Wandering Mage retaliation cost 8 HP and granted
one Bitter Experience stack, but the battle still ended in a loss. Native behavior already earned one
bonus in each of the other three cases. This is concrete mechanism evidence, not population strength.

The first 16-execution audit is retained but unscored. Its prototype-level override was replaced by the
per-instance final A19 neural tie selector in the disputed case; independent validation correctly
rejected it because the committed target was Medusa instead of Wandering Mage. The corrected audit
wraps the final instance selector and verifies the actually executed attack. No production guard was
disabled, no candidate threshold changed, and the original sample, seeds and cutoff were retained.
This correction also clarifies that pilot observation `chosen` fields describe the search prototype;
committed turn records, not those intermediate fields, establish the final action. The pilot's zero
added comparisons and exact full off/on traces remain valid.

Final audit registration is
`446d3ef204e47b4b775057922edf133abb7aaeb0d5803e1316351fc83fdb18f0`.
The accepted output is in the capsule's `counterfactual-audit/v2`; preserve the original registration,
`verification-failed.json`, both source versions and every emitted result. The compact evidence record
is `docs/evidence/peasant_bitter_experience_20261116.json`.

## Provenance and corrections

The frozen committed common source is `ade975b8378b71742ac51bd32eb9187a48100ee0`; server source is
`82336c6981c7679febb1793043fd3671c90cb898`. Concurrent peer working-tree changes were excluded. The
source receipt's `publishedSourcesOnly` label means committed inputs here; it is not proof that those
commits were pushed or deployed. The capsule alone adds the offline helper and strict tier hook.

Initial registration `d35dcdd9c4e1005a9a6729f352ba8616fa3f3974eb4a11727ba3ac05ab680dc3` stopped
because deep comparison distinguished live `undefined` fields from absent keys in persisted JSON.
Every serialized input, result, turn, event and health field in the two emitted native controls matched.
The original outputs and incident are preserved. Registration
`462f5291322fdd19ccd8a2e68edcabbf682808408dff2d2ff22f3e7dfb727d90` normalizes only the comparison
representation. Policy, sample, seeds, values and the original hard cutoff stayed unchanged.

The helper SHA-256 is `7bc1cb77450879e004fa13ca00bf7f3aa24ad0f475122e158c856e50fb939709`. Preserve it
as a closed candidate. The checked-in test SHA is
`6ed267afbc4cc358df0d67ea40557d7f44d3bcddf0784b51695d94073ae3cdbb`; the frozen capsule test has SHA
`3367e55e8e9ab1521bcac5d8b3a4242b72a933a55accbefd1e9cf10a36aa7543`. The only later test change
uses an explicit test-only `Object.assign` for the same two-stat perturbation, respecting the readonly
TypeScript getter. It changes no runtime policy, expected result or assertion. The source/helper and test
pass targeted formatting, ESLint, all nine focused tests, and a TypeScript check covering all source plus
the new test. The broad test-project typecheck has unrelated existing failures and is not reported as
passing.

Further research must distinguish immediate value representation, final neural tie selection, movement
needed to reach a weak responder, and the cost of delaying a more urgent attack. A new candidate needs
its own identity, legal public inputs and representative fresh evidence; this closed shortlist proposal
must not be relabeled as a win. The separate actual-outcome geometry study is untouched.

The distinct [exchange-angles audit](peasant_exchange_angles_research.md) subsequently completed 1,200
verified executions across a fresh 108-family sample and 30 fixed continuation roots. It includes moving
attacks, small late-game stacks and separate armor/movement ablations. Forcing the nominated attacks
changed no final result versus native play; removing earned armor worsened two continuations. This
preserves the value of the mechanic without establishing a stronger policy or reopening this candidate.
Its compact evidence reserves every scanned fresh channel for future agents.
