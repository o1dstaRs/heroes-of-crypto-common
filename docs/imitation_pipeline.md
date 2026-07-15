# Imitation-learning pipeline (search → distilled policy groundwork)

**Status: data infrastructure only. Nothing here changes any AI strategy's behavior.** Every knob is
env-gated and default-OFF; the fit output is a report artifact. Wiring a distilled policy into a strategy
(v0.7 decision logic, search tuning, the wait scorer) is fight-policy territory owned by the peer session —
any such change must be coordinated there and measured under the standard ship bar (LIVETWIN paired
side-swap, both draft distributions, >= +1pp pooled with no cell below −0.5pp).

## Why

The B2/RAWS rollout search (`src/simulation/search_driver.ts`) beats the plain v0.7 policy by re-scoring
the F4 enumerated candidate set with paired-seed rollouts — but at ~50–500 ms per decision it is a
sim-only oracle, not a live policy. The cheap path to converting search gains into live gains is
**imitation**: log every searched decision (state, candidate set, search's choice), then distill a fast
scorer that predicts the search's choice from enumeration-time features alone. This document is the
committed end-to-end recipe: corpus → extraction → baseline imitator → (peer-coordinated) deployment seam.

## 1. Corpus generation (`SEARCH_IL_DATASET`)

`SEARCH_IL_DATASET=<jsonl path>` (search mode `V07_SEARCH=1` only; ignored in oracle/ablation modes) makes
the SearchDriver append one JSONL row per **searched** decision (>= 2 candidates after class filtering),
buffered per game and flushed in `onMatchEnd`. Row schema and the strict parser live in
`src/simulation/il_dataset.ts` (`t:"ild", v:1`):

- `wf` — the 41-dim wait-scorer state vector (`ai/versions/wait_scorer.WAIT_FEATURE_NAMES`), extracted on
  the live pre-rollout state with the incumbent's actions (same extractor the deployed scorer uses).
- `vf` — the 60-dim deployed V2 value basis (`simulation/value_features.VALUE_FEATURE_NAMES_V2`), acting
  team's perspective.
- `cands[]` — every scored candidate: `kind` (F4 class, `incumbent` for candidate 0), `ck` (action class
  via `classifyActions`), `sig` (semantic action signature — dedupe identity minus the presentation-only
  `select_attack_type` token), `cf` (the 11 F4 enumeration-time features, `IL_CANDIDATE_FEATURE_NAMES`
  order), `m` (mean rollout leaf value; `null` = illegal in simulation).
- `chosen` — index of the search's final selection (0 = incumbent kept), `ov` — override flag,
  `act` — the chosen action list verbatim, `k` — the incumbent's action class, `nc` — enumerated
  candidate count before any shortlist.
- `cfg` — search provenance (gate/horizon/rollouts/leaf/shortlist/includeMoves/oppModel).

Decisions abandoned by `SEARCH_DECISION_DEADLINE_MS` produce no row (no comparable scores exist).

### The committed corpus recipe (run 2026-07-15)

v0.7+search **self-play** (both seats searched — on-policy for the search-play distribution) under
LIVETWIN, three roster cohorts (roster-cohort discipline: melee/mixed/random), pre-registered seeds:

```sh
cd heroes-of-crypto-common && mkdir -p sim-out/il_dataset
# melee (LIVETWIN default FIGHT_MELEE_ROSTERS=1): 1200 games, seed 83301710
LIVETWIN=1 V07_SEARCH=1 SEARCH_VERSIONS=v0.7 \
  SEARCH_AUDIT=$PWD/sim-out/il_dataset/melee.audit.jsonl \
  SEARCH_IL_DATASET=$PWD/sim-out/il_dataset/melee.ild.jsonl \
  bun src/simulation/run_tournament.ts v0.7 v0.7 1200 83301710 sim-out/il_dataset 6
# mixed (FIGHT_MELEE_ROSTERS=0.5): 400 games, seed 83302710   — same command, env override
# random (FIGHT_MELEE_ROSTERS=0): 400 games, seed 83303710    — same command, env override
```

Search config = the committed defaults (gate 0.01, horizon 12, rollouts 3, committed learned 20-dim leaf).
Cost: ~7.5 s CPU per game — 2,000 games in well under an hour at concurrency 6.

## 2. Extraction (`optimizer/extract_il.mjs`)

```sh
bun src/simulation/optimizer/extract_il.mjs out=sim-out/il_dataset/rows.jsonl \
  melee=sim-out/il_dataset/melee.ild.jsonl mixed=sim-out/il_dataset/mixed.ild.jsonl \
  random=sim-out/il_dataset/random.ild.jsonl
```

Validates every dump row (`parseIlRow`; torn/truncated lines are dropped and counted, never silently
kept), writes one fit-ready training row per decision (`{c, s, side, lap, unit, cls, chosen, agree, wf,
cands:[{ck,sig,cf}], m}`) and prints the dataset stats: decisions/games per cohort, candidate-count
quantiles, class balance of the search's chosen action, and the **v0.7-policy-agreement baseline**
(`agree` = the chosen candidate's semantic signature equals the incumbent's — how often plain v0.7
already plays the search's choice; 1 − agreement is the imitation headroom).

## 3. Baseline imitator (`optimizer/fit_il.mjs`)

```sh
bun src/simulation/optimizer/fit_il.mjs rows=sim-out/il_dataset/rows.jsonl epochs=200
```

A **conditional logit** (multinomial logistic over each decision's candidate set — the `fit_*.mjs` house
style, full-batch GD + L2, split by game seed): `z_i = w·phi(candidate_i)`, softmax across the decision,
cross-entropy on the search's chosen index. Two fits:

- **A: candidate-only** (21 dims) — `isIncumbent`, action-class one-hot, the F4 economy features
  (morale/luck deltas, hourglass/shot/spell-charge/res-charge spends), `expectedKill`, and two
  `expectedDamage` transforms (within-decision max-normalized + log).
- **B: A + class-group × state** (51 dims) — adds {attack, spell, wait, defend, move} group interactions
  with a curated slice of `wf` (hpAdv, rangedAdv, lapNorm, enemyExposed, fmExposure, nearEnemyDistOurs).

Evaluation is top-1 with **semantic-signature credit** (predicting any candidate that plays the same turn
as the search's choice counts), reported pooled / per chosen-action class / per cohort / on the
overridden-only subset, against two baselines: *always-incumbent* (= the v0.7 agreement rate) and
*max-expectedDamage*.

## 4. Results (corpus 2026-07-15, seeds 83301710/83302710/83303710)

**Corpus COMPLETE**: 2,000 games (melee 1,200 / mixed 400 / random 400, paired seat-swap ⇒ 1,000 distinct
combat seeds), conc 6, ~19 min wall. Dumps + manifest under `sim-out/il_dataset/` (gitignored; commit
`5d34d48`, clean worktree). Note: the first attempt at this run was launched detached from a prior session
and died at 250/2,000 games when that session ended — not a natural completion. Re-run from scratch (same
preregistered recipe/seeds, no new seeds burned) for this record; `sim-out/il_dataset/` was cleared first
so no partial-run rows leaked into the corpus below.

**`extract_il.mjs`** (153,988 rows total):

| cohort | decisions | games | overrides | v0.7-agreement | candidates (mean / p50 / p95 / max) |
|---|---|---|---|---|---|
| melee  | 83,424 | 1,200 | 49.23% | 50.77% | 5.5 / 5 / 11 / 16 |
| mixed  | 31,890 |   400 | 51.45% | 48.55% | 6.0 / 6 / 11 / 24 |
| random | 38,674 |   400 | 52.12% | 47.88% | 6.1 / 6 / 12 / 26 |

Pooled v0.7-policy agreement (imitation headroom baseline): **49.59%** — self-play search overrides the
plain v0.7 incumbent on very close to half of all searched decisions, consistent across all three roster
cohorts (47.9–51.0%) and matching the 8-game smoke's ~51% estimate closely. Chosen-action class balance:
melee 35.5%, wait 25.4%, defend 15.4%, move 13.6%, shot 5.5%, spell 3.2%, idle 1.2%, area_throw 0.3%.
`defend` and `area_throw` never appear as the incumbent's own class (0.00% agreement whenever search picks
them) — the search invents both from scratch; the incumbent v0.7 policy has no direct route to either.

**`fit_il.mjs`** (train/test split by seed, 129,358 / 24,630 decisions, semantic-signature top-1 credit):

| chooser | pooled | overridden-only | melee | mixed | random |
|---|---|---|---|---|---|
| always-incumbent (= agreement baseline) | 50.32% | 0.00% | 50.58% | 49.07% | 51.00% |
| max-expectedDamage | 32.49% | 13.01% | 32.13% | 32.08% | 33.85% |
| **A** candidate-only conditional logit (21 dims) | 49.94% | 1.21% | 50.48% | 49.03% | 49.53% |
| **B** A + class-group × state (51 dims) | 49.74% | 1.27% | 50.34% | 48.96% | 49.00% |

**Honest result: the linear baseline imitator does NOT beat "always trust v0.7."** Both A and B land
within noise of (fractionally below) the always-incumbent baseline, and both collapse on the
overridden-only subset (1.2–1.3% — a linear model in these features essentially cannot predict *when*
search will override, only mildly re-rank within the incumbent-agreeing majority). The max-expectedDamage
heuristic is confirmed much worse (32.5%), which is a useful sanity check on the harness (a bad baseline
scores clearly lower, not a wash). The real headroom is genuine (≈50% of decisions), but capturing it needs
a model expressive enough to separate the override/no-override boundary — a linear conditional logit over
these 21–51 features is not that model. This result is a report artifact only; nothing here changes any
strategy's behavior. Full stats and fitted weights are printed by the commands in §§2–3 above; rerun against
`sim-out/il_dataset/rows.jsonl` to reproduce.

## 5. Where a distilled policy WOULD plug in (peer-coordinated; NOT done here)

Two seams, both already anchored on "candidate 0 = incumbent" so an imitator that always ranks the
incumbent first reproduces shipped behavior byte-for-byte:

1. **Search cost control** — `SearchDriver.shortlistCandidates` currently pre-scores candidates with one
   immediate-leaf rollout each; an imitator scoring `phi(candidate)` is ~free and could replace or gate
   that pre-pass (`SEARCH_SHORTLIST` semantics unchanged), cutting the per-decision budget the live
   circuit breaker has to cover.
2. **A distilled override stage** — the wait-scorer lineage (Q2 oracle → `fit_wait.mjs` →
   `V07_WAIT_WEIGHTS`) generalized from {act, wait} to the full candidate set: at the end of
   `decideTurn`, enumerate + score with the imitator and override when the top candidate clears a gate.
   This is exactly the wait-scorer's anchor pattern (env-gated weights, all-zero = anchor), but it is a
   fight-policy change: it belongs to the peer session and must clear the standard ship bar (LIVETWIN
   paired side-swap, live-heuristic AND league-champion draft distributions, >= +1pp pooled, no cohort
   cell below −0.5pp).

History guards that bind any deployment attempt: composition-aware anything trained with free vision is
the augCA trap (this corpus is SEE_NONE end-to-end — the state features only see the board, never the
hidden enemy draft); blanket wait-more rules are pre-refuted (the imitator must stay a per-decision
classifier); measure per-cohort, never pooled-only.
