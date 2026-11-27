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
(`docs/evidence/close_screen_decision_20261126.json`, the policy's `registrationSha256`). The initial adoption
recorded `qualification: "owner-decision-check-pending"`.

The adoption called for a registered non-inferiority check against the v36 screen body. Its
95% lower bound had to clear −2 points per game across AI-vs-AI and owner-shaped drafts. The
owner approved rolling the rule back for AI seats and Premium together on a failed check.

## Check CS1 passed on November 27, 2026

CS1 compared the active close screen with the previous screen-body preference. Both seats
played A19 on the ranked engine with deterministic Zig deep fit. The 2,160 fresh draft families
were balanced across the three maps and doctrines. Half faced the default draft and half faced
a synthetic ranged-fort draft modeled on the shooters in the owner's recorded corner-fort game.
The census evaluated both physical seat assignments of every family.

The authoritative census found 1,160 changed openings in 4,320 eligible seats. Both arms played
each changed opening, for 2,320 scored fights. A further 24 unchanged pairs reproduced their
full fight traces, and all 40 cross-host replay fights matched. The comparison holds paid
upgrades, artifacts, armies, and the actual opponent opening fixed within each pair.

| Population     | Eligible seats | Score difference | 95% family interval |
| -------------- | -------------: | ---------------: | ------------------: |
| Pooled         |          4,320 |     +0.37 points |      −0.28 to +1.03 |
| Default mirror |          2,160 |     +0.30 points |      −0.76 to +1.39 |
| Ranged fort    |          2,160 |     +0.44 points |      −0.30 to +1.20 |

All seven gates passed, including the registered −2-point non-inferiority margin and both
population guards. The opening used 4,337 flying one-model stacks versus 1,989 before. Across
changed openings, the opponent's accepted ranged and area-shot actions in the first two laps
fell from 2.31 to 2.06 per fight. All played fights had zero engine quality errors.

The qualification is now `non-inferiority-confirmed` for the current default and Premium
"Arrange army". The fight-score interval includes zero.
[Registration and paired results](evidence/close_screen_check_20261127.json)
