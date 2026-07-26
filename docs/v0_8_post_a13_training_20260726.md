# v0.8 post-A13 creature training preregistration

Recorded before the first scored run on 2026-07-26. This is a research-only combat-search
fine-tuning campaign. It cannot bake, promote, or deploy a policy automatically.

## Why a new panel is required

Production A13 was trained from common commit
`80059c9f34d918285eeb996589c9e3335efc240a`. Twelve playable creatures were added after
that source snapshot:

- L1: Mermaid, Dryad, Blacksmith, Ash Moth
- L2: Wyvern, Trent, Manticore, Battle Mage
- L3: Zena, Monk, Nightmare
- L4: Magic Dragon

The live-faithful tournament uses the deployed melee-weighted draft. On the historical
256-game screen seed, Battle Mage, Dryad, Magic Dragon, Monk, and Zena never appear;
several others appear only once. Four of those five are structurally unreachable under
the current top-of-offer draft rule, so increasing the number of candidate genomes does
not create coverage: every candidate reuses the same roster panel.

The new forced panel therefore gives each of the twelve creatures its real level slot,
uses a pre-A13 same-level control on the other army, balances target ownership between
candidate and opponent, and swaps physical sides. Three pairs per lane give each
unit/owner combination one paired observation on each live map: NORMAL, LAVA_CENTER,
and BLOCK_CENTER. WATER_CENTER remains excluded because it is not a live ranked map.
The exact lane/seed/map/physical-seat schedule is hashed, and every persisted lane keeps
its per-map and per-seat census.

## Incumbent and search

- Exact incumbent: current production `V08_A13_GENOME`, not the historical r3 test
  candidate.
- Base search: the reviewed 48-genome v0.8 catalog plus the exact A13 incumbent.
- Adaptive search: 24 deterministic children from four screened parents. All 49 base
  arms run the twelve-creature panel before those parents are selected; all 24 children
  run the same common-random panel before the level-4 reserve is selected. The A13 arm
  includes a melee-targeting ablation, the reviewed ranged finish alternatives, a
  lower gate, and leaf blends.
- Live fitness: paired `v0.8s` versus `v0.7` LiveTwin fights on the three live maps.
- Safety gates: the existing four-creature level-4 panel plus the exact twelve-creature
  post-A13 panel. The new panel requires complete lane/seat/map census, target turns,
  no candidate-side engine rejections, and no rejected or raw passive decisions by a
  candidate-owned target. Every searched arm must actually cast at least one remaining
  spell from each candidate-owned spellcaster lane; the deliberately search-inactive
  c37/c38 control is retained as a control without that requirement. Post-A13
  Armageddon rate must not regress against exact A13 on the identical panel (an
  absolute 0.1% gate would be invalid for these intentionally symmetric forced fights).

The balanced post-A13 outcomes contribute to parent selection, reserve selection, and
pre-validation candidate ranking; they are not telemetry-only. Per-unit outcomes are
retained for audit, while the strength comparison is pooled: twelve games per unit are
too noisy for twelve simultaneous point-estimate non-regression gates.

Every selected parent and validation shortlist is bound to the exact ordered job specs
and result hashes that produced it, not only to aggregate win rates. Each completed job
also commits byte hashes for its runner summary and JSONL records. Resume rejects a
missing or changed source artifact. An exclusive output-directory lease prevents two
orchestrators from writing the same checkpoint, and a post-deadline resume may reconcile
already-finished artifacts and commit a complete validation round but may not launch any
new work.

Before training, candidate/engine differential tests also close the newly exposed
action paths: Blacksmith Craft areas are enumerated without equivalent-recipient
duplicates; Trent Vine Throw and thrown damage spells respect line of sight; Fire Wall
keeps orientation identity and edge fallbacks; meteor spells include large-unit
footprints; and every custom targeted spell now passes the authoritative visibility,
team, immunity, and target-legality gate before dispatch.

## Fresh seed allocation

The following decimal uint32 seeds were absent from every searchable file under
`/Users/zolotukhin/Workplace` when preregistered:

- screen: `1726072601`
- legacy level-4 safety: `2026072601`
- post-A13 creature coverage: `2326072601`
- validation: `2626072601`

Smoke tests use separate seeds and cannot spend these panels.

## M4 Max run

The scored run must start from an immutable clean clone of pushed `origin/main`. The
manifest records the exact commit, tree, Bun runtime, campaign inputs, and candidate
identities. Source identity is checked again before every child job.

Resume fails closed if the prior orchestrator died while a child was still live or
before its PID was durably recorded. The latter rare `pid: null` state requires manual
process inspection before clearing that one checkpoint active-job record; it is never
guessed away automatically.

```bash
bun src/simulation/v0_8_aggressive_12h.ts \
  --output /absolute/path/to/results \
  --hours 12 \
  --concurrency 12 \
  --lanes 3 \
  --screen-games 256 \
  --validation-games 1024 \
  --top 8 \
  --l4-pairs 16 \
  --coverage-pairs 3 \
  --screen-seed 1726072601 \
  --level4-seed 2026072601 \
  --coverage-seed 2326072601 \
  --validation-seed 2626072601 \
  --unbounded-search
```

Unbounded search keeps model selection deterministic across host load, but its winner
is not deployable. Any retained genome must be replayed against the exact A13 incumbent
under the production 175 ms decision deadline and 275 ms circuit breaker, then pass
fresh ranked, cohort, deterministic-replay, rejection, stuck-game, and latency gates.

## Deliberate scope limit

This campaign fine-tunes combat search and can interpolate the existing 60-value leaf;
it is not a from-scratch leaf fit. It also does not retrain the ranked draft, artifact,
augment, synergy, or placement policies. Those need a separate non-fight campaign with
new mechanic-aware draft features before any claim that the whole ranked AI has been
retrained for these creatures. Fire Wall orientation is now distinct in the search
action identity, but the older IL-v3 action-feature corpus still omits that orientation;
changing it requires a separately versioned IL schema/corpus migration and is not
silently mixed into this campaign.
