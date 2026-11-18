# Coherent melee approach research

The inactive `a19-coherent-melee-approach-v1` repairs a concrete action
construction bug. An inherited aura-positioning rule, and the analogous Rapid
Charge rule, can replace a melee approach without replacing the explicit move
before it. In the exposed reproduction, a Peasant moves from (1,3) to (3,0),
then proposes a strike from (4,2) with a route beginning at the old (1,3).
The current native engine refuses that second action. This also occurs without
the counterfactual setup selector; its original failed study stays closed.

The [research helper](../src/ai/coherent_melee_approach_research.ts) runs after
the final v0.8 policy, only when an actor's explicit move destination differs
from its melee approach. It replaces that move with one native reachable route
to the selected approach and makes the attack stationary there. A chosen
stationary strike removes the stale move. An unavailable approach retains the
original move and drops its dependent suffix. Consistent commands keep their
original array reference. The helper does not change targets, learned weights,
search budgets, models, setup or the authoritative action engine.

Movement stays explicit. Native terrain flags, full body cells, Fire Wall
damage, shields, vines, smoke and movement events still apply. The existing
post-move availability/Cowardice projection removes a suffix that movement
would make unavailable. The helper reads current legal board information,
never future randomness. It has no import from a serving strategy or export
through the public AI entry point.

Twelve focused native-engine tests / 138 assertions cover both teams and
1x1, 2x1, 1x2 and 2x2 bodies, unchanged decisions, unavailable approaches,
stationary strikes and fatal Fire Wall cleanup. Owned source and test types
pass. A separate exposed full-battle diagnostic completes without the refused
proposal. These establish correctness on those fixtures, not a fresh win-rate
gain. Research invocation counts include hypothetical search rollouts and
must never be reported as actual committed actions or inflate the actual
SearchDriver decision denominator.

The separate registered admission is
`a19-coherent-melee-approach-admission-20261118`, seal
`25f906d7c67cb23d806d6b3711ee5bc7eec59d0322d17dff77d500a4ed79aa86`.
It reuses the original 108 Sniper-development families, both seats and three
arms: current v12, unchanged qualified guard and guard plus coherent combat.
All 648 games retain the actual V3/contextual/exclusive draft, funded setup,
splits, final placement and full accepted A19 search. The guard keeps its exact
qualified population; the repair is scoped to the declared entrant team.
This population is narrow and already exposed. It cannot establish a general
combat improvement or fresh qualification.

Require at least +0.15 score points and a positive adjusted 95% whole-family
bootstrap interval against **both** references, at least ten changed families,
30,000 resamples and seed 2026111820. Preserve all outcomes, zero-error native
quality gates, complete original-control equality, funded openings and source
hashes. Eight fixed exposed cases separately test cold workers, persistent
workers and cached replay: 48 additional physical games and 24 cached repeats.
All fifteen activation/control tests / 158 assertions pass before sealing.

Only a passed admission can justify prospectively registering a distinct broad
native-draft development/held-out bank and serial cost study. Full fight CPU
and weighted CPU per actual decision must each stay within +10% **overall**
against both references; subgroups are descriptive. No fresh confirmation,
serving activation, automatic retry, cutoff extension or deployment follows
from functional tests or an interim score. The fixed admission cutoff is
2026-11-18 21:00 UTC. Raw sources and results remain in the client's ignored
`game/core/tmp/a19-coherent-melee-approach-20261118` capsule.

The admission completed all **648 games** at 2026-11-18 16:46:31 UTC.
Current scored 106 wins / 1 draw / 109 losses, the guard 125 / 4 / 87,
and guard plus coherent approach **126 / 4 / 86**. Against current the gain
was +9.953704 points, adjusted 95% interval +4.166667 to +15.972222. Against
the guard it was **+0.462963 points**, interval **0 to +1.851852**, one
recovered outcome and none given back. Only three families changed against
the guard: the registered ten-family coverage and strictly positive lower
bound gates failed. This result does not establish a new strength gain;
an empirical interval based on one improved outcome cannot rule out unseen
regressions. The fixed candidate stays inactive and closed to fresh progression.

Independent verification checked all 1,444 source hashes, all semantic inputs,
cached records, authoritative winners, funded openings, **432 exact original
current/guard outcomes**, all cold/persistent/cache/main outcomes and both
108-family bootstrap comparisons. Quality errors were zero. The 216 candidate
games contained three repaired root-policy proposals and 491 repaired
hypothetical proposals across 1,513,760 hypothetical policy calls. Four
accepted native commands matched recorded repaired proposals and their events
were verified in the real journal. These are command matches, not proof that
every matching command came from that particular current root decision.
No fresh bank, new cost qualification, default change or deployment followed.

The entrant's repair also applies when either native search forecasts that
entrant's hypothetical actions. In the one recovered case there were no
repaired root proposals and 24 repaired hypothetical proposals; the first
different real journal row was an opponent move. The result therefore must
not be described as a win directly recovered from a refused real attack, or
as evidence of improved win rate against humans. The complete all-case dossier
retains that distinction and every unchanged outcome.

The deliberate [compact result fixture](evidence/coherent_melee_approach_admission_results_20261118.json)
binds all 1,444 sources, all 648 execution summaries, the original controls,
gates, failed attempts and verification receipts. The complete study archive
contains 3,058 independently verified regular files, SHA-256
`e6f55e45de526ea3404c93d07343768bec3cd418dda6383659295f235370bb8d`
(58,726,072 bytes), with a hash-verified Puffalo copy. Follow-up repository
validation and the all-case interpretation dossier are retained separately.
The common build compiler, strict owned source/test types and full client
`bun run check` passed. Serving code does not import the helper.
