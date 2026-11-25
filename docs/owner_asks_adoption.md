# The owner's three asks — confirmation OA

On November 24, 2026 the owner asked for three behaviour fixes. Each had measured flat in development, so the owner
chose for each: the flyer-dive guard, "Check, then adopt"; screen splits, "AI seats + Premium, after a check"; the Troll
gift, "Check, then adopt". One registered non-inferiority confirmation, OA, checked all three against one shared
production control, with the gate the earlier behaviour fixes used (keep-attack v21, rejection fixes v22, carrier
cohesion v32): the 95% lower bound may not fall below −2 points per game.

**Outcome (November 25, 2026).** The flyer-dive guard failed FD1 (lower bound), −0.91 points per game (95% −2.00 to
+0.15), and is not adopted; split screen passed all five gates, +0.87 points per game (95% −0.15 to +1.88), and is
profile v35; the Troll gift split failed TG2 (populations), +0.99 points per game (95% −0.11 to +2.11), and is not
adopted. A failed gate stays recorded as failed: it is not waived, re-run or relabelled.

## Flyer-dive guard (`a19-flyer-dive-guard-v1`)

The owner, after arena game eca8580f: "force flying single unit griffin not always a good idea, and I had good
coverage". The native v0.8 decision waited the Griffin; the search turned the wait into a lone move-and-strike, and the
owner's corner fort killed it the same lap.

**The rule.** In laps 1–2, while the native decision of a melee flyer (any level) is a wait, the search drops every
challenger that is a move or a move-and-strike ending 4 or more cells (Chebyshev, between footprints) from every living
ally and farther from them than the flyer stands now (`src/ai/flyer_dive_guard.ts`, the search driver's challenger
filter; counter `flyerDiveGuardRejects`). It runs in every v0.8 search of the A19 driver: bot seats (stock and deep
fit), the tournament tiers and Premium's fight advice. Switch `A19_FLYER_DIVE_GUARD_<LEFT|RIGHT>`, on unless `0`.

Development (research tree prod28f, pools of 402 owner-shaped and 402 mirror tasks): owner-shaped −1.24 (95% −3.48 to
+1.00), mirror +1.24 (−1.73 to +4.26), pooled +0.00 (−2.10 to +2.07).

### Result: FAILED FD1 (lower bound)

| Population                           | Tasks     | Games played | Points per game                | Changed games: better / worse |
| ------------------------------------ | --------- | ------------ | ------------------------------ | ----------------------------- |
| **All (primary)**                    | **2,755** | **2,755**    | **−0.91 (95% −2.00 to +0.15)** | **104 / 132**                 |
| Natural, mirror                      | 1,185     | 1,185        | −1.22                          | 56 / 72                       |
| Natural, owner-shaped opponent       | 1,250     | 1,250        | −0.92                          | 46 / 59                       |
| The owner's 10 games (32 seeds each) | 320       | 320          | +0.31                          | 2 / 1                         |

Gates: FD1 FAILED, FD2 passed, FD3 passed, FD4 passed, FD5 passed. Quality errors (games with one): rule 0,
production 0. Behaviour: the guard removed challengers in 6,627 decisions; real melee-flyer stacks (two or more
creatures) lost in laps 1–2: rule 1721, production 1926. Level-4 stacks alive at the end: rule 956 of 2755, production
982 of 2755. Parity: 20 control and 20 rule replays on the second host, 0 digest mismatches; played games opening
differently from their census: 0.

Not adopted. It stays recorded as failed.

## Split screen (`a19-split-screen-v1`)

The owner: "premium for some reason always decides to split ranges instead of melee for some reason. For example wolf is
much better to split to cover, as it is 1x2 unit. But it depends. Looks like ai is not trained to split well".

Before this rule the tactical split planner (`planTacticalStackSplits`, reached through `planA19SupportSplits` by the
server's split plan for AI seats and Premium "Arrange army", and by the client's Premium projection) split only 1x1
stacks and reserved a "cover" split from any shooter before its melee bait, so an owner-like army with spare slots split
a shooter and at most two cheap 1x1 bodies, never the Wolf.

**The rule.** With `{ screen: true }` no shooter cover split is reserved, 1x2/2x1 stacks may be split (as screen bodies
only: aura, support and shield sources stay 1x1), and every slot left after the aura, support and shield splits becomes
a one-model split of the best cheap body: lowest level first, then the larger footprint, melee before shooter, then the
largest stack (`src/ai/split_screen.ts`, `src/ai/tactical_split_placement.ts`). The server's split plan passes it for
the default v0.8 planner, the path OA measured: production bot seats and Premium "Arrange army". Other AI versions and
research bot profiles keep the legacy planner unchanged. The client's Premium projection follows the server. Switch
`A19_SPLIT_SCREEN_<LEFT|RIGHT>`, on unless `0`.

Development (research tree prod28s, tasks where the rule changes the opening): owner-shaped +4.36 (95% −5.00 to +12.78),
mirror −3.05 (−10.48 to +4.74), pooled +0.89 (−6.20 to +7.54).

### Result: all five gates passed

| Population                           | Tasks     | Games played | Points per game                | Changed games: better / worse |
| ------------------------------------ | --------- | ------------ | ------------------------------ | ----------------------------- |
| **All (primary)**                    | **3,374** | **1,289**    | **+0.87 (95% −0.15 to +1.88)** | **193 / 165**                 |
| Natural, mirror                      | 1,527     | 519          | +1.54                          | 96 / 72                       |
| Natural, owner-shaped opponent       | 1,527     | 578          | +0.20                          | 78 / 76                       |
| The owner's 10 games (32 seeds each) | 320       | 192          | +0.94                          | 19 / 17                       |

Gates: SS1 passed, SS2 passed, SS3 passed, SS4 passed, SS5 passed. Quality errors (games with one): rule 0,
production 0. Behaviour: shooter split stacks in the openings: rule 155, production 738; 1x2/2x1 split stacks: rule 865,
production 0. Parity: 20 control and 20 rule replays on the second host, 0 digest mismatches; played games opening
differently from their census: 0.

## Troll gift split (`a19-troll-gift-split-v1`)

The owner, staging game 7c0a741a: "he could've gifted with 1 troll instead of full stack to crusader, and full stack
coulve go for attack". The AI had a one-Troll split, and its 24-Troll stack cast the one-way Wild Regeneration gift on
the Crusader, spending the big stack's turn on it.

**The rule.** (1) No Wild Regeneration cast is offered to a stack while a smaller living allied stack of its creature
still holds the ability (`a19GiftFromSmallerStack`: the candidate generator and the v0.4 native gift). (2) When the army
has a Troll stack of at least two, no one-Troll stack, and an ally of level 3 or lower, not a Troll, with more HP per
creature, the split plan adds a one-Troll "cover" split in a free slot, or in place of its last bait or cover split
(`a19TrollGiftSplitPlans`: the server's split plan on the default v0.8 planner and the client's Premium projection).
Wild Regeneration's earlier rule (profile v24: the gift only goes to a creature with more max HP than the caster) is
unchanged. Switch `A19_TROLL_GIFT_SPLIT_<LEFT|RIGHT>`, on unless `0`.

Development (research tree prod28g, 588 tasks where the rule can act): pooled +0.17 (95% −2.01 to +2.32); big-stack
gifts while split 195 → 97. Confirmation TG was prepared on prod28g and never registered or played; OA replaced it.

### Result: FAILED TG2 (populations)

| Population                           | Tasks     | Games played | Points per game                | Changed games: better / worse |
| ------------------------------------ | --------- | ------------ | ------------------------------ | ----------------------------- |
| **All (primary)**                    | **1,814** | **1,145**    | **+0.99 (95% −0.11 to +2.11)** | **76 / 56**                   |
| Natural, mirror                      | 240       | 114          | +0.21                          | 6 / 6                         |
| Natural, owner-shaped opponent       | 213       | 138          | −2.58                          | 7 / 12                        |
| The owner's 10 games (32 seeds each) | 96        | 96           | −1.04                          | 3 / 5                         |
| Troll bank, mirror                   | 534       | 290          | +2.53                          | 24 / 10                       |
| Troll bank, owner-shaped opponent    | 731       | 507          | +1.44                          | 36 / 23                       |

Gates: TG1 passed, TG2 FAILED, TG3 passed, TG4 passed, TG5 passed. Quality errors (games with one): rule 0,
production 0. Behaviour: gifts in games with two or more Troll stacks from a smaller stack: rule 727, production 528;
from the largest stack: rule 217, production 419 (rule share from a smaller stack 77.0%); gifts with one Troll stack:
rule 0, production 57. Parity: 20 control and 20 rule replays on the second host, 0 digest mismatches; played games
opening differently from their census: 0.

Not adopted. It stays recorded as failed.

## Confirmation OA

Registration: `docs/evidence/owner_asks_registration_20261124.json` (sha256
`01fdd229c2e6ac7a8d4ea3d99f0dd13c20e60991dc8c71401fa63f24e86b89e4`), written and hashed at 23:06:38Z on November 24,
before any OA game. It holds the decision rule verbatim, the analysis's sha256 and the hashes of the 131 registered
inputs (runner, specs, banks, census rows, lists, analysis). Results:
`docs/evidence/owner_asks_confirmation_20261125.json` (the registered analysis's output).

Tree: the profile-v34 server (2655971) and common (dbb349ff) plus the three rules behind per-seat switches that were off
unless `1`, and a research-only replay override (`ranked_adapter.ts` e91e1733) so a replayed owner game keeps its
game-id-seeded stones. With every switch off the tree reproduced the v34 override tree on 4 of 4 owner tasks. Both seats
play the production bot seat with deep fit at 4,000 rollout turns; an arm sets its rule's switch for the candidate's
seat only. Offline play has no clock, so host speed and load cannot change a game.

Populations:

- **Natural, owner-shaped and mirror**: fresh seeds22 families 1700–2208 (never drafted or played before), fight r0 on
  maps 1, 3 and 4; the candidate drafted as the default seat against owner-shaped strikers (`S:B23:fast:K14`) or the
  default mix; 1,527 tasks each.
- **The owner's 10 recent test-server games**: the owner's real setup replayed on its seat, the AI seat on the v34
  production re-draft, 32 fresh seeds per game (320 tasks).
- **Troll banks** (TG only): the prepared TG banks (seeds22 families 1100–1699, drafted with the Troll forced at level
  2, never played), the tasks whose army has a Troll: 731 owner-shaped and 534 mirror.

A setup-only census of every task under production and each split rule (outcome-blind, before registration) chose the
games to play: FD plays every task whose candidate fields a melee flyer at the opening; SS and TG play the tasks whose
opening the rule changes (TG also every task with two or more Troll stacks, where the casting rule can act). A task
whose opening is identical plays an identical game in both arms and adds 0. Control: every task some rule plays. 8,918
games plus 80 parity replays.

Analysis (`oa_analyze.py`): per rule, the candidate arm against the control, paired by task, points per game for the
candidate (win 100, draw 50, loss 0); the primary is the mean over the rule's whole population; the interval is the 95%
percentile of 10,000 bootstrap replicates (seed 20261124) that resample draft-root families (natural and Troll tasks)
and seeds within each owner game. Gates for each rule, all required: X1 the lower bound at least −2; X2 no population
below −2; X3 quality errors in the rule's arm not more than the control's; X4 behaviour (FD: the guard removes
challengers and real melee-flyer stacks lost in laps 1–2 do not rise; SS: fewer shooter split stacks and more 1x2/2x1
split stacks in the openings; TG: at least 75% of the gifts in two-Troll-stack games come from the smaller stack); X5
parity (the first 20 owner-shaped tasks of the control's and the rule's lists reproduce their digests on the second
host, and every played game opens as its census did).

Execution: basenode (Ryzen 9 3900X) and x3d (Ryzen 7 9800X3D), from 23:06Z and 23:14Z, at low priority. Operational
changes, disclosed: the owner lists, planned as basenode's second wave, ran on x3d, each starting as soon as x3d had
free slots; from 01:49Z to 01:54Z on November 25, seven basenode pools were re-sharded so that x3d could take part of
them: each pool stopped, its completed rows were appended to every new shard file (nothing deleted, no case replayed,
none lost) and basenode restarted its shards with the new count while x3d played the others from one queue of
single-runner jobs, at most 14 processes; at 04:17Z, so that no single runner held the tail, x3d's seven unstarted
re-shard jobs were split in four (shard k of M into k, k + M, k + 2M and k + 3M of 4M: the same cases, the completed
rows copied into each new file first), and the owner lists ran as 8, 8 and 4 shards instead of 4, 4 and 2, the control's
and the Troll gift's on basenode as its slots freed; at 06:53Z, x3d having finished its share while basenode had started
2 of those 12 owner shards, the other 10 moved to x3d as 20 smaller ones (none had rows). Which host plays a game cannot
change it (X5).

## What is not claimed

- Non-inferiority results, not strength gains: no rule's 95% lower bound is above zero, so none is shown to make the AI
  stronger.
- Not a win rate against people. The owner population is a floor: with identical armies and setups the owner's own fight
  is worth about 28 points per game more than the AI-played owner seat, which punishes lone arrivals less (the fight
  study in the server's `docs/ai_prefight_scorecard.md`). A null there does not show the guard is useless against the
  owner.
- Each rule was measured alone against production; adopted together, their interaction is not measured (SS and TG both
  change the split plan).
