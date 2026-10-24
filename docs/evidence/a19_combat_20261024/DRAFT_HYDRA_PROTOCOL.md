# D: legal Hydra preference — separate draft experiment, 2026-10-24

Registered before any deciding D game. The S screen completed 300 fresh ranked matchups / 1,200 games at
50% draw-aware score (591 wins, 591 losses, 18 draws), with no changed trajectories. Its rosters contained
no Hydra and no Black Dragon. Hydra was banned in 135/300 drafts, Black Dragon in 129/300; the absence
therefore also occurs when these units are legal. M is withdrawn before its deciding screen for lack of
eligible actors in that prespecified board stream. Neither combat candidate qualifies for promotion.

Hypothesis: the new Hydra army blessing may make a legal Hydra choice better than the stale draft prior's
usual level-four pick. This is a full draft-policy comparison, not a forced post-draft roster substitution.
Candidate D uses current ranked A19 everywhere, but chooses Hydra when it is in its legally visible creature
choices. Otherwise it takes the exact current choice. It never changes bans, artifacts, unseen information,
creature stats or budgets. The resulting normal setup, synergies, placement and splits respond to its army.
Both combat experiments S and M remain disabled. The opponent always uses the current draft policy.

Freeze source, the static current server profile and this rule before evaluating outcomes. No score/weight
is tuned on the data. Reuse playRankedDraftGame and the existing four-game draft-assignment/physical-seat
crossover. Normal, Lava and Block receive equal independent offer-board counts. Confidence uses complete
four-game army clusters; outcomes score win 1, draw 0.5, loss 0. Both decisive and draw-aware rates are reported.

- A/A: 24 offer boards / 96 games, seed 2026102410, preference disabled; require exactly 50%, zero rejected
  actions, plus exact omitted/disabled-override trajectory tests.
- Screen: 300 fresh offer boards / 1,200 games, seed 2026102411, preference enabled. No optional stopping.
  Require the two-sided 98.75% clustered bootstrap interval wholly above 50% and exact two-sided cluster
  sign-flip p <= 0.0125, with zero rejected actions. This is a deliberately stricter alpha allocation than
  S/M, reserving room for up to four tested hypotheses in the broader exploration.
- Confirmation: only after the screen passes, 2,016 fresh offer boards / 8,064 games, seed 2026102412.
  Require the same interval and sign-flip gates, a draw-aware score >=51%, no map below 49% point score,
  and zero rejected actions. No retuning or pooling screen and confirmation to meet a threshold.
- After confirmation: validate the exact public server draft path and normal quality checks, then compare
  production-budget latency/fallbacks on 120 fixed games, seed 2026102413. No fallback-rate increase >1pp.

Bootstrap: 20,000 whole-cluster resamples, random seed 19625140, quantiles 0.00625 and 0.99375. Exact sign
flips use the cluster score difference from 0.5. Archive all raw records, rejected/incomplete runs and the
frozen source identities outside Git. A passing screen alone does not authorize a default change or deploy.
