# Shield screen (A19 profile v36)

`a19-shield-screen-v1` was adopted on November 25, 2026 by the owner's decision, for AI seats and Premium "Arrange
army" together. It refines profile v35's split screen (`docs/owner_asks_adoption.md`): when the army has a splittable
Mermaid, the spare split slots become one-model Mermaid screens.

## The request

After staging game 4a48d1ca the owner wrote: "it is always better to split mermaid if we have it, because it takes two
shots to kill her". In that game Premium's arrangement split one Mermaid and spent the other spare slots on the next
cheapest body, and the owner re-split by hand ("i had to resplit to what AI did").

Mermaid (Might, level 1, 12 hp) has Water Shield: once per battle it absorbs the first incoming attack (0 damage) and
breaks; fire passes through. Every stack keeps its own shield, so a one-model Mermaid split takes two attacks to kill,
where any other one-model screen dies to one. Mermaid is the only creature with Water Shield.

## The rule

In the split planner's screen mode (`src/ai/tactical_split_placement.ts`, option `shieldScreen`), a splittable Water
Shield stack is the screen body before any other. After its reserved shield split, every spare slot becomes one more
one-model split of it. Slots it cannot fill (a stack of two or three) go to the split-screen body, the cheapest stack not
yet split. An army without a splittable Mermaid, or without spare slots, plans exactly as in profile v35.

The switch is `A19_SHIELD_SCREEN_<LEFT|RIGHT>` (`src/ai/split_screen.ts`), on unless `0`. The server's split plan (AI
seats and Premium "Arrange army") passes it to the planner, and the client's Premium projection follows it.

## The decision and its check

The owner was offered three ways to ship it: both now, Premium now and AI seats after a check, or both after a check
(the v35 way). The owner chose "Both now" (`docs/evidence/shield_screen_decision_20261125.json`, sha256
`e50024247b049178de58d092acca14ac93433c405e843647b7b6b20799bf3ddc`, the policy's `registrationSha256`). So the profile
records `qualification: "owner-decision-check-pending"`.

A registered non-inferiority check follows once research hosts are free: AI seats whose army holds a splittable
Mermaid, against the v35 screen body, with OA's bar (the 95% lower bound may not fall below −2 points per game). If it
fails, the rule is rolled back through its switch and a new profile. It is not a measured strength gain.
