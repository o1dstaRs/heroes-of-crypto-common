# Tier-2 beneficiary rule (artifact-fit-v8)

A player with five melee and caster picks was shown Farsight Quiver as the first suggestion of a
three-artifact offer. Farsight Quiver removes range falloff for shooters. The army had none. The
suggestion came from a win-rate table that is an average over armies and cannot see whether the
army in front of it has anything the artifact acts on.

`artifact-fit-v8` adds one rule to the Tier-2 pick: **an offered artifact that this roster cannot
use never outranks one that does something.** It is the engine's own rule, not a strength estimate:

- **Farsight Quiver** is granted to native shooters only, and changes nothing for a shooter that
  already has Sniper.
- **Giant's Maul** multiplies physical area damage: Lightning Spin, Area Throw, Through Shot,
  Skewer Strike, Large Caliber and Chakram. Magical area damage is not affected.

Every other artifact acts on any army. When nothing usable is on offer the choice is immaterial
and stays the previous one. v8 extends the registered v6 line; the v7 Dual Strike candidate is a
side branch and is not part of it. For drafting v8 **is** v6: `artifactFitVersionForSetupSpec`
reports 6, so creature and bundle scoring and the frozen contextual draft helpers are untouched.

## The level-4 pick

The artifact is chosen before the level-4 creature, and the two artifacts differ on whether that
pick should count. This was measured, not assumed.

Design: every distinct roster of three lifecycle banks (726). For a roster whose five known
creatures cannot use one of the two artifacts, one offer on which the table and the rule disagree
was sampled by hash. Each pair of games differs only in that seat's Tier-2 artifact, both seats on
the A19 profile v14 default. The rule changes the choice on 9,455 of 86,996 roster and offer
combinations.

| Changed cases                                     | Pairs | Table pick | Rule pick | Difference |   95% interval |
| ------------------------------------------------- | ----: | ---------: | --------: | ---------: | -------------: |
| All                                               |   239 |      50.2% |     57.7% |       +7.5 |  +0.8 to +14.0 |
| Giant's Maul, no area attacker in the final army  |    64 |      32.0% |     51.6% |      +19.5 |  +6.3 to +32.8 |
| Giant's Maul, an area attacker arrived at level 4 |   137 |      58.0% |     64.2% |       +6.2 |  -2.2 to +14.6 |
| Farsight Quiver, no shooter in the final army     |    30 |      43.3% |     50.0% |       +6.7 | -10.0 to +23.3 |
| Farsight Quiver, a shooter arrived at level 4     |     8 |      87.5% |     25.0% |      -62.5 | -87.5 to -25.0 |

So:

- **Giant's Maul is judged on the five known creatures.** The artifact that replaced it did no
  worse when an area attacker arrived later and much better when none did.
- **Farsight Quiver counts the seat's next pick.** One level-4 shooter makes it strong, and taking
  it away from such an army is the one clear loss in the table. The decision context therefore
  carries `ownProspectiveCreatureIds`: an empty list means "judge the army as it stands", a
  creature means "this seat expects to add it", and an omitted field means the caller cannot say,
  which leaves the quiver eligible.

The server states the prospect for two callers. A seat with the striker draft head adds a striker
at level 4, so it passes the empty list. Premium advice also passes the empty list, because the
player's next pick is theirs to make: an artifact none of their drafted creatures can use is listed
below every one that works, with the reason and its beneficiaries.

## Status

Adopted with A19 profile v15 on this changed-case diagnostic under the user's standing instruction.
It is development evidence on the cases the rule changes, not a registered confirmation and not an
unconditional gain. `HOC_V08_SETUP_POLICY=artifact-fit-v6:conditional-v1:sniper+t2a19` restores the
previous Tier-2 choice. The evidence file is
[artifact_beneficiary_diagnostic_20261120.json](evidence/artifact_beneficiary_diagnostic_20261120.json).
