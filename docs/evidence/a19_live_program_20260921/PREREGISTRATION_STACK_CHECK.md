# Preregistration — final stack check for P9–P11

Written 2026-09-23 ~21:00Z, before any P9, P10 or P11 verdict.

## Why
P9 (Tier-2 table), P10 (Chaos synergy) and P11 (v4 prior at weight 16) are each measured against the stack live when
they were preregistered: v4-w8-r4 drafts, `conditional-v1` setup, SEE_NONE. Each ships on its own verdict, so the
combination of the ones that pass would reach the ranked bot unmeasured. Setup rules and the draft interact through
composition (the Tier-2 table and the synergy flip were measured on v4-w8 armies, not on w16 ones).

## Design
Once all three are decided, the combination of every passing change plays the pre-P9 stack (v4-w8-r4 +
`conditional-v1` + SEE_NONE) in `ranked_draft_eval.ts`: live draft rules, side board, deterministic a19 on both seats,
4000 games, seed 99930001. If only one change passed, this check is not run (its own confirmation already measured
it against this stack).

## Rule
The combination must beat the pre-P9 stack (draw-aware > 0.50) and come within 3pp of the largest single passing
confirmation. If it does not, the combination is reverted to the single change with the largest confirmation until
the interaction is understood. Seeds are never re-rolled.

## Execution note 2026-09-24 ~01:45Z, before any stack-check game and before P10's verdict
P9 and P11 passed, so the check runs. Because P10 is still confirming, both possible combinations are queued on the
same seed (99930001) so that no host idles: (a) v4-w16-r4 + `conditional-v1:sniper+t2a19` on hft, (b) the same plus
`syn-a19` on the shared node, each against v4-w8-r4 + `conditional-v1`. Which one counts is fixed by P10's verdict
alone: (b) if P10 passes, (a) if it fails. The other is reported as informational and never used for the decision.
