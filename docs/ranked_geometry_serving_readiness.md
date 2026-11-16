# Serving readiness for the confirmed geometry planner

The independent geometry checkpoint is preserved in `cb5ee84a`; its fixed 324-family
confirmation gained +2.083333 points, whole-family 95% +0.848765 to +3.395062.
See `ranked_geometry_confirmation.md`. That strength result does not make the
expensive offline planner a live default.

`src/simulation/ranked_geometry_exact_search.ts` preserves its exact score-bound
scheduler and identical-applied-state shortcut for further research integration.
It is outside the serving API. A score callback supplies only requested hypothetical
fight scores, each 0, 0.5 or 1. It retains the original 0.03 margin, positive gain
in both future blocks, strict highest mean and earliest-plan ties. If even all
remaining wins cannot select a plan, its remaining fights are skipped. Callback
errors propagate; a deadline must not silently turn a partial search into a decision.

The geometry shortcut requires six complete consumed-input SHA-256 keys, with
the same frozen runtime, scoring seat and combat seed, and an unchanged opponent
across the alternatives. Positions alone are not sufficient: quantities, spell
charges, purchases, artifacts, terrain and all other consumed battle fields matter.
If all six applied inputs are identical, keeping current preserves the applied
state. In that case the helper explicitly does not claim the same internal plan index.

The independent archive audit covered all 648 physical-seat contexts in the
completed bank. Score pruning preserved all 648 selector indexes; the combined
shortcut preserved all 648 applied battle inputs. Across 8,424 native opening
replays, distinct requests fell from 15,084 to 4,396, a 70.86% reduction. There were
313 identical-state early returns and 19 different internal indexes only within
those equivalent-state cases. These are archived operation counts, not measured
production latency or new strength games. The executable tests additionally cover
3,750,705 prefix/completion combinations and 20,000 complete score tables.

A separate CPU imitation pilot used 216 historical training families, 54 development
families and 54 reserved test families. It fit two linear ridge models and one
256-feature random-Fourier ridge model, locking all three before development.
All failed their registered teacher-imitation gates; the final test stayed closed.
The models and original gates are preserved outside Git in the campaign artifacts.
They are not default candidates and their hypothetical-label scores are not ranked
win rates. Python/Bun scores matched within 1.8e-15 with 324 exact development choices.

The native audit distinguishes changing a plan index from changing a formation.
The three models selected noncurrent plans in 86, 76 and 43 of 108 development
contexts, but changed complete applied states in 27, 23 and 11. The teacher selected
nine noncurrent plans and changed eight actual states. These posthoc diagnostics
do not overturn the failed gates.

Training-only inspection also found a target mismatch worth correcting before a
larger fit. The old teacher scores full funded proposals, while the confirmed
candidate applies their geometry with current spending. Across 432 training
contexts and 4,752 native preparations, 271 groups of identical current-spending
applied states had different full-plan mean labels. There were 279 current-equivalent
alternatives with nonzero full-plan labels, including 76 positive labels. All six
plans applied identically in 202 contexts. These findings do not invalidate the
confirmed geometry comparison; they explain why its full-plan value labels are
not interchangeable with the value of the final applied action.

An exact-input reuse pass recovered 13,404 current-spending labels from 3,108
existing fights across the 216 training families. Another 2,148 logical labels,
representing 1,824 distinct counterfactual fights, remain explicitly missing.
Every reused label matched the complete consumed input, combat seed and original
raw/source receipt. No new battles or fits were needed for this reconstruction.
The 202 fully covered contexts are the identical-state cases; dropping incomplete
contexts would therefore leave a misleading corpus of no-op choices. The fixed
missing-counterfactual manifest is preserved for a separately admitted collection.

The next data contract must label exact current-spending applied states, collapse
true equivalences, retain missing counterfactuals, and use only public Setup input.
Any fitted replacement still needs separately registered fresh current-source
strength evidence and authoritative timing, state restoration, Undo and budget
qualification. Current combat has advanced since the original frozen source.
No helper, failed fit, conditional label or operation-count result authorizes
changing the default, deploying or rebuilding Premium by itself.
