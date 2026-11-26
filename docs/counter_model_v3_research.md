# Counter model v3 — not adopted (screen MV4)

Recorded on 2026-11-26. Counter model v3 refits the strengths and counters of a19-counter-draft-v1 toward v1, like
counter model v2 (profile v37, `docs/counter_model_v2_adoption.md`), on 13,605 games instead of 6,549. The extra games are
the 7,056 fights of the v35 Premium snapshot, collected at the owner's request ("you can just collect premium snapshot
and use it i guess"). Registered screen MV4 compared v1, v2 and v3 for the counter draft and the closing pick. v3 beat v1
but not v2: it failed one of its five bars and is not adopted, so v2 stays. MV4 also replicated v2's gain over v1 on
fresh seeds. Do not waive, re-run or relabel MV4's v3 − v2 bar.

## Why v3

The snapshot (seven cohorts, maps 1, 3 and 4) predicts held-out fights from creature strengths, counters, synergies and
artifacts, and from no map interaction (development lookups; the server's `docs/ai_prefight_scorecard.md`). v2, fitted
on self-play only, predicted the snapshot's armies worse than v1 (log loss 0.6443 against 0.6394). The 59 human battery
games were seen by no fit. On them, each game's level-4 options were ranked against the human's real army:

- Rank correlation: v1 +0.244, v2 +0.283, v3 +0.308.
- The model's top option minus production's, in points per game: v1 +1.64, v2 +3.65, v3 +4.24.

Against v1, v3 raises Crusader, Hydra, Magic Dragon, Arachna Queen and Mantis. It lowers Abomination, Ogre Mage,
Nightmare, Angel, Zena and Thunderbird. The model is `docs/evidence/counter_model_v3_candidate_20261125.json`; Python's
`json.dumps(json.load(f))` reproduces the registered bytes (sha256 `daef6836ce68179519e70a9c449763ea4c501a25b995199c63f82dc6868a1a63`).

## Screen MV4

The decision rule was written and hashed at 20:29Z on November 25, before any game of MV4 or MV4G and before any MV3
result was read: `docs/evidence/counter_model_v3_registration_20261125.json` (sha256
`150f095aa4e663e579aa85aa4e76e850cd79563790a72cf4acad9f3850409487`; decision rule sha256
`ef15e06fd319ebb279c58402b5ba1e536f6e7c63f90b6cf7b8f2c6071b92c373`).

- Tree: server 9705f5e (profile v36) with common 19f3c39c, plus MV3's research harness with a third arm.
- Populations: fresh seeds, the opponent's doctrine drawn live, the candidate on each seat and production everywhere
  else. S4 has 1,000 families with the candidate seat forced to Spymaster; C4 has 400 forced to Scout.
- Stage 1 drafted every case with v1, v2 and v3.
- Stage 2 played each distinct army of every case where an arm changed the candidate's army; an arm with the same army
  as another reuses its game. Deep fit, same seeds, 48 shards on the Mac and x3d.
- Every distinct army was played exactly once: 4,517 games for S4's 1,786 changed cases and 1,662 for C4's 673.
- Statistics: families weighted equally; 95% intervals from 10,000 family resamples.

Results are in points per changed draft (95% interval), with the changed cases:

| Comparison | Spymaster seat (S4)                     | Scout seat (C4)                    |
| ---------- | --------------------------------------- | ---------------------------------- |
| v3 − v1    | +8.02 (+4.88 to +11.13); 1,719 cases    | +9.06 (+3.60 to +14.33); 645 cases |
| v3 − v2    | **−0.49 (−4.44 to +3.53); 1,100 cases** | +1.35 (−5.30 to +8.16); 380 cases  |
| v2 − v1    | +9.17 (+5.95 to +12.32); 1,698 cases    | +8.23 (+2.51 to +14.01); 637 cases |

By the opponent's doctrine (a report, not a gate; families weighted within each split):

| Opponent      | S4 v3 − v2              | S4 v2 − v1               | C4 v2 − v1               |
| ------------- | ----------------------- | ------------------------ | ------------------------ |
| Scout         | −3.54 (−10.02 to +2.79) | +7.51 (+2.08 to +13.03)  | +4.79 (−4.49 to +13.92)  |
| Spymaster     | +1.89 (−5.19 to +8.81)  | +8.81 (+3.46 to +14.26)  | +9.87 (+1.18 to +18.42)  |
| Battle Trance | −1.90 (−8.15 to +4.35)  | +11.73 (+6.76 to +16.70) | +11.02 (+1.75 to +20.16) |

MV4G, the human guard, re-drafted the owner-history games with v3 against production's re-draft. Each changed army played
the human's replayed setup on the battery's seeds, paired with production's army: +4.63 points per game (95% −3.70 to
+14.12; 27 games, 5 better, 5 worse). There were 0 quality errors in MV4 and MV4G.

| Bar                            | Value | Result |
| ------------------------------ | ----- | ------ |
| S4 v3 − v1 lower bound above 0 | +4.88 | passed |
| S4 v3 − v2 estimate above 0    | −0.49 | failed |
| C4 v3 − v1 lower bound ≥ −3    | +3.60 | passed |
| 0 quality errors in MV4, MV4G  | 0     | passed |
| MV4G estimate ≥ −2 per game    | +4.63 | passed |

Results: `docs/evidence/counter_model_v3_screen_20261126.json`.

## What it means

- For the Spymaster seat, where v3 and v2 differ (55% of its drafts), they are tied. Adding the snapshot's prescribed
  armies to the fit improved the battery ranking but not play against the default AI. A better offline ranking of 59
  human games is not evidence of a better draft.
- v2's gain over v1 replicated on fresh seeds and on a newer tree: +9.17 per changed Spymaster draft (MV3 +9.18). The
  Scout seat's gain now has its lower bound above 0: +8.23 (MV3 +4.88, −0.46 to +10.29). These v2 − v1 figures are
  reports of MV4, not its bars.
- Both trees predate common b0100048. Their offline fight driver still applied the A19 neural correction that live bot
  seats have not applied since profile v30. Both arms of every comparison played with that driver on the same seeds.
- A new counter model is a new candidate with its own registration, and it must beat v2 (profile v37), not v1.
