# Agent guidance

## Pre-fight goals — owner, November 21, 2026

Before changing anything a default AI seat does before the fight, read the server's
[AI pre-fight goals and scorecard](../../../heroes-of-crypto-server/docs/ai_prefight_scorecard.md). That covers the
doctrine, draft, bans, Tier-1/Tier-2 artifacts, upgrades and placement or splits. The owner wants each doctrine
drawn a third of the time and its information used. Synergies should be planned, and counters and map-suited units
picked. Artifacts and upgrades should be chosen for the army's strategy, and units placed well. Every such change
names the goals it advances and reports the scorecard metric before and after.

## Carrier cohesion — November 24, 2026

At the owner's request `a19-carrier-cohesion-v2` is active: **the current default is profile v32**. Read
`docs/carrier_cohesion_adoption.md`. In laps 1–3 a principal blessing carrier that walks (the largest living stack of a
creature whose blessing lasts only while it lives) does not move from at most 3 cells of its nearest ally to at least 4
cells and 2 farther: the native move becomes a wait, else a defend, and such challengers leave the search
(`src/ai/carrier_cohesion.ts`, hooks in `src/simulation/search_driver.ts`). Flying carriers (Manticore, Angel) and a
seat that bought the striker rush are exempt. Switch `A19_CARRIER_COHESION_<LEFT|RIGHT>` (on unless `0`). A
non-inferiority result, not a strength gain: registered confirmation CF on v30 +0.41 points (95% −0.33 to +1.24). The
first version, R6, held flyers too: it passed confirmation K2 on v28 and failed confirmation CC on v29 at gate CC2
(forced-Manticore armies −2.50 points, 95% −6.67 to +1.67, against the −2 bar). CC2 stays recorded as failed: do not
waive, re-run or relabel it, and do not hold flying carriers again without a new registered confirmation. Keep
`carrier_cohesion.test.ts` passing: it pins the blessing list to `abilities.json`.

Profile v31 is retained inside v32.

## WAIT comparisons under the clock — November 24, 2026

At the owner's request ("Keep v29, confirm cap") `a19-wait-clock-v1` is active: at that date the default was profile v31.
Read `docs/wait_clock_adoption.md`. The bot seat's stock and deep searches run WAIT comparisons under the same deadline as
every other comparison (`V08_A19_DEEP_FIT.waitBudget`: `SEARCH_WAIT_DEADLINE_POLICY` `profile` instead of the A19 profile's
`operation_bounded`), so no move outruns the owner's 4 s. Offline deterministic work and Premium are unchanged. Registered
confirmation WC, a non-inferiority real-time clash at the production host's speed: 49.05% head to head against v30 (95%
47.89 to 50.19; 1,080 tasks, both seats); the capped bot's longest move 4.09 s and none over 4.5 s, against 7.22% over
4.5 s and a longest 11.0 s for v30. All seven gates passed. Do not report it as a strength gain.

Profile v30 is retained inside v31.

## Stock search deadline 2,500 ms — November 24, 2026

Under the standing instruction `a19-stock-deadline-v1` is active: at that date the default was profile v30. Read
`docs/stock_deadline_adoption.md`. A bot seat's stock search gets a live decision deadline of 2,500 ms and a circuit breaker
of 3,750 ms (`V08_A19_DEEP_FIT.stockBudget` in `src/simulation/v0_8_a19_deep_fit.ts`) instead of the A19 profile's
1,000 / 1,500 ms; on the production host the 1,000 ms deadline cut the stock search on about one decision in eight.
Offline deterministic work has no clock, so no offline result changes. Registered confirmation SD, a real-time clash at
the production host's speed: 53.12% head to head against v29 (95% 51.56 to 54.76; 720 tasks, both seats;
owner-shaped 52.71%, mirror 53.54%); all seven gates passed.

Profile v29 is retained inside v30.

## Deep fit at 4,000 rollout turns — November 23, 2026

Under the standing instruction `a19-deep-fit-4000-v1` is active: at that date the default was profile v29. Read
`docs/deep_fit_4000_adoption.md`. The bot seat's deep-fit budget (`V08_A19_DEEP_FIT.rolloutTurnBudget` in
`src/simulation/v0_8_a19_deep_fit.ts`) is 4,000 rollout turns instead of 2,800; the driver, the deep search and the
4,000 ms think deadline are unchanged. Registered confirmation U +2.48 points per task (95% +1.67 to +3.28; 7,950
tasks; mirror +3.81, owner-shaped rush +0.98, native +2.53). It is a turn-budget estimate: on the slow production host
the deadline cuts many deep searches, and a WAIT incumbent's deep search (no wall clock) can take up to about 9 s there.

Profile v28 is retained inside v29.

## Valkyrie with the strikers — November 23, 2026

Under the standing instruction `a19-valkyrie-striker-v1` is active: at that date the default was profile v28. Read
`docs/valkyrie_striker_adoption.md`. The striker-rush formation moves Valkyrie with the strikers
(`src/ai/setup/a19_valkyrie_striker.ts`; server switch `HOC_A19_VALKYRIE_STRIKER`). Confirmation S on rush armies with a
Valkyrie +7.36 points per task (95% +4.72 to +10.02). Confirmation P (also flyers in the middle rows)
failed and is not adopted.

Profile v27 is retained inside v28.

## Never casting Wind Flow: failed, November 23, 2026

Read `docs/no_wind_flow_research.md` before changing how the AI casts Wind Flow. Registered confirmation T dropped every
Wind Flow challenger from the A19 search on armies with a Valkyrie. Its strength gate failed: +0.28 points per task (95%
−0.19 to +0.77). It is not adopted, and `candidates.ts` still generates Wind Flow. Do not waive, re-run or relabel T1.
Its bank is consumed. A situational variant played like never casting in development and is not pursued.

## Opponent history in the counter draft: failed, November 23, 2026

Read `docs/opponent_history_draft_research.md` before giving the counter draft any opponent history. Registered
confirmation OH drew the opponent's unseen slots from its last 30 armies blended with the production prior. Its
strength gate failed: owner-shaped rush +1.04 (95% −0.03 to +2.16). Against the default AI it lost −2.43 (−4.44 to
−0.42). It is not adopted and `a19_counter_draft.ts` is unchanged. Do not waive, re-run or relabel it; its bank is
consumed.

## Lava Striders by map — November 22, 2026

Under the standing instruction `a19-lava-map-artifact-v1` is active: **the current default is profile v27**. Read
`docs/lava_map_artifact_adoption.md`. With the map public at the Tier-2 pick, Lava Striders is never taken on a map
without lava while a usable artifact is offered (`src/ai/setup/a19_lava_map_artifact.ts`; server switch
`HOC_A19_LAVA_MAP_ARTIFACT`). Confirmation V without lava +0.48 points per task (95% +0.24 to
+0.73); the owner-rush guard passed. Its lava-map rule (a striker army takes Lava Striders) failed its strength
gate (+0.09, 95% −0.32 to +0.51) and is not adopted.

Profile v26 is retained inside v27.

## Gated counter draft — November 22, 2026

Under the standing instruction `a19-counter-draft-v1` is active: **the current default is profile v26**. Read
`docs/counter_draft_adoption.md`. Once a seat sees two opposing creatures that read melee, it drafts with a matchup model
of creature counters (`src/ai/setup/a19_counter_draft.ts`; server switch `HOC_A19_COUNTER_DRAFT`). Confirmation Z against
the default AI +5.30 points (95% +1.19 to +9.35); owner-rush, decoy-fort, Queen-fort and
caster guards passed.

Profile v25 is retained inside v26.

## Decoy-aware targeting — November 22, 2026

Under the standing instruction `a19-decoy-aware-v1` is active: **the current default is profile v25**. Read
`docs/decoy_aware_adoption.md`. A melee unit never spends its strike on a one-model decoy while it can strike a real
stack (`src/ai/decoy_aware.ts`; switch `A19_DECOY_AWARE_<LEFT|RIGHT>`, on unless `0`). Confirmation Y against the owner's
checkerboard decoy-fort layout +6.33 points (95% +2.59 to +10.05); ring fort, mirror and owner guards passed.

Profile v24 is retained inside v25.

## Wild Regeneration gift — November 22, 2026

By the owner's explicit decision `a19-wild-regen-gift-v1` is active: **the current default is profile v24**. Read
`docs/wild_regen_gift_adoption.md`. The Troll's one-way Wild Regeneration gift goes only to an ally whose creatures have
more max HP than the caster's (`src/ai/wild_regeneration_gift.ts`, used by `candidates.ts` and the v0.8 native gift;
switch `A19_WILD_REGEN_GIFT_<LEFT|RIGHT>`, on unless `0`). Confirmation W measured +0.05 points (95% −1.97 to +2.09) and
removed every gift to a weaker creature (526 → 0). Its owner guard (W3, −2.34) failed and stays recorded as failed: do not
waive, re-run or relabel it. No strength gain is claimed.

Profile v23 is retained inside v24.

## Deep search when it fits — November 22, 2026

Under the standing instruction and at the owner-approved think budget of about 4 s, `a19-deep-fit-v1` is active:
**the current default is profile v23**. Read `docs/deep_fit_adoption.md`. A bot seat runs the deep A19 search (8
rollouts, shortlist 10, max melee 16) after the stock search, whenever both fit 2,800 rollout turns, or 4,000 ms
live. Otherwise it plays the stock choice (`src/simulation/v0_8_a19_deep_fit.ts`). Premium advice keeps the stock
search. Preserve the registered +5.35-point mirror estimate (95% +2.72 to +8.06; every map positive) and the
owner-shaped guard of +3.67. Its quality gate (G4: 10 candidate games against 6, all refusal causes that v22 fixes)
failed and stays recorded as failed: do not waive, re-run or relabel it. Confirmation K, the same rule at 1,400
turns, failed its strength gate (+1.22) and stays failed.

## Rejection fixes — November 21, 2026

Profile v22 is retained inside v23. At the owner's request (“Need to fix all rejection causes”),
`a19-rejection-fixes-v1` is active: **the current default is profile v22**. Read `docs/rejection_fixes_adoption.md`. Two causes are fixed in common.
`a19CoherentMeleeApproach` (`src/ai/coherent_melee_approach.ts`) is the last step of `StrategyV0_8.decideTurn`, so
a native decision no longer moves and then strikes from the old cell. `StrategyV0_1.isLegalMoveRoute` accepts only
destinations in the engine-equivalent, zone-of-control-aware known paths, which a mindless Berserker or Frenzied
Boar needs. Both are on unless `A19_COHERENT_MELEE_APPROACH_<LEFT|RIGHT>` or `A19_ENGINE_REACHABLE_ROUTES_<LEFT|RIGHT>`
is `"0"`. The third cause, a turn-engine wedge, is fixed in the server. The registered non-inferiority confirmation
passed all six gates. Mirror +0.06 points (95% −0.94 to +1.07); owner-shaped guard
+0.10; entrant refusals 5 → 0. Its bank (namespace `rejection-fixes-20261121-v1`,
171 families) is consumed.

## Keep-attack fix — November 21, 2026

Profile v21 is retained inside v22. At the owner's request, `a19-keep-attack-v1` is active: **the current default
is profile v21**. Read
`docs/keep_attack_adoption.md`. The owner reported that units sometimes move up to an enemy and do not
attack. A melee unit's search no longer lets a non-attacking challenger replace a native melee attack
(`SEARCH_A19_KEEP_MELEE_ATTACK`). While any scored candidate attacks, it also does not let a plain move
that ends next to an enemy win (`SEARCH_A19_KEEP_CONTACT_ATTACK`). The rule is `applyA19KeepAttack` in
`src/ai/keep_attack.ts`, applied in the search driver right after the primary means. Ranged units are
unchanged. The confirmation was registered as non-inferiority on a fresh sealed bank and passed all six
gates. Mirror +1.34 points (95% −0.39 to +3.05; 1,674 tasks); owner-shaped guard +2.15 (+0.69 to
+3.58); plain moves into contact 3,499 → 84. Do not report the mirror as a strength gain: its interval
crosses zero. Confirmation J tested rule 1 alone (+0.33, 95% −1.19 to +1.94). It failed its strength
gate and stays recorded as failed. All ten quality-error games of the confirmation were the declined
scripted melee proposal, which is a separate cause. Its bank (namespace `keep-attack-20261121-v1`,
families 0000–0185) is consumed.

## Tier-2 pick for a striker army — November 21, 2026

Profile v20 is retained inside v21. Under the same standing instruction as the sections below,
`a19-tier2-striker-v1` is active: **the current default is profile v20**. Read
`docs/tier2_striker_adoption.md`. An army with fewer than two
ranged stacks takes Crown of Command when it is offered and the opponent's melee probability
(`a19OpponentMeleeProbability`, legally visible creatures only) is below 0.8; otherwise an established
Tier-2 artifact outranks the five that artifact-fit-v8 scores with a forecast. Such armies used to read
the v0.7 melee table, where Crown is the lowest entry. The rule is in `src/ai/setup/a19_tier2_striker.ts`;
the server applies it in its A19 setup policy and Premium advice follows it. Preserve the registered
+7.06-point estimate (95% +4.39 to +9.76; 1,693 changed games on a fresh sealed bank) with its scope:
games where the artifact changes, not a win rate against people. Its quality gate (G4: two candidate
games against one with a declined scripted melee proposal) failed and stays recorded as failed: do not
waive, re-run or relabel it. Crown loses the melee mirror (−18 on development swaps): do not drop the
melee-probability condition. Its bank (namespace `tier2-striker-20261121-v1`, first 120 of 306
families) is consumed; the remaining 186 families are unused.

## Striker rush from one shooter — November 20, 2026

Profile v19 is retained inside v20. Under the same standing instruction as the sections below,
`a19-striker-rush-one-shooter-v1` is active: **the current default is profile v19**. Read
`docs/striker_rush_one_shooter_adoption.md`. An
army with exactly four strikers is rushed from one shooter (v18: two). Casters without a ranged
attack do not count: four strikers with casters only measured −12.8 for the rusher and keep the
native setup. `A19_STRIKER_RUSH_MIXED_V18_MIN_SHOOTERS` keeps the v18 value for the server's
rollback switch. Preserve the registered +4.64-point estimate (95% +0.91 to +8.40; 927 changed games
on a fresh sealed bank); its quality gate (G4: two candidate games against one with a declined
scripted melee proposal) failed and stays recorded as failed: do not waive, re-run or relabel it.
Its bank (namespace `rush-shooter-20261120-v1`) is now consumed.

## Striker rush against mixed armies — November 20, 2026

Profile v18 is retained inside v19; where this section says "current default", read v18 as the
default at that date. Under the same standing instruction as the sections below,
`a19-striker-rush-mixed-v1` is active in the A19-backed v0.8 default: **the current default is profile v18**. Read
`docs/striker_rush_mixed_adoption.md` before changing the rush condition.

The striker rush used to stop at three enemy strikers. It now also covers an army with **exactly four
strikers and at least two shooters**: a seat that drafted for a melee fight was keeping its stock
setup while two shooters fired at it, and scored 53% and 63% against such armies. The condition is
`isA19StrikerRushSetup` in `src/ai/setup/a19_striker_rush.ts`; plan, formation and draft are
unchanged, and the draft's matchup probability keeps its four-striker boundary.

Do not widen it beyond what profile v19 confirmed (one shooter, casters not counted). "Any army with
four strikers" was registered first and **failed its mirror guard**:
against the default's own four-striker armies it lost 7 and won 1 of 12 changed tasks. One shooter
measured +3.7 (95% −6.5 to +14.4). Four strikers with no shooter, the shape of the army the rush was
learned from, hardly occurs in the mixed banks and lost all three mirror tasks. Even the adopted
shape lost 4 and won 1 of 10 changed mirror tasks; such armies are about 1% of
default-against-default games.

Preserve the registered +9.20-point estimate against mixed armies (95% +6.81 to +11.68; 576 sealed
tasks; +23.2 and +13.2 on the tasks where the setup changes) together with its **failed** quality
gate: four candidate games against one with a declined scripted melee proposal, the known incoherent
approach of `docs/coherent_melee_approach_research.md`. Do not waive, re-run or relabel it. The
estimate is against mixed armies drafted by the AI, not a win rate against people.

Subsequent research compares with v18. Both research seed pools are now fully consumed: a new study
needs a new namespace.

## Striker matchup draft adoption — November 20, 2026

Profile v17 is retained inside v18; where this section says "current default", read v17 as the
default at that date.

Under the same standing instruction as the sections below, `a19-striker-matchup-v1` is active in the
A19-backed v0.8 default: **the current default is profile v17**. Read
`docs/striker_matchup_adoption.md` before changing it.

Profile v15 took fast strikers first, which is right for a rush and wrong for a brawl. Every striker
now has two measured values, one for a rush against an army that is not melee and one for a fight
against a melee army, and the seat takes the striker on offer worth most for the probability that
the opponent ends with four or more strikers. That probability is computed from the opposing
creatures the seat may legally see at the pick, through the server's own visibility projection; never
hand it anything else. The head runs on the striker rush head's choice, never takes a non-striker,
never runs without the striker rush head, and spends none of the earlier layers' one-use budgets.
`src/ai/setup/a19_striker_matchup.ts` holds the table and the choice; the server's draft decider
calls it.

The table is fitted on exploration drafts with uniformly random striker picks (1,925 rush games,
1,260 mirror games). Do not edit a value by hand or re-fit it on games drafted by the policy itself:
a new table is a new candidate and needs its own confirmation. The values describe AI-played games
and are not a balance statement.

Preserve the registered +28.06-point estimate against v16 (95% +22.96 to +33.06; 540 sealed tasks,
all three maps positive, all six gates passed) with its meaning: it is against a default that does
not adapt, two matchup seats meet at 50%, and it is not a win rate against people. Against the
shooter-fielding v14 the candidate measured +3.52 (95% −0.83 to +7.96): not worse, gain not
established. Fitted Tier-1 values in the bundle choice and matchup values at level 3-4 only were
tried on development tasks and were worse.

Namespace `matchup-draft-20261120-v1`: families 0-59 are this confirmation; 60-119 and 120-183 were
consumed by the two striker rush confirmations of profile v18.

## Shooterless Movement adoption — November 20, 2026

Profile v16 is retained inside v17; where this section says "current default", read v16 as the
default at that date.

Under the same standing instruction as the section below, `a19-shooterless-movement-v1` is active in
the A19-backed v0.8 default: **the current default is profile v16**. Read
`docs/shooterless_movement_adoption.md` before changing it.

A seat without a ranged creature gets nothing from Sniper, yet the composition-blind anchor spend
gave every seven-point seat Armor 3, Might 3 and Sniper 1. The rule spends those Sniper levels on
Movement. It rewrites the stock plan only: a plan that already buys Placement or Movement (a funded
delivery plan, a rush plan) is left as it is, and so is every army with a shooter.
`src/ai/setup/a19_shooterless_setup.ts` holds the rule; the server's setup decider calls it. Armor 3
and Might 3 still come first: one Movement or Placement level in place of the last Might or Armor
level measured worse, so do not extend the rule to five- and six-point plans.

Preserve the registered +8.06-point estimate (95% +3.89 to +12.04; 540 sealed tasks; all five gates
passed) with its scope: a **seven-point seat against profile v15**, a melee mirror. One default seat
in three has seven points, games the seat rushes are unchanged, armies with exactly one shooter were
not measured, and it is not a win rate against people. The registered analysis script was amended
once, before any result was seen, for a division by zero in a descriptive breakdown; both hashes are
in the results file.

Subsequent research compares with v16. The first rush namespace is now fully consumed: families 0-66
development, 67-126 the striker rush confirmation, 127-186 this confirmation. A second sealed pool,
namespace `matchup-draft-20261120-v1`, has had no development use.

## Striker rush and artifact beneficiary adoption — November 20, 2026

Profile v15 is retained inside v16; where this section says "current default", read v15 as the
default at that date.

On November 19 the user gave a standing instruction for this research: “always lock in wins and
continue”. Under it `a19-striker-rush-v1` and the Tier-2 beneficiary rule (`artifact-fit-v8`) are
active in the A19-backed v0.8 default: **the current default is profile v15**. Read
`docs/striker_rush_adoption.md`, `docs/striker_rush_research.md` and
`docs/artifact_beneficiary_rule.md` before changing any of it.

The policy is a draft head plus a setup rule and they are one policy. A default seat drafts melee
strikers, fast ones first. With both complete rosters public, a seat with at least four strikers
facing an army with at most three buys Placement 2 and Movement 2 and starts its real striker stacks
on the edge of the zone nearest the enemy. Against a melee army it keeps its native setup, because the
same plan loses there. The draft head without the setup rule is worth nothing (+0.0 on 198 development
tasks) and the setup rule on the previous shooter-heavy drafts costs points, so never ship, switch
off or measure one half as if it were the policy. `src/ai/setup/a19_striker_rush.ts` holds the rules;
the server's deciders call them. The A19 search, weights, models and budgets are unchanged.

Preserve the registered +28.80-point estimate against v14 (95% +23.52 to +34.07; 540 sealed tasks,
positive on all three maps) together with its two **failed** gates, quality and cost: do not waive,
re-run or relabel either. The quality failure is one declined melee proposal in 540 candidate games,
made by the default opponent's script (the inactive coherent-approach repair addresses it); the cost
failure is 1.2529 times the control's CPU per game against a 1.25 limit, about 39% more CPU per
searched decision. Live latency under the decision deadline is not measured. The estimate is against
the previous default, which fields shooters: it is not a win rate against people, and the new default
against itself was only run as a quality check.

The beneficiary rule keeps Giant's Maul for rosters with a physical area attacker among the five
known creatures and Farsight Quiver for rosters with a shooter, counting the seat's stated level-4
prospect for the quiver only. It rests on a 239-pair changed-case diagnostic, not on a registered
confirmation. v8 extends the registered v6 line and changes only the Tier-2 pick, so
`artifactFitVersionForSetupSpec` reports **6** for a v8 spec: every draft consumer, including the
frozen contextual draft helpers whose source hashes are locked, stays on its v6 path. Never hand a
draft 8, because "at least 7" selects the unadopted Dual Strike candidate.

Subsequent research compares with v15. Already-running frozen studies keep their registered
comparator. The research seeds are namespace `rush-doctrine-20261120-v1`: families 0-66 development,
67-126 the consumed confirmation, 127-186 still sealed.

## Explicit neutral barrel deliberation adoption — November 19, 2026

Profile v14 is retained inside v15; where this section says "current default", read v14 as the
default at that date.

The study report recommended adopting the candidate as profile v14 and listed both failed gates. The
user answered “continue, do what is needed”. This activates `a19-neutral-barrel-deliberation-v1` in
the A19-backed v0.8 default: **the current default is profile v14**. It supersedes the non-activation
notes in the study section below for this candidate only. Read
`docs/neutral_barrel_deliberation_adoption.md`.

`SEARCH_A19_NEUTRAL_BARREL_DELIBERATION=1` is a sealed profile rule; the switch itself lives in
`SearchDriver`. At an A19 root whose native incumbent strikes a standing neutral stone, melee or ranged,
the strike is searched against the other legal actions instead of being returned. It stays candidate
zero and survives ties and deadline fallbacks. The native cleanup, every forecast, deployment-barrel
handling, classic mountains, draft, setup, models and budgets are unchanged, and boards without neutral
stones cannot change. The a13 rollback leaves the switch unset; an explicit A19 research override may
set it to 0. Tiers without A19 search keep the scripted strike.

This is explicit user adoption of a confirmed strength result whose quality and serial-cost gates
failed, not a complete qualification. Preserve the +3.58-point held-out estimate against v13 (95%
+2.44 to +4.75), both failed gates and all fixtures unchanged; do not waive, re-run or relabel either
gate. The estimate changes one seat on Cemetery only. It is not a global win rate, and production
latency is not certified. The +10.14% is complete CPU of a two-seat game with one seat changed; that
seat itself searches about 21% more decisions per Cemetery game (22.8 to 27.6), an estimated one sixth
more search CPU. All 212 replayed games of profile v14 match the measured candidate exactly, and all
212 match v13 with the rollback override. Subsequent research compares with v14. Already-running
frozen studies keep their registered v13 comparator and need separate confirmation against v14 before
claiming a new default gain.

## Neutral cemetery barrel deliberation study — November 19, 2026

Read `docs/neutral_barrel_deliberation_research.md` before touching barrel strikes. The native v0.8
cleanup turns every non-attacking turn into an obstacle strike while a one-hit stone stands, and A19
returned that strike without comparison except for melee deployment-barrel strikes. On Cemetery this was
3.27 neutral barrel strikes per seat-game, 12.6% of all root decisions.

`a19-neutral-barrel-deliberation-v1` gives a strike on a standing **neutral** stone, melee or ranged,
the same comparison the adopted v9 switch gives melee deployment-barrel strikes. The native cleanup,
every forecast, deployment-barrel handling, classic mountains, models and budgets are unchanged, and
boards without neutral stones cannot change. Fresh development on 1,080 Cemetery families gained +3.31
score points (95% +1.57 to +5.07). The registered held-out confirmation on 2,700 fresh families / 10,800
games gained **+3.58 points (95% +2.44 to +4.75)** under the most adverse reading of its six rejected
games (every affected family scored as a double loss for the candidate); the Amendment 1 analysis gives
+3.62 (+2.46 to +4.79). Every strength and control gate passed. **Two registered gates FAILED:**
quality, because one rejected game was outside the amended class (a mindless v0.1 Berserker closed by
the non-policy timeout), and serial cost (complete CPU +10.14% against the +10% limit on 72 Cemetery
cases; +3.93% per decision). Do not waive, re-run or relabel either gate: the candidate is measurably
stronger on Cemetery but is not qualified for automatic progression.

The switch `SEARCH_A19_NEUTRAL_BARREL_DELIBERATION` is in `SearchDriver`. When the study closed it was
pinned **off** in profile v13 (sealed environment `"0"`, a13 rollback unset); the adoption above turned
it on as profile v14. A 36-game integration replay through the real switch matches the research seam
exactly. Amendment 1 was filed blind during collection: a game rejected only for the known native
refusal (`strategy v0.8 proposal declined: type=melee_attack reason=attack_not_available`) has its
family scored as the worst completion for the candidate; 5 families were imputed that way. Do not relax
that rule, drop those families or reuse the consumed bank. A searchless exploration found no gain from
removing the scripted strike from the plain native policy (−0.82 points, −2.52 to +0.86), so the gain
comes from giving those turns back to A19's search.

Preserve `docs/evidence/neutral_barrel_deliberation_registration_20261119.json`, the results fixture and
the seed fixture. Exclude namespace `barrel-strike-necessity-20261119-v1`: roles `draft`, `setup`,
`reverse`, `terrain`, counters 1..24,000 each, preimage = first four little-endian bytes of
SHA-256(`<namespace>:<role>:<counter>`); draft reserves raw offsets 0..31 and their native permutation,
setup and reverse their root, terrain its root and canonical search channel. Every scanned counter stays
reserved, including rejected ones and the 1,386 never-played families (scan index 420..573). The arrays
are in the client's ignored `game/core/tmp/barrel-strike-necessity-20261119` capsule. The consumed
confirmation bank must not tune another candidate. Melee-only and root-removal variants scored the same
within noise on development and were not confirmed; do not present them as separately qualified. Ranged
strikes on deployment barrels and the searchless native policy were not studied and keep their behavior.

## Exact placement inference optimization — November 19, 2026

Read `docs/a19_placement_inference_optimization.md`. Current v13 retains its
original packed models, eight proposals, reference policy and strict 0.03 margin.
Cached compiled predictors snapshot finite tensors and rebuild the input nonzero
indices on every call. Skip zero products only before the first hidden ReLU,
retain nonzero accumulation order and binary64 inputs, and keep linear outputs /
later layers on the dense evaluator. Do not cache feature masks or regroup terms.
The existing dense `predict` function remains the exact reference.

The actual serving-selector benchmark used 72 balanced public inputs / 576
counterbalanced selections per arm and 32.47% less warm CPU, with 5.803 ms one-time
compilation CPU for both models. Six known complete native games reproduce all
three dense/compiled outcome pairs exactly on the three live maps. This is
performance/correctness evidence, not new strength or full-match latency.
Both packed tensor identities and the profile revision remain unchanged. Keep
`placement_predictor.test.ts` and the existing adoption/placement/isolation tests
passing. The independent learning source `a0263806` remains frozen and running;
its data, final 80, strength/confirmation and overall-average +10% gates stay intact.

## Fresh weighted-movement paired study — November 19, 2026

Read `docs/a19_public_placement_weighted_move_learning.md` before new sampling,
fitting or seed allocation. This distinct preparation freezes published corrected
common d4fa46e4/server d2d830d with current v13; all five predecessors stay closed
and unfitted. Reserve ALL six roles ×32,768 counters and 2,293,206 expanded channels
in `native-public-placement-weighted-move-pairs-20261119-v1`, including rejected,
unused and unselected values, all raw/permuted draft offsets0..31 and terrain search
channels. Exclude this full sixth reservation in other studies, not just selected
roots. Input/label/fit cutoffs are Nov19 12Z /Nov20 04Z /05Z, without extension.

Keep all 1,152 families/16,128 labels, the paired observation schedule, exact warm
start/final80 and original +2-point/positive95%/30 changed-family gate. Both final
exports precede validation; exact regenerated native CPU choices must match on
both nodes before accepting effect statistics. All 24 local process/protocol/atomic controls, actual scheduler preflight,
24 known native/cold/pooled games and twelve foreign corruption checks passed.
Both nodes independently reconstructed identical 1,152-family / 4,608-case inputs
and verified label source `a0263806` (8,351 files / 27 links). Read the execution
checkpoint in that document: metadata publication failures remain preserved;
no captures or native combats were replayed for those repairs. Fresh labels are
now collecting in 146 fixed blocks, with two indexed raw replicas and foreign
native verification before each acknowledgment. No model or gain exists yet.
Complete data precedes fitting. Fresh strength/held confirmation and the
user's overall-average +10% complete-fight/weighted actual-decision CPU for both-AI
adoption remain separate. No automatic activation or deployment.

## Backstab authoritative movement correction — November 19, 2026

Read `docs/a19_backstab_movement_correction.md`. The Scavenger invalid move was
traced to `preferBackstabAttackCell` asking for finite movement against a zero
threat matrix. Threat is an authoritative movement price; the corrected request
uses actual enemy aggro and keeps the original attack when no bonus cell fits.
Preserve the engine's reachability checks and all fourteen Backstab tests,
including both teams/axes and cached/direct native paths. Do not restore the
zero-threat shortcut or treat it as a risk preference.

Three complete read-only diagnostic games exactly reproduced the exposed original
native outcome. Two separately sealed corrected engineering replays, one per node,
have zero raw quality errors and identical full corrected outcomes; the winner is
unchanged. This is correctness evidence, not fresh strength or final compute
qualification. No model/profile/search-budget change or deployment follows.
Keep the paired study closed/unfitted and exclude all five complete six-role
namespace reservations. Future compute gates use the user's overall mean +10%
bound for full-fight and weighted actual-search-decision CPU, including both-AI
adoption; subgroup costs are descriptive.

## Closed paired placement after invalid native move — November 19, 2026

Read the closeout in `docs/a19_public_placement_pair_learning.md`. The paired
study is CLOSED INCOMPLETE after a native enemy Scavenger move_unit/invalid_move
at 08:28:59 UTC. Preserve 768 logical / 711 unique native fights in 12 complete blocks,
both raw interrupted prefixes and rejected outcome; all are replicated and all
member indexes verified on both nodes. Every native controller/child is stopped.
There was no fit or validation-effect aggregation. No resume, extension, partial
fit, case exclusion, data retry, reclassification, new gain or default activation.

Exclude ALL 6 roles × 32,768 counters / 2,293,095 expanded channels in namespace
`native-public-placement-paired-data-20261119-v1`, including rejected/unused scans,
raw/permuted draft offsets 0..31 and terrain sim-search expansions. The FOUR older
closed six-role reservations also remain excluded. This is a fifth closed bank.

The separately registered two-game read-only Scavenger diagnosis uses only the
exposed invalid case; it must exactly match the original full raw native outcome
and keep its warning invalid. Its telemetry cannot fit/rescue this corpus or
qualify strength. Unsupported observer flags did NOT establish movement state or
RNG mutation; the move lacked the full witness and actual engine draws were zero.

## Paired-label placement preparation — November 19, 2026

Read `docs/a19_public_placement_pair_learning.md` before new sampling or fitting.
The distinct prospective study uses current published engine revisions and a
wholly fresh `native-public-placement-paired-data-20261119-v1` namespace. Reserve
all six roles × 32,768 counters, including rejected/unused values, with the same
raw/permuted draft offsets and terrain search expansion. Explicitly exclude all
four preceding full six-role reservations, including the closed five-/six-point
study, plus historical/peer ledgers. No old partial labels are fitted or bank resumed.

Keep 864 training / 288 validation families and all four seat/future cases. Training
observes reference 0 plus one fixed scheduled alternative; validation keeps all
eight proposals. Complete funding is 16,128 logical labels. The final 80 models,
primary 2-point/positive 95% interval/ 30 changed-family gates, full native quality,
fresh strength/confirmation and overall-average +10% CPU requirements remain.
Source/input/execution seals, actual scheduler preflight and integrated process /
ENOSPC stop rehearsal must pass before any fresh native label. No Mac collection,
partial fitting, validation tuning, automatic retry or default activation follows.

Input source `72308b4d` stopped at worker import with zero scanned drafts,
setup captures or combat games. Preserve that failed attempt. Read the separate
packaging correction: `77a36c2f` adds the omitted existing parity helper and
known-input preflight before only previously unexecuted input tasks. It is the
SAME unopened allocation, not new independent data or an invalid native retry.
All 2,293,095 reserved channels, funding, validation and cutoffs remain fixed.

The complete unopened label source is now `da73d271` (6,225 files). Both nodes
independently reconstructed identical 1,152-family / 4,608-case inputs; the final
freshness audit found zero intersections across 402 ledgers. Actual scheduler
inspection passed for 91 HFT / 55 Puffalo whole-family blocks at four / eight
nice 19 workers. Keep the execution fixture, eight remaining known canonical
engineering games, foreign corruption controls, both-archive acknowledgment
barrier, complete 16,128 labels and final80-before-validation requirements.
Per-block canonical comparisons are quarantined; they do not select a model.

The original `da73d271` label execution stopped in known-input engineering on
an exporter final-record format assertion, before any fresh label. Preserve it
and both stopped prefixes. The separate final-record correction is `794b281e`
(6,246 files), with the SAME unopened input bank and all 16,128 funded labels.
All 24 completed known engineering games / exact native-cold-pooled-cache parity
and twelve foreign corruptions pass. Two interrupted unvalidated Puffalo attempts
remain separate; only their same two logical slots were continued, with no valid
completed or native-invalid result replayed. Freshness was re-audited across 403
ledgers with zero intersections. Keep the original policies, complete-data gates,
model/fit, fixed hardware, full validation and cutoffs. The failed source stays failed.

The first two native blocks produced 128 logical / 119 unique physical games,
with zero native rejections. Both schedulers then stopped on an acknowledgment
shape error. Read the source-bound operational correction `1f30d785`: strict
shared flat acknowledgments, sixteen local controls and seven real-payload tests
on each node. Native producer `794b281e`, every native source/cache key, inputs,
policies, quality, funding, models, gates and original cutoffs stay unchanged.
Both first blocks were fully reverified on the opposite node with two exact raw
replicas, without replaying any completed fight. The 128-label barrier passed
before continuing only unexecuted tasks. This study remains unclosed; do not fit
partially, retry a native-invalid game or reinterpret the failed scheduler as passed.

## Closed JSON placement collection after storage failure — November 19, 2026

The `b8d7f4ed` producer / `8cf5e842` analysis continuation is now **closed incomplete**.
Read the storage closeout appended to `docs/a19_public_placement_json_learning.md`.
The local controller died on ENOSPC while publishing a completed block receipt;
its failure-marker write also failed, and the coordinator did not check process
liveness. All owned collection jobs are stopped. Preserve 6,144 independently
verified logical labels / 5,250 unique native inputs in 26 complete blocks,
including the 128-label postmortem recovery, plus all unvalidated interrupted
prefixes. There was no fit or validation-score aggregation. Do not resume this
bank, fit partial labels, extend cutoffs or call the collection passed. All six
roles ×32,768 counters and 2,293,218 expanded channels in its JSON namespace remain
excluded, including rejected and unused values. Earlier closed banks stay excluded.

Future copies of this pipeline must verify the owned controller's actual process
identity, detect missing processes even without a marker, and deliver every remote
stop despite a failed local write. Seven fault-injection controls pass for the
separate guard prototype; integrate it before another campaign. The frozen failed
sources stay unchanged. Independent description-cache research is separate and
does not train this incomplete data or activate a model.

## Fresh lossless-JSON placement preparation — November 19, 2026

Read `docs/a19_public_placement_json_learning.md`. The corrected recorder passed
twelve fixed cross-host native/observed controls; this is functional evidence only.
The separate study retains the same complete-data/model/gate/04:00/10:00/11:00 UTC
deadline recipe and uses wholly fresh inputs, not either closed collection.
Reserve all six roles ×32,768 counters in namespace
`native-public-placement-audited-json-data-20261119-v1`: 2,293,218 unique expanded
channels, including rejected and unused values. Explicitly exclude both preceding
six-role reservations. No partial fitting, validation tuning, automatic retry,
default change or promotion. Full label source/allocation is now sealed at
`6169a81c` with 6,173 files; read the label-execution fixture. Fixed whole-family
allocation is 720Mac/288HFT/144Puff, four/six/twelve nice19 workers and 223 blocks.
Only a complete independently verified 36,864-label index permits fitting.

That source stopped on an operational registration lookup before any fresh
combat task. Read the appended scheduler correction. The separately sealed
`b8d7f4ed` execution fixes only orchestration, with a zero-game scheduler contract
check before launch. It retains the SAME unopened registered input bank and all
policies/models/gates/deadlines; do not call it new independent data or a native
label retry. Preserve the failed6169a81c attempt. No automatic invalid-game retry,
input substitution, partial fitting or deadline extension follows.

The independent Float64 equality check later produced a false audit failure:
all1,064,448 affected coordinates have identical actual Float32 tensor bytes.
Read the appended Float32 correction and evidence. Separate analysis source
`8cf5e842` reverified640 completed logical labels, retaining the unchanged
`b8d7f4ed` producer, inputs, cache keys/outcomes, fitter and policy gates. Resume
only canonical unfinished tasks; never retry a native-invalid outcome or count
old labels as new independent data. The operational Mac pool is8 after an exact
old-case parity control, HFT6/Puff12; full per-game work and host assignments stay
fixed. Final CPU-policy choices must still exactly match and numerical error stay
within1e-4. Complete-data and original cutoff requirements remain mandatory.

## Audited collection stopped in engineering — November 19, 2026

The `22a4a8bf` label source failed strict JSON encoding of an optional native
`engineResult.message: undefined` in its fixed preflight. Read the closeout in
`docs/a19_public_placement_audited_learning.md`. No fresh label or fit exists.
All its six-role scanned/rejected/unused reservations remain excluded; do not
resume that source, reuse its input bank as fresh data or reinterpret it as passed.
The separately registered twelve-game lossless-JSON admission verifies the
corrected recorder only; it is not strength, cost or a deployed AI improvement.

## Fresh audited placement collection preparation — November 19, 2026

Read `docs/a19_public_placement_audited_learning.md` before new data work or seed allocation.
The separate source-bound native-refusal observer passed all thirty fixed controls, keeping the
original warning canonically invalid. This does not reopen the failed November18 collection or
qualify strength/cost. The new complete-data registration fixes 1,152 fresh families, 36,864 logical
labels, the unchanged 2,772-feature warm-start/final80 fitter and an explicit per-game quality
contract. No old partial labels, validation tuning or automatic activation. Full label source and
allocation must be sealed before fresh fights; every native warning/proof remains auditable.

Reserve **all six roles ×32,768 scanned preimages** in namespace
`native-public-placement-audited-data-20261119-v1`, including rejected/unused scans. Expand its
little-endian SHA256 recipe, draft raw/permuted offsets0..31, setup/reverse roots and terrain raw /
`sim-<root>` search channels explicitly; see the registration fixture. There are 2,293,215 unique
reserved channels. Preserve all older exclusions and unopened banks. Inputs/labels/fitting cutoffs
are November19 04:00/10:00/11:00 UTC without automatic retry/extension/exclusion or partial fitting.
Internal admission is not fresh qualification; independent confirmation and overall-average +10%
full-fight/weighted actual-decision CPU including both-AI use remain separate. Current v13 is unchanged.

## Closed placement collection and distinct final-root research — November 19, 2026

The November 18 public-context placement collection is closed incomplete after a native melee
refusal on Puffalo. Read its appended closeout in `docs/a19_public_placement_value_learning.md`.
Preserve all 2,554 independently verified physical labels, the failed uncached game, four complete
blocks, all inputs and six-role scanned/rejected/unused reservations. No fitter or model-selection
validation ran. Do not resume that registration, fit partial labels, extend its cutoffs or rewrite gates.

The separate inactive `a19-authoritative-root-melee-repair-v1` applies immutable geometry repair only
to the final real result of unchanged A19 search, before native target-memory reconciliation. Read
`docs/a19_authoritative_root_repair_research.md`. Preserve its fifteen completed diagnostic games,
one pre-opening observer failure, full-outcome/cold controls and original-reference sentinel. It
fixes one refused actual command without changing that winner; it does not qualify strength or cost.
The old all-policy/atomic candidates stay closed. The distinct fixed reused screen contains all
2,554 valid exposed inputs / 97 families, both arms and every loss: 5,108 main games. Retain its
source, confidence/coverage/original-outcome/quality/cold gates and November 19 02:00 UTC cutoff.
No retries, exclusions, extension or automatic promotion. Fresh broad strength, held confirmation
and overall-average +10% full-fight / weighted actual-decision CPU, including both-AI use, remain
required. Slower subgroups are descriptive. No serving import, default change or deployment follows.

That screen is now complete and **failed admission**: both arms have 1,121 wins / 36 draws /
1,397 losses, zero score changes, twelve changed traces in nine families and thirteen returned
root repairs with zero hypothetical edits. Read
`docs/evidence/a19_authoritative_root_repair_results_20261119.json`. All 5,108 games, original
native outcomes, runtime source/input/cache/winner bindings and twelve changed cold replays pass
independent verification. The empirical [0,0] paired interval is not proof of general equivalence.
Keep this fixed candidate inactive and closed without fresh/cost progression or subgroup rescue.

The separate four-game native-refusal integrity fixture proves no rejected-handler state/RNG/UUID
mutation in that one exposed case; it does not license other warnings or reopen partial-label fitting.
Preserve its full source versions, raw warnings and original uncached-outcome limitation in
`docs/evidence/a19_native_refusal_integrity_diagnosis_20261119.json`. The server's research runner
now retains rejected outcomes outside valid cache before aborting; its quality gate is unchanged.

The separate thirty-game read-only compound-choice audit also completed with exact observer/cold
controls. All fifteen malformed native incumbents already have an exact aligned attack in the
initial catalog; twelve reach full H64/R2 and tie the incumbent. Read
`docs/evidence/a19_root_compound_choice_audit_20261119.json`. This does not qualify a new
pre-scoring selector, broad missing-choice frequency, strength or CPU gain. Keep prior candidates closed.

## Frozen public-context placement learning — November 18, 2026

Read `docs/a19_public_placement_value_learning.md` before new placement learning or seed allocation.
The separate inactive study freezes 1,152 legally drafted families, 864 training / 288 validation,
four seat/future cases per family and eight fixed free proposals: 36,864 logical full-native labels.
Its exact source/input/fitter registration is in
`docs/evidence/a19_public_placement_value_registration_20261118.json`. All controls and losses stay;
neither its data nor internal validation qualify a new template, default or combat artifact.
Keep the current v13, locked weights, old failed studies and unopened teacher tests unchanged.
Both final eighty-epoch artifacts must be sealed before validation; the old-feature ablation is
descriptive and cannot replace a failed primary. Fresh strength/confirmation and overall-average
+10% full-fight / weighted actual-decision CPU, including both-AI activation, remain required.

Exclude **all six roles × 32,768 scanned preimages**, including rejected, unused and unselected
roots, for namespace `native-public-placement-value-data-20261118-v1`. Roles are `draft`, `setup-a`,
`setup-b`, `reverse-a`, `reverse-b`, `terrain`. Expand the fixture's little-endian SHA-256 recipe,
raw/permuted draft offsets zero through 31 and terrain `sim-<root>` search hash explicitly;
generic integer collection does not reconstruct this compact reservation. Exact raw arrays and
complete archives remain in the client's ignored capsule and both research hosts. No automatic
retry, cutoff extension, serving promotion or deployment is authorized by this registration.

## Explicit Sniper donor protection adoption — November 18, 2026

The user requested “lock it in and continue” after reviewing the confirmed Sniper guard. This
established profile v13, retained in current v14. Read `docs/sniper_donor_adoption.md`; preserve
checkpoint `a19-preserve-sniper-20261118`, its exact eligibility and unchanged evidence fixture.
Reject Sniper-reducing delivery plans before preview only in the qualified public complete-setup
population. Keep the exclusive draft allowance, legal visibility, standard own quantities, existing
geometry and A19 combat. Retain already funded v12 plans through restart and preserve Premium undo.
New default comparisons use the current default; frozen studies keep their original controls. The
+8.10-point held-out gain is conditional, not an unconditional ranked or human win rate. No model
retraining or deployment is implied. Further broadening requires separate qualification.

## Explicit revealed-ranged delivery adoption — November 18, 2026 UTC

The user explicitly requested “adopt the ones that gave gains please” after reviewing the failed
combined arm and uncertain positive component estimates. Adopt the separate draft and setup policies
in authoritative default A19-backed v0.8/Premium, profile v12, with `revealed-ranged-exclusive-delivery-v1`:
a seat that consumed the delivery draft override keeps native setup; only other seats may use delivery
setup. This new dispatch must never stack the failed combination. Read
`docs/revealed_ranged_delivery_adoption.md`. Preserve the original +7.407407 pp draft-only,
+9.259259 pp setup-only and −1.851852 pp combined results and all failed confidence gates. This is
explicit adoption under uncertainty, not fresh statistical qualification or an additive +16.67 pp gain.

Keep the independent draft budget atomic through accepted picks, hidden-pick collisions and restart,
including human acceptance of the default Premium suggestion. Setup previews use own fight-start
stats, public roster/terrain and fixed hypothetical target cells, preserve the live RNG/board, and
commit only fully funded plans. Retain Armor/Might/relevant Empower and the shooter's Sniper floor.
Private setup, partial automatic spending, explicit policy overrides and native v0.9 remain isolated.
The old research checkpoints/seed exclusions stay immutable. Collection using the authoritative
server inherits this dispatcher; the existing meta oracle remains a separately labelled experiment,
not an exact replay of authoritative setup. This adoption established v12, now retained within v13; frozen v11 studies
keep their recorded comparators. The global wire version and accepted A19 combat weights stay unchanged.

## Caster-screen and draft-commitment research — November 18, 2026

Read `docs/a19_caster_screen_counterfactual_research.md` before changing screen waits merely
because the ranged-output feature omits offensive spellbooks. The one retained exposed v13
Hyena wait wins; among six bounded native move alternatives, three lose and one draws. All 14
full games, original controls, target-memory semantics, source/RNG/prefix checks and repeated
changed outcomes passed independent verification. This is a counterexample to the inference
that a feature omission proves a bad wait, not a new strength or timing policy. No default changed.

The distinct inactive `map-visible-contextual-override-v1` defers only the extra contextual
allowance while the native public map is absent, retaining V3 and delivery. Read
`docs/map_visible_contextual_draft_timing_research.md`. Preserve all 36 five-point exact draft
controls and the fixed 108-family / 648-logical-game reused admission against both current v13
and contextual-disabled matched draft. Do not infer hidden maps, spend a budget twice, reuse old
confirmation channels, rewrite failed contextual gates or promote a reused score. Fresh independent
strength and overall-average +10% complete draft/fight CPU and weighted CPU per actual decision
remain required. The fixed admission cutoff is November 18 21:00 UTC with no automatic extension.
The completed admission failed: −5.56 points versus current, simultaneous 95% interval −10.65 to
−1.39; +2.78 versus the disabled head remains uncertain. All 648 outcomes, native quality/source/
funding/cold controls and both family bootstraps passed independent audit. Keep this fixed candidate
closed without fresh/cost progression, slice rescue or retuning; no default changed.

## Native placement coverage and free-template diagnosis — November 18, 2026

Read `docs/a19_native_placement_coverage_research.md` before broadening the learned placement
domain. The complete current-v13 observation used 452 physical games on 108 exposed families;
all 432 main native/observed outcomes match the original controls. At the final funded placement
call, 136/144 seven-point seats have valid model inputs and geometry; five-/six-point doctrines
remain outside the trained domain. No seat has a quantity mismatch there. Fight-start amounts
cannot establish an earlier model rejection. Preserve the initial wrong-field audit, intermediate
funding verifier correction and every raw call. These are source-verified reachable branches,
not instrumented neural-call counts, strength, cost or live-frequency estimates.

The separate `docs/a19_barrel_formation_opportunity_research.md` records 72 full counterfactual
games / 3,914 actual decisions on three exposed barrel-map families, both seats. All 18 native,
observed and cloned-placement controls match. Among 42 fixed free-template alternatives, five
improve, seven worsen and 30 retain the terminal score; all twelve changes replay exactly. Three
cases have a winning alternative, but no general selector or new weights are qualified. Preserve
all losses, the six-case selection, original cutoffs and unchanged paid levels. Do not activate
or qualify a blanket template from these outcomes or rescue an earlier closed study.

Detached JSON sorts body keys, while the existing `layout.propose` private seed uses native body
property order. Reconstruct with `buildPlacementInput` before regenerating archived proposals;
semantic object equality alone is insufficient. The corrected replay matches all 528 proposals
across 66 frames; retain its first failed attempt. Future public-terrain/active-synergy learning
needs a distinct complete plan, independent family splits, fresh full-policy strength/confirmation
and overall-average +10% full-fight / weighted actual-decision CPU gates. Neither diagnosis changes v13.

## Original Sniper donor qualification — November 18, 2026

The following records the study's completion before explicit adoption; see `docs/sniper_donor_adoption.md`
for current dispatch. Preserve the original unpromoted fixture and consumed confirmation bank.

Read `docs/a19_delivery_donor_research.md` and preserve its compact evidence fixture. The separate
terrain-after-delivery repair failed reused admission (16 points, current 16, free 17) and stays
inactive. The distinct guard skips funded delivery plans that reduce native Sniper before preview,
with original geometry and A19 combat. Its 28-case/14-exposed-family diagnosis scored 19.5 versus 16,
four improved outcomes and none worse; all native/cold/source/RNG controls pass. This is not fresh
strength or paid superiority: the free-only arm also scored 19.5. No serving default changed.

Fresh seal `ae9cb960941fd66c60ec66c2675549eb52e153e504ecb16b31de394ac27cef9d` completed 108 development
and 108 held-out families, both seats and all three live maps/budgets. Preserve checkpoint
`a19-preserve-sniper-20261118` and `docs/evidence/a19_sniper_donor_preservation_results_20261118.json`.
Development gained +9.49 score points (95% +4.40 to +14.58); independent held-out confirmation gained
+8.10 (+1.62 to +14.81). The 72-case serial AB/BA cost check used 6.91% less complete CPU and 4.88%
less weighted CPU per decision. All registered gates and independent source/input/winner/bootstrap/
cold controls passed. This is confirmed research, not serving activation or production latency.

Qualification is limited to the original public complete-Setup population, actual unused delivery
budget, native fully funded Sniper>=2 and Placement=Movement=0, with the declared roster eligibility.
Every paid plan cuts Sniper there, so the guard equals existing free-forward; no paid superiority is
established. Preserve current behavior outside this population. Retain this unchanged checkpoint as
a comparator for future setup research; do not tune on its consumed confirmation bank, silently
broaden dispatch or alter combat models. The subsequent explicit activation is limited to that scope.
The user's +10% compute limit
is on the overall average; slower subgroups are descriptive, not separate qualification gates.

See the document's exact typed seed recipes: exclude all 4 roles × 20,480 V2 preimages and all
20,480 failed-V1 preimages, including rejected/unused roots and specified derived channels. Generic
integer collection does not expand these compact namespace recipes. Actual arrays and scans remain
in the client's ignored `game/core/tmp/barrel-sniper-donor-fresh-20261118` capsule, with a verified
source/raw backup on Puffalo. Raw CPU metadata is whole-process scoped; only serial-worker
counterbalanced runs attribute per-case cost. This work does not advance the closed incomplete
root-scoped forecast, failed terrain repair or held-out teacher data, or alter their gates/cutoffs.

## Closed joint delivery utility screen — November 18, 2026

Read `docs/a19_joint_delivery_utility_research.md` and preserve
`docs/evidence/a19_joint_delivery_utility_results_20261118.json`. The single fixed
`a19-joint-contact-shooting-utility-v1` adds XP-weighted actual own attack and native range falloff
to the saved melee-contact proxy. All 648 logical rows / 666 physical games on 108 **reused** families
completed. It gained +9.49 points against current v12 but **zero against the qualified Sniper guard**
(adjusted 95% −2.78 to +3.24), three recovered outcomes and three given back. Only eight families
changed against that comparator. The incremental gate failed; no fresh bank, cost qualification,
confirmation, default change or deployment followed. Do not rescue the current-only gain, fewer
regressions, or a favorable subgroup, tune this closed recipe or weaken its gates.

Every original 432 current/guard complete outcome, 648 semantic input/cache/report records, 1,387
sealed source hashes and all cold/persistent/cached controls passed. The complete existing development
bank and all its old typed channels remain reserved by the unchanged Sniper evidence; no new seed
allocation was made. Preserve the independently confirmed Sniper guard as the stronger established
reference. A distinct continuation must value the real tradeoffs and pass both current and matched
free/qualified-guard comparisons with fresh independent evaluation and overall-average CPU limits.

## Counterfactual delivery research — November 18, 2026

Read `docs/a19_counterfactual_delivery_research.md` and preserve its engineering fixture. No new
strength gain or serving activation is established; the confirmed Sniper guard remains the stronger
research reference. The cheap private-policy pilot stopped on illegal proposals after 13 real games.
The distinct 48-game H8 pilot preserved every real guard outcome but failed its turn-count gate by
omitting automatic skips. Keep both originals closed, including failed diagnostics and +70.50%
forced-probe CPU; none qualifies strength or representative cost.

The corrected `a19-counterfactual-dominance-v1` uses the unchanged failed joint proxy only to propose
one paid plan, then requires strict native-leaf superiority over the actual guard in all three fixed
unknown-budget scenarios. Use legally public enemy artifacts; never private doctrine, augments,
deployment, future randomness or the all-AI visibility bypass. Count automatic completed turns and
stop at a whole native event boundary. Keep private work outside the actual decision denominator,
charge all CPU and retain recorded guard abstentions for known private proposal refusals.

Fresh seal `5c280d79aa39fe35d9349a5db9e9003cc547acffcc3ef03188d6629b987da683` reserves 1,080
development and 1,080 conditional confirmation families, both seats/three arms. Both adjusted
strength comparisons, independent source/input/outcome checks, cold controls and both-seat serial
overall-average +10% cost gates must pass before confirmation. Development subsequently closed
incomplete at 5,213/6,480 games on a refused native melee proposal. Do not resume it, exclude that
case or open confirmation. Preserve the complete source/raw archive and the separately registered
9800X3D cost replication; its result cannot rescue failed strength. Never change the 21:00 UTC
November 18 cutoff. Preserve the supplemental
binding of 178 unchanged native project files against the ancestor archive captured before fresh
development preflights finished; the original seal is untouched. Reserve all four roles × 32,768
namespace preimages, raw/permuted draft offsets and six private roots per terrain, plus timing-bank
private roots. Keep every historical failed gate and earlier held-out exclusion intact.
The complete independent 432-game 9800X3D cost replication passed all overall gates: +7.119941%
complete fight CPU and +6.170494% weighted CPU per actual decision versus both-seat guard; both
were lower than current v12. Preserve `docs/evidence/a19_counterfactual_delivery_closeout_20261118.json`.
The incomplete strength gate still fails, confirmation remains closed and no serving activation follows.

The distinct inactive `coherent_melee_approach_research.ts` addresses the native final-policy bug
that leaves an old move before a rewritten melee approach. Read `docs/coherent_melee_approach_research.md`.
Its 648-game admission reuses 108 exposed families and compares against both current v12 and the
unchanged confirmed Sniper guard. Native legality, original controls, source/cold parity and both
fixed score gates remain required; functional repairs or hypothetical invocation counts do not
qualify a strength gain. Preserve explicit movement hazards, full body geometry and unchanged-array
identity. The serving default and accepted models remain unchanged; no fresh confirmation opens
without a distinct prospective registration and overall-average +10% full-cost qualification.
The completed admission recovered one guard outcome and lost none (+0.462963 pp, adjusted 95%
interval 0 to +1.851852), but changed only three families. Its fixed coverage/confidence gates failed;
keep the helper inactive and do not progress this closed candidate to a fresh bank or retune it.

## Closed revealed-ranged delivery screen — November 17, 2026

Read `docs/revealed_ranged_delivery_research.md` before revisiting early public shooter/caster reveals,
Chaos Movement, flying picks or paid rush setup. This distinct current-v11 screen used 27 fresh
opportunity families / 270 paired logical battles. Combined draft/setup scored −1.851852 pp versus
native (adjusted 95% −16.666667 to +12.962963); draft alone +7.407407 and setup alone +9.259259 both
have intervals crossing zero. Adding setup after the new draft lost ten seats and recovered five.
Only one incremental paid-Placement seat differed from its matched free control. No candidate passed,
no confirmation opened, and no default changed. Preserve both evidence fixtures and all failed arms.
Exclude namespace `revealed-ranged-delivery-20261117-fresh-v1`, counters 1..20,480, including every
scanned preimage plus offsets 0..31 raw and permuted. The prototype uses real fight-start own stats,
native paid splits and public neutral terrain; never regress to placement-time steps or concealed
enemy positions. Ranked Setup already exposes the whole roster; early doctrine/collision reveals
matter during drafting. Positive component estimates are exploratory, not approved promotions.

## Explicit public-terrain placement adoption — November 17, 2026

The user requested “plesae add it to the default strategy for sure” after reviewing the terrain
screen. This adopts the exact `public-terrain-formation-reflection-v1` candidate as profile v11
and supersedes that candidate's historical non-activation instructions below. Read
`docs/terrain_placement_adoption.md`. Keep the original +7.638889-point result, 95% interval
0 to +16.666667, failed lower-bound gate and unopened confirmation unchanged. The serving helper
is `src/ai/placement/terrain_reflection.ts`; use only own units and public neutral terrain, after
all normal formation layers and before own artifact barrels. Preserve ranked/Premium routing,
undo and simulation parity. Normal/Lava/Water and other AI versions retain their behavior.
The wire default remains v0.8 with locked v0.9 V3/contextual draft and A19 combat. Future research
uses this adopted v11 comparator; do not silently modify a frozen in-flight baseline.

## Explicit Nightmare wall and movement adoption — November 17, 2026

After reviewing the completed movement study, the user explicitly requested “that is strong... we
should save those into default strategy”. This activates the exact combined ground-wall and missing
movement candidate in the A19-backed v0.8 default, profile v10. It supersedes the historical
non-activation notes below for this candidate only. Read `docs/nightmare_wall_movement_adoption.md`.

The serving helper is `src/ai/nightmare_wall_movement.ts`, default switch
`SEARCH_A19_NIGHTMARE_WALL_MOVEMENT=1`, policy `nightmare-wall-movement-coverage-v1`. Preserve every
native shortlist entry and its order, then the extra legal ground wall, then at most one already
leaf-scored pure move if none survived. Full H64/R2, material arbitration and neural correction still
choose the action. Use only current public combat information. Do not activate the failed route
veto, invent an extra attack preference, change draft/setup/models, or switch the wire default to v0.9.
The a13 rollback clears the switch; explicit A19 research overrides may set it to 0.

This is explicit user adoption with remaining uncertainty, not a statistical qualification. Preserve
the original +0.520833-point estimate versus the previous default, simultaneous 95% interval
−1.157407 to +2.256944, negative five-point doctrine slice and failed gates. Keep both immutable
research helpers, the full evidence fixture and its excluded channels unchanged. Subsequent research
must use the adopted default as its comparator; already-running frozen studies retain their original
comparators and need separate confirmation against v10 before claiming a new default gain.

## Explicit A19 default adoption, November 14, 2026

The user subsequently requested “lock in wins into default v19 and continue diving deep”. There is no
v19 version; this means the existing A19-backed v0.8 default, retaining locked V3 draft and A19 combat.
This explicit adoption supersedes the historical non-activation instructions below for the full
063a888e contextual draft head and d786f4e9 ranged setup selector only. It does not change their failed
qualification, unopened confirmation banks, immutable sources or model metadata. Read
`docs/a19_default_adoption_20261114.md`. The new serving modules live in `src/ai/setup/a19_*` and remain
outside the browser entry point. Both draft overrides need independent, atomic persisted state. Private
setup never receives concealed opponent identities; unfunded Placement plans cannot be applied later.
New research must compare against this adopted policy on fresh channels and report its legality-aware
setup dispatch separately from the historical study. Native v0.9 combat remains unchanged research.

## User-selected v0.9 draft + A19 combat default

After reviewing the completed 7,056-game comparison (native v0.9 20.48% score, A19 79.52%), the user
selected the locked v0.9 draft together with A19 combat on 2026-11-05. Keep `DEFAULT_AI_VERSION` on
`v0.8`; authoritative default seats bind the locked V3 draft. The `v09-draft-a19-work` meta profile
measures this combination. `v09-native` remains explicit research with no A19 search. Preserve the
native combat artifact's anchor-only metadata and learned-model qualification gates. The older notes
below describe the earlier v0.9-seat-only draft activation and remain historical evidence.

Use `bun fmt --no-script <paths>` for targeted formatting and add `--check` for a read-only check.
Do not invoke Prettier separately. `--no-script` avoids running this package's whole-source `fmt`
script when you only intend to format your own files. Keep the required build and lint checks.

Set `HOC_TEST_WORKERS=2` when a shared workstation is busy. The test runner caps this override at the
available cores and the existing local/CI limits, and rejects invalid counts. It also applies to tests
started by the package build; the default remains up to 12 local workers and 2 CI workers.

## Focused verification before the final gate

Use focused tests while editing, then one full gate for the finalized source. The client root's
`bun run check` already runs this package's full suite; do not launch a duplicate common suite beside
it. Re-run a passed gate when source, dependencies or relevant configuration change, not just because
another message arrived. Retain isolated workers and the required lint/typecheck checks.

The ranged-corner placement regression now shares one four-arm, two-seat opening across placement,
opening legality and summary assertions. Its measured serial time fell from 14.3 to 5.5 seconds by
removing duplicated setup and reducing the placement smoke check from twenty rounds to one. Keep actual
search-activity assertions so a zero-action fixture cannot pass. Full combat rejection/fallback and
observer-parity tests remain separate; the deadline fixture also proves actual fallbacks occurred.

## User-locked shooter counter-play research

The user requested locking strategy gains on November 9, 2026 UTC. Preserve
`ranged-counter-promising-20261109` through `lockedRangedCounterCheckpoint()` in
`src/simulation/ranged_counter_checkpoint.ts`. The free-spread and middle-Placement/Sniper candidates have
positive point estimates in different populations; neither passed the original 54-board / 1,512-fight
qualification. This request preserves exact research references, not a new live activation.
Keep `ranged_counter_research.ts` and `measure_ranged_counter_research.ts` immutable at the hashes checked
by that loader, retain every losing arm and failed gate, and exclude all channels in
`docs/evidence/ranged_counter_20261109.json`. The old held-out bank was never opened and is retired after
an expanded seed audit found a reused combat channel. Do not reopen it or silently rewrite its registration.

New situational dispatch belongs in `ranged_counter_situational_research.ts` under its separate v2 ID.
Read `docs/ranged_counter_research.md`. Fully funded paid plans must improve against both current setup
and a matched free formation, on independent armies and a fresh confirmation, within the user's +10%
compute bound. Extra shots and favorable slices do not replace the registered score gates. Native v0.9
combat training and its locked comparators remain separate.

The separate v2 continuation is `ranged-counter-situational-20261109T054706Z`, registration
`121e70d7dc472ab906adf21934c2179e7c8ebaeb7191a213e4e7abd8075fdd07`, frozen policy source manifest
`0eb9800682b2846542fe977747368f4c50e562f248cff7a5eca49d7fb07b79a9` on committed base `11110405`.
It reserves 1,080 new development boards and 1,512 held-out boards with current/free/situational arms.
Exclude `docs/evidence/ranged_counter_situational_registration_20261109.json` in other campaigns too.
No replacement candidate after its confirmation opens and no automatic production promotion.
The original Python analyzer cannot reserialize tiny timing values with JavaScript's exact number notation.
Its source is preserved. The separate `analyze_raw.py` / `resume_verified.py` finalizer in that ignored run
directory verifies exact emitted row bytes and resumes the unchanged registered analysis after development;
read `finalizer-status.json` as well as the original controller status. No outcomes, policy or gates were edited.

That v2 continuation completed all 12,960 games: free +1.09954 pp and situational +0.81019 pp versus current,
both adjusted intervals crossing zero. No finalist qualified and confirmation stayed closed. Preserve
`docs/evidence/ranged_counter_situational_results_20261109.json`; do not promote the earlier small pilot
or an outcome-selected subgroup instead.

The subsequent learned setup checkpoint is `public-ranged-setup-effects-d786f4e9-20261109`, canonical model SHA
`d786f4e9d90c321172021b65a81cb5b04f715aba5c203d388580007f93930007`. Its 165-feature ridge heads use only
own/public roster data, own budget, map and public synergy variants. The 810/270-board internal split
selected a recipe; its gains are not independent confirmation. The fixed refit is evaluated separately as
`learned-ranged-setup-qual-20261109T163646Z` on the 9800X3D: 1,080 new qualification boards and 1,512
reserved fresh boards, each with current/free/situational/learned arms. Registration SHA is
`d52d1b0e153f9c0788a1afa18088a97d925385e5f9e7e899991cf1d31b741f72`. Read
`docs/learned_ranged_setup_research.md` and exclude its evidence ledger. Never refit or replace the
candidate after either bank opens, expose concealed enemy inputs, relabel it native v0.9 combat, or
activate it automatically. Preserve both failed earlier studies and every fixed control.

The learned setup qualification completed all 17,280 games. Its score was 49.560185% versus 47.013889%
for the study reference: +2.546296 pp, adjusted 95% +0.856481 to +4.270833. Its advantage over free
spacing was only +0.208333 pp with an interval crossing zero, and other registered gates failed.
Confirmation remained unopened. The user's subsequent “lock it in and continue” preserves the exact
checkpoint, completed evidence and positive baseline contrast; it does not rewrite the failed gates.
Read `docs/evidence/learned_ranged_setup_results_20261109.json`. The archive SHA is
`cf9d4e6c9c6d0ba22f8afe8f44032d99afc675b2957b0b924ecafd9dd87908cf`.
Keep its original nonfight setup distinct from the server's v0.8 conditional Sniper/t2a19 setup.
New map/synergy draft research must use the actual phase-projected map, public variants and distinct
faction thresholds, retain locked V3 as a comparator, and keep the old banks closed and excluded.
The continuation's design is in `docs/contextual_draft_research.md`: distinct map/synergy interactions,
all public variants from the first bundle, early map only for five-point doctrine, actual conditional
v0.8 setup, and paired outcome labels. Do not substitute the older nonfight setup or reopen an old bank.
The frozen run is `contextual-draft-20261110T034659Z`, registration
`b3c86d9ed2b14858828a31f30f664dd3b8d7b3be42ff1e567f63b94a0d0ffc29`, policy source `2ab2617e`.
Exclude `docs/evidence/contextual_draft_registration_20261110.json`, including **every scanned preimage's**
eight raw and eight `permuteRankedDraftSeed` channels. Generic recursive integer collection alone does not
expand that compact ledger. Training has 4,320 boards; qualification and confirmation reserve 1,728 each.
Preserve its full and separately fitted context-ablated heads and all controls. Before collection, an explicit
runtime amendment lowered eight actors to nice 19 / 400% CPU to share the host; the original seal remains.

This contextual draft run completed 17,280 training and 27,648 qualification games. Preserve
`docs/evidence/contextual_draft_results_20261110.json` and both models under
`src/simulation/checkpoints/contextual_draft_20261110`, loaded by `lockedContextualDraftResearchModels()`.
Full model `063a888e6e38fe4322e89385929ac8f21dcb7b7f0dd5db070cb46a44a95eeeba` gained +3.428819 pp
against the frozen baseline and +1.750579 pp against locked setup, both positive adjusted overall intervals.
Qualification still failed: ordinary-opponent noninferiority against locked setup reached -1.012731 pp,
below the registered -1 pp limit. Confirmation stayed closed. Never waive that gate or reuse its held-out bank.
The separate ablated model `be2bf950866cbb139e8f7cd284302f41f4a3fc61361743310e0729202443072a`
was nearly tied; no incremental strength from the explicit context feature block was established.
Keep all four helper hashes immutable; new candidates need new modules and channels. These results use
`2ab2617e`, not later balance changes. See `docs/ai_research_closeout_20261114.md` for actual completed work,
the Friday cutoff and the follow-on campaigns that were not launched during the pending inventory request.

## User-locked A19 full-policy research reference

The user accepted the **50.36%** result and requested a fixed checkpoint on November 8, 2026 UTC.
Keep `a19-full-policy-5036-20261108` immutable under
`src/simulation/v0_9/checkpoints/a19_full_policy_5036_20261108/`. Load its original coupled models with
`loadLockedA19FullPolicyPair()` from `src/simulation/v0_9/a19_full_policy_checkpoint.ts`; the same module
exports the exact original model/profile bytes and verifies their identities. Its pair manifest SHA is
`675b438406b6ee3aa313feb1e382843a0442bc9970bc28810abc19d30d26aa68`.
Future combat research should retain this accepted reference alongside stock A19, with source differences
recorded explicitly. Never overwrite its weights or modify an already registered campaign to substitute it.

The measured source is `77af0770`, both seats use locked V3 draft, and the complete 6,048-game score is
50.35549% with a whole-board 95% interval of 49.42130–51.27315%. User acceptance does not rewrite the
original failed positive-advantage/55% gates or supply production timing. This is a locked research baseline;
the global live AI/default profile is unchanged. Native v0.9 combat remains separate. The user's lock request
authorizes these versioned model bytes, numerical references and compact evidence fixtures. Exclude the
consumed channels in `docs/evidence/a19_full_policy_5036_20261108.json` from future confirmation.

## User-locked Satyr contact/support reference

Subsequent explicit routing request: the user asked to connect the saved Mage strategies and “same for
satyr and healer.” The new production `a19-unit-support-v1` modules implement that adoption under
uncertainty. See `docs/a19_unit_support_adoption.md`. This supersedes the older no-live-activation
decision below, while leaving every immutable research checkpoint, original failed gate and excluded
channel unchanged. The new Healer dispatch and combined Mage policy are not independently qualified.

The user locked `satyr-contact-support-20261108` on November 8 and moved research to Healer.
Keep `src/simulation/satyr_contact_policy.ts` immutable (SHA256
`39de95f41dee17dd5fc0621b70204bd332b321a6aba259780049d95a646b4345`).
`lockedSatyrContactCheckpoint()` validates the metadata; `docs/satyr_contact_research.md` documents it.
The fixed 72-board / 432-fight paired pilot gained +4.5139 points over stock A19, whole-board 95%
interval -2.0833 to +11.4583; the original progression gate failed. That original acceptance preserved the
research candidate, not a confirmed improvement or live activation. All arms shared the forward-summon
fix. The later explicit adoption above is separate. Exclude all 150 consumed setup/combat channels
in `docs/evidence/satyr_contact_20261108.json` from future independent studies. New Satyr candidates
must use a separate module/checkpoint and retain this comparator; never overwrite its policy or gates.

## Saved Wandering Mage research candidates

The user requested preservation of the promising Mage strategies after the November 8 campaign.
Use `createLockedWanderingMageResearchStrategy()` in `src/simulation/wandering_mage_checkpoint.ts`
for the fixed one-buff/backline/search8 and flank-preserving backline candidates. Their positive
point estimates did not clear the original gates; their immutable research wrappers remain separate from
the subsequent support adoption above. Preserve both IDs and helper hashes. Read `docs/wandering_mage_research.md`, retain
all four studies' losses, and exclude the reserved channels in `docs/evidence/wandering_mage_20261108.json`.
New rules or combinations need new IDs and independent evidence; never overwrite these checkpoints.

## Native v0.9 combat research reference

Native combat now has an independently confirmed **unpromoted research model**, separate from the
accepted A19 neural pair and the inert embedded native artifact. Model SHA
`4e1d8992717784995447f28ccdf577692e8fb670f6915add313ff11425f77ce3` scored **25.6366% against stock
A19**, versus 18.9319% for native anchor, on 1,512 fresh boards / 12,096 matched battles. The native gain
is +6.7047 points (prospective whole-board 95% interval +5.6713 to +7.7546). All 132,275 native decisions
had zero A19 search calls and zero model errors. This improves native v0.9; it does not beat A19 or pass
the 52% target. Production timing and promotion remain unqualified; do not change the live default or
rewrite the embedded native artifact's anchor-only metadata.

Preserve the read-only node reference `native-v09-2564-20261108-4e1d89927177` and its paired evidence.
See `docs/v0_9_native_combat_rdna_research.md` for source, registrations, exact artifact/archive hashes,
numerical checks, failed pilot and complete fresh results. Preserve this first reference as a fixed comparator.
The separately registered scale campaign uses
`v09-native-scale-acquisition-20261108T170905Z` on the 9800X3D/RDNA node. Its initial scale fitter stopped
before SGD on a KFD host-memory mapping error. The separate
`v09-native-scale-recovery-20261108T180216Z` learner used exact-readback 128-row uploads and unchanged
recipes. It completed one candidate before an AMD GPU virtual-memory fault/reset; preserve the original
four-recipe campaign as failed/incomplete. No manual driver reset was performed. The completed candidate
`4749da06ec07` completed the separately fixed CPU-only study
`v09-native-single-evaluation-20261108T182917Z`. On its 1,512 new matched board families / 12,096 battles,
it scored **25.8598% against stock A19**, versus **24.6610%** for `4e1d89927177` on the same bank:
**+1.1987 points**, whole-board 95% interval **+0.1819 to +2.2321**. Independent reconstruction confirmed
the positive interval. Both models use 20,592 multiply-accumulates per candidate; observed mean decision
time increased 0.13%, and total native decision time increased 0.91%. Production timing remains unqualified.

Keep this first-bank scale reference immutable in `src/simulation/v0_9/checkpoints/native_scale_20261108/`.
`loadNativeV09ScaleResearchModel()` from `native_scale_checkpoint.ts` restores the exact original artifact
and leaves activation separate. Model SHA is
`4749da06ec07bfd08db7ec6c2bbe03ba6dc4e73847e67585804dbccc253e7bb9`; checkpoint manifest SHA is
`40b243333e4d6963650bf87877afd8ba8ec151cb89af2cbf2c46f6f5783b50b0`.
The user's commit request authorizes these versioned model bytes, numerical references and compact
evidence fixtures. Merge `docs/evidence/v0_9_native_scale_20261108.json` with previous seed ledgers.
The model remains unpromoted, its native-seat search calls remain zero, and the 52% target remains unmet.

Further native candidates must beat both fixed references, with stock A19 still the target opponent.
The fixed CPU-only committee study `v09-native-fusion-study-20261108T220850Z` completed all 18,144
fresh battles without a confirmed gain: committee 25.9590%, prior reference 26.5625%, scale reference
25.8681%; both committee paired intervals cross zero. Its registration SHA is
`6d508b22963f75937304cda352a8fa400406b84b0a8cf86635bbfccf25d3b1f5`.
The scale model's earlier +1.1987-point gain did not replicate on this independent bank. The secondary
two-bank pooled gain is +0.2521 points (95% -0.4630 to +0.9590), so retain both models rather than claiming
the scale model is conclusively stronger. Preserve the original first-bank checkpoint manifest and gates.
The failed committee is not promoted; its read-only evidence archive SHA is
`c66fede0801306a0b5bf661f96a9bae18409b6803b9688c46727271a8f49b452`.

The separate continuation is `v09-native-full-cpu-20261109T021936Z`, registration SHA
`5a71e35f3f556391a3813944523b48883319ed6fd2c74ab23de5fa52daae2d3b`.
It fits four fixed float/QAT recipes on all 113,986 training / 37,464 validation decisions, using CPU only
after numerical/gradient transport tests. The frozen engine remains `8a8d731b`; exact native execution
optimization `65820f41` is recorded separately and does not change decisions. All recipes must finish;
whole-development selection requires positive mean gain against both native references, followed by one
new 1,512-family / 18,144-battle fresh comparison. No replacement after fresh opens and no automatic
promotion. Do not reopen the failed AMD GPU fitter or reset a shared device to run this CPU campaign.
See the research document for exact identities and transport checks.
Do not treat validation teacher agreement as a win rate.
This CPU continuation has since completed all four fits and development comparisons with status
`complete_without_finalist`; no fresh comparison opened and no native model was promoted. Preserve
the failed continuation and the two existing native references. The learned shooter setup research above
does not alter this native-combat result.
Exclude all prior and reserved banks, including their derived setup/combat channels;
never select a replacement model after opening its fresh bank.

## Locked v0.9 draft default

The user explicitly activated the improved model as the default draft for v0.9 seats. The immutable
`doctrine-draft-v3-20261104` checkpoint, weights, seed registration, evaluation evidence and decision
regressions live in `src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/`. Use
`lockedDoctrineDraftModel()` from `src/simulation/v0_9/doctrine_draft_checkpoint.ts` to load it.
Use `createLockedDoctrineDraftResearchChoices()` from that module to reproduce its draft behavior;
create one instance per draft seat/game and retain it through collision retries.
Its initial development gain was 2.28 match-score percentage points over the original policy
(95% interval +1.20 to +3.38). Fresh, prospectively registered overall confirmation passed at
**+3.34 points (+2.20 to +4.49)**, with positive intervals for both five- and six-point doctrines.
The separate `overall_confirmation_20261105.json` fixture preserves that result, independent
verification and all 1,080 paired board scores; `lockedDoctrineDraftOverallConfirmation()` validates
and loads it. Keep V3 as a required comparison for further draft iterations; create a new checkpoint
rather than overwriting or refitting it. The V4 continuation failed to improve over V3 and is not promoted.

The server's `getRankedAiProfile("v0.9")` binds `selectV09DoctrineDraftChoice()` from
`src/ai/setup/doctrine_draft_policy.ts` to the fixed `ranked-unit-strength-a19-side-v4-w16-r4` candidate policy.
Its native v0.9 profile was separately qualified on 1,512 fresh boards / 18,144 battles: **+1.76
match-score points (+0.91 to +2.62)** overall, +2.78 for five points and +2.50 for six points;
seven-point decisions reproduce the original policy. The secondary information ablation measured
**+0.347 points (+0.025 to +0.694)** pooled. Individual doctrine information intervals cross zero.
`native_qualification_20261105.json` preserves both comparisons and every paired board delta;
`lockedDoctrineDraftNativeQualification()` validates it. The registered runner is
`src/simulation/v0_9/doctrine_draft_native.ts`; its source commit and seed banks are recorded in
`docs/evidence/v0_9_native_draft_registration_20261105.json`. Exclude these banks from future work too.

The server persists each seat's consumed override atomically with an accepted bundle, creature pick,
or collision reveal. Reuse that persisted state after retries/restarts. Refresh the pick between
sequential bundle decisions so the next seat can use the first bundle only through its legal projection.
Keep the 5/6/7 budget and visibility rules. This activation does not change `DEFAULT_AI_VERSION` or
the native combat artifact. The original model's `productionPromotion: false` is historical fit
metadata and must not be rewritten to express the separate runtime activation.

The draft default is not a newly qualified combat model. Its original additional
early-information gain was +0.42 points (0.00 to +0.84), so the original scouting-specific gate failed
and its confirmation bank stays closed. Preserve that distinction in reports. The user's request
explicitly authorizes these small versioned checkpoint fixtures; ordinary run output remains ignored.
See `docs/v0_9_doctrine_training.md` for the protocol, results and continuation requirements.
The separate prospective overall-strength confirmation is registered in
`docs/evidence/v0_9_locked_draft_overall_confirmation_20261105.json`. It compares the fixed V3
checkpoint with the original policy on V4's fresh development bank; it does not reopen or alter
the old failed scouting-specific experiment. The fresh overall result does not establish an incremental
scouting benefit on A19. Preserve both historical conclusions alongside the separate native qualification.
V4's complete seed registration is saved in `docs/evidence/v0_9_doctrine_draft_v4_registration_20261105.json`;
exclude every bank, including its unopened confirmation bank, from future campaigns.
The earlier target was ranked A19 (`a19-neural-r2-placement-v2`). The new native qualification uses
`artifact-fit-v6:v07-nonfight-4eda84635fe7`, native v0.9 combat without search, and live sequential
bundle commitments. Another profile still needs its own evaluation. New candidates must improve
over this locked default on fresh boards; never overwrite its weights or change failed studies retroactively.

## Parallel agents / mainline workflow

Multiple agents run on this repo **at the same time**. Rules:

- **Always work on `main` (the shared working tree). Do NOT create git worktrees or branches.**
- **Never use `git stash`** (push/pop/apply) — it sweeps a peer's in-flight edits into your stash and
  restores a tree that never existed. To inspect pre-change behavior, read the committed version with
  `git show HEAD:<file>` instead of touching the working tree.
- **Never revert or discard files you didn't author** — no `git checkout -- <file>`, `git restore`,
  `git reset --hard`, or overwriting a peer's edits to "clean up" the tree.
- **Do NOT run `bun run build:proto`.** It is broken on Node 24 (`protoc-gen-js` plugin fails) **and** does
  `rm -rf src/generated` _before_ regenerating — so it deletes every generated file, then fails, leaving the
  tree empty and destroying peers' uncommitted generated edits. The generated protobuf is **hand-maintained**:
  edit `src/generated/protobuf/v1/*` (`types.ts` / `types.d.ts` / `types_pb.js` + `creature_gen.ts`) by hand
  when adding a creature/enum. If generated files ever go missing, **hand-recreate** them — never `git checkout`
  to "restore" (that reverts peers' uncommitted work).
- Each agent **owns and is responsible for driving/fixing its own changes** — the build may briefly be red or
  the working tree may churn because another agent is mid-edit; that agent will fix it.
- Stage and commit **only your own files** (`git add <paths>`, never `git add -A`); re-`git fetch` right before
  pushing. Expect your commit to land alongside others'. Verify with `bun test` (transpiles independently of a
  peer's in-progress tsc errors) rather than blocking on a shared `tsc`.

## Sync with the remote before pushing, opening a PR, or deploying

Before you push, before you open **or update** a PR, and before **any** deploy, bring the branch you are
standing on up to date with its remote:

```bash
git fetch <remote>                       # check `git remote -v`; normally origin
git -c rebase.autoStash=false pull --rebase -X ours <remote> <branch> # the branch you are ON, not always main
```

Peers push continuously, so "it was current when I started" is never true by the time you finish.

**Remote changes take precedence in conflicting hunks.** During a rebase, `ours` is the upstream-based
history and `theirs` is the local commit being replayed, so use `--rebase -X ours`. For an ordinary merge
of the remote branch, the corresponding option is `-X theirs`. Preserve nonconflicting local work; never
replace whole files with `git checkout --ours/--theirs`, or use the whole-tree `-s ours` strategy. Resolve
any remaining conflicts per hunk with the remote intent taking precedence, then verify both the remote
change and unrelated local changes survived. Never stash a peer's edits to make the pull succeed.

**Deployment must enforce freshness across common, client, and server.** Sync before validation and
building. Record the branches and commits being built; fetch those same remote branches again immediately
before each upload. If a checkout, upstream, or remote commit changed, stop and rebuild from newly synced
checkouts. Never rebase after a build and upload the older output. Deploy only clean, published commits
through the guarded client/server deploy commands; manual rsync must not bypass them.

**This package is consumed by pinned commit.** After pushing here, the client's submodule pointer and the
server's `package.json` + `bun.lock` pins must be advanced to match, or those repos keep building against
the old engine while their code expects the new one. Re-check all three pins after every rebase or merge,
including the actual common checkout: the client's `ignore = all` submodule setting hides pin drift from
normal `git status`. Commit the server manifest and regenerated lockfile together, reinstall its dependency,
then rerun the affected checks before deploying.

## Empower spending research (2026-11-14)

The default A19 setup's missing Empower allocation is being evaluated separately from report coverage.
Read `docs/empower_setup_research.md` and reserve every eight-channel raw/permuted expansion in
`docs/evidence/empower_setup_registration_20261114.json`, including its retired first registration.
The current study is `empower-funding-20261114T231900Z-v2`, registration
`c8a266a496d392ad7d9ead559df6a4ba3a4d61eb3dbc058c96a4f51ad077902b`. Its training source and node
exports are sealed; the 432-board training bank, 864-board qualification bank and 864-board confirmation
bank are distinct. Development results do not authorize claiming an independent strength improvement.
Keep the registered funding, source, whole-board score gates and confirmation boundary intact.
The default has not been changed by this study. If the live draft/setup is changed concurrently,
verify the measured comparator and combination before claiming that this candidate improves it.

This study completed qualification and failed: −0.260417 pp, whole-board 95% −0.795718 to +0.274884 pp,
864 boards / 3,802 executed fights. Confirmation stayed closed. Preserve the exact fit via
`lockedEmpowerSetupResearchModel()` and every result in `docs/evidence/empower_setup_results_20261114.json`.
Do not activate it, reopen confirmation, or claim that adding Empower has established a strength gain.

The distinct continuation `empower-protected-axis-20261114T212900Z`, registration
`209d7c172fbb8cde1256cc5550d25327087060700b21865640040ed3144dd7c7`, tests only Empower 1 funded
from spare Might/Sniper, then Armor, while retaining the preferred physical axis. Its training reuses
the earlier development boards with exact-control provenance; its 864 qualification and 864 confirmation
boards are new. Exclude `docs/evidence/empower_protected_axis_registration_20261114.json` as well.
It retains the same progression gates and does not activate the failed earlier model.

The protected-axis continuation also failed qualification: +0.188079 pp, whole-board 95%
−0.347222 to +0.737847 pp, 864 boards / 3,902 executed fights, 210 activated boards. Its independent
verifier passed, but the gain and interval gates did not. Preserve the exact fit and
`docs/evidence/empower_protected_axis_results_20261114.json`; confirmation remains unopened and
reserved. Neither Empower fit is a production default. A favorable budget slice does not rescue
this result, and changing the selector requires a separate registered experiment and fresh banks.

The user's continuation starts `empower-public-context-20261115T013200Z`, registration
`896fdd2c2ee97e1a9b5bd5192aee5991c56866ddc0932679fdd09ec1f48bcb17`: 2,160 explicit development boards
(old training and both opened qualification banks), then 1,728 new boards per independent stage.
Reserve `docs/evidence/empower_context_registration_20261115.json`. Preserve its sealed inference,
reconstruction and actor hashes. Complete public placement context and full paid budgets are required;
private setup and partial spending retain the incumbent. This remains research only. The research
document records the model-selection gates and checks needed for any concurrent default change.

This public-context continuation closed without a finalist: all 44 recipes missed its +0.5 pp
development threshold (best +0.219907 pp). Both fresh banks remain unopened and reserved. Preserve
`docs/evidence/empower_context_results_20261115.json`; do not activate a failed recipe or describe its
cross-validation scores as fresh qualification. Further Empower work must use a separate hypothesis
and measure against the newly adopted A19 policy.

The separate allocation continuation is `empower-allocation-adopted-20261115T021200Z`, registration
`72d5d0a369f569dac42cbbc0f2d783422086d5cd4b60564cadd2dcf1bdd6ff20`. Reserve its evidence ledger too.
It measures six fully funded Empower plans against the adopted A19 setup using the authoritative
server's native formation, support splits, spell charges and public setup projection. Its candidate
is research only; do not import it into a default before independent qualification, confirmation
and serving compatibility verification. Both earlier one-point study banks remain closed.

The adopted-policy allocation continuation also closed without a finalist. All 18,144 development
comparisons (10,252 distinct fights) were independently verified; the best of 24 settings gained only
+0.077160 pp. No model was refitted or activated. Preserve
`docs/evidence/empower_allocation_results_20261115.json`; both fresh banks remain unopened and reserved.
The explicitly parameterized compatibility helper is inert. Do not treat it as an adopted checkpoint.

The separate shared-cost continuation is `empower-shared-cost-20261115T033000Z`, registration
`3a33e2af1c3460a1f004026ef58930e739ff51397abbfb8c74b3a3eb1c958580`. Its 500-feature shared effect
model prices actual marginal augment powers with public context; it is not a serving default. Reserve
`docs/evidence/empower_cost_registration_20261115.json` and retain the earlier closed experiments.
Independent qualification, confirmation and serving-source compatibility are still required.

The shared-cost continuation completed all 48 settings with no development finalist (best +0.192901 pp,
threshold +0.5 pp). Preserve `docs/evidence/empower_cost_results_20261115.json`. No model was refitted,
no default changed, and both fresh banks remain unopened. Do not activate its best failed setting.

The direct policy-tree continuation `empower-policy-tree-20261115T044000Z`, registration
`91d8571dcc9eeef69f1ff607318e729979543aa75e2c417fd140e9fab8f9dc46`, also closed without a finalist.
All 18 settings reused the 648 adopted-policy development boards explicitly; the best was +0.192901 pp,
below +0.5 pp. Independent Python verified all 90 fold models and paired scores. No model was refitted,
no fresh seeds or games were allocated, and no serving default changed. Preserve
`docs/empower_policy_tree_research.md` and its registration/result fixtures. Its inference helper is inert.

The joint continuation `magic-empower-joint-20261115T044500Z` also failed development. All 72 already-opened
seven-point Dragon families were rebuilt on the latest engine with actual public ranked Setup. Across
576 comparisons / 556 distinct fights, spare-physical-point Empower plus immutable precision lost
4.513889 pp versus current and 6.25 pp versus precision alone. Read `docs/magic_empower_joint_research.md`.
No fresh banks or channels were allocated and no model was activated. Preserve the factorial evidence
and original failed gates; neither the seven-point hypothesis nor the favorable Lava slice is a qualification.

For the user's broader improvement request, read `docs/ai_coordination_priorities_20261115.md` before
duplicating the active artifact/final-pick planner. The separate stationary-melee metadata prototype closed
at its fixed functional coverage gate: two supported estimates versus five required across eighteen
executions, with exact control replays and zero changed trajectories. Its development bank never opened.
Preserve `docs/evidence/stationary_melee_value_20261115.json` and the inert helper; do not enable it, broaden
its eligibility or weaken that gate in place. Movement/retaliation coordination needs a distinct candidate.

The separate `melee-delivery-diversity-20261115-v2` experiment keeps the native melee cap, target allocation,
target leaders and per-slot damage/kill/stationary class, diversifying only equivalent extra approach cells.
Read `docs/melee_delivery_diversity_research.md`; the helper is offline only. Registration
`9e8f698bc871d12fefc27984681051dd8ccd34abf526b42bba8df5cd5d6298ab` passed its 162-fight correctness
admission, then failed its complete 162-family / 1,296-fight development comparison: +0.077160 pp,
95% −0.462963 to +0.694444 pp, with a negative seven-point mean. Preserve
`docs/evidence/melee_delivery_diversity_20261115.json`. No fresh bank opened and no default changed.
Do not import it into serving code or rescue it using a favorable subgroup or relaxed gate.

Native research capsules must prove actual package identity. A shared `node_modules` symlink can make
server setup import another frozen common tree while combat imports the intended tree; a Bun runtime
alias plugin alone did not prevent this. Assert identical RNG functions and FightStateManager constructors,
resolve the server's common dependency to the capsule's own source, seed copied runtime identities, and
reconstruct each arm's opening independently. V2 also passes cold-process replay. Preserve the excluded
initial batch and correction; cached-opening A/A replay does not establish source or setup reproducibility.

The distinct `retaliation-handoff-20261115-v1` study admits a legal melee wait only when a nearby ready ally
could consume the defender's response, retaining that wait within the ordinary shortlist. Read
`docs/retaliation_handoff_research.md`; registration
`5ddde8da61d439d9e135c0393b2c7886da61210c8e2d7b61155b2d5869412ed6` fixes the coverage and development
gates before execution. The helper is offline only, the development families are explicitly reused,
and no fresh qualification bank or serving default is authorized by this smoke test.
The completed 162-family / 1,296-game trial failed its +0.5 pp gate: gain +0.231481 pp, whole-family 95%
−0.462963 to +0.925926 pp. All doctrine means were nonnegative, but that does not rescue the overall result.
Preserve `docs/evidence/retaliation_handoff_20261115.json`, its independent verification and the documented
native-filter audit correction. No fresh bank opened and no serving default changed. Further ideas need
a distinct hypothesis; do not weaken this gate or activate the failed candidate.

The distinct combat continuation is `chakram-screen-move-20261115`, registration
`94405e2c05ef9853535a4c5dc4e1e69eae3ffcac0478c803a78122209d37d1d8`. Read
`docs/chakram_screen_move_research.md`. It adds at most one geometrically safer pure move to an offline
catalog, preserving the normal moves, native guards and bounded A19 shortlist. The helper is not imported
by serving code. Its 108-case admission and 162-family development reuse already-opened channels;
neither is independent confirmation. Keep the failed static Chakram formation study closed. Do not
expand this admission bank, weaken its coverage/score gates, or activate it without separate evidence.

This continuation completed all 1,296 development games and failed: −0.154321 pp, whole-family 95%
−1.466049 to +1.157407 pp, with a negative six-point mean. Preserve
`docs/evidence/chakram_screen_move_20261115.json`, the order-only footprint audit correction and all 648
exact control replays. Observed enemy Chakram collateral fell 16.81%, but that is not a strength gain.
The candidate remains inactive; no fresh bank opened. Do not replace its gate with the collateral metric
or enable a favorable doctrine slice. Further combat ideas need distinct candidates and evidence.

The user's separate offensive Chaos Movement idea completed as `chaos-rush-20261115`: 108 explicitly
reused development families, 8,079 distinct battles, 39 raw draft/setup arms and 13 pre-outcome Chaos-only
compositions. Read `docs/chaos_rush_research.md`. No policy passed its fixed development gate. The strongest
observed recipe, Chaos-only Movement 2 / Placement 1 / Armor-first, gained +3.086420 pp versus current
(simultaneous 95% −2.875348 to +9.048188) and +1.851852 pp versus matched free (−3.122945 to +6.826649),
but its six-point mean was −2.777778 pp. Preserve the inactive `chaos_rush_research.ts` helper and isolation
test; no fresh qualification/confirmation ran and no default changed. Faster contact and shooter denial
are mechanism results, not strength qualification. Do not activate it, rescue it with five-/seven-point
slices, or tune this closed candidate on the same bank. Further work needs a distinct registered candidate.

The distinct continuation `offense-preserving-mobility-20261115` is registered at
`eca22a6fca45e15ff764fb58fc9ccdbb7bfe80b6d5d1fc2c477e6ddaa7ac8078`. Read
`docs/offense_preserving_mobility_research.md`, including its reproducible seed reservation before
allocating other banks. It keeps the adopted draft and every offensive augment, funding Movement only
from existing Armor against public physical-shooter rosters. Four fixed recipes cover active-Chaos and
ordinary dispatch. All 216 fresh development families completed: 1,684 distinct battles / 4,320 logical
rows, with no finalist. Broad Movement 1 lost 4.552469 pp (simultaneous 95% −8.581220 to −0.523719),
Movement 2 lost 1.697531 pp, and Chaos-only Movement 1/2 lost 1.466049/0.771605 pp. Earlier contact did
not establish a score gain. Independent input, score and interval reconstruction passed; no
qualification/confirmation was allocated and no default changed. Preserve the closed helper and full
doctrine gates. Do not activate the five-point Movement 2 slice or tune this candidate on its opened bank.

The distinct `guarded-intercept-free-20261115` continuation completed under registration
`356f98a9e4daae66d7144d7fc85fb12fbc267d4952ebac852dfe49bcbe23b98a`. Read
`docs/guarded_intercept_research.md` and its capsule handoff before duplicating it. It compares current,
one guarded late mobile draft override, selective free forward placement, and their fixed combination.
All native augment spending is preserved; public damage casters can trigger the rule. Its 216-family
bank completed 1,431 distinct battles. The combination lost 2.932099 pp versus current (simultaneous
95% -7.649357 to +1.785159) and failed its fixed gates; all three doctrine means were negative. Input,
score and bootstrap verification passed. No confirmation opened and no default changed. Preserve
the closed policy and do not rescue a diagnostic component or subgroup. The earlier paid
prototype closed unscored: placement-time steps omit fight-start upgrades and extra Placement can
change native splits. Preserve that finding rather than claiming a real reach improvement from its
proxy. Exclude every scanned seed preimage described in the research document. The separate peer
`ranked-geometry-confirm-20261115` study remains independent and must not be interrupted.

The distinct `backline-approach-move-20261115` combat continuation is registered at
`1b884ae79e13b177e63504ca59f1a9811126cb41ae812bfd1fc9ea9b663797d3`. Read
`docs/backline_approach_move_research.md` and exclude every scanned channel in its compact seed ledger.
The read-only audit found omitted approach moves, while its complete off/observer traces matched.
The candidate compares at most one legal pure move toward visible remaining shooter/damage-spell output,
retains all native role filters and reserves an ordinary A19 slot without forcing movement. It changes no
draft, upgrades, placement or default. All 216 fresh development families / 1,728 battles completed:
primary gain +0.154321 pp (whole-family 95% −1.388889 to +1.620370), with negative seven-point and
damage-caster means. The candidate failed its fixed gates and remains inactive. All inputs, scores,
source seals and seed channels were independently checked; no confirmation opened. Preserve the closed
helper and evidence. Do not rescue the five-point/Lava slices, replace score with approach distance, or
retune this candidate on its opened bank. The peer geometry confirmation remains separate and untouched.

The user explicitly requested a distinct loss-focused follow-up to the uncertain +0.154321 pp result.
Read `docs/backline_approach_preservation_research.md`. Registration
`4c4a4919cd0ee03df7b9eaaec3aa0cbdff64ea6e24d17995e9ca90b7567f1b3e` fixes two new inactive candidates:
retain every ordinary A19 alternative before appending the approach move, with a second arm also
requiring the existing 0.01 value margin. All 18 old regressions and 17 improvements were audited;
140 repaired admission fights and 12 cold replays passed. All 216 fresh families / 3,456 battles completed
and independently verified. Preserve gained +0.462963 pp versus current (adjusted 95% −0.925926 to
+1.929012), but tied original v1 and lost 1.388889 pp against casters. Margin gained +0.231481 pp versus
current, lost 0.231481 pp versus v1 and had negative seven-point/caster means. Neither candidate passed;
no confirmation opened and no default changed. Reserve all 219 scanned preimages in the documented
namespace, including rejected scans; the capsule also has `reserved-scanned-channels.json`. Do not
activate a favorable shooter slice, retune either policy on this opened bank, or reopen the failed v1
candidate. The peer geometry study is independent.

The subsequent lock-in review preserves the backliner-preservation helper, tests and complete result as
an inactive versioned research checkpoint. Its helper SHA is
`27bf8168f64bf268f22a5014af1ae784f23534ee116dd6c1bfedcf97e18dabf8`; the research document pins its tests too.
Keep those bytes and the failed gates intact. This preserves reusable work for other agents without
adopting a stronger default, strict-margin rule or favorable shooter-only exception. New variants need
separate identities and fresh evidence; physical shooters and damage casters remain distinct hypotheses.

The distinct `shooter-pin-delivery-20261116` prototype closed at functional admission. Read
`docs/shooter_pin_and_forecast_audit.md`. Registration
`9ba378bc695636ecb6c3392e791d4893e4715a5cf08b46f0eef37c6b1a50931d` preserves same-target melee delivery
while adding contact suppression of ready physical shooters. All 171 admission/cold executions reproduce
controls, but only three proposals occur, all blocked by Angel's protector-intent guard; zero full
shortlists or trajectories change. Nine independent guard replays confirm the reason. No fresh seed
or strength bank opened. Preserve the inactive helper and failed coverage gate; do not disable the
protector guard or broaden this closed candidate on the same cases.

The separate read-only `backline-forecast-audit-20261116` records all 35 old outcome-changing roots,
70 exact full replays plus six cold controls, with no extra rollouts. Of 711 existing full forecasts,
678 reach exact simulated terminals; both forecasts predict terminal wins in 10 of the 18 regression
cases and 11 of the 17 improvements. This is selected diagnostic data, not population calibration or
a new win-rate gain. Native future-turn modeling and actual searched continuation differ; the audit
does not isolate that difference from chance or later interventions. Do not rescue the closed searched-
reply candidate or tune from these selected roots. Future continuation work needs separate registration,
outcome-independent samples, legal public inputs, representative strength evidence and serving timing.

## Closed action-aligned geometry approximation

The original geometry planner's confirmed +2.083333-point checkpoint remains locked and unchanged.
The explicitly authorized `ranked-geometry-aligned-20261116` continuation completed all 1,824 missing
historical training battles and independently verified 15,552 exact current-spending labels. Read
`docs/ranked_geometry_aligned_research.md`. Three fixed fast recipes were fitted; ridge 100 won the
54-family development selection at +1.388889 points, then **lost 1.195988 points** on 324 fresh current-
source qualification families (95% −2.353395 to −0.115741), with negative means for all three doctrines.
It failed; the 648-family confirmation bank stayed closed. Do not adopt it, substitute ridge 10 after
qualification, rescue a favorable slice, or retune this closed candidate on the opened bank.

Registration is `89250a8a697feb0f117a90a4b535606fd418578b6204402bcb82fabb0ad00838`; selected model
SHA is `889f3d9a66cf00f058f99a63da25d06c5b770600d9e2d5f27cbdc5c93b52b2d9`. Preserve the corrected
dataset and all outcomes in the client capsule `game/core/tmp/ranked-geometry-aligned-20261116`.
Exclude `docs/evidence/ranked_geometry_aligned_20261116.json`, including all scanned raw/permuted
channels and unopened confirmation. Independent score/input/trace/health/model checks passed, but no
serving/default or Premium change was made. The original confirmed search policy is a different policy;
its win does not validate this failed approximation. Further work needs a new registration and fresh banks.

The separate `ranked-geometry-real-outcomes-20261116` continuation is registered, not a strength win.
Read `docs/ranked_geometry_real_outcomes_research.md`. It trains three frozen public-input geometry
models on 1,080 new actual-ranked-outcome families, then uses separate 216/648/648 development,
qualification and confirmation banks. Preserve registration
`60d306e95690ca89db6e57e799128afd9a8fcb61cc98af5592f056fde10426c8`, its pre-battle timing correction,
and all scanned reservations. The hard cutoff is 2026-11-16 17:34:15 UTC, four local CPU actors,
no GPU or automatic restart/extension. It is distinct from the closed failed aligned pilot and the
peer's aligned12h hypothetical-label campaign. No model is a default until all strength and serving
gates pass. Inspect the capsule's pipeline/terminal receipts before reporting status or starting work.

## Closed Peasant cheap-retaliation pilot

The user's Peasant armor-farming idea was evaluated as `bitter-experience-cheap-response-v1`.
Read `docs/peasant_bitter_experience_research.md` and its compact evidence. Bitter Experience grants
+1 base armor and +1 step per nonfatal hit with casualties; harmless or fatal hits give no bonus.
Ordinary melee replies use the defender's pre-primary-hit stack. Keep the canonical response gate.
The immediate value features omit armor/steps, but full engine search retains their effects.

The 26-family reused diagnostic pilot completed 330 verified executions under registration
`462f5291322fdd19ccd8a2e68edcabbf682808408dff2d2ff22f3e7dfb727d90`. All four nominated trades among
402 Peasant roots were already in native full search; no comparison, decision or trajectory changed.
Gain was 0.00 points and the fixed coverage/score gates failed. A further 16 verified forced-root
continuations also changed no result: the rejected 8-HP trade earned the bonus but still lost.
Preserve the inactive helper SHA `7bc1cb77450879e004fa13ca00bf7f3aa24ad0f475122e158c856e50fb939709`,
tests, failed gates, serialization correction and final-neural-selector audit correction. Do not call
this a strength win, broaden this closed candidate on its opened bank or bypass final serving guards.
No fresh channels/banks were allocated and no default changed. Further value or movement hypotheses
need separate identities and fresh evidence; actual committed turns are authoritative over a prototype
selector's intermediate choice. The separate actual-outcome geometry collection remains untouched.

## User-locked melee barrel correction (November 16, 2026)

The user requested “lock it in and continue” after the complete independent confirmation. Preserve the
A19 profile v9 default-on `SEARCH_A19_MELEE_BARREL_DELIBERATION` correction described in
`docs/melee_barrel_deliberation.md`. It compares melee deployment-barrel incumbents with legal movement,
wait and defend using the existing H64/R2/K6 search, rather than inheriting the neutral cemetery fast
return or a forced-productive preference. Useful clears remain; ranged/neutral cleanup and native rollout
policy stay unchanged. Wire version remains v0.8 and no model weights changed.

All 1,512 fresh families / 12,096 fights completed: +0.620040 score points, whole-family 95% +0.124008 to
+1.132606, with positive means on every map, own doctrine and fixed opponent style. This is conditional
on legally drafted barrel-containing families, not an unconditional global win rate. Independent input,
integer-score and bootstrap reconstruction passed. Serial complete-fight CPU increased at most 0.711645%
on the measured host, and bounded-live checks passed. Keep the compact evidence fixture
`docs/evidence/melee_barrel_deliberation_20261116.json`, including every scanned raw/permuted seed channel.
The original node handoff was not executed; strength games all stayed local.

Future combat studies use this adopted default as their incumbent, with off only as an explicit ablation.
Do not overwrite its confirmed result, reopen its bank, enable the older failed own-barrel fallback guard,
or infer that native rollout cleanup is now qualified. Any continuation needs a distinct candidate and
fresh channels; preserve the accepted neural pair and all earlier failed research references.

## Closed Peasant same-kill follow-through pilot

The distinct `peasant-same-kill-followthrough-v1` candidate completed its registered study on November 17.
Read `docs/peasant_followthrough_research.md` and preserve
`docs/evidence/peasant_followthrough_20261117.json`. It compared already-complete H64/R2 same-target
kill ties with matched immediate Peasant HP, bodies, armor, steps, Bitter stacks and response price,
then preferred a square closer to remaining ranged/caster output before the unchanged neural correction.
It added no candidate or rollout and remains offline only.

All 1,413 executions passed quality checks, including 108 fresh families / 432 paired outcome comparisons.
Every game result was unchanged: 0.000000-point gain, six changed trajectories, failed coverage and
strength gates. The all-zero empirical bootstrap interval is degenerate, not proof of zero population
effect. In every changed comparison both Peasants still attacked next turn in the same lap. Preserve
helper SHA `95c25e5faefffda560ee045a57e18d011b67b95b04a2a22797118c2183472824`, tests, all audits and the
20,480 scanned preimages with all raw/permuted channels. No qualification/confirmation opened and no
default, model or Premium change was made. Do not activate or widen this closed rule on its opened bank.
Further positioning work needs a distinct hypothesis and fresh evidence; shorter geometric distance
does not establish an extra attack or a strength gain.

## Closed Nightmare ground-wall coverage pilot

The user's Nightmare Fire Wall investigation completed as `nightmare-ground-wall-coverage-v1` on
November 17. Read `docs/nightmare_ground_wall_research.md` and preserve the full reservation ledger in
`docs/evidence/nightmare_ground_wall_20261117.json`. The inactive helper adds one ground-approach wall
to the unchanged root search, excluding flyers and units with remaining ranged/damaging-spell output
from its geometric targeting. It preserves every native action and uses no hidden information or RNG.

All 1,350 executions passed quality checks: 108 fresh legal Nightmare-preference draft families,
432 paired outcomes, 432 observer comparisons and 54 cold replays. The extra wall was selected 64 times;
65 trajectories changed. Four losses became wins, three wins became losses: **+0.231481 score points**,
whole-family 95% **−0.925926 to +1.388889**. The 7-point doctrine regressed. Minimum gain, confidence
and doctrine gates failed. Do not activate this rule, rescue a favorable slice or retune it on this bank.
No qualification/confirmation opened; no model, default or Premium routing changed.

Preserve helper SHA `83d590e8ad804382bf649891c8114a29e3ea5db2da937b8492f476ea5dffd85c`, registration
`bc6bb9ca33124c11133c24a87f0a4c0a1950a89e7ef464e9e8392e2be19da03d`, all 20,480 scanned preimages and
their 1,310,532 raw/permuted channels, including rejected and unused scans. Independent geometry,
integer-score/bootstrap, full wall-use and all-seven-outcome trace audits passed. More enemy burns
were accompanied by more allied burns; damage totals do not establish a strength gain.

A separate frozen-model diagnostic proves A19's observation omits Fire Wall orientation and existing
burning cells/lifetime/power. Identical neural inputs/predictions can accompany 0 versus 250 HP crossing
damage. Engine rollouts still simulate fire; this is not complete-agent blindness or an isolated cause
of the pilot result. Fixing the trained representation needs a new contract, new fits and fresh strength
and serving-cost qualification. Future route-aware wall work must also price allied access and the
attack/Empower turn given up. Preserve the accepted A19 neural pair and adopted barrel correction.

## Halted Nightmare route-preservation admission

The distinct `nightmare-route-preserving-wall-v1` follow-up halted before fresh games, not a qualified
gain. Read `docs/nightmare_route_preservation_research.md` and preserve its evidence fixture's full
scanned reservations. The original wall checkpoint above remains immutable and inactive. The new
helper filters its proposal using current native routes, protects allied safe approaches, declines
positive-damage attacks, and requires a strict full-R2 lead over productive alternatives.

Registration `3ed06ee12097d7e63ff7079e853f7b015f95017343144ffd5846b193c35b0887` covers all 65 old
changed cases for admission and 216 fresh families / 864 paired comparisons against both default and
original v1. Preserve all four arms, all outcomes and simultaneous confidence/doctrine gates. The
original hard cutoff is November 17 at 09:51:21 UTC: six nice-19 Puffalo CPU workers, no GPU, no
automatic retry or extension. Inspect the capsule's status and terminal receipts before starting work.
The first run completed 284 old-case executions, then failed selection-quality verification: 20 masked
walls were reselected because cached material evidence retained an unmasked array. All observer/cold
repeats and 130 cross-host off/v1 traces match. No fresh executions opened. Preserve the failed capsule;
fixing this harness requires masking its shared selection array and separately recording a corrected
execution before opening the reserved bank. No result permits automatic adoption, and opened admission
cases never count as fresh strength.

## Closed corrected Nightmare route-preservation pilot

The corrected execution `nightmare-route-selection-corrected-20261117` completed 3,812 executions before
the original cutoff. Read `docs/nightmare_route_selection_corrected_research.md` and its evidence fixture.
Registration `a2a5e57a790f1e9376f75c63aa3389df88175693038de179c7f006cccd0b1dba` preserved the exact policy,
previously unopened 216-family bank and gates. The adapter masks the shared selection array used by
material arbitration and final neural correction, retaining raw forecasts separately. 530 tests and
eight old-case canaries pass. Every selected new wall obeys the gate. All 929 observer pairs, 96 cold replays
and 130 original cross-host comparisons match. Fresh cold repeats were local; admission cold coverage
was split across hosts. Preserve that actual allocation.

On 864 fresh paired outcomes, guarded v2 scored **−0.173611 points versus default** (simultaneous 95%
−0.810185 to +0.405093) and **−0.925926 versus original v1** (−2.083333 to +0.231481). It selected 24 new
walls and changed 24 trajectories. Quality/coverage passed; gain, confidence and doctrine gates failed.
Original v1's diagnostic replication was +0.752315 points (ordinary 95% −0.405093 to +1.909722), still
uncertain and not a retrospective promotion. Independent raw-score/integer-family/bootstrap checks agree
on rejection. No confirmation, serial cost qualification, default, model or Premium change followed.

The guards retained only two of v1's 18 improved outcomes and four of its 12 regressions. Two retained
regressions replaced movement with a wall while neither game had a burn. Better friendly-fire totals
did not imply better outcomes. Preserve every outcome, the all-guard first-divergence audit and the
complete reservations; do not retune on this opened bank or rescue a guard subgroup. Future work needs
fresh evidence for movement opportunity cost, longer-horizon wall value or a new wall-aware learned
representation. The separate Hidden fixture confirms untargetable units still take fire damage; it is
mechanics evidence only and did not modify the candidate. Keep the original helper and route-helper
hashes, the corrected shared-array adapter/tests, accepted A19 pair and adopted barrel correction intact.

## Closed Nightmare wall movement comparison pilot

The distinct `nightmare-wall-movement-coverage-v1` candidate completed as
`nightmare-wall-movement-20261117`, registration
`819fa13d6e88006994abcca5c31ca400a0d5bac9c339e00eddc57c167e64b09a`. Read
`docs/nightmare_wall_movement_research.md` and preserve its full seed reservation fixture. The prior
coverage audit found no pure move in full search on 261 of 481 eligible wall roots, despite legal
native moves. Preserve the original-v1 comparison set and append at most one best finite native leaf
move only when none survived. No route veto, score mask, forced move or new model is involved.

All 3,720 executions completed on November 17 at 16:38:52 UTC: 24 admission cases, 216 fresh families /
864 paired outcomes and fixed cold repetitions. All 888 observer pairs, 168 cold replays and 48 old
default/v1 control comparisons match. Both source seals, raw scores and independent whole-family
statistics verify. All 535 targeted tests and the later 8,151-test common suite pass; full TypeScript
and package copy steps pass after a peer fixed its own transient type error.

Movement coverage scored **+0.520833 points versus default** (simultaneous 95% −1.157407 to +2.256944)
and **+0.231481 versus original v1** (−0.694444 to +1.388889). These are positive estimates, not qualified
gains: confidence and own-doctrine gates failed, with the five-point doctrine negative. Original v1's
diagnostic replication was +0.289352 points (ordinary 95% −0.752315 to +1.273148); it is not an alternate
finalist. No confirmation, serial serving-cost qualification, default, model or Premium change followed.

The move was added 293 times and selected 69 times. There were 69 changed trajectories against v1:
seven losses became wins, five wins became losses, and 852 paired outcomes stayed the same. Three wins
came from one family; the positive result is fragile. All twelve flips first chose movement, but three
other first divergences changed between existing actions and kept the same outcome. Preserve that
descriptive audit correction. Strict forecast leads preceded three regressions as well as five gains;
do not infer a qualified tie filter or blanket movement preference. Fewer allied burns and fewer wall
casts do not substitute for match score. Keep the full evidence, all 1,310,515 scanned reserved channels
and every earlier failed wall study. Do not tune a subgroup/threshold on this opened bank. Further
wall-aware representation or continuation research needs a distinct contract and fresh evidence while
preserving the accepted A19 pair and adopted barrel correction.

## Closed melee barrel shortlist coverage follow-up

The distinct `melee-barrel-choice-diversity-v1` study completed against the adopted v9 default.
Read `docs/melee_barrel_choice_diversity_research.md` and preserve both registration/result fixtures.
Exclude every scanned preimage in `docs/evidence/melee_barrel_choice_diversity_registration_20261117.json`,
expanding all eight raw and eight native-permuted channels, including rejected/unused scans.
Registration is `44a82736e7631a66c2d976911d05ac8bf993bb42f5b786ef16ea66cfcce812f1`.

All 1,353 executions passed quality checks, including 108 fresh families / 1,296 three-arm fights.
Every one of the 432 primary paired outcomes was unchanged: 0.000000-point gain, ten changed traces
on seven families, 25 shortlist interventions. Strength and coverage gates failed. The all-zero
empirical bootstrap interval is degenerate, not proof of zero population effect. No qualification,
confirmation or serving timing opened and no model/default changed. Preserve inactive helper SHA
`dd35a741728acf6d2895f664ea330d9e588c4211e9b7ba8b520d45026c332934`, tests and exact type-erasure parity.
Do not retune it on this bank, substitute more walking for a strength gain or weaken its closed gates.
Further native-forecast consistency work needs a distinct candidate and fresh channels, retaining
this result, the adopted barrel correction and the earlier failed own-barrel/search-reply studies.

## Closed barrel forecast-intent experiment

`barrel-forecast-native-intent-v1` completed on its frozen adopted v9 comparator. Read
`docs/barrel_forecast_intent_research.md` and preserve both registration/result fixtures, including all
scanned raw/permuted reservations. All 2,592 fresh fights and 144 functional/cold executions completed.
Primary gain was **+0.347222 points**, whole-family 95% **−2.141204 to +2.893519**. Strength, confidence,
map, own-doctrine and opponent-style gates failed; coverage passed. Blocked regressed −3.298611 points.
The rule remains inactive, with qualification, confirmation and serial timing unopened. Do not retune
it on this bank, rescue a favorable slice or infer a gain from unchanged/favorable concurrent CPU cost.

All 68 worsened and 74 improved pairs received exact full-trace/input/score replays (284 diagnostic
fights). Every first divergence retained the same actor and raw native incumbent but changed the final
choice. Ordinary shot retargets occur among both regressions and gains. This localizes changed forecast
valuations; it does not qualify a root-action filter or prove every useful-clear mechanism. Preserve the
inactive helper, source seals, original gates, all losing cases and the independent integer/bootstrap
verification. Further constrained forecast work needs a distinct candidate and fresh games against the
subsequently adopted v10 default. Keep the confirmed barrel deliberation and accepted neural pair intact.

## Closed useful-clear forecast regression repair

`barrel-forecast-friendly-shot-clear-v1` failed its full reused regression admission. Read
`docs/barrel_forecast_useful_clear_research.md` and preserve both registration/result fixtures and
helper SHA `5f031ae76411f1d3ab21391d81abf061d0decd8a4786e431de0fbd5b632de580`.
All 1,148 executions and 284 original controls verified; independent integer reconstruction agrees.
Against stock, regressed cases decreased 68 to 56, but gains decreased 74 to 54: **−0.462963 points
versus naive v1, −0.115741 versus stock**. It recovered 23 losses fully/one partly, erased 30 gains,
and introduced ten losses/ten gains among formerly unchanged cases. Fewer losses alone is not a gain.

All 144 v10 functional executions and 8,199 common tests pass; these do not qualify strength. No fresh
bank, confirmation or serial timing opened, and no default/model changed. Keep both closed forecast
helpers, original gates and every losing/unchanged case immutable. No map/action/outcome slice rescue
or tuning on this bank. Distinct uncertain-model work needs new source identity and fresh v10 evidence
within the +10% full-decision/full-fight cost bound, preserving the accepted neural pair and adopted
barrel correction.

## Paired forecast-model mixture passed reused admission

`barrel-forecast-paired-model-mixture-v1` is a separate inactive uncertainty hypothesis after both
closed forecast rules failed. Read `docs/barrel_forecast_model_mixture_research.md`. It uses one native
and one original-intent sample within existing full R2, assigning the models by semantic seed parity
identically across all candidates. Both future armies/owners share a sample's model. Root incumbent construction and non-full
probes remain native. No new rollout/inference/RNG draw or learned weights are introduced. Each model
has only one chance sample, so do not claim unchanged within-model antithetic cancellation or calibrated
values. Keep the frozen helper, source seal and fixed all-864-case admission gates. Old data cannot
qualify a new v10 default or rescue a favorable slice. Passing requires fresh v10 evidence, complete
safety/uncertainty and +10% full-decision/full-fight cost gates; no automatic promotion.

The mixture completed all 1,148 reused executions: +0.983796 score points versus stock and +0.636574
versus naive v1; regressed outcomes fell 68 to 49. It also erased 35 old gains and introduced 13 old-
neutral losses. This passes fixed admission, not independent strength. Preserve the admission fixture,
all raw counts and both failed rules. All 144 v10 functional runs and 8,204 common tests pass; source CI
is green. Fresh qualification reserves 756 families / 12,096 fights with balanced 540 local/216 Puffalo
families. Exclude every scanned preimage from
`docs/evidence/barrel_forecast_model_mixture_qualification_allocation_20261117.json`, expanding eight
raw/eight native-permuted channels including rejects/unused seeds. Require cold parity and the frozen
strength registration before combat. Do not retune the mixture coefficient, rescue a subgroup, claim
v10 strength from reused v9 data, or promote without independent strength/cost/confirmation.

Fresh mixture qualification is now frozen under
`c2e6a08938110cc5ab360b2cffb1823391abe92044fab4ad1f65a013f403eebb`;
read `docs/evidence/barrel_forecast_model_mixture_qualification_registration_20261117.json`.
After cold throughput calibration, BEFORE fresh combat, execution changed to 648 local/108 Puffalo
families (12/8 workers, Unix nice19). Original allocation stays preserved, with six/one complete factor
replicates per host. No source, seed, model or score-gate change occurred. Both shards use the common
November17 20:56:07 UTC hard cutoff. No automatic retry, extension or family reassignment after start.
All 48 local/Puffalo functional cold runs match exactly. Fixed fresh cold cases replay all four strength
arms, including accepted reference, on both hosts after collection. Keep finalizers blind until both
shards complete; independently verify integer outcomes/bootstrap and zero timing fallbacks. No result
from reused admission or partial fresh data qualifies a new default or removes serial-cost/confirmation.

The mixture passed its complete independent v10 strength qualification: **+1.488095 score points**,
whole-family 95% **+0.281085 to +2.711640**, on 756 families / 12,096 fights. All registered strength,
confidence, map, own-doctrine, opponent-style and coverage gates passed; all 288 fixed fresh cold
executions and independent integer/bootstrap verification match. Preserve
`docs/evidence/barrel_forecast_model_mixture_qualification_results_20261117.json`, including every
family delta and all 166 worsened outcomes. This is a conditional net gain, not universal no-regression.
The candidate remains inactive: quiet serial complete-decision/full-fight +10% cost and at least 756
fresh independent confirmation families are still pending. A live adapter must pass the ACTUAL
effective rollout count; timing-degraded R1 stays native. Offline qualification used uniform full R2
and could not degrade. Preserve all failed helpers, original gates and the adopted default; no
promotion/deployment follows from qualification alone.

The complete-cost study is frozen under
`8f91fb4c12efceaeb4c34b908959106cb87ce2e741a7a112121a139394538a5a`; read
`docs/evidence/barrel_forecast_model_mixture_cost_registration_20261117.json`. One nice-19 M4 actor
runs 276 fixed executions, including 72 balanced three-arm serial cases, full-decision timing,
bounded-live controls and forced-effective-R1 identity pairs. Its cutoff is November 17 at 21:43:41 UTC.
Both one- and two-actual-driver modes must satisfy every registered +10% cost gate; no retry,
extension, subset rescue, automatic promotion or fresh confirmation before cost passes.

The cost study completed all 276 executions and **failed** its registered gate. Preserve
`docs/evidence/barrel_forecast_model_mixture_cost_results_20261117.json`. Offline 72-case CPU was
−3.45% entrant-only / +1.62% both drivers; bounded 12-case CPU was −5.02% / **+18.11%**. Both-driver
bounded wall/decision totals also failed +10%, while mean decision cost passed. All quality, original
controls, forced-effective-R1 pairs and independent integer checks passed. All 36 matched live/offline
actual traces agree; their longer two-AI trajectories use 661 versus 592 decisions. Forecast records can
differ because certified loser bounds are offline-only. Preserve the diagnostic assertion erratum;
it changed no result. No confirmation was allocated/opened and the candidate remains inactive. Never
repeat this unchanged study until pass, waive its two-AI gate or promote the positive strength result.
Further implementation/pruning work must have a distinct source, exact behavioral controls and its
own fixed cost gate; preserve the frozen mixture and every earlier failed candidate unchanged.

The distinct `barrel-forecast-native-context-live-bounds-implementation-v1` is an inactive,
behavior-preserving runtime hypothesis. Read `docs/barrel_forecast_runtime_research.md` and its
registration fixture. Direct native sample context, a lean selector and the existing certified loser
bound replace research overhead; no strategy, score, budget or model changes. All 444 full-game
controls and independent verification match; 95,040 selector guard comparisons and 20,000 bound
matrices pass. Admission uses a controlled unexhausted clock and claims no speed gain.
Its separate real-clock cost study freezes 464 executions with one active fight in two isolated
nice-19 actors; offline and live 72-case ratios AND the original twelve slow cases must all pass
+10% CPU/wall/full-decision-total/mean for entrant and both-driver modes. Cutoff November 17 at
22:35:37 UTC; no retry,
extension or subset rescue. Original cost failure remains failed; no confirmation/default/deploy opens
from equivalence alone. Exact patches/hashes are preserved without modifying serving source.

The native-context v1 real-clock study completed all 464 executions and **failed** its complete
registered gate. Preserve `docs/evidence/barrel_forecast_runtime_results_20261117.json`. All full
traces/outcomes/inputs and independent integer checks agree, with zero model/action/timing failures.
Both-driver live72 CPU was +1.44% (mean decision +0.82%), but preserved slow12 CPU was +19.91%
(mean decision +6.91%); three slow12 total-cost gates failed. Do not waive that gate or rerun unchanged.
All 72-case aggregate gates passed; both facts remain explicit. Pruning removed projected turns on
identical trajectories, while the two-AI sample still uses 661 versus 592 actual decisions. No fresh
confirmation/default/deploy opened. Further loop-invariant/context-layout work needs a distinct source,
exact equivalence and a fixed study; no action/model/score changes or old-result rewriting.

The user explicitly selected **overall average (+10%)** for the next independent study on
November 17 after both historical cost studies closed. This supersedes their subgroup veto only
for future registrations; neither old failure is rewritten. A new prospective study must retain
all 72 balanced cases, both actual-driver modes, real clocks, exact complete traces and quality
controls. Report the original slow twelve explicitly. Their cost is descriptive under this new
user-selected target. The separate loop-invariant/stable-context v2 implementation is frozen under
`36ed17b8c51d54947c0f68146ea512589b6b2503ae9bb9cd316f1578839deb18` for 444 equivalence
executions; cost and fresh strength remain pending. Any fresh default comparison must use adopted
terrain-aware v11 on both arms, while the already-frozen v10 implementation controls stay v10.

The loop-invariant v2 passed its prospectively registered overall-average cost gate: all 464 full
inputs/traces/outcomes exact, zero engine/model/timing failures, live two-AI CPU **+2.36%** and mean
decision **+1.09%**. Slow12 remains +20.27% CPU descriptively; both earlier subgroup-gated studies
remain failed. Read `docs/evidence/barrel_forecast_loop_runtime_results_20261117.json`. All 96 reused
v11 cross-host cold controls also match. A lexical JSON verifier correction distinguishes original
Python integer tokens from an integral floating deadline; actual seeds, prior, policy and gates did
not change. Both failed verifier attempt and corrected independent checks remain preserved.

Independent terrain-aware v11 confirmation is frozen under
`1a31dd5fbba8544bf25ad96c3d10ab47165f4ddeabaf8602d9096f83c1dbb3ff`: 1,512 families / 18,144
fights, unchanged mixture versus stock, accepted pair descriptive. Read its separate allocation and
registration fixtures. Exclude **all 207,510 scanned preimages**, including rejected and unused, with
eight raw/eight native-permuted channels. All 3,096,576 accepted channels independently avoid the
29,997,656-channel prior; legal family selection and paid native physical-side doctrines pass.
12 Mac / 8 Puffalo nice19 actors share the November18 **03:10:07 UTC** cutoff, with 1,404 / 108
whole families. No retries, extension, family reassignment, policy/model/source/score-gate tuning or
interim score selection. Fixed 36-case cold replay and 72-case v11 serial cost remain required before
claiming a confirmed serving gain. No automatic default change or deployment.

The independent v11 strength confirmation has now completed and **failed**: +0.107474 score points,
whole-family95% −0.752315 to +0.967262, across 1,512 families / 18,144 fights. Read
`docs/evidence/barrel_forecast_model_mixture_v11_strength_results_20261118.json`. Minimum gain,
positive lower-bound and shooter-opponent floor gates failed. All source/input/engine/neural/timing
controls, 216 fixed cross-host cold replays and independent integer/bootstrap verification pass.
Preserve all 375 gains, 364 losses and 5,309 unchanged pairs; no subgroup, accepted reference or pooled
old v10 result rescues this candidate. Both frozen v11 serial-cost studies continue pending; they
cannot rescue failed strength. No default/model/deployment changes, and no retuning or bank extension.

Both v11 cost studies subsequently completed: original72/464 executions and balanced216/1,328,
all sixteen aggregate +10% gates in each, exact original inputs/full traces/outcomes/actual turns,
zero engine/model/timing failures and independent integer verification. Read
`docs/evidence/barrel_forecast_model_mixture_v11_cost_results_20261118.json`. Live both-driver CPU
was −7.09% and −4.47%, respectively; differing trajectories/decision counts do not isolate a causal
runtime speedup. Preserve the failed strength verdict and every older cost failure. The forecast
candidate stays inactive; current-v12 default qualification remains separate from these frozen v11 studies.

The separate native-forecast live-pruning functional admission also **failed**. Read
`docs/native_live_pruning_research.md`. All128 reused executions and 7,288 independently checked mutable
snapshot hashes preserve committed actions/state/memory/RNG/UUID/array identity and cold controls, but54
retained samples in two caster cases differ in private UUID counters. Preserve the exact failed gate,
all counterexamples and zero-game packaging failure. Projected work fell4.02%; this is not CPU or strength
evidence. No runtime study/default activation follows. Resolve per-sample UUID allocation explicitly before
a distinct implementation study; do not rescue this attempt by ignoring the private counters.

The separate observed-stock teacher acquisition completed all3,024 reused v10 games and4,220 public
decision labels with exact original controls, independent verification and24 exact cold observations.
Read `docs/barrel_forecast_teacher_research.md`. A frozen110-feature family-disjoint linear fit improves
held-out choice logloss by0.063860, but has zero P(before)>=.85 proposals and **fails** its support/precision
gates. Keep modela59b6d8d inactive, retain all folds/recipes/failures, and do not lower the threshold on
the opened test. The1,865 exact third choices include move/hold/spell alternatives; nine are footprint-order
equivalents. These descriptive categories and teacher accuracy are not strength gains. No candidate
fight/cost bank opens; future action/legality work needs a distinct source and current-v12 evidence.

The separate passive legal-catalog recorder passed56 reused executions, all3,188 independently checked
mutable hashes, original traces/counters and31 exact cold observations. Its first zero-observation
coverage attempt remains failed. Read `docs/barrel_legal_catalog_research.md` and preserve both source
and result fixtures. Proposed catalogs/partial scores do not certify universal legality or full means.
The next unchanged-stock acquisition is frozen under
`05a09addf03a216f0e2270d9e2013fdb73c70ad0554dfe3471b1050c6462ec9a`:6,048 reused v11 games,
1,512 prospectively split families,28 admitted cross-host preflight executions and72 fixed cold controls.
The registration fixture records collection in progress, not completed labels or a model result.
Keep test labels separate, no held-out model selection, no automatic fitter/promotion, all fixed cutoffs
and prior failed gates. Current-v12 work must use native setup dispatch with persisted delivery flags
and the server's actual memory/committed-turn contract; the older headless teacher is not that server.

The separate initial-catalog prefix admission passed56 controls,31 real and402 hypothetical catalogs,
zero score/rollout/engine-action requests and1,732 independently verified before/after state bodies.
Preserve `docs/evidence/barrel_native_catalog_prefix_results_20261118.json`, including the late-stop
attempt's15 scoring requests per epoch and failed gates. This is fixed older-v11 feasibility only.
The inactive190-feature prototype explicitly admits immediate first-catalog metadata and spell mechanics;
its13 tests do not establish prediction or battle strength. Missing active-roster spell recipients may
be legal graveyard targets: retain them as incomplete information and require learned-policy abstention.
Main-data fitting still needs a complete initial/pre-leaf provenance contract, unchanged held-out gates,
actual native memory/UUID semantics and fresh current-v12 whole-family strength/cost. No auto promotion.

The full reused-v11 acquisition and subsequent input assembly have now completed:6,148 original/preflight/
cold controls,8,732 main observations and320,412 lightweight frames independently verified; zero input
contract violations. Preserve `docs/evidence/barrel_catalog_teacher_complete_results_20261118.json`.
All6,048 source cases/1,512 original family folds remain, including empty cases and explicit unsupported/
outside options. The source-bound productive-tier/Healer-wait contract and all33 added static fields,
labels/masks/outside rows pass independent checks; the earlier157 numeric features are not separately
reimplemented in Python. No held-out model metric or fitter has opened. Keep the old805-label test closed.
Further learning needs its own frozen fit/confidence gates and sealed artifact before test evaluation,
then actual/hypothetical validation and fresh current-v12 strength/overall-average+10% cost. No default changed.

The separately registered native-catalog ranker fit is now complete and failed validation support:
4 confident proposals across4 families, below the fixed100/60 minimums. Preserve
`docs/evidence/barrel_native_catalog_ranker_fit_results_20261118.json` and read
`docs/barrel_native_catalog_ranker_research.md`. Its validation logloss improvement0.49902 and44.8645%
teacher agreement are development prediction metrics, not combat gains. No final refit or test parsing
occurred; the new1,757-decision test and older805-label test remain unopened/closed respectively.
Keep all6 recipes/30 temperature results and failed gates. Independent Bun checks all1,587 validation
posteriors, decisions and family sufficient statistics, not NumPy's bootstrap RNG. No default changed.

The separate train/validation identifiability audit verifies all6,975 records in Python and Bun:
zero validation targets have an identical valid feature rival, so duplicated option vectors do not
explain the four-proposal support failure. Preserve
`docs/evidence/barrel_catalog_identifiability_results_20261118.json`. Its structural ceilings and
observed repeated-input conflicts are not model accuracy or strength. The fitted weights, failed gates
and unopened1,757-label test remain unchanged; do not treat this diagnostic as permission to activate.

The separate fixed-normalization audit also verifies all6,975 opened records in Python and Bun:
clipping introduces zero additional valid-option aliases or contradictory ordered-input groups.
Preserve `docs/evidence/barrel_catalog_normalization_results_20261118.json`. Validation has412 clipped
coordinates across189 OOD rows;979 complete, in-range alternative targets retain unique vectors.
This necessary-condition ceiling does not prove learnability or achieved support. It does not rule out
soft distance/optimization effects; keep all failed gates, weights, thresholds and tests unchanged.

The distinct root-scoped mixture reused admission is registered at
`6eda742bd48db1366e7ec95c898578b97c80f974a2cab7fb6b654542bc3bb438`; read
`docs/barrel_root_scoped_mixture_research.md` and its registration fixture. It retains all6,048 old-v11
cases/1,512 families and compares both recovered regressions and erased gains. Only actual melee
deployment-barrel incumbents enable the old mixture; ordinary root choices otherwise stay native.
Preserve the zero-actor local disk failure and node startup-stream failure with zero completed records;
actual starts in the latter are not proven absent. Preserve the second stream failure too. V3 retains
the ready handshake and original campaign parser/environment, logging every stdout line. Exclude only
raw work.msTotal wall timing from logical-counter equality; retain it in raw records. All intelligence,
cases/gates and the original November18 09:45 UTC cutoff stay fixed. No ranker tuning,
teacher-test parsing, fresh strength claim or default change. Only a complete passing reused admission
permits separately registered current-v12 authoritative-memory qualification and overall-average+10% cost.

That root-scoped attempt stopped at its original cutoff with4,590/6,048 acknowledged cases; neither
cold epoch ran. Preserve `docs/evidence/barrel_root_scoped_mixture_incomplete_20261118.json` and the
verified terminal archive. All11 current and6,959 parent registered files still match. No partial score
is aggregated, no reused admission is achieved, and no forecast qualification/promotion follows. Do not
restart, extend, rescue a subset or mistake an incomplete execution for a policy-strength verdict.

The prospective final-validation source seal is
`f42f14045131fecab5ac79d13228d595d2aa4f37d0ae5b25ab115403660eaf51`; read
`docs/evidence/barrel_forecast_model_mixture_v11_validation_design_20261117.json`. The original
72-case timing sample covers games0/1 and only opponent see-all. It stays unchanged and required.
Before any strength aggregation or new timing observation, a separate **216-case / 1,328-execution**
cost check was fixed from all108style/map/own/opponent-doctrine cells, covering both draft orders
and opposite physical teams, 54 cases of each game index. Both cost studies must pass the same
full-matrix aggregate +10% gates; neither rescues a failed phase. No outcome/runtime-based sampling.
All8 validation runner/verifier bodies and hashes are versioned in the fixture; prepare scripts
check the seal before execution. Six reused functional smoke fights reproduced every stored stock/
mixture input, full trace, outcome and actual action; both-driver activation also ran. This adds no
strength or timing claim. No existing frozen file, policy, model or score gate changed. Cold replay
still requires 216 exact executions. Each later validation phase gets its own fixed cutoff and
does not extend the unchanged strength-collection cutoff. No automatic default change or deployment.

The completed-control transfer rehearsal caught a local Python3.9 `tarfile.extractall(filter=...)`
compatibility error before any fresh return. Preserve
`docs/evidence/barrel_forecast_v11_transport_control_rehearsal_20261118.json`. Only the observer was
stopped while waiting; no battle was restarted. Operational supervisor v2
`5ac80d26d5be909b734ac77c2924292ac6e2947367452797f6a1f3529206b0f0` copies only manifest-listed
regular members into a temporary directory, rejects links/absolute/parent paths and checks all SHA
values. Its real SSH/archive/SCP/portable extraction roundtrip matches all five existing control
files byte for byte. All 6,959 intelligence/input and ten validation files, seeds, models, gates
and cutoffs remain exact. This control supplies no new strength or timing claim. Keep both old
observer source/registration and the failed rehearsal; use the v2 supervisor handle in local resume
state, and never duplicate or restart the existing experiments.

The completed old-v10 regression audit is in `docs/barrel_forecast_regression_audit.md`. Independent
reconstruction retains all 3,024 pairs, 208 gains and 166 losses. All 48 fixed final diagnostic replays
and four separate memory-identity replays reproduce original full controls. Two improved cases have
target-memory differences before their first recorded choice change: equivalent actions take different
commit paths through array identity. Preserve both gains, every failed observer and the original cutoff.
Actual committed turns, not inner search returns, are authoritative. The current ranked server also
has the identity branch plus separate incumbent-memory restoration. No corrected policy was evaluated;
do not fold a memory fix into frozen v11 confirmation or claim a new strength/calibration gain from
these selected old cases. Keep the full evidence fixture and all earlier gates unchanged.

## Closed ranged counter-shot screens

Read `docs/ranged_countershot_safety_research.md` before continuing the November 17 human-match
investigation. The separate inactive `ranged-countershot-safety-20261117-pilot-v1` freezes current v10
at `997490ee`, 54 fresh native draft families and 432 paired battles. It uses existing full-search
samples to reject only fatal low-return ranged exchanges with a surviving, non-losing ranged
alternative whose full forecast is no worse. Keep its fixed candidate and all cases; do not tune on
partial outcomes. The registered one-decision alternatives are reused-bank diagnostics, not fresh
policy qualification. Neither experiment changes a serving default or the peer's mixture study.
Reserve every scanned channel in namespace `ranged-countershot-safety-20261117-fresh-v1`, counters
1 through 20,480, with 32 raw and 32 native-permuted channels per SHA-256 little-endian preimage,
including unused and rejected allocations. The ignored client capsule contains the exact receipts.

The conservative screen completed: both arms 102 wins / 5 draws / 109 losses, **0.00 points**, nine
changed trajectories across six families. It failed promotion. All six cold repeats and independent
integer checks passed. The separate 14-case one-shot diagnostic recovered one loss and two draws into
wins with no worse cases, all from safer shots whose native full forecast was 0.25 lower. That is
selected reused evidence, not a general strength claim. Preserve the closed source and all 216 paired
outcomes in `docs/evidence/ranged_countershot_safety_20261117.json`; a new one-correction rule needs
a distinct registration and fresh seeds. No default changed.

The distinct `ranged-countershot-once-20261117-fresh-v1` candidate removes the forecast floor but
permits only one correction per battle. Read `docs/ranged_countershot_once_research.md`. All 14
automatic-policy development traces match the prior forced branches exactly. Its independent screen
reserves 108 fresh families / 864 battles on the 9800X3D host, four nice19 workers, cutoff November 17
20:41:38 UTC. Exclude namespace `ranged-countershot-once-20261117-fresh-v1`, counters 1..20,480,
with the same 32 raw/32 native-permuted expansion. No partial-outcome tuning, extension or promotion;
positive fresh evidence still needs independent confirmation, durable budget semantics and +10% cost.
Its frozen source and every scanned preimage are recorded in
`docs/evidence/ranged_countershot_once_registration_20261117.json` (registration
`c204e5c4c03543fb8e80dffe84b270fb53feba56d4f8ea93ad63376cfee1610b`). Independent channel verification
found zero prior intersections across all 34,560 used raw/permuted channels and 192 exclusion ledgers.

The once-per-battle fresh screen is complete and failed: **+0.00 points, 95% -0.69 to +0.69**, 864
battles. Both arms scored 211 wins / 4 draws / 217 losses. Twenty-one corrections across 18 families
produced one gain, one loss and 19 unchanged outcomes; all 411 untouched cases and every changed prefix
matched exactly. All six fresh cross-host cold executions and independent integer calculations passed.
Preserve `docs/evidence/ranged_countershot_once_result_20261117.json`. The regression saved a 14-HP
single Elf that had baited Arbalester's response; the following Centaur then took 285 HP / 19 creatures
in retaliation. A distinct future hypothesis must account for response consumption and ready allies,
not erase this counterexample or exempt its creature after the fact. Both fresh outcome flips were
full-forecast ties. Do not claim lower-forecast corrections were qualified. No default, model,
confirmation or cost campaign changed; both closed helpers and seed reservations remain immutable.

## Abomination counterpick screen, November 17, 2026

Read `docs/abomination_counterpick_research.md`. The distinct six-arm exploratory screen freezes 54
public legal offer families / 648 battles against current v10. It tests draft choice, the existing
guard contract, free shield coverage and their combination without spending extra upgrade points.
Preserve hidden collision retries, public-only choices, native opponent formations and family-level
inference. No subgroup or absorption statistic licenses promotion; the old protector-release wins
remain historical evidence. Registration and sources are in
`docs/evidence/abomination_counterpick_registration_20261117.json`. Exclude every scanned preimage in
namespace `abomination-counterpick-20261117-fresh-v1`, counters 1..20,480, and its 32 raw/32 permuted
channels, including rejected and unused values. Fixed cutoff: November 17, 22:15 UTC. No default
change, automatic promotion or tuning on these outcomes.

The initial screen is complete: no overall win. Prefer-Abomination versus the alternate offer was
-7.41 pp; formation plus guard versus the native default was -7.87 pp. All planned confidence
intervals include zero. Preserve `docs/evidence/abomination_counterpick_result_20261117.json` and the
18 exact cold replays. A 24-family post-hoc physical-shooter slice was +8.33 pp [-8.33,+25.00]; it is
only a hypothesis, not a promoted exception.

The separate `abomination-physical-counterpick-20261117` validation freezes 108 new eligible families,
both seats and three arms / 648 fights. The first public L4 offer must show at least two ranged
opponents, no magic-damage-capable opponent and at least two own ranged/caster assets. Keep that
decision through retries; never use hidden or later-revealed identities to select cases. Compare the
unchanged formation-plus-guard policy against both native default and ordinary Abomination play.
Registration `23be7c8f621ad8ff66105f3d4798123f76ef5d86b1d50ddcb41f12df9ea97917`, sources and every
scanned seed are in `docs/evidence/abomination_physical_counterpick_registration_20261117.json`.
Exclude namespace `abomination-physical-counterpick-20261117-fresh-v1`, counters 1..20,480, with the
same 32 raw/32 permuted expansion, including rejected and unused channels. Eligibility-only sampling
was extended within already-reserved channels before any battle to fill the low-visibility
Block / seven-point versus five-point / first-pick stratum. No outcome-based extension or tuning;
cutoff remains November 17 22:15 UTC. No default activation.

The fresh targeted Abomination validation is complete and **failed all three strength gates**.
Native: 105W/5D/106L; contextual Abomination with ordinary play: 79W/3D/134L; formation plus guard:
89W/2D/125L. Combined versus native was **-8.10 pp**, simultaneous 95% **[-17.59,+1.16]**. Combined
versus ordinary Abomination was **+4.40 pp [-3.47,+12.50]** and remains uncertain. All 648 battles,
nine cold cross-host repeats, six smoke traces and independent integer/bootstrap checks passed.
Preserve `docs/evidence/abomination_physical_counterpick_result_20261117.json`. The earlier +8.33
post-hoc hint did not validate. More shield HP or a favorable slice does not rescue either bank;
do not enable this draft preference, formation repair or guard rule. Default v10 remains unchanged.
Future research needs a distinct registration and fresh seeds; retained channels include every
rejected, unused and eligibility-extension bundle. Healer builds were scarcely represented, and
frontline coordination and paid Placement were not independently qualified here.

## Closed terrain-placement reflection screen

The November 17 audit confirmed a missing actual-terrain input in split/final placement: all 48
changed-neutral-barrel-layout comparisons retained identical formations. Read
`docs/terrain_placement_research.md`; this is not complete combat or lava blindness.
`public-terrain-formation-reflection-v1` then completed a fixed 36-family, both-seat screen against
the adopted v10 default: +7.638889 match-score points, whole-family 95% interval 0 to +16.666667.
The strictly positive lower-bound gate failed; no default/model changed and confirmation remains
unopened. Preserve both terrain-placement evidence fixtures, exact frozen candidate source, all
20,480 scanned/rejected/unused preimages plus audit seeds, 106 executed battles/38 exact-input
reuses, and successful reproducibility checks. Do not extend this bank until significant or
activate the heuristic as a qualified gain. Future terrain-aware learning must retain public-only
information, both ranked/Premium routing, native setup/split parity and the placement promotion gate.
