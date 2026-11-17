# Nightmare wall and movement default adoption

On November 17, 2026, after reviewing the completed experiment, the user requested:
“that is strong... we should save those into default strategy”. The existing A19-backed v0.8
production profile now includes the exact `nightmare-wall-movement-coverage-v1` candidate. The
profile schema advances from v9 to v10; the global wire version remains v0.8.

This is explicit user adoption with remaining strength uncertainty. The original development study
remains **closed-development-failed**. Its positive point estimates do not become a passed gate or a
fresh confirmation because the user selected the behavior.

## Adopted behavior

`src/ai/nightmare_wall_movement.ts` contains the serving implementation. The immutable research
helpers remain separate and unchanged. At an eligible Nightmare root, when both ground melee threats
and other visible enemy types exist and an ordinary Fire Wall cast is legal, the helper offers the
original extra wall toward those ground threats. Hidden enemies are excluded. It uses current public
unit, spell, board and terrain information, without future outcomes or concealed draft information.

The native shortlist stays intact, with the same entries and order. The additional wall is appended.
If no pure movement action survived, the best finite movement action from the existing catalog and
already-computed leaf scores is appended too. Stable ties retain catalog order. There is no second
leaf pass, new path search, forced wall/movement, fabricated damage, route veto or special tie rule.
H64/R2, material arbitration and the accepted neural correction continue to select the final action.

The canonical profile seals `SEARCH_A19_NIGHTMARE_WALL_MOVEMENT=1` for live and deterministic A19
callers. An explicit `V08_A19_SEARCH_ENV_OVERRIDES` value of
`{"SEARCH_A19_NIGHTMARE_WALL_MOVEMENT":"0"}` restores the previous comparison behavior. Invalid
values fail closed. The a13 rollback clears the switch and native v0.9 does not use this A19 policy.
The locked V3/contextual draft, learned setup heads, adopted barrel policy and neural weights retain
their existing identities.

The server uses the same factory for ranked bot turns and Premium fight search. Its strategy revision
advances to `a19-neural-r2-placement-v2-unit-support-v2-barrel-v1-nightmare-v1`, allowing new collected
advice to identify the adopted comparator. This source adoption does not regenerate historical
Premium SQLite data or claim that production has already been deployed.

## Preserved evidence

The complete [research record](nightmare_wall_movement_research.md) and
[evidence fixture](evidence/nightmare_wall_movement_20261117.json) remain the authority for the study.
Registration SHA-256 is `819fa13d6e88006994abcca5c31ca400a0d5bac9c339e00eddc57c167e64b09a`.

Across 216 independent legal Nightmare-preferring draft families and 864 paired outcomes:

| Contrast                                               | Match-score difference | Simultaneous 95% interval |
| ------------------------------------------------------ | ---------------------: | ------------------------: |
| Combined candidate versus previous default             |       +0.520833 points |    −1.157407 to +2.256944 |
| Combined candidate versus original wall-only candidate |       +0.231481 points |    −0.694444 to +1.388889 |

The five-point doctrine slice was negative. Confidence and own-doctrine gates failed. Three of the
seven improvements over wall-only came from one family. These conditional results are not a global
win-rate promise. No independent strength confirmation or production-host cost qualification is
implied by adoption. Preserve all consumed and reserved seed channels, losing cases and failed gates.
The failed route-preserving wall policy remains inactive.

## Integration checks

The serving helper is compared directly with the immutable helpers on real engine fixtures spanning
both sides, all three studied maps and flyer/shooter/caster/all-ground opponents. Tests also cover
hidden units, missing casts, rollout exclusion, unchanged state/RNG, a legal engine cast, native
shortlist prefix preservation, reuse of exactly one leaf pass, unpruned catalogs, version isolation,
canonical factory defaults, explicit rollback and source/environment fingerprints.

The separate ignored capsule `game/core/tmp/nightmare-default-adoption-20261117` in the client checkout
replays already-consumed cases. It uses an isolated copy of the frozen runtime with only the adopted
common sources overlaid. Its first family for each map/own-doctrine combination, both seats and the
first registered combat future were fixed without selecting by outcomes. The replay compares complete
results, turns, events and health with the saved combined candidate and previous default. These are
integration checks, not new strength samples. Local bounded live runs check legal execution; local
latency observations cannot establish production-host latency or a population compute bound.

All **36 deterministic replay executions** passed exact parity: 18 serving-default games match the
saved combined candidate and 18 explicit rollback games match the previous default. Two of the 18
sampled trajectories differ between policies, so this is not solely a no-change control. All three
additional bounded live games passed engine and neural quality checks, across 139 searched decisions,
with zero deadline fallbacks. Nightmare decision times in that small local live sample had a 52.56 ms
median and 234.48 ms maximum; these are workstation observations, not server latency guarantees.
The integration receipt SHA-256 is
`897ea3bd544b87c70cd39b2299e543f8636660d7e548124dfe673ad92b67a192`.

The serving source SHA-256 is
`2618932cb65f4205ce4a82ec9ff54c41797ee4ca4e85bed6126374957d245020`;
the canonical behavior environment is
`820db7a1f8eb9243a9d79e6ac68eff1df706c2d148a9d0606c28efaa709258ba`.
The original research sources and evidence fixture still match their registered hashes.

Future research uses profile v10 as its default comparator. Already-running studies keep their frozen
v9 comparator and original registration; any new default improvement needs an explicit comparison
against the adopted behavior. Do not silently add this policy to an in-flight baseline.
