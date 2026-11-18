# Caster pressure and the retained screen wait

The shoot-only ranged-output feature omits offensive spellbooks. That does not establish that a
screen wait produced by it is a tactical error. A current-v13 observation found nine such waits
while an enemy non-shooter retained offensive spells: A19 replaced eight and kept one. The
separate, fixed `a19-caster-wait-counterfactual-20261118` probe investigates that retained decision,
using the committed v13 server and its native common dependency. No serving policy changes.

The exposed development case is `fresh-m1-d12-f000-seat1`, setup seed 4120914536 and terrain seed 1584809577. At actual SearchDriver decision 13, a team-1 Hyena waits on lap two. The shoot-only
resource proxy is 16,039 versus 5,948, and the enemy Magic Dragon subsequently casts Lightning
Strike before the Hyena's next action. The native retained-wait continuation nevertheless wins.
The fixed probe enumerates six ordinary native move destinations plus defend, using the actual
root context, and substitutes each once through the authoritative engine. Both sides then retain
unchanged full A19 continuations. All alternatives share the starting native random stream; their
actions can change subsequent draw consumption. This is one exposed scenario, not independent
strength evidence or a policy allowed to read future outcomes.

| Root action / move anchor | Native result for the Hyena's side | Actual SearchDriver decisions |
| ------------------------- | ---------------------------------: | ----------------------------: |
| Existing wait             |                                Win |                            47 |
| Defend                    |                                Win |                            77 |
| Move to (6,6)             |                                Win |                            43 |
| Move to (7,6)             |                               Loss |                            75 |
| Move to (8,6)             |                               Draw |                            66 |
| Move to (7,5)             |                               Loss |                            52 |
| Move to (7,7)             |                                Win |                            79 |
| Move to (7,8)             |                               Loss |                            62 |

All seven alternatives were executed. Every outcome-changing alternative was re-executed
exactly, including full final state, journal and target-memory observations. The six
moves therefore contain two wins, one draw and three losses; these correlated alternatives must
not be reported as a measured win rate. No alternative improves the native win on this one stream.
Fewer decisions in one winning branch do not establish a CPU saving, better expected play or a
generalisable move rule. Other legal board moves and other chance streams remain untested.

Before interpreting alternatives, the untouched control reproduced the complete original exposed
v13 outcome. Enumeration plus detached observation reproduced it again. A separately cloned wait
also reproduced it, with every target-memory binding unchanged; only the declared array-reference
flag differs at the intervention. Every counterfactual preserves every captured pre-action physical
field and journal prefix, all funded opening state, native RNG/UUID state during enumeration and
the model/search identities. Each substituted root command is accepted by the real engine.
All fourteen full games finish without quality errors and contain 850 actual SearchDriver
decisions. Neither hypothetical policy calls nor replayed labels inflate that denominator.

Independent verification checked all 2,990 frozen source bindings, 34 content hashes, complete
original/control/clone outcomes, all pre-action states, authoritative journal winners, root command
acceptance and all four changed-outcome replays. The [compact evidence](evidence/a19_caster_screen_counterfactual_20261118.json)
retains all fourteen execution summaries, exact channels, bounded actions and verification receipts.
The full source/raw archive has SHA-256
`2734fa7d7ef3c8b58acf6df3de227c497fa54d852d4926d62ef538096ca9a471`,
43,324,338 bytes and 3,011 verified regular members. Every member was independently hash-checked
locally and in its Puffalo backup. The original source and all losing alternatives stay preserved.

The probe closes without a demonstrated missed win, candidate policy, fresh bank, CPU
qualification, model change or deployment. Caster-aware timing remains a possible research topic,
but a feature omission or a following spell cannot by itself justify replacing these native waits.
Any further policy needs a distinct actual opportunity, current-v13 and appropriate matched
comparisons, independent fresh strength evidence and the overall-average +10% complete CPU and
weighted CPU per actual decision gates. Keep the Sniper guard and all earlier closed studies intact.
