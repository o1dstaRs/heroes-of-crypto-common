# Public map and synergy draft training

The user requested preserving the learned shooter setup result and training the AI to use the current game's synergies and map. This continuation retains the exact V3 draft and `d786f4e9` setup checkpoint as references. It changes no live default, creature balance, combat rule or locked research artifact.

## Information and mechanics audit

`getVisibleDraftMap` reveals the map to five-point Spymaster from the initial bundle. Every doctrine sees it from the first level-three phase. All four faction synergy variants are public from the first draft screen. The new feature extractor accepts the acting seat's `IDraftScoutingContext`; it never accepts a raw hidden map, game seed, opponent amounts, selected upgrades, positions or concealed picks.

The existing locked draft has map and continuation features but no active-variant features. Its server adapter passes `undefined` for the common scorer's variant argument. The default v4-w16-r4 policy has no variant residual active anyway. Passing variants alone therefore cannot supply the requested intelligence. The older setup model has variant flags but no explicit army-by-variant interaction features.

`draft_battlefield_context.ts` resolves distinct-creature 2/4/6 thresholds and reads powers from the same `SynergyKeysToPower` as `FightProperties`. Its movement, capacity, aura range, flying armor, ability power, supply, morale, luck and break values reproduce the authoritative engine. Split stacks do not create another distinct faction member. Revealed enemy synergy levels are lower bounds. Reachable own thresholds use only visible bans, known picks and remaining pick levels; they are possible continuations, not guaranteed future offers.

The new research head includes map-by-role and available-variant-by-role interactions, actual own synergy powers, reachable levels, public enemy movement pressure against shooters/casters, and aura-extended null-field pressure. Nature board capacity interacts with spellbooks, aura carriers and shooters across the whole allied army. It does not assume every split is beneficial or invent additional experience. The serving split planner, actual budgets and complete spellbooks determine the battle.

## Fixed policy and collection

The locked V3 policy makes its normal decisions and retains its own one-use override. One new outcome-trained override may select the alternative during bundle or level-one through level-four picks. The alternative creature comes from the existing role-safe coherent scorer without the forced four-shooter floor. A proposed alternative is still a legal visible offer; a learned margin decides whether to accept it. A failed collision consumes the extra override, matching the authoritative persistence rule. Later picks continue through V3. Neutral-head tests reproduce the complete draft, including retries.

Training reserves **4,320 independent boards / 17,280 fights**, each testing a single registered decision level with two physical mirror seats and reference/alternative arms. It balances all 16 public synergy combinations, three ranked maps, all nine doctrine pairs, two opponent populations and five decision levels. One candidate draft assignment is assigned independently per board; evaluation uses both assignments and both physical seats. Boards are selected by legal draft eligibility and required public variants before any fight outcome exists. Ordinary opponents use locked V3; pressure opponents use the preserved legal rush draft and fully paid Movement/Might plan.

Reference and alternative use the locked setup selector on both training arms, transferred onto the server's actual v0.8 `artifact-fit-v6:conditional-v1:sniper+t2a19` setup. The previous setup study used a different nonfight setup; its numerical gains are not carried over. Both seats receive actual support splits and final authoritative placement before barrels. All fights retain the same deterministic A19 R2 work caps and must finish by elimination with zero rejected actions.

Whole-board hashing reserves 1,080 training-bank boards for internal recipe selection. The fixed grid is ridge regularization 4/16/64 and margins 0.02/0.05/0.10. Fit the full-context head and a separately trained map/synergy-ablated head on the same examples. Select each recipe by its internal counterfactual score, then refit each once on the complete training bank before qualification. Internal recipe selection is not independent strength evidence.

## Prospective gates

Qualification reserves **1,728 new boards / 27,648 fights** across four conditions: current server-policy reference, locked setup with V3 draft, contextual draft with locked setup, and separately fitted context ablation. A further **1,728 boards / 27,648 fights** are reserved for conditional fresh confirmation. Every stage balances maps, doctrines, opponent populations and all 16 synergy combinations. No roster filtering forces a shooter army in the new population.

The full candidate must gain at least one percentage point overall with a positive family-adjusted 95% interval against both the server-policy reference and locked-setup reference. The two populations must retain at least −1 pp noninferiority at the adjusted lower bound, with nonnegative means. These six planned contrasts use whole-board stratified bootstrap, 20,000 resamples, fixed seeds and Bonferroni correction. Map and candidate-doctrine means must not fall below −1 pp. The context ablation is a prespecified diagnostic; a gain over baseline alone does not establish that context caused it.

Mean full-fight and total own-decision times must remain within +10% of both references. Only a successful qualification opens the fixed fresh bank; a failed finalist is not replaced. A successful fresh result requires a separate alternating serial timing check on reused qualification boards. None of these stages automatically activates the model on a server. Preserve all failures, old seed reservations and exact source/model identities. Eight low-priority main-thread CPU processes operate under a fresh research directory on the 9800X3D; live services and GPUs are untouched.

## Frozen registration

Study `contextual-draft-20261110T034659Z` binds committed policy source `2ab2617e51d234b623a38b8b287d45a2ba0a1f3e`, 709 source files and manifest SHA `eb6ff05c7b65e6e1ddbd7799d8db0422d48f920f2310b7a97f55fba4051a850e`. Registration SHA is `b3c86d9ed2b14858828a31f30f664dd3b8d7b3be42ff1e567f63b94a0d0ffc29`. The original input archive is 58,285,900 bytes, SHA `f092599b3e060787cb25b35986d6658d928a7358d3eeaa275864d52ae43a921d`. Local smoke verifies 40 reused training-arm records plus four zero-head A/A battles; it supplies no extra independent evidence.

[Compact registration and seed reservations](evidence/contextual_draft_registration_20261110.json) preserve all 7,776 board rows and 124,416 selected channels. The 125,416 scanned preimages expand to **2,006,656** new reserved channels, disjoint from 5,226,607 previous numeric values. For **every** `reservedScannedPreimages` value `p`, exclude `p+i` and `permuteRankedDraftSeed(p+i)` for `i=0..7`. Reading only the selected bank seeds does not exclude the complete reservation. The expanded-ledger hash and the complete uncompressed prior/final ledgers remain in the study packet.

Before independent training opened, a second research workload became active on the shared host. A separate execution amendment retains eight actors but lowers their priority from nice 10 to **nice 19** and their aggregate CPU quota from 800% to **400%**. It changes no policy, recipe, seed, contrast or gate. Amendment SHA is `39f4269ea88d49f2c56e0cf74d88f40068f8fb10a66d84b8c7b5aec419f9ba6e`. The original archive and orchestration seal are retained alongside the amended execution receipt. Timing comparisons must disclose these actual resource limits.

## Completed comparison

The run completed 17,280 training fights and all 27,648 qualification fights, finishing on **2026-11-11 at 03:36:33 UTC** (November 10, 7:36 PM Pacific). Qualification took approximately 14 hours 34 minutes after approximately nine hours of collection and fitting. Its 1,728 independent offer boards contain 864 ordinary and 864 pressure-opponent boards, both draft assignments and both physical seats.

| Condition | Wins | Draws | Losses | Draw-adjusted score |
| --- | ---: | ---: | ---: | ---: |
| Frozen server-policy reference | 3,091 | 74 | 3,747 | 45.254630% |
| Locked setup selector with V3 draft | 3,208 | 72 | 3,632 | 46.932870% |
| Full contextual draft with locked setup | 3,329 | 72 | 3,511 | 48.683449% |
| Separately fitted context-ablated head with locked setup | 3,325 | 75 | 3,512 | 48.647280% |

The fixed full model gained **+3.428819 pp** against the frozen current reference, family-adjusted 95% interval **+2.018229 to +4.868345 pp**, and **+1.750579 pp** against locked setup, interval **+0.687211 to +2.813947 pp**. All map and candidate-doctrine means were positive. Against pressure opponents it gained +2.965856 pp over locked setup, interval +1.533565 to +4.412616.

The registered progression gate nevertheless **failed**. The ordinary-opponent gain over locked setup was +0.535301 pp, with adjusted interval **−1.012731 to +2.112269 pp**. Its lower bound missed the predefined −1 pp noninferiority limit. Keep that failure exactly as registered: the reserved confirmation bank stayed closed, serial timing did not run and no model was promoted.

The context ablation was +0.036169 pp in favor of the full head, nominal 95% interval −0.448495 to +0.535301. This does not establish incremental strength from the new head's explicit map/synergy block. Both arms retain V3's existing information use and the shared setup selector; this comparison does not remove all map/synergy knowledge from the AI.

Observed concurrent full-fight time increased **1.656630%** against current and decreased 0.228591% against locked setup. Total own combat-decision time increased 0.951554% against current and decreased 1.030804% against locked setup. The draft phase itself increased 10.431555% against current. The registered compute gates concern full-fight and total own combat-decision time, not every phase individually. These are shared-host measurements; production serial timing remains unqualified.

As a separate diagnostic, mean time per own combat decision was 308.8393 ms for the full candidate, versus 310.4368 ms for current and 312.5126 ms for locked setup. The draft-phase increase was approximately 2.49 ms per game (23.87 to 26.36 ms). These diagnostics do not change the registered gates or establish production latency.

[Completed evidence](evidence/contextual_draft_results_20261110.json) retains every paired board total, all comparisons and descriptive diagnostics. Independent verification checked **44,968** manifest-listed node smoke/training/qualification records, all **709** frozen source files and all **4,320** paired training examples, plus the 40 matching local/node transport cases. It reproduced the six primary confidence intervals and the separate ablation interval exactly. Re-fitting both selected recipes on the saved dataset reproduced every weight exactly, maximum absolute difference zero. The read-only complete archive is 73,255,935 bytes, SHA `6af9c6e5c88367ee652825458942eeb28884d051cd3b2793fbbd984a911b25cf`.

`lockedContextualDraftResearchModels()` restores the full model `063a888e6e38fe4322e89385929ac8f21dcb7b7f0dd5db070cb46a44a95eeeba` and ablated model `be2bf950866cbb139e8f7cd284302f41f4a3fc61361743310e0729202443072a`. Keep both models, all four helper hashes, their numerical reference cases and the original failed gate unchanged. Future experiments need separate files, IDs and channels.

Descriptive usage shows mean native shooter count falling from 3.5972 to 3.5252, with four-or-more-shooter armies falling from 4,264 to 3,940 of 6,912 cases. The full head used its additional override in 2,468 cases. It committed before map reveal in 382 of 730 six-point overrides and 1,032 of 1,194 seven-point overrides. These counts motivate testing commitment timing; they do not demonstrate that waiting improves results. No map, synergy or unit subgroup from these diagnostics is promoted.

The source remains `2ab2617e`; subsequent Fire Wall and Arcane Aegis changes in `50491b14` are outside this numerical estimate. This study improves the measured draft/setup research policy with A19 combat, not native v0.9 combat. Existing production defaults, engine rules, balance, checkpoint history and seed reservations are unchanged.
