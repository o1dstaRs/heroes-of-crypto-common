# Barrel forecast regression audit

This is a read-only follow-up to the completed v10 qualification. It identifies what changed in
the old losses while preserving every gain and unchanged case. It does not change a strategy,
qualify another rule, or inspect the in-flight v11 confirmation's outcomes.

The [complete evidence](evidence/barrel_forecast_regression_audit_20261118.json) preserves the
3,024-case attribution ledger, independently reconstructed integer scores, fixed replay design,
observer corrections, returned-file hashes, final observer/analyzer/verifier source and limitations.
The original +1.488095-point result and all 166 worsened outcomes remain unchanged.

## Complete old-bank attribution

Independent Python and Bun reconstruction agree on all 756 families / 3,024 stock-mixture pairs:

| Result                                      | Cases |
| ------------------------------------------- | ----: |
| Improved                                    |   208 |
| Worsened                                    |   166 |
| Unchanged outcome                           | 2,650 |
| Identical full trace and recorded decisions | 1,461 |
| Changed full trace and recorded decisions   | 1,563 |

Every first recorded difference has the same actor and raw native proposal but a different final
choice. Both losses and gains include ordinary ranged retargets: 64 of the 166 losses and 73 of
the 208 gains first change between ranged attacks. A root-action restriction therefore cannot be
called a regression repair from this observation alone. The earlier failed useful-clear filter,
its erased gains and every closed forecast rule remain preserved.

Matching recorded decisions does **not** establish matching policy memory or complete engine state.

## Fixed diagnostic replays

Before the replay, select the first six `(board, game)` cases in each of four groups: worsened,
improved, unchanged with a changed trace, and identical control. All **48 final executions** reproduce
their original consumed input, full action/event trace, outcome, recorded turns and logical forecast
counts/witnesses exactly. There are no additional rollouts, model predictions or RNG draws.

The observer records the registered battle-snapshot fields, actual action/event prefixes, live random
draw prefix and UUID sequence. It also observes the existing candidate forecasts without enabling the
scored-decision observer, which can itself alter search work. Actual committed turns are authoritative;
the inner SearchDriver return is retained separately because an outer selector can change it.

All six sampled losses have matching checked prefixes. Twenty-two of all 24 pairs have matching
snapshot fields too. Two **improved** cases have different target memory before their first recorded
choice changes. The mismatch is retained and investigated below; those gains are not excluded.

Of 473 observed existing full-search samples, 417 end at exact **simulated** terminals. They still use
hypothetical chance and native future controllers. They are not calibrated real-game probabilities or
proof that one root action caused an eventual outcome. Some certified losing tails are skipped; returned
selection scores must not all be interpreted as fully observed sample means. Stock's barrel-boundary
hook is inactive, so its zero observed boundary counts do not establish no opportunity.

The first observer attempt compared in-memory optional `undefined` fields with parsed JSON, although
the original format omits those fields. Later attempts exposed that forced Berserker turns bypass both
A19 and the team-strategy override. The final observer covers the cached pinned v0.1 strategy too and
labels the two native-only roots explicitly. Every failed attempt, partial valid record, source and
transport receipt remains preserved. The final 48 executions finished before the **original**
November 18 00:56:02 UTC cutoff; no case, policy, gate or cutoff changed.

## Target-memory identity interaction

A separate four-execution diagnostic replays exactly the two identified old anomalies. Independent
Python and Bun verification reproduce all original controls and confirm:

| Old case | Actor    | First memory difference | First recorded choice difference |
| -------- | -------- | ----------------------: | -------------------------------: |
| 7 / 3    | Fairy    |                  turn 1 |                          turn 12 |
| 22 / 3   | Beholder |                  turn 8 |                          turn 11 |

At the first memory difference, both arms execute structurally identical native/chosen actions.
Stock's chosen observation array is a separate object; mixture reuses the native array. The frozen
engine's `decided !== decided0` condition consequently takes different memory-commit paths. Stock
records the attack target, while mixture lacks that actor's entry. This explains the observed memory
divergence, without proving that the memory difference caused the later win.

The current ranked server also uses an array-identity condition. It additionally restores the
incumbent-memory snapshot when search returns the same array; the simulator's ordinary non-shadow
path does not. A future correction must reconcile both paths and retain the native proposal's intended
memory for semantically unchanged actions, while retaining proper memory for real overrides, native-only
units, retries and failures. Do not silently fold a memory correction into an already frozen study.

No corrected policy was evaluated here. These selected diagnostics establish neither a new score gain
nor production latency. Any correction needs a distinct source, meaningful contract tests, complete
gain/loss admission, independent fresh strength and overall-average +10% cost checks. The unchanged v11
confirmation, both registered serial-cost matrices, earlier failed gates and serving default remain intact.
