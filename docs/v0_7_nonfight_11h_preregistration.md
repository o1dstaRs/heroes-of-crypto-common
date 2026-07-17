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
   placement behavior. Unsupported opponent information is forbidden.

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
actions by arm. A control comparison must reproduce symmetry before a candidate
can be considered.

## Promotion bars

An overnight artifact is only an eligible research candidate when all of these
hold on the untouched final guard:

- decisive win rate is above 50% and the paired-cluster 95% lower bound is above
  50%;
- candidate-side rejected actions are zero and no invalid/failed game is omitted;
- no registered composition cohort has a point estimate below 49.5% or a 95%
  lower bound below 48.0%;
- the policy is expressible using information available to the ranked bot and
  the serialized candidate contains only heads the production seam consumes;
- a deterministic replay sample is byte-identical.

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
