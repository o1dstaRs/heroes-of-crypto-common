# v0.7 AI — Final Report: Architecture, Ceiling Diagnosis, and Roadmap

---

## 1. How v0.6 is built and optimized

**The decision stack.** A full match runs draft → perks/augments → placement → fight, and v0.6 is the first "full-game" AI: every stage has a policy, though almost all capacity is hand-coded.

The fight AI lives in `heroes-of-crypto-common/src/ai` as a versioned inheritance chain (v0.1→v0.6) behind one seam: `IAIStrategy.decideTurn`, called once per unit turn, returning engine `GameAction`s. The v0.1 base is a greedy rule engine (`ai.ts findTarget`): melee if adjacent, else best ranged shot, else BFS-advance toward the nearest enemy. v0.2–v0.4 stack ~20 sequential hand-coded overrides (beneficial-only spell casting for 4 of 7 casters, no-counter retargeting, aura positioning, ~15 named-creature tactics, legality guards). Precedence is implicit call order; each stage sees only the previous stage's single decision, never a candidate list.

v0.5 is the RL layer: five learned **linear re-rankers** (shot scoring, move destination, melee target + stand-cell, mountain mining, AOE positioning) totaling 56 coefficients, each with an incumbency-anchor feature so zero weights reproduce v0.4 byte-for-byte. On top sits the single biggest win ever, a hand rule: the **strategic hourglass** — wait when ≥67% of enemies haven't acted, converting the 41%-winrate first-mover seat into the 59% second-mover seat (+6–7pp). v0.6's fight vector is BESTMIX, a +0.97pp mixed-roster retrain of the same 56 dims (one subsystem review called it "byte-for-byte v0.5"; the ledger's bake record is authoritative: same architecture, retrained weights). Decisions are one unit at a time, one ply deep, no team coordination, no multi-turn planning.

Upstream: **draft** is an 11-dim context-free linear creature scorer (coevolution-trained melee champion, `DEFAULT_DRAFT_W`); **setup** is greedy static tables (perk = SEE_NONE always; augments = Armor3+Might3+Sniper1; artifacts by composition-blind winrate tables) plus one trained 7-dim vector; **placement** is v0.3/v0.4's hand-coded geometric layout with a 13-dim trainable seam left at its no-op anchor (confirmed tapped). Total learned parameters across the entire stack: ~90.

**The training pipeline.** `optimizer/cem.mjs` runs the Cross-Entropy Method: sample a Gaussian population (16 local / 40 on the node) around the current mean; evaluate each candidate's *decisive win rate over whole matches vs a frozen ancestor* (2,200–3,000 games each, deterministic per-match seeds so every candidate plays the identical scenario set); keep the elite 4, refit mean/sigma, decay sigma toward 0.05, restart-from-best in multi-hour mode. Anti-overfit machinery: a 5-seed held-out panel (4,000 games/seed) gates the global best, and a bake additionally requires fresh-seed round-robin vs both the champion *and* v0.4 plus cohort non-regression (melee/range/random rosters). Sibling trainers reuse the recipe for draft, setup, augments, and placement. A separate 14-feature logistic value function (`fit_value.mjs`, 69.5% held-out accuracy) beats a material leaf by +2.1pp but every search vehicle built on it (2-ply, 1-ply rerank — both over ≤5 melee-only candidates) only ties. Full battle snapshot/restore exists (`battle_snapshot.ts`, ~125µs); the old "no clone, so no search" premise is stale.

**Deployment caveat, load-bearing for everything below:** much of this never runs live. The server drafts and sets up with the *untrained* heuristic, AI placement is a random midline scatter, server takeover turns use pre-v0.5 `findTarget`, the browser executes only the first decided action — and no persistent bot seat exists at all.

---

## 2. Why the current methodology is at its ceiling

Five structural limits, each with ledger evidence:

**2.1 The policy class cannot express new behavior.** All learned scores are `w·f` over hand-picked features, anchored to the v0.4 incumbent, re-ranking only candidates the v0.4 heuristics already emit. A weight setting can never produce a play shape the pipeline doesn't generate — and *every* multi-pp win in project history was a new shape, not a weight movement: hourglass (+6–7pp, hand rule), melee stand-cell enumeration (+2.4pp, new candidates), splash-AOE dispersion (+5.58pp), Griffin aura positioning (+2.25pp), block-map mountain logic (+1.8pp). Meanwhile whole engine-legal action classes carry literally zero probability: Angel Resurrection, Valkyrie Wind Flow (the game's only in-fight anti-flyer tool, vs a 0% matchup), Harpy Castling, `area_throw_attack`, `defend_turn`, and the entire morale/luck economy.

**2.2 Credit assignment is one bit per game.** CEM's reward is the win/loss of a ~60-turn match, ascribed to a 56-dim vector. Per-candidate SE at 2,200 games is ~1.07pp, so once true headroom drops below ~1pp — where the ledger says it now is — elite selection ranks candidates essentially at random. Honest gains per run shrank monotonically: +9.7pp (v0.3 era) → +0.9pp → +0.97pp → 0. The per-decision label infrastructure (`VALUE_DATA`) exists but only ever fed a leaf evaluator, never policy training.

**2.3 The objective is saturated and non-transitive.** Fitness is best-response to a frozen anchor. Documented failures: a vector that beat the champion +0.9pp head-to-head was *not* stronger vs v0.4; the first draft champion (86–87% vs anchor) was hard-countered 85% by melee; draft coevolution converged to gen-7 all-tie. Structurally, ~39% of mirrored games are seat-decided coin flips, capping mirror win rates near 72–73% — the remaining gap to "perfect play vs v0.4" may genuinely be ~1–2pp. The sim objective itself is nearly exhausted.

**2.4 Self-play certifies optimality only against shared blind spots.** Both sides ignore Resurrection, Wind Flow, control-EV, area throws, morale — so adding a mechanic the opponent also lacks reads as noise until an opponent can exploit it. This is why "tapped" verdicts kept being overturned by mechanic fixes: the Double Shot damage-model fix un-tapped a "converged" vector for +0.93pp, and three multi-pp fixes baked *after* the 2026-07-08 "all levers exhausted" verdict.

**2.5 The sim certifies a different game than the one deployed.** Confirmed reversal: augment-CA's +1.6pp sim win regressed −1.3pp live (free enemy vision + random rosters in training vs SEE_NONE + ~97%-melee drafts live). Verified-in-code gaps that remain open: live stacks are `ceil(1000/exp)` per creature (L1 ~73–200, L4 ~1–3) vs the trained {50,30,15,8}; the client truncates multi-action turns to the primary; server takeover/placement/draft paths bypass the trained stack entirely; the corrective eval flags cited in the ledger were never committed. And the deepest gap, surfaced by the completeness review: **there is no live AI opponent** — `play_session.ts` sets every player `aiControlled: false` and flips it only on timeout/disconnect, clearing on any accepted action. Every pp ever measured is about a game no human currently plays against.

**Conclusion:** the optimizer is fine; the policy class, the reward granularity, the opponent distribution, and the deployment path are the ceilings. v0.7 must change what the AI *can consider* (candidates/search), what *feeds the fight* (draft/setup/placement — draft alone swings ±15pp, the T2 artifact table spans 34.4pp), and *where gains are measured* (live-faithful config, real opponents). All six adversarially-judged proposals survived (none died on 2+ lenses); the roadmap below sequences them, incorporating every judge fix.

---

## 3. The v0.7 roadmap

The causal chain, made explicit: **draft decides which armies fight (±15pp) → setup decides whether they're equipped to win (34pp artifact spread, augment-fit) → placement decides the opening tempo (2–5pp layout deltas, +5.58pp dispersion precedent) → the fight vector converts the entering advantage.** The fight vector is at its mirror ceiling; the stages feeding it are not, and half the stack isn't even wired to live play. So: fix the foundation, win the war upstream (League), and attack the in-fight ceiling with the one untested vehicle (wide-candidate search) plus cheap repertoire additions.

### (a) Foundation — weeks 1–2, unblocks everything

**F1. Reclaim agent-zinc.** Kill `keepalive_fight58b.sh` (the 58-dim CEM whose panel gains are "always overfit" — the ledger's own words: utilization theater). Harvest `best_iter_N.json` for one fresh-seed check, then free the node. Zero cost, funds every big bet.

**F2. Commit the LiveTwin eval config** (from the fidelity proposal, judged strong/strong on tapped+feasibility). In `common/src/simulation`: a **per-creature** amount resolver porting `amountForCreatureExperienceBudget` (judge fix: `options.amountByLevel` cannot express `ceil(1000/exp)` — extend `buildRoster`/`draftRoster` with an amount function), drafted-melee rosters + SEE_NONE as first-class committed `TournamentOptions`, cohort battery (melee/range/random) and paired side-swap seeds as defaults in `cem.mjs`/`measure_*`. Week-one kill test: DEFAULT_V06_W vs v0.4 under trained vs live amounts, 2×8,000 games × 3 fresh seeds (judge fix: powered up from 2×4,000; budget 1–2h, not 30 min — big L1 stacks lengthen games). If the edge shifts, a LiveTwin retrain is warranted; if not, the config still de-risks every other workstream. **Every gate in (b) and (c) reports its headline on this config** (`FIGHT_MELEE_ROSTERS=1` + SEE_NONE), per the augCA lesson.

**F3. Deployment parity + the bot seat.** (i) Client: generalize `AIController.performStrategyActions` to drive the full `GameAction[]` like `battle_engine.ts`'s apply loop (RAWS, NEURO, and micro all silently require this). (ii) Server: route takeover turns through `getAIStrategy(DEFAULT_AI_VERSION)` instead of legacy `AI.findTarget` (play_session.ts:1897), and AI-seat placement through `strategy.placeArmy` instead of the midline scatter (:2469). (iii) Journal: tag `actorType=AI` + `aiVersion` (the exact blocker `analyze_losses.ts` documents). (iv) **Build the persistent bot-seat / vs-AI mode** — the completeness review's biggest finding: without it, parity gains fire only on takeover slivers and no real-game data ever accrues. (v) Run the 5-minute ArangoDB AQL audit counting decisive human games — it decides whether real-loss mining is viable this quarter. (vi) Define the acceptance metric now: proposed — *v0.7 beats v0.6 by ≥+4pp full-game on the committed LiveTwin config (9 fresh seeds × 3,000, round-robin vs v0.6 AND v0.4), with per-cohort non-regression, plus a journal-replay decision-divergence check once bot-seat games exist.* Honest caveat on parity pp: audit the real fraction of turns hitting takeover/scatter/truncation before crediting the +3–6pp claim; with no bot seat it is currently small — the bot seat is what makes it real.

**F4. One enumerated candidate generator, three consumers.** Micro's capability modules, RAWS's candidate widening, and NEURO's action enumerator are the same artifact — build it once in `common/src/ai`: all legal (move, melee target×stand, shot aims, area_throw cells, every castable spell incl. MELEE_MAGIC, defend, wait) for the acting unit, candidate 0 always the incumbent v0.6 decision. This also begins the generate-then-score flattening of the override chain that Tempo Commander's team layer needs. Include morale/luck and initiative-order features in the featurization backlog — flagged invisible by the rules audit, absent from every proposal.

### (b) Big bets — the substantial win

**B1. Full-Game League (rank 1 — the only triple-strong verdict).** Keep the fight vector frozen; move optimization upstream where the proven ±15pp lives.
- *Build:* `pick_sim` mirroring the real pick phase — auto-bans 5/5/3/3, bundles [L1,L2,T1], snake order, shared exclusive pool with collision reveals, T2 3-of-12 — with the judge's key fix: **move pick-phase logic into common with injectable RNG and have the server consume it** (server uses unseedable `node:crypto`, so a parity test alone can't hold; this also makes live wiring trivial). One ~90-dim anchored chain: state-conditioned counter-draft (add canFly/hp/armor/speed + own/opponent-composition interactions to `creature_score.ts` — the flyers>ranged>ground-melee triangle is currently structurally unlearnable), augment/T2 heads seeded from the `CEM_DRAFT_AUGMENTS='2'` rule, and a discrete placement-template selector (the +5.58pp dispersion bake is the existence proof). Train vs an exploiter pool with worst-case/Nash fitness in `cem_league.mjs` — this replaces the frozen-anchor objective responsible for every documented non-transitive artifact, and should serve as the shared evaluator for B2/B3 gating too.
- *Judge fixes incorporated:* demote the vision-gated perk head (visionValue ≈ −1.06; keep anchored-at-0 and block-frozen until pick_sim measures actual collision/reveal frequency); power the oracle counter-pick kill gate to 5,000+ games; pin pick_sim parity in CI (the pick-phase redesign is still moving); add a melee-mirror control cell to the payoff matrix.
- *Expected gain:* +4–8pp full-game vs v0.6 in the live-faithful sim (honest range; mixture-only value cashes even if reveals prove sparse), plus the live wiring jump once F3's bot seat exists.
- *Compute:* kill test ~40k games ≈ 10 min local; a full league pass ≈ 3–4h on reclaimed agent-zinc, 2 passes/night.
- *Week-one kill:* the archetype payoff matrix — 5 scripted armies (melee_coevo, flyer-max, ranged-max+Sniper3, hybrid, anchor) pairwise under full live config, 2,000 games/cell. **Kill if no archetype beats melee_coevo ≥55% AND a full-information oracle counter-picker gains <+3pp (at 5,000 samples).** That would prove melee is dominant under the frozen fight AI and counter-drafting has no cashable value.
- *Dependencies:* F2 (config), F1 (node). Resolves the ship-now-vs-retrain contradiction on draft weights (see Q3).

**B2. RAWS — wide-candidate rollout search (rank 2 — the one untested in-fight vehicle).** The 2-ply "tie" is code-verified to have tested ≤5 melee-only candidates with single-sample scoring; search never saw the actions the policy can't emit.
- *Build:* generalize `LookaheadDriver` into a SearchDriver over F4's generator (alternative shots, area throws, all spells, defend, wait for all unit types — **kite/retreat cells dropped**: that candidate class is ledger-dead twice); score by N=3 paired-seed rollouts to a fixed ~12-turn horizon with the learned-value leaf (refit on ~6k fresh games, +~6 spatial features) and an override gate. Widen the `battle_engine.ts:700` version gate from v0.5 to v0.7.
- *Judge fixes incorporated:* corrected compute model — ~90–180ms per searched turn, ~4–6s/game (2–3× the original claim; the kill 2x2 still fits 4–8h local at conc 8); headline metric on `FIGHT_MELEE_ROSTERS=1`; kill gate powered to 12–16k paired games; smoke-test that headless Wind Flow/Castling effects work before spending rollout budget; validate the winner vs v0.4 and best_v06br too (opponent-model inflation guard).
- *Live path:* constrain candidates to single-primary/foldable shapes until F3's client fix ships; price inference against the **240s total-match turn budget** (constants.ts) — ship either K-capped (~K=3–4) or, preferably, distilled disagreement classes back into anchored dims via one freeze-CEM pass (the Double Shot pattern).
- *Expected gain:* honest +1–3pp on the live config, upside to +5pp concentrated in caster/ranged cohorts; prior search results (2-ply tie, 1-ply −6.7pp crater) genuinely predict par — this is a falsification-priced bet with floor ≈ one week sunk.
- *Week-one kill:* the same-day tripwire — SEARCH_AUDIT over 500 games; **if search overrides the policy on <5% of turns even at gate 0.01, the angle dies before the full 2x2.** Then the minimal wide×rollout arm: kill if ≤+0.5pp live-mix AND ≤+1pp range-heavy at 12–16k games.
- *Dependencies:* F4 (generator), F2 (config). Q1's micro modules feed it candidates.

**B3. NEURO — per-decision neural policy (conditional, gated on B2's outcome).** BC-anchored AWR over the same enumerated space, ~200k-param pure-TS MLP, per-decision labels. It attacks the same seam as RAWS with the same generator and a shared DECISION_DATA hook — per the completeness review, run it **only if RAWS's kill test shows the widened envelope carries signal but rollout scoring/representation binds**, or if RAWS wins and distillation needs more capacity than linear dims.
- *Judge fixes if triggered:* per-worker binary Float32 shards (JSONL append will corrupt at 24–60GB); specify multi-action-turn candidate semantics up front (casters on v0.6 fallback initially); power Gate A/B to ≥20k fresh-seed games; run Gate B on the committed live config, not just at bake; browser behavioral sweep at Gate A, and a one-day client execution test for defend/Resurrection before envelope widening.
- *Expected gain:* +1–3pp near-term (cap per judge), +3–6pp speculative with league generations; ~1–2 node-weeks if the generation loop runs.

### (c) Quick wins — cheap pp while the big bets train

**Q1. Repertoire modules (micro; strong/strong/promising).** Census-ranked capability additions with anchored gates: MISPLAY_AUDIT census (run under the live distribution — judge fix — and mind the `run_tournament` positional-args order), then: **M1** universal caster router, *Resurrection first* (no substitute action exists; judge corrections: the 50%-on-death trigger is a passive that already works — the cast targets living allies and burns the charge, so price that opportunity cost; Castling needs the missing `getCurrentEnemiesCellsWithinMovementRange` engine-context callback, ~1 day); **M2** Gargantuan `area_throw_attack` generator + the Area-Throw structure-occlusion bug fix; **M3** rider-EV terms (Medusa petrify kill-EV, paralysis/stun denial, Devour-Essence kill-secure, Troll burst-focus, charge path-length term — currently the AI optimizes *against* Champion/Nomad kits); anti-flyer screen bit. **M4's plink-vs-close half is dropped** (overlaps the near-tapped reposition seam). Then one freeze-CEM pass on only the new dims (~8–12 effective, restoring selection signal above the 1pp floor). Validate cast_spell/area_throw through the actual *ranked* server path (the obstacle_attack world-pos precedent makes this mandatory) and land the pending spell_amounts/aggro sync fixes first. Replace the 0%-floor flyer-vs-ranged falsifier with a 20–80%-baseline cohort. *Realistic gain:* +1–3pp live-weighted (M1 dominant; Gargantuan/Medusa modules mostly move cohort panels), a week of Mac-local work. *Kill:* if the top-3 census gaps sum to <1.5% of unit-turns, the angle dies in two days.

**Q2. Tempo Commander probe (Gates 0–1 only).** The tempo axis produced the biggest win ever and joint wait-sets have verifiably never been in any candidate space (lookahead stops at the first enemy reply). Build the act-vs-wait lap-rollout oracle as a **driver-level interception** (strategies lack engine access — judge fix), roll through hourglass-queue resolution (else the wait branch never sees its payoff), and run the lap-horizon-vs-first-reply ablation first — if horizon doesn't change wait choices, the 2-ply tie *does* bound this and it dies for ~zero compute. Decide on pooled totals (~27k games, SE ~0.3pp), melee-heavy cohort decisive; pre-register a draw/armageddon ceiling and sweep the alreadyHourglass desync seam. **Gate-2's deterministic kill-plan bias is demoted** — it is structurally the 2026-07-09 tactical-dart pattern; revive only if the wait oracle shows life and prefer letting rollouts price kill-denial implicitly. *Gain if alive:* distilled-policy number only (+1–3pp honest; oracle numbers are an upper bound). Runs in days on the Mac; sequence its joint-set phase after F4's flattening.

**Q3. Ship the upstream stack live — after pick_sim validation.** The trained draft champion beats the live server's untrained heuristic 97.6%, `pickBundle` contradicts the draft direction, T1/T2 tables are composition-blind — but the pick-phase redesign changed the landscape those weights were trained on, so blind shipping risks an augCA-style reversal. Resolution (per the completeness review): validate melee_coevo inside B1's pick_sim (week 2–3), then ship `scoreCreatureWeighted` into `pick_decider.ts`, unify the bundle scorer, and add the cheap conditional T1/T2 fit terms. Also wire the Placement zone-size augment into the AI action space (currently human-only) and let League price it.

### Recommended sequence

| Week | Do |
|---|---|
| 1 | F1 node reclaim; F2 config + distribution kill test; F3(i–iii) parity fixes; B1 archetype payoff matrix; Q2 Gate-0 ablation; ArangoDB data audit |
| 2 | F4 generator; B1 pick_sim (in common); Q1 census + M1 Resurrection; RAWS SEARCH_AUDIT tripwire; F3(iv) bot-seat design |
| 3–4 | B1 league training on agent-zinc; RAWS kill 2x2 → tune or kill; Q1 M2/M3 A/Bs + freeze-CEM; Q3 draft-weight validation → live ship |
| 5+ | B1 bake per protocol; RAWS distill-or-ship under the 240s budget; B3 NEURO only if B2's evidence warrants; journal-replay pipeline once bot-seat games accrue |

---

## 4. What NOT to do

Dead levers — re-running any of these burns the compute the roadmap needs:

- **Single-anchor fight-vector CEM** (56–58 dim): fresh-seed gains sign-flip at +0.16pp; best-response wins are non-transitive.
- **The agent-zinc keepalive 58-dim run**: panel gains always overfit — kill it, don't extend it.
- **Placement CEM on the 13-dim geometric seam**: trained twice, zero panel gain; the family can't express screening/corner camps (templates and rollout placement are different objects).
- **augCA composition-aware augments as trained**: +1.6pp was a free-vision/random-roster sim artifact; −1.3pp live. Never bake; never train setup on `cem_augca_eval` defaults.
- **Augment micro-tuning under melee+SEE_NONE**: blind Armor3+Might3+Sniper1 is already optimal for the current deployment distribution.
- **Kiting as a rule** (crude hold and safe-frontier): dead twice; kiting may only emerge from ≥2-own-turn search, not from a one-turn rule — and is excluded from RAWS's candidate classes.
- **Unit splitting for ranged**: melee wins 92.2%; concentrated stacks win.
- **Situational synergy picker**: anchor table never beaten in 3h of training.
- **Hourglass threshold refinements** (kill/retal exclusions, wait-on-in-place): neutral to −5pp; only the *joint/lap-horizon* question (Q2) is open.
- **Shallow value-guided search as previously configured** (1-ply rerank, 2-ply over ≤5 melee candidates): craters or ties; only the wide-candidate rollout regime (B2) is untested.
- **The three 2026-07-09 tactical darts** (offensive debuffs, luck-aura weighting, Ogre Mass Magic Mirror) and manual sim darts generally: the fight AI is at ceiling for hand-perturbations of converged decisions — Tempo's Gate-2 kill-plan is demoted for exactly this reason.
- **All-melee specialist fight training**: +0.5pp melee, −4.6pp random — fragile.
- **Any sim pp claimed off the committed live config**: random rosters, free vision, {50,30,15,8} stacks, or full-action execution assumptions have each already converted a "win" into a live regression. No bake without the LiveTwin headline, fresh-seed round-robin vs v0.6 *and* v0.4, cohort non-regression, and owner sign-off.

The through-line for future sessions: **"tapped" means tapped for the current feature set, action envelope, opponent pool, and environment.** Change one of those four (as every workstream above does) and measurement is warranted; change none and it isn't.

---

## Appendix: completeness critique

Spot-checks done (server `play_session.ts` aiControlled paths, `constants.ts` timers, git state, `src/scripts/analyze_losses.ts`). Findings:

## GAPS — nobody proposed / nobody read

1. **No live AI opponent exists.** `play_session.ts` inits every player `aiControlled: false` (:409/:417); it flips true only on timeout/disconnect (:998, :1763) and **clears on any accepted action** (:826, :2913). There is no bot seat, no vs-AI matchmaking. The "tens of pp in AI-filled live games" claims (draft map, League, LiveTwin) have no live consumer beyond takeover slivers. The single biggest unproposed item: **build the persistent bot-seat / vs-AI mode** that lets v0.7 actually fight humans — also the only way to generate the real-game data three proposals depend on.
2. **No acceptance metric or data-volume audit.** Every gate is sim-side. Nobody defined what "substantially better" means live (N ranked games vs humans? playtest protocol?), and nobody counted decisive human games in ArangoDB — a 5-minute AQL query that decides whether real-loss mining is viable at all. Note: `analyze_losses.ts` (commit 23c3441) **already exists** and documents the blocker — journal logs AI-takeover turns as `actorType HUMAN`. Proposals scoping "build the loss miner" should start there; LiveTwin's additive journal marker is exactly its stated missing piece.
3. **Turn-timer budget unread.** `constants.ts:51-53`: 12s min / 60s max per turn, but only **240s TOTAL per match**. RAWS inference rollouts (~4-6s/game sim cost) and draft-map lever 7 (L3/L4 rollout picks) were never priced against the shared 240s pool for server-executed AI turns.
4. **Compute plan.** agent-zinc still runs the persistent 58-dim CEM whose panel gains are "always overfit" (ledger). Nobody proposed killing it to fund NEURO/RAWS/League, which all assume the node.
5. **Morale/luck economy + initiative RNG** — flagged invisible by rules-surface; absent from every proposal's feature set.

## CONTRADICTIONS between readers

- **Draft ship-now vs retrain-first:** draft map lever 1 says ship melee_coevo weights live (S, "tens of pp"); ledger lever 6 says those weights were trained on the OLD uniform-offer proxy and the pick-phase redesign changed the landscape. Shipping unvalidated weights into the new bundle/snake flow risks an augCA-style reversal. League's live-faithful pick sim resolves this — sequence it before any weight ship.
- **What is v0.6's fight vector:** fight-core says "byte-for-byte v0.5"; ledger says BESTMIX (+0.97pp) is baked. One is wrong about DEFAULT_V06_W.
- **Search prognosis:** fight-core (+5-15pp plausible) vs ledger ("long shot"; 1-ply craters −6.7pp — evidence the *leaf* is bad, which RAWS's N=3 shallow rollouts only partly fix).
- **Placement live value:** placement map implies 2-5pp from wiring `placeArmy`; LiveTwin's verdict notes it fires only on takeover. Magnitude hinges on gap #1.

## COMBINATIONS

- **Shared prerequisite, build once:** all six need the committed live-faithful eval config (exp-budget stacks, melee cohorts, SEE_NONE, FIGHT_MELEE_ROSTERS). Land it week 1 as common infra, plus the client multi-action execution fix (S) that RAWS/NEURO/micro all silently require.
- **One enumerated candidate generator, three consumers:** micro's capability modules, RAWS's candidate widening, and NEURO's action enumerator are the *same artifact*. Build it once; micro A/Bs it greedily, RAWS searches over it, NEURO trains on it.
- **League as the shared evaluator:** League's exploiter pool + Nash fitness should replace the frozen anchor for RAWS/NEURO gating too (kills the non-transitivity trap flagged in Tempo's verdict).
- **Conflicts:** NEURO vs RAWS compete for the same seam and compute — gate one on the other's kill test. Tempo Commander's team layer conflicts with per-unit `decideTurn` unless fight-core's generate-then-score flattening lands first.
- **Coherent sequence:** parity wiring + eval config (LiveTwin) → generator + micro modules → RAWS search → League full-game training; NEURO only if RAWS's leaf proves insufficient.
