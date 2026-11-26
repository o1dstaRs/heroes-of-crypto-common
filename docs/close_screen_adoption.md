# Close screen (A19 profile v39)

`a19-close-screen-v1` was adopted on November 26, 2026 by the owner's decision, for AI seats and Premium "Arrange army"
together. It refines profile v35's split screen (`docs/owner_asks_adoption.md`) for one situation: an army that has to
close the range on enemy shooters screens with its fastest cheap body, not its biggest.

## The request

After their local vs-AI game d6d7ee8b the owner wrote: "it may would have been better if they split fairy into 1 units
splits instead of wolfs in this specific situation to have a chance to close ranges quickly. Wolf split because of larger
size generally better in defense".

In that game the AI seat (brutal, production v0.8) drafted no shooter: Wolf, Fairy, Trent, Pikeman, Pegasus and Hydra.
The owner built a corner fort with Gargantuan and Medusa behind five one-model Peasant splits. The v35 screen rule
(lowest level, rectangle first) made all five spare slots one-model Wolf splits. They walked into the Unicorn and the
White Tiger for 1 or 2 damage each and died to the reply. Nothing reached the shooters. The Gargantuan's throws took 51
Wolves, the Pegasus and Fairy stacks, and later the Pikeman and the Trent, and the owner won on lap 4 with both shooters
untouched.

A shooter that can be attacked in melee cannot shoot (`AttackHandler.canLandRangeAttack`), so one enemy next to it stops
its fire. Fairy (level 1) flies with 10 steps; Wolf (level 1, 1x2) walks with 5.8.

## The rule

In the split planner's screen mode (`src/ai/tactical_split_placement.ts`, options `closeScreen` and
`opponentCreatureIds`), the army is closing when:

- it holds no shooter (no stack whose attack type is RANGE), and
- a shooter is among the opponent creatures this seat may see (`creatureInfo(id).ranged`; the server passes the setup
  context's public opponent creature ids, the client's Premium projection its revealed enemy ids).

A closing army takes its fastest cheap body as the screen body: the lowest level, a flyer first, then the most steps,
with the v35 order (bigger footprint, melee, larger stack) breaking ties. Every spare slot left after the aura, support
and shield splits becomes one more one-model split of it. Every other army, and every army without spare slots, plans
exactly as in profile v36, so the Wolf screen stays for defence.

The switch is `A19_CLOSE_SCREEN_<LEFT|RIGHT>` (`src/ai/split_screen.ts`), on unless `0`. The server's split plan (AI
seats and Premium "Arrange army") passes it to the planner, and the client's Premium projection follows it.

## The decision and its check

The owner was offered three ways to ship it: check first and adopt only if it passes, adopt now and check after, or
Premium's advice only. The owner chose "Adopt now, check after"
(`docs/evidence/close_screen_decision_20261126.json`, the policy's `registrationSha256`). So the profile records
`qualification: "owner-decision-check-pending"`.

A registered non-inferiority check follows: AI seats whose army is closing, against the v36 screen body, with OA's bar
(the 95% lower bound may not fall below −2 points per game) over an AI-vs-AI and an owner-shaped population. If it fails,
the rule is rolled back through its switch as the next profile, for AI seats and Premium together, and the owner is told.
It is not a measured strength gain.
