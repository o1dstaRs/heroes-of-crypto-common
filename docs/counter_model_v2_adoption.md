# Counter model v2 — adopted as A19 profile v37

Adopted on 2026-11-26 under the owner's standing instruction ("Make sure we lock in wins"), for the owner's goal that
every doctrine be strong and use its strengths ("improve our pick phase measurably so all doctrines actually strong and
use their strenghts (knowing map ahead of time, bans, seeing 1/2 of opponent or full)"). Policy id
`a19-counter-model-v2`: `src/ai/setup/draft_models/a19_counter_draft_v2.json`, selected by `src/ai/setup/a19_counter_draft.ts`
for the counter draft (profile v26) and the closing pick (profile v34). Switch `A19_COUNTER_MODEL` (`v2` unless `v1`).

## Why

Spymaster gives up two upgrade points to see every opposing pick, Scout one to see three. On profile v34 Spymaster scored
37.9% in the default mirror against 57.9% for Battle Trance (DT1); with Battle Trance's seven points the same seat and
draft scored 58.5% (DT2), and its view of the opponent's picks was worth −1.75 points per draft (IV1). The view reaches
the draft through one model, a19-counter-draft-v1: creature strengths plus creature-vs-creature counters, fitted on
40,040 production games of the confirmations before profile v26. On 6,549 AI-vs-AI games played on profiles v34 and v35
on November 25, that model predicted held-out games much worse than a refit: log loss 0.6654 with side and budget only,
0.6425 with v1's logit, 0.6051 with strengths and counters refit toward v1. The owner keeps the doctrine budgets
(November 25), so the view has to pay for itself.

## The model

v1's form, refit toward v1's values with ridge penalties (32 on the 57 strengths, 128 on the 1,596 counters; a seat and
an upgrade-budget term fitted alongside and not stored) on those 6,549 games; the completion prior (how often each
creature appears in armies) is v1's. The largest changes: Crusader +0.15 → +0.50, Magic Dragon 0 → +0.18, Valkyrie +0.01 →
+0.15, Hydra +0.14 → +0.27; Thunderbird +0.07 → −0.15, Zena +0.04 → −0.15, Medusa −0.06 → −0.25, Ogre Mage 0 → −0.15. The
rules that use the model are unchanged: the counter draft still opens on two visible creatures that read melee, the
closing pick still fires at level 4 while that gate is shut, with its 0.05 margin and synergy bonus. Premium draft advice
goes through the same decider.

## Path to adoption

| Step                           | Data                                                           | Result                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Held-out fit                   | 6,549 v34/v35 games, 5 folds by family                         | log loss 0.6425 (v1) → 0.6051 (refit)                                                                                                                                                                      |
| Human battery ranking          | 59 human games × every offered level-4 creature                | rank correlation +0.244 → +0.283; top option minus production +1.64 → +3.65                                                                                                                                |
| MV1G (human guard)             | 29 changed battery games, 264 tasks per arm                    | +1.72 per game (95% −6.25 to +9.70)                                                                                                                                                                        |
| MV1 (screen, v35)              | Spymaster 1,600 cases, Scout 800                               | +5.65 per changed Spymaster draft (95% +2.21 to +9.08), +10.12 per changed Scout draft (+4.90 to +15.27); quality gate failed: one game stranded a Magic Dragon (a placement bug, fixed in server 20aea77) |
| MV3G (human guard, fixed tree) | 29 changed battery games, 264 tasks per arm                    | +2.16 per game (95% −5.60 to +10.13)                                                                                                                                                                       |
| MV3 (confirmation, fixed tree) | Spymaster 2,000 cases (1,684 changed), Scout 800 (647 changed) | +9.18 per changed Spymaster draft (95% +5.96 to +12.47), +4.88 per changed Scout draft (−0.46 to +10.29); 0 quality errors; all four gates passed                                                          |

MV1 stays recorded with its quality gate failed; MV3 was registered to decide in its place before MV1's final result was
read, and the model was not changed between them.

## Evidence

Registration: `docs/evidence/counter_model_v2_registration_20261125.json` (sha256
`054c80d7361aaa9e8533e7c25d53b5a2911952e4259b56159df0d93c4995a360`) holds MV3's decision rule verbatim (sha256
`e62c89868e8b201c2417282a8178fe7703e3cd46e9f3f4d98196085330ed7235`, written and hashed at 19:15Z on November 25, before
any game of MV3 or MV3G ran) with every input hash. Results: `docs/evidence/counter_model_v2_confirmation_20261125.json`.

Tree: server 20aea77 (origin main, with the placement fix) and common b60b2ab6, plus research-only files: the draft
harness, a game-id override and a seam that swaps the counter model's strengths and counters. Fresh seeds; the
opponent's doctrine drawn live; the candidate on each seat; production everywhere else. Stage 1 drafted every case with
production (v1) and with model v2; stage 2 played both drafts of every case where the candidate's army changed, with the
production bot-seat driver and deep fit, same seeds, in 48 shards on three hosts (every changed case played once in both
arms). Per changed case, the candidate seat's score with v2 minus production; families weighted equally; 95% from
10,000 family resamples.

| Population                   | Changed cases                 | Per changed draft               | Better / worse / equal | Per game |
| ---------------------------- | ----------------------------- | ------------------------------- | ---------------------- | -------- |
| S3, Spymaster seat (primary) | 1,684 of 2,000 (978 families) | **+9.18 (95% +5.96 to +12.47)** | 448 / 282 / 954        | +8.30    |
| C3, Scout seat               | 647 of 800 (384 families)     | **+4.88 (95% −0.46 to +10.29)** | 155 / 117 / 375        | +4.62    |

By the opponent's doctrine (a report, not a gate):

| Opponent      | Spymaster seat                      | Scout seat                         |
| ------------- | ----------------------------------- | ---------------------------------- |
| Scout         | +5.29 (−0.21 to +11.00; 545 cases)  | +6.61 (−2.12 to +15.34; 216 cases) |
| Spymaster     | +14.08 (+8.54 to +19.67; 551 cases) | +3.50 (−4.59 to +11.59; 229 cases) |
| Battle Trance | +10.55 (+5.45 to +15.90; 588 cases) | +5.76 (−3.37 to +15.03; 202 cases) |

MV3G: the owner-history games re-drafted with model v2 against production's re-draft on the same tree; each changed
army plays the human's replayed setup on the battery's seeds, paired with production's army. +2.16 points per game (95%
−5.60 to +10.13; 29 games, 7 better, 6 worse); the owner's 18 games +1.04 (−9.38 to +11.81), the other 11 +3.98 (−6.82
to +16.48).

Gates, all required: S3's lower bound per changed draft above 0 (+5.96); C3's lower bound at least −3 (−0.46); 0 quality
errors in MV3 and MV3G (0); MV3G's estimate at least −2 per game (+2.16). All four passed.

## What the estimate is and is not

- A gain of a v2 seat against the v1 default AI, in the drafts where v2 changes the seat's army: 84% of Spymaster drafts
  and 81% of Scout drafts. Two v2 seats meet at 50%; it is not a win rate against people.
- MV3G is a non-inferiority check on human setups: its interval includes 0, and no gain against people is claimed.
- The Scout gain is not established (its lower bound is below 0); the gate asked only that it cost at most 3 points.
- MV1 and MV3 ran on common trees before b0100048, whose offline fight driver still applied the A19 neural correction
  that no live bot seat applies since profile v30. Both arms played with that driver on the same seeds, so the
  comparison is paired, but the fights are not exactly live's.
- The model changes no rule: it changes which creature the counter draft and the closing pick score best. Battle
  Trance seats see opposing creatures only through hidden-pick collisions, so their drafts change rarely.

## Rollback

`A19_COUNTER_MODEL=v1` makes the counter draft and the closing pick score with v1 again for every seat of the process;
`test/ai/a19_closing_pick.test.ts` checks that it reproduces confirmation CPC's six level-4 picks. On those six human
games model v2 changes three closing picks: 76f5f3d5 (Thunderbird → Frenzied Boar), 3fd7b865 (Thunderbird → the earlier
layers' Champion; CPC measured the Thunderbird there at −35.9) and 974d9737 (Thunderbird → Hydra).
