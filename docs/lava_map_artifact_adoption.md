# Lava Striders by map — adopted as A19 profile v27

Adopted on November 22, 2026 under the owner's standing instruction ("always lock in wins please"), after the owner
reported: "AI suggests lava striders on open map lol". Policy id `a19-lava-map-artifact-v1`.

## Why

Lava Striders lets an army move over and stand in lava, and a unit that crosses lava with it gains Made of Fire's
boost. Only the lava-centre map has lava. The Tier-2 tables are averages over every map, so the policy was map-blind:
in 26,894 production-replica games Lava Striders was offered in 22% of games on every map and taken in 9.2% (open),
9.6% (lava) and 10.1% (mountain) of them. On 539 tasks where Lava Striders and another Tier-2 artifact were both played,
the other artifact scored +6.7 points (open) and +13.1 (mountain) better for armies with fewer than two ranged stacks,
and 13.3 points worse on the lava map.

## The rule

`src/ai/setup/a19_lava_map_artifact.ts`, around the striker rule (the map is public at the Tier-2 pick for every
doctrine). Two rules were registered together and judged separately:

- (A) on a map without lava, Lava Striders leaves the offer while another offered artifact passes the beneficiary
  rule. **Adopted.**
- (B) on the lava map, an army with fewer than two ranged stacks takes Lava Striders when it is offered, unless the
  striker rule takes Crown of Command. **Failed its strength gate (V2); not adopted.** The lava map keeps the striker
  rule's pick.

The server switch is `HOC_A19_LAVA_MAP_ARTIFACT` (on unless `off`; it needs the Tier-2 striker rule). Premium ranks
Lava Striders below every usable artifact on a map without lava and says why.

## Evidence

Registered confirmation V (`docs/evidence/lava_map_artifact_registration_20261122.json`, sha256 `09fdcef677947b48b52c0baee2d6beb296aa9add6dad05c55d92a587d80a364f`) on a fresh
sealed bank (namespace `lava-map-artifact-20261122-v1`: one draft root per family, maps 1/3/4 x 3 fight seeds).
Results: `docs/evidence/lava_map_artifact_confirmation_20261122.json`. Differences are per task (0 for an unchanged
task) and per changed task.

| Population                                             | Tasks | Changed | Difference | On changed | 95% interval   |
| ------------------------------------------------------ | ----: | ------: | ---------: | ---------: | -------------- |
| Default AI, maps 1 and 4 (rule A)                      | 14010 |     870 |      +0.48 |      +7.70 | +0.24 to +0.73 |
| Default AI, map 3 (rule B, not adopted)                |  7005 |     585 |      +0.09 |      +1.11 | −0.32 to +0.51 |
| Owner-shaped rush (guard), maps 1 and 4 (rule A)       |  4674 |     429 |      +0.51 |      +5.59 | +0.11 to +0.93 |
| Owner-shaped rush (guard), map 3 (rule B, not adopted) |  2337 |     234 |      +0.51 |      +5.13 | −0.21 to +1.24 |

The rows for map 3 measure rule B, which is not adopted. Gates V1 (strength without lava), V3 (owner-rush guard), V4
(quality), V5 (parity of unchanged tasks) and V6 (second host) passed, so rule A is adopted. V2 (strength on the lava
map) failed: the lower bound of its 95% interval is below zero. Rule B stays recorded as failed; it is not waived,
re-run or relabelled.

## What the estimate is and is not

- Against AI-played armies in deterministic work mode; not a win rate against people.
- A seat whose map is unknown at the Tier-2 pick keeps its choice.
