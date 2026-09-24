# Preregistration — re-fit the unit-strength prior on the armies the bot drafts now (P13, "v5")

Written 2026-09-24 ~05:05Z, before any P13 data was collected. Base: common main at the commit that adds the
collector's `--setup` option.

## Why
P7's re-fit (v4, fitted on armies r4 drafted) was worth +13pp with the weight at 8, and the bot has moved again since:
it now drafts with v4 at weight 16 (Wandering Mage in ~37% of armies, no Hydra) and sets up with the re-measured
Tier-2 table. v4 was fitted on r4's armies under the v07-nonfight setup. A prior fitted on the armies and setup the
bot uses today is the natural next step; P7 is the precedent for it working, v3 (2026-09-14) the precedent for a
re-fit that correlated 0.91 with its predecessor and gained nothing.

## Data (fixed now)
`collect_ranked_draft_strength_data.ts --policy ranked-unit-strength-a19-side-v4-w16-r4 --setup
conditional-v1:sniper+t2a19 --exploration 0.5 --boards 500`, 8 shards on seeds 99440001 + 5000·k (k = 0..7), 8,000
games; concatenated in shard order with offerBoard renumbered to 500·k + board. Nothing is filtered.

## Fit (fixed now)
`fit_ranked_draft_unit_strength.ts --id ranked-unit-strength-a19-side-v5 --lambda 4 --bootstrap 200` (v1's and v4's
settings). Registered outside main as `…-v5-w16-r4` (weight 16, floor 4 — today's default's structure).

## Evaluation (incumbent = policy:ranked-unit-strength-a19-side-v4-w16-r4, the live stack)
- Selection: v5-w16-r4 vs v4-w16-r4, 2000 games, seed 99790001; continue only if draw-aware > 0.505.
- Confirmation: 8000 games, seed 99840001. Robustness: candidate and v4-w16-r4 vs pool `reference`, seed 99850001.
- Both seats `conditional-v1:sniper+t2a19` and SEE_NONE. Gates: the eight of verdict.py.
PASS -> v5-w16-r4 on main and as the server default; rollback `HOC_DRAFT_WEIGHTS=…-v4-w16-r4`. Seeds never re-rolled.

Prediction, written down so it can be wrong: v5 correlates above 0.85 with v4 and gains 0–3pp — a smaller step than
v4's, because v4 already saw this era's balance.
