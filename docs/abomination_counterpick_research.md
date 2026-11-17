# Abomination counterpick and protection research

The user suspects Abomination was an important counterpick in the November 17 test-server game.
This is a separate, fixed exploratory study against the adopted v10 default. It does not reopen the
closed counter-shot studies or reverse the historically qualified Abomination protector release.

The public replay records at least 332 HP absorbed by Flesh Shield. The exact private RNG and draft
decision history are unavailable, so this is evidence of useful protection, not proof that another
legal pick would have lost. Physical damage redirects through the owner's armor and finite HP;
spells, Fire Breath and Chain Lightning bypass it. Existing physical-only and target-health-cap tests
passed: 31 tests, including physical responses, multi-hit cancellation, splash, armor and overflow.

Registration `182bdfbba220f1fec20c710ace2195000bda03e38e830966008d65172786dacf` freezes 54 new draft
families, both physical seats, one matched combat future and six arms: current native behavior,
prefer another offered unit, prefer Abomination, Abomination with existing guard duty, free placement
maximizing shield coverage, and that formation with guard duty. Total: 648 screen fights. All three
maps, all own/opposing doctrine pairings and both pick orders are covered. Selection examined 83
drafts without combat outcomes. Hidden pick collisions remain real retries; choosing an apparent
offer does not guarantee acquiring it. No hidden identities or future offers enter decisions.

Formation changes preserve the actual funded setup, splits, enemy placement and native barrel
placement stage. They use exact aura geometry and only the accepted own army and paid placement zone.
The existing stable ranged/caster value ranks protected allies. More absorption is a mechanism metric;
only completed battle outcomes measure strength. A packed formation may expose allies to splash.

Five comparisons and descriptive matchup groups were specified before combat. Analysis averages both
seats within each independent draft family and uses 20,000 whole-family bootstrap samples, reporting
ordinary and simultaneous intervals. Favorable subgroups cannot qualify a live dispatch rule. Any
candidate needs new confirmation against current behavior before a strength claim or promotion.

Sources are common `997490ee10c64f7379396c869c4d7976fddb04dc` and server
`51b2f9530d28557337a0acd62b6d65d3f86b8837`. The ignored capsule is
`game/core/tmp/abomination-counterpick-20261117` in the client repository. The source, registration,
seed exclusions and analyzer schema errata are preserved in
`docs/evidence/abomination_counterpick_registration_20261117.json`.

The bank is reserved even if unfinished: namespace `abomination-counterpick-20261117-fresh-v1`,
counters 1 through 20,480, with 32 raw and 32 native-permuted channels per scanned preimage, including
unused and rejected seeds. No automatic promotion, outcome-based retuning or deadline extension.

## Completed screen

All 648 battles passed legality, health-ledger and neural checks. Independent integer calculations
reproduced the family-bootstrap results. All 18 fresh cold repeats and 12 reused smoke traces matched
across the Mac and 9800X3D host. No default was changed.

| Comparison                                                      | Paired score difference | Ordinary 95% interval |
| --------------------------------------------------------------- | ----------------------: | --------------------: |
| Prefer Abomination versus another offered unit                  |                -7.41 pp |       -21.30 to +6.48 |
| Guard duty versus normal Abomination play                       |                -8.33 pp |       -17.59 to +0.93 |
| Free shield formation versus normal Abomination play            |                -0.93 pp |      -12.50 to +10.19 |
| Formation plus guard versus normal Abomination play             |                +0.46 pp |       -9.72 to +10.19 |
| Formation plus guard and Abomination pick versus native default |                -7.87 pp |       -21.30 to +5.09 |

All simultaneous intervals also include zero. The native default won 52/108 cases; the combined
candidate won 43, drew one and lost 64. This screen provides no overall improvement.

Coverage increased from 61.2% to 100% of the existing ranged/caster value proxy, but that did not
translate into more wins. Mean own shield absorption rose from 219 to 299 HP with formation plus
guard; Abomination died by round two in 53/108 cases instead of 22/108. Its mean outgoing damage fell
from 114 to 30 HP. These are descriptive mechanisms, not isolated causal attributions.

A post-hoc intersection of 24 families with at least two revealed ranged units and no revealed
magic-damage-capable creature scored +8.33 pp for the combination against native, ordinary 95%
interval -8.33 to +25.00. This is an uncertain hypothesis, not a qualified dispatch rule. Picking
Abomination alone was neutral in that slice; guard alone and formation alone were negative.
A separate fresh targeted validation is being registered under
`abomination-physical-counterpick-20261117`; the original bank remains closed.

Full results, source identity, raw-result hashes and verification receipts are preserved in
`docs/evidence/abomination_counterpick_result_20261117.json`. The ignored capsule also contains
`report.html`, including the human match's opening diagram and all registered comparisons.

## Fresh targeted validation

The new protocol is registered as
`23be7c8f621ad8ff66105f3d4798123f76ef5d86b1d50ddcb41f12df9ea97917`. It freezes 108 independent
eligible draft families, both seats and three arms: native default; the contextual Abomination pick
with ordinary play; and that pick with the unchanged shield formation and guard contract. The bank
contains 648 battles. The candidate must gain at least one point over native and have positive
simultaneous lower bounds against both controls. No automatic activation follows a pass.

Eligibility is evaluated at the first public Abomination offer: at least two revealed ranged units,
no revealed creature with magic-damage capability, and at least two own ranged/caster units. Absence
from revealed information is not proof that the enemy has no magic. Later hidden picks remain in the
sample; the policy cannot remove a game or revise its trigger using those future identities.

Two qualifying offers were selected per map/doctrine pair/pick-order stratum. The initial pool had
no eligible offers in Block / seven-point versus five-point / first-pick. Before any battle, its
eligibility search was extended by 192 already-reserved unused draft bundles; 507 drafts were
examined in total. All 108 selected families satisfy the public trigger. Independent checking found
no intersection across their 34,560 used/reserved channels and the earlier seed ledgers.

The exact sources and all scanned preimages are preserved in
`docs/evidence/abomination_physical_counterpick_registration_20261117.json`. The namespace is
`abomination-physical-counterpick-20261117-fresh-v1`, counters 1..20,480, with the same 32 raw and 32
native-permuted channels per scanned preimage. Every unused and rejected channel remains excluded.
The fixed cutoff is November 17, 22:15 UTC. No outcome-based tuning or extension is permitted.

### Fresh result: rejected

All 648 targeted battles completed, with 108 independent families / 216 paired cases. The nine cold
cross-host repeats and six smoke repeats matched full opening, draft, result, turn, event and health
traces. Independent integer calculations reproduced the scores and bootstrap intervals. All three
registered strength conditions failed. The default remains unchanged.

| Policy                                      | Wins | Draws | Losses | Draw-aware score |
| ------------------------------------------- | ---: | ----: | -----: | ---------------: |
| Native default                              |  105 |     5 |    106 |           49.77% |
| Contextual Abomination pick, ordinary play  |   79 |     3 |    134 |           37.27% |
| Contextual pick, shield formation and guard |   89 |     2 |    125 |           41.67% |

| Registered comparison                       | Paired difference |    Ordinary 95% | Simultaneous 95% |
| ------------------------------------------- | ----------------: | --------------: | ---------------: |
| Combined tactic versus native default       |          -8.10 pp |  -16.44 to 0.00 |  -17.59 to +1.16 |
| Combined tactic versus ordinary Abomination |          +4.40 pp | -2.55 to +11.57 |  -3.47 to +12.50 |

The combination improved the point estimate for _using an already selected Abomination_, but did not
justify its draft opportunity cost against the current choices. This distinction is important:
the controls separate picking the unit from handling it. The +4.40-point estimate remains uncertain
and is not permission to enable the formation/guard policy by itself.

Mean shield absorption increased from 207 to 291 HP, while Abomination's mean outgoing damage fell
from 148 to 48 HP. It died by round two in 100/216 combined-policy cases versus 58/216 ordinary cases.
More covered assets and more absorption therefore do not by themselves prove better overall play.

Post-hoc checks did not rescue the rule: its point estimate versus native was negative with all six
enemy identities known, with Magic Dragon known banned, with at least three revealed shooters and
with at least three own shooters. These checks are descriptive only; they do not become new rules
or justify further tuning on this bank. Dedicated Healer support is underrepresented: zero families
in the broad bank and one in the targeted bank. Paid Placement and coordinated frontline protection
were not independently qualified by these experiments.

Both studies are closed. Preserve every losing arm, unused seed and failed gate. Results and raw-file
hashes are in `docs/evidence/abomination_physical_counterpick_result_20261117.json`. The user match's
332 recorded absorbed HP remains evidence of useful human play, not proof of an optimal counterpick
or a reliable AI dispatch condition. A new candidate needs a distinct protocol and fresh channels.
