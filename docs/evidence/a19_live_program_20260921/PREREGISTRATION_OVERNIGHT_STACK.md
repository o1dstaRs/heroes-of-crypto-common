# Preregistration — the overnight stack against the live v0.8 a19 (P19)

Written 2026-09-24 ~18:05Z, before any result of P15, P17 or P18.

## The question
The owner's goal for the morning of 2026-09-25: at least +10pp head-to-head over the current v0.8 a19 — draft
v4-w16-r4, setup `conditional-v1:sniper+t2a19`, SEE_NONE doctrine, production leaf, and (as live) the server's split
pass. Each of tonight's changes ships only on its own eight gates; this check measures what they add up to.

## Design (fixed now)
Candidate = every change that passed its own verdict tonight, combined. Opponent = the live stack above.
`ranked_draft_eval`, live draft rules, side board, deterministic a19, live synergy variants and split pass (the
harness as the live server plays), 8000 games, seed 99810001. If no change passes, the check is not run.

## Report (no new gate)
Draw-aware and decisive head-to-head with the clustered 95% interval, per map, rejections. Goal met when the
draw-aware score is at least 60.0%; stated with its interval either way. If the combination falls more than 3pp
below the largest single confirmation, the interaction is reported and the combination is not recommended until
understood.
