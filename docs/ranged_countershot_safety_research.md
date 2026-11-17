# Ranged counter-shot decisions after a human test match

This is an offline combat investigation prompted by the November 17 test-server match
`f463cd7b-b728-4edf-b925-b4cf27335fef`. It does not change a serving profile or learned weights.

The complete public replay shows a Centaur attack dealing 24 combined HP damage while its remaining
stack dies to the Arbalester's response. The terminal replay contains every public board and action,
but not the original private RNG state or search scores. Public HP, maximum HP and stack power are
rounded on the wire. Do not describe a reconstruction from those snapshots as an exact internal replay.
The deployed common revision was `c0bad9439b408fa2d36756933c1442279ff73c04`; the new comparison uses
the current adopted v10 profile, frozen at `997490ee10c64f7379396c869c4d7976fddb04dc`, with server
`51b2f9530d28557337a0acd62b6d65d3f86b8837`.

## Fixed policy screen

`ranged-countershot-safety-20261117-pilot-v1` uses the existing two full-search samples. It intervenes
only when both samples kill the ranged actor and enemy XP damage is less than one quarter of allied
XP lost. The alternative must already be fully scored, survive both samples, deal positive enemy XP
damage with no greater allied loss, and have a full-search mean at least as good as the original choice.
Rank alternatives by full-search mean, immediate net XP, then original catalog order. No extra search
samples, candidate slots, model inference or random draws are added. This is a narrow exchange guard,
not a ban on sacrifices or a new forecast model.

The fixed screen contains 54 fresh natural ranked drafts with a ranged unit on both teams: three maps,
all nine own/opponent doctrine pairs, and both pick orders. Two physical seats and two combat futures
produce 216 matched cases, or 432 battles. Both arms retain current draft, fully funded native Setup,
splits, placement, search and accepted neural models. The control contains identical passive observers.
An off/observer smoke reproduces the entire battle exactly; its actions, events, health and observations
also reproduce exactly on the local Mac and the 9800X3D Linux host. Both resolve the same capsule-owned
common RNG function and fight-state constructor as the copied server.

The primary statistic is the equal-weight whole-family mean score difference, with scores 0, 0.5 and 1.
The 95% interval uses 20,000 whole-family bootstrap resamples, xorshift32 seed `17112026`. The fixed
screen gate requires at least +0.5 percentage points, a positive lower interval bound, six changed
families, and no map or doctrine mean below -2 points. Even a passing screen requires independent
fresh confirmation and quiet runtime validation before any strength or serving claim.

Execution uses two nice19 workers per host, assigning even family indices locally and odd indices to
the 9800X3D host. No other jobs are stopped or reprioritized. The fixed cutoff is November 17,
21:18:15 UTC. No incomplete-bank promotion, outcome-dependent extension or policy retuning is allowed.
Three fixed cases are replayed cold after collection.

## Separate one-decision diagnostic

Before opening the screen's battle outcomes, a separate diagnostic was registered. After the whole
screen completes, inspect every baseline case and select its first qualifying fatal low-return ranged
decision with a surviving, non-losing ranged alternative. Use the same deterministic ranking but omit
the forecast floor. Change that one decision only, then continue the default AI on the same combat
future. Include every eligible case regardless of final result; at most one branch per case.

Require exact root observations, identical full action prefixes, legal actions and a valid health
ledger. These reused-bank counterfactuals can distinguish useful sacrifices from bad decisions, but
cannot qualify a new policy or rescue a failed fresh screen. They are separate from the peer's forecast
model-mixture qualification and do not modify its source, seeds or workers.

## Reproduction and seed reservation

The ignored client capsule is `game/core/tmp/ranged-countershot-safety-20261117`. It contains frozen
committed source archives, capsule-owned dependencies, registration hashes, full traces, health ledgers,
worker logs and read-only analysis scripts. Historical research capsules remain unchanged.

Exclude all 20,480 scanned SHA-256-derived preimages in namespace
`ranged-countershot-safety-20261117-fresh-v1`, including rejected and unused ones. For each counter
1 through 20,480, interpret the first four SHA-256 bytes of `namespace:counter` as unsigned little-endian;
reserve 32 consecutive unsigned raw channels and their native `permuteRankedDraftSeed` channels. The
allocator checked 189 existing evidence ledgers, including every scanned peer-mixture qualification
preimage. The development smoke is descriptive and is not counted as fresh evidence.

## Completed results

All 432 screen battles and six fresh-process repeats completed. Both arms scored **102 wins,
5 draws and 109 losses**, with all 216 paired final outcomes identical: **0.00 percentage points**.
The guard changed nine trajectories across six families. It did not pass the gain or confidence gate.
The bootstrap is mechanically [0, 0] because every observed paired delta is zero; that degenerate
interval is not proof of zero risk or zero effect on future games. Do not promote this rule.

The baseline recorded 2,244 ranged decisions, including 17 two-sample fatal low-return exchanges.
Fourteen cases across 11 families qualified for the separate one-shot diagnostic. Every rerun matched
the complete action prefix and root observation, then changed only the registered shot. Results were
**three better, zero worse and eleven unchanged**: Orc and Beholder changed draws into wins, and Zena
changed a loss into a win. In all three, the safer shot's full forecast was 0.25 below the sacrificed
shot's forecast. The conservative screen had deliberately excluded those corrections.

The selected-case gain is descriptive: it must not be advertised as a general +14.29-point strength
improvement. It motivates a distinct one-correction-per-battle candidate with independent fresh seeds.
The failed conservative guard and all of its outcomes remain unchanged. The exact source, seed
reservation, family results, cross-host controls and independent integer verification are preserved in
[`evidence/ranged_countershot_safety_20261117.json`](evidence/ranged_countershot_safety_20261117.json).
An initial verification-script failure was only an omitted zero-valued Python Counter key; the repaired
independent verifier reproduces all outcomes and bootstrap values without changing any input or policy.
