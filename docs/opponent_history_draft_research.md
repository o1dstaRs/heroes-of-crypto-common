# Opponent history in the counter draft — failed confirmation OH

Studied on 2026-11-23 at the owner's request ("Try 1 measurably from all angles": use the opponent's own match history in
the counter draft; "lock in wins if any"). Registered confirmation OH failed its strength gate. **Not adopted; the
default is unchanged.**

## The candidate

The gated counter draft (`a19-counter-draft-v1`, profile v26) samples the opponent's unseen slots in proportion to how
often each creature appears in production armies. The candidate drew them from the opponent's own last 30 armies
instead, blended with that prior: `w(id) = (h(id) + 5 p(id)) / (n + 5)`, where `h(id)` is the number of history armies
with the creature, `n` the number of armies and `p(id)` the creature's share of production armies. The gate (two visible
opposing creatures that read melee) was unchanged, so a seat without history drafts exactly as before.

History predicts the opponent much better: per draft level the counter draft's top-3 guess of the opponent's actual
creatures rose from 11–35% to 62–65% against the owner-shaped styles. That did not turn into points.

## Development

On confirmation Z's consumed bank, against the v26 default, three arms: **prior** (the candidate above), **openprior**
(history may also open the gate early) and **full** (history may open or close the gate). Opponents: the default AI, an
owner-shaped rush, a caster brawler, a decoy fort and a Queen fort. Histories: 30 armies of the opponent's own style
(C30), 5 (C5), the owner's three styles mixed (X30) and a misleading history of 30 Queen forts (W30).

| Prior arm              | C30                        | Other conditions               |
| ---------------------- | -------------------------- | ------------------------------ |
| Owner-shaped rush      | **+4.17** (+1.25 to +7.12) | C5 +1.85, X30 +1.08, W30 −1.08 |
| Caster brawler         | +0.62                      | X30 −1.85                      |
| Decoy fort             | −1.23 (−2.79 to 0.00)      | C5 0.00, X30 −0.62, W30 −0.62  |
| Queen fort             | −0.63                      | C5 −0.95, X30 0.00, W30 −0.32  |
| Default AI (963 tasks) | −0.21 (−2.22 to +1.77)     | C5 +0.99                       |

The full arm's history-closed gate lost against the caster brawler (C30 −1.85), and neither gate arm beat prior against
the owner's styles. Prior was registered. The registration quoted partial default-AI numbers (prior about +2.8,
openprior about −0.6); the final values are in the table and in the evidence file.

## Registered confirmation OH

Registration `docs/evidence/opponent_history_registration_20261123.json` (sha256
`510b334a9dabc5f0d30a064d308dc674bf32dc1df0651b8b78005dd2fd163d1c`), written before any confirmation fight. Fresh bank:
namespace `opponent-history-20261123-v1`, 1,867 families × maps 1/3/4, audited against 1,236 ledgers with 0
intersections; histories drafted on 450 separate tasks per style. Every population spans all nine doctrine cells.
3,154 distinct fights on the x3d host (8 processes, 07:24–09:48 UTC), fight trees prod21c6/c7 as in confirmation Z.
Results: `docs/evidence/opponent_history_confirmation_20261123.json`. The commit hook reformatted the registration file;
the registered bytes are `json.dumps(json.load(file), indent=1)` in Python, whose sha256 is the one above.

| Population, history                  | Tasks | Changed (won/lost) | Difference | 95% interval       |
| ------------------------------------ | ----: | -----------------: | ---------: | ------------------ |
| **Owner-shaped rush, own (primary)** |  1875 |    332 (+54 / −35) |  **+1.04** | **−0.03 to +2.16** |
| Owner-shaped rush, mixed             |  1875 |    323 (+55 / −38) |      +0.91 | −0.13 to +1.95     |
| Owner-shaped rush, misleading        |  1875 |    407 (+60 / −66) |      −0.35 | −1.55 to +0.85     |
| Caster brawler, own                  |  1875 |    238 (+44 / −32) |      +0.67 | −0.19 to +1.52     |
| Caster brawler, mixed                |  1875 |    215 (+32 / −42) |      −0.51 | −1.55 to +0.48     |
| Decoy fort, own                      |  1863 |    154 (+23 / −31) |      −0.46 | −1.37 to +0.43     |
| Decoy fort, mixed                    |  1863 |    104 (+20 / −14) |      +0.32 | −0.30 to +0.97     |
| Queen fort, own                      |  1863 |    108 (+21 / −21) |      +0.00 | −0.75 to +0.75     |
| Queen fort, mixed                    |  1863 |    109 (+19 / −18) |      +0.05 | −0.54 to +0.64     |
| **Default AI, own**                  |   945 |    261 (+31 / −54) |  **−2.43** | **−4.44 to −0.42** |

Gates: **OH1 strength failed** (the lower bound must be above 0). OH2–OH7 guards passed (each at least −3, the misleading
history at least −5), OH8 quality passed (no quality error in either arm), OH9 parity passed (150 unchanged inputs
replay identically under two tags), OH10 second host passed (30 fights on the Mac reproduce the x3d digests).

## What it shows

- The development gain on the owner-shaped rush (+4.17, 67 changed tasks, the best of three arms) shrank to +1.04 on
  332 changed fresh tasks.
- Against the default AI the history read loses points: −2.43 with the whole interval below zero (Scout −5.71,
  Spymaster −2.22, Battle Trance +0.63; Normal −4.13, Lava −2.86, Block −0.32). It passed its −3 guard, but it is a
  measured loss, not noise. The default AI drafts adaptively, so its past armies, drafted against another seat, may
  describe it worse than the production prior does. That explanation is a hypothesis and was not tested.
- On the primary population, seats that see more of the opponent's draft moved more: Spymaster +1.76, Scout +1.36,
  Battle Trance 0.00.
- Better prediction of the unseen picks is not what limits the counter draft's choice.

## Rules for this result

- OH stays recorded as failed. Do not waive, re-run or relabel OH1, and do not adopt the prior arm on the strength of
  the passed guards. The bank namespace `opponent-history-20261123-v1` is consumed.
- The openprior and full arms were never confirmed; their default-AI development gains come from a reused bank.
- A new history candidate needs a new hypothesis, development on other data and a fresh bank. Against the default AI it
  must beat the −2.43 measured here, not only stay inside a −3 guard.
- Not claimed: a win rate against people or real players' histories (the opponent styles are scripted bots).

The production port (an `opponentHistory` input to `a19CounterDraftCreature`) was prepared and never applied. It is kept
with the inputs, fight rows and analysis in the ignored client capsule `game/core/tmp/opponent-history-20261123`
(results archive sha256 `e20f62c6fc5656698b6ae3e34a8f0cad72bd73353a8938a86905f677c134b328`); the x3d copy is
`/root/hoc-research/opponent-history-20261123`.
