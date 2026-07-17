# v0.7 non-fight 11-hour campaign preregistration

Recorded before the first scored campaign run on 2026-07-16. This is a
research-only search for a stronger composed v0.7 policy. It does not authorize
changing a ranked default, baking a candidate, or deploying a server.

## Incumbent

- Draft: `league-r1-br-57de5a2d`, projected to the 15 intrinsic weights that the
  ranked ship path consumes.
- Setup: `CONDITIONAL_SETUP_V1=all`, including its own-roster Tier-2 and augment
  rules, plus the current fixed synergy table.
- Placement and combat: v0.7, persisted creature order, legitimate pick reveals,
  `SEE_NONE`, and search off unless both arms explicitly enable the same setting.
  Placement candidates target the corrected server-main lifecycle in which a
  successful Placement augment re-runs the versioned bot placement strategy in
  the expanded zone (`heroes-of-crypto-server` commit `a03dece30b05852694d569a0c5c17aa993e54c2d`).
  The earlier delayed-setup 3-wide behavior is retained only as a legacy
  diagnostic and is not promotion-eligible.
- Maps: the live equal-probability set only: `NORMAL`, `LAVA_CENTER`, and
  `BLOCK_CENTER`. `WATER_CENTER` is disabled and is excluded. The simulator's
  `Grid` and `FightProperties` must carry the same registered map type.
- Initial source revision: `31a92cef9014d8deba8d699d6ba8b2e07e5a8d53`.
  The launched campaign records the final pushed revision that contains its
  harnesses and runs from a clean clone of that exact revision.

## Search lanes

1. **Draft:** optimize only the 15 deployable intrinsic draft weights. Candidate
   and incumbent occupy opposite seats in the same real `pick_sim`; every offer
   board is replayed with seats swapped. Non-draft heads are projected to the
   incumbent and cannot earn fitness.
2. **Setup and placement:** keep the accepted draft on both sides and search
   own-roster-only setup plans. The panel includes Tier-2 artifact ordering,
   synergy choice, augment plans (including Movement and Placement), and
   placement behavior. Placement plans are scored against the corrected
   server-main expanded-zone lifecycle. Unsupported opponent information is
   forbidden.

The two lanes share at most the M4 Max's 12 performance cores. The already
running Zinc combat campaign is not modified and receives no competing workers.

## Evidence separation

Each lane uses three deterministic, non-overlapping seed domains:

- **training:** may influence optimizer updates;
- **selection:** may choose among checkpoints, so it is not final evidence;
- **final guard:** is not evaluated until optimization has stopped.

All comparisons use paired same-board seat swaps and treat the pair, not each
fight, as the independent cluster. Reports include wins, losses, draws, decisive
win rate, paired-cluster 95% confidence interval, laps/end reasons, and rejected
actions by arm. The ranged, mage, melee-magic, and aura guard tags are inclusive:
one matching own-roster creature is enough to enter the corresponding cohort.
A control comparison must reproduce symmetry before a candidate can be
considered.

## Promotion bars

An overnight artifact is only an eligible research candidate when all of these
hold on the untouched final guard:

- decisive win rate is above 50% and the paired-cluster 95% lower bound is above
  50%;
- candidate-side rejected actions are zero and no invalid/failed game is omitted;
- no registered composition cohort has a point estimate below 49.5% or a 95%
  lower bound below 48.0%;
- no live map has a point estimate below 49.5% or a paired-cluster 95% lower
  bound below 48.0%;
- the policy is expressible using information available to the ranked bot and
  the serialized candidate contains only heads the production seam consumes;
- a deterministic replay sample is byte-identical, including placement and the
  complete executed action trace rather than only the final outcome.

Passing these bars permits a review and a separately committed candidate
artifact. It does not automatically flip configuration or deploy. A failure is
retained as evidence and does not change the incumbent.

## Operations

- Wall-clock budget: 11 hours from supervisor launch, with an exact recorded
  deadline.
- Supervisor outputs: `run.json`, heartbeat, per-lane logs/checkpoints, and a
  terminal marker. Outputs live outside the source checkout.
- The supervisor stops both process trees at the deadline, preserves partial
  checkpoints, and never writes production policy files.
- Sleep prevention is owned by the detached campaign process; successful launch
  requires advancing heartbeats and the expected worker count after detachment.

## Pilot interruption amendment (2026-07-16)

Run `9cd9f708-e691-4649-a022-f8f16f89a5a4` started from clean commit
`9e3d5ce2da9ab661abe2d81abcc46486de939c2f` at 22:40:57 PDT. It was stopped
cleanly at 22:53:52 PDT and its signed terminal artifact records
`interrupted_research_only`. This run is pilot evidence only and none of its
selection or guard panels may qualify a policy.

The pilot exposed deterministic engine-declined v0.7 commands on the live
`LAVA_CENTER` and `BLOCK_CENTER` maps. The absolute-zero rejection bar above is
not relaxed. A replacement run may start only after the underlying legality
defects have exact-seed regressions and the pilot's frozen 6,400-game validation
panel reports zero rejected actions for both arms.

The replacement run uses seed domains disjoint from every pilot draft domain:

| Purpose                     | Replacement base | End exclusive |
| --------------------------- | ---------------: | ------------: |
| Draft training reserve      |       50,331,648 |    52,131,648 |
| Draft selection             |    1,627,389,952 | 1,627,394,752 |
| Draft final guard           |    3,238,002,688 | 3,238,026,688 |
| Draft targeted cohort guard |    3,556,769,792 | 3,604,769,792 |
| Draft deterministic replay  |    4,043,309,056 | 4,043,309,068 |

The replacement setup base is `623981622`. Relative to pilot base `87110710`,
this advances each top-bit-separated setup panel by exactly `2^29` positions in
its full-period modulo-`2^30` permutation. The replacement is capped at 12
search passes; even the harness's maximum scan allowance keeps every replacement
cursor below `2^29` (training 24,576,000; selection 393,216,000; guard
32,780,292). The stopped pilot remained at pass 0 with cursors 288,997,
65,123, and 0 respectively. The two setup streams therefore cannot overlap.
The replacement draft CEM seed is `1506473542`.

The replacement supervisor's hard deadline must be no later than the original
09:40:57 PDT deadline. Diagnosis and repair time consumes search time; it does
not extend the 11-hour wall-clock budget. All other search surfaces, worker
limits, promotion bars, and the no-bake/no-deploy rule remain unchanged.
