# Own-roster Empower setup research

The live A19 setup, `artifact-fit-v6:conditional-v1:sniper+t2a19`, never buys Empower.
The Premium cohort collector already observes all six augment axes; that coverage is not a trained
spending policy. This study addresses the runtime allocation separately, using the locked V3 draft,
current A19 combat, actual tactical splits, and the current setup as the control.

## Candidate and information boundary

`src/ai/setup/empower_setup.ts` defines three fully funded alternatives, Empower 1, 2 and 3,
for each five-, six- and seven-point budget. Funding comes from the less preferred physical damage
axis, the preferred physical damage axis, then Armor if necessary. Placement and Movement stay zero.
The control is the exact existing conditional plan, including its ordering.

The three learned heads predict paired score differences from the player's own six drafted creatures
and budget only. They receive no opponent roster, hidden picks, map, random seed, draft outcome or
battle outcome at decision time. A frozen positive margin retains the incumbent unless an alternative
has sufficient predicted benefit. Invalid or incomplete rosters retain the incumbent.

Eligibility requires an actual Empower beneficiary: offensive spell damage, Chain Lightning,
Fire Breath, Fire Shield, or Nightmare's Fire Wall. The latter captures the caster's magic bonus even
though its spell catalog multiplier is `NO_MULTIPLIER`. Healing, resurrection, control, crafted buffs
and the `MELEE_MAGIC` label alone do not establish a beneficiary.

## Registered measurement

Study `empower-funding-20261114T231900Z-v2`, registration
`c8a266a496d392ad7d9ead559df6a4ba3a4d61eb3dbc058c96a4f51ad077902b`, reserves
432 training boards, 864 qualification boards and 864 fresh confirmation boards. Each board covers
both draft assignments and both physical seats. Map and both doctrine schedules balance in 27-board
blocks. The independent inference unit is the offer board.

Training compares all four plans, chooses among the registered ridge penalties and margins on a
108-board internal validation split, then refits once on the training bank. Qualification and
confirmation use that frozen model. Neither internal validation nor cohort marginal win rates
establishes an improvement.

Each independent stage requires at least +0.5 percentage points of paired score gain, a positive
whole-board bootstrap 95% lower bound, no own-budget or map mean below -1 percentage point, at least
60 activated boards, and no illegal actions or unmatched controlled inputs. Confirmation opens only
after qualification passes. A failed stage cannot be rescued by a favorable subgroup or an adjusted
candidate on the same bank.

`empower_setup_research.ts` changes only the candidate's funded augments after the draft. It preserves
artifacts, opponent, doctrine, split stacks, supply, combat seed and the incumbent final formation.
Input and formation hashes verify that contrast. The incumbent formation context is intentionally
retained: the existing learned formation adapter otherwise excludes nonzero Empower. Any eventual
runtime integration must reproduce this behavior and receive its own routing tests.

`empower_setup_training.ts` validates complete paired interventions and physical seats. Exact no-change
interventions may reuse their deterministic control row; receipts distinguish reused rows from executed
fights. Sealed source exports run outside the shared working tree. Identical smoke traces on macOS and
Puffalo Linux precede combining host outputs. The node uses its root filesystem rather than the nearly
full shared scratch volume, with 16 low-priority workers; the local shard uses four.

## Audit and current status

The prior ledger audit covers 130 committed evidence/manifests/checkpoint files and the retired first
registration, including all eight raw and permuted channels of the contextual draft study's scanned
preimages. Both new and retired seed banks remain excluded from later studies.

The first registration was retired before fitting because the capability filter omitted Nightmare's
Fire Wall. Its partial training output is retained, its qualification and confirmation stayed closed,
and the corrected study uses fresh seeds. The earlier absent-feature hash serialization correction
changed instrumentation only. Neither correction was selected from battle outcomes.

Qualification failed. No model has been qualified, promoted or enabled, and the production setup
default remains unchanged. Working registrations, frozen source, logs and rows live in the ignored
client directory `game/core/tmp/empower-setup-20261114-v2`; the retired run is retained beside it.

The completed training bank contains 6,912 logical comparisons and 4,818 distinct executed fights.
Its internal split selected ridge penalty 0.01 and margin 0.01, then refit once. The internal gain was
+0.462963 percentage points with 16 switched army cases. It is selection evidence, not a fresh strength
result. `lockedEmpowerSetupResearchModel()` preserves the exact fit under
`src/simulation/checkpoints/empower_setup_20261114`; canonical model SHA is
`308dbc27429a16696778b4543d4130507f9246e0403b47411acd49a1b11c0c15`.

Execution assistance was scheduled from missing keys only. All 723 overlapping training rows matched
independently across hosts; repeated cold/warm controls also retained identical results and traces.
Qualification uses eight local and sixteen Puffalo actors, allocating complete 27-board blocks in a
five-to-three ratio. Host scheduling does not change source, budgets, model, banks or analysis gates.

The compact seed ledger is `docs/evidence/empower_setup_registration_20261114.json`. It also reserves
the retired first study. The frozen source manifest SHA is
`aa9572e1957d0f10b729cf2a3ba09d0f1942f1ee8422582388c41845cc460b3e`; the original fit-file SHA is
`a81f69d412ec1d739ca0218fa9fcf659c08a4e197083ca6311fb04ca95d053f5`.

After collection, analyze only the complete registered bank. From the common package:

```sh
study_dir="../core/tmp/empower-setup-20261114-v2"
python3 "$study_dir/collect_evaluation.py" qualification
bun src/simulation/empower_setup_analysis.ts "$study_dir/qualification.rows.jsonl" \
  "$study_dir/registration.json" "$study_dir/fit.json" qualification \
  "$study_dir/qualification.analysis.json"
python3 "$study_dir/verify_results.py" qualification
```

The collector preserves original worker files and hashes, rejects incomplete or duplicate banks, and
requires the frozen fit/source identities from both hosts. The independent verifier reconstructs model
selections, legal spending, paired scores, bootstrap intervals and every progression gate. Do not rerun
the fitter after qualification opens. Keep confirmation closed unless qualification passes.

## Closed qualification result

All 864 fresh boards completed: 6,912 logical rows and 3,802 newly executed fights. The other 3,110
rows exactly reuse unchanged controls. Current setup scored 51.171875%; the learned policy scored
50.911458%, a paired difference of **−0.260417 percentage points**, with whole-board 95% interval
**−0.795718 to +0.274884 pp**. It activated on 157 boards. The gain and positive-interval gates failed;
map, budget and activation gates passed. The independent verifier reproduced every paired difference,
model decision, legal spend, interval and gate. Confirmation remains unopened and its bank reserved.

`docs/evidence/empower_setup_results_20261114.json` preserves all board scores and identities. This fit
was not enabled. In training, funding Empower by reducing the preferred physical axis was especially
costly at budgets five and six. A separate continuation may test a different fully funded policy on
new qualification banks; these outcomes cannot qualify that replacement.

## Separate protected-axis continuation

`empower-protected-axis-20261114T212900Z` tests only Empower 1. It first spends the less-preferred
physical damage point, when present, then one Armor point. It never reduces the preferred physical
damage axis. The original three-level candidate, source helpers, failed result and unopened confirmation
bank stay intact. New helpers are named `empower_protected_axis_*`; the candidate remains research only.

The development bank deliberately reuses the earlier 432 training boards. An old row is reusable only
when its complete paid plan and reconstructed input hash match; receipts retain its original registration
and row hash. Both hosts re-executed all four cases of the first 27 balanced boards, matching all 216
control outcomes and input, formation and behavior hashes. Levels 2 and 3 are disabled zero-effect heads;
their fit labels are algebraic zeros, not extra battles or independent observations.

The continuation selects the same ridge/margin grid on a 108-board internal split with salt 2026111421,
then freezes one refit. Its 864 qualification and 864 confirmation boards are fresh and retain every
original score, safety, activation and confirmation gate. Registration SHA is
`209d7c172fbb8cde1256cc5550d25327087060700b21865640040ed3144dd7c7`, frozen source manifest SHA
`74becb6020ec7fefa738aa73fd840dbc82b0237ae2b646e130867bddcd86df16`. The concurrent Magic Dragon study's
476,928 reserved channels were also checked, with zero overlap; its manifest SHA is
`fdf86b23914433b19fed83cc314e2f180357e1cff94bdf83f300667924987d19`.

Training completed: 3,456 logical rows, 704 new battles and 2,752 independently verified prior rows.
The internal split selected ridge 0.01 and margin 0.01 (+0.694444 pp, 30 switched army cases); this is
not independent strength evidence. The frozen model SHA is
`96750442dcf7d489f13db0334b39b9ead3b4e8d16da7c039857aeb7a8dcbd721`, preserved by
`lockedProtectedAxisEmpowerResearchModel()`. Raw qualification outputs remain under ignored
`game/core/tmp/empower-protected-axis-20261114`. Twelve local actors handled seven of every eight
balanced blocks; eight low-priority Puffalo actors handled the rest, leaving capacity for the node's
other studies. No live model or default changed during this research.

## Closed continuation result

The protected-axis candidate also failed qualification. All 864 fresh boards completed: 6,912 logical
rows, 3,902 newly executed fights and 3,010 exact unchanged-control reuses. Current setup scored
50.434028%; the learned policy scored 50.622106%, a paired difference of **+0.188079 percentage points**.
The whole-board 95% interval was **−0.347222 to +0.737847 pp**. It activated on 210 boards. The minimum
gain and positive-interval gates failed; map, budget and activation gates passed. The independently
implemented verifier reproduced every model choice, donor plan, paired score, interval and gate.

`docs/evidence/empower_protected_axis_results_20261114.json` preserves all 864 board scores, source,
model and collection identities. Confirmation stayed closed and its seeds remain reserved. Neither
candidate is eligible for default activation. The favorable seven-point subgroup is exploratory and
cannot qualify this failed overall policy. Do not alter its margin, funding or features and retest on
the same qualification bank.

The separate server correction routes human Premium build advice and Tier-2 artifact advice through
the current default AI setup profile, while preserving explicitly injected policy overrides. Empower
explanations name actual magic-damage beneficiaries, including Nightmare's Fire Wall. This routing fix
was deployed to test, knowledge and production services; it does not enable either research model or
replace the existing Premium SQLite snapshot. The report's six-axis coverage and these observational
rows remain separate from independent policy qualification.

## Public-context continuation, 2026-11-15

The user requested continued work after both earlier candidates failed. Study
`empower-public-context-20261115T013200Z` retains one-point protected-axis funding and tests a new
selector using complete public opponent identities, the public placement map, own artifacts, own
roster and the full doctrine budget. Opponent artifacts, upgrades, stack amounts, formation and live
engine objects are excluded. Private or incomplete setup and partially spent budgets keep the incumbent.

The 2,160 development boards combine the original 432 training boards and both already-opened
864-board qualification banks. Those old results are explicitly development evidence for this new
hypothesis; they cannot qualify it. Reuse requires an identical paid plan and reconstructed input hash,
with original file/line/hash provenance. Both initial hosts reproduced 216 controls, including outcomes
and action traces. Only missing interventions are simulated. An independent Python implementation
reconstructs every feature and funded plan from the public creature catalog.

Fivefold selection groups whole boards. The registered recipes compare five ridge penalties, six
shallow forest configurations and four positive margins. An eligible recipe needs at least +0.5 pp
mean gain and three positive folds. The highest eligible mean is refit once. This is development
selection, not independent strength evidence. Actor source and inference helpers are sealed separately
from the fitter and analysis code.

New qualification and confirmation each reserve 1,728 boards, retaining +0.5 pp mean gain, a positive
whole-board 95% lower bound, all budget/map safety gates and at least 60 activated boards. Confirmation
opens only after qualification passes. Registration is
`896fdd2c2ee97e1a9b5bd5192aee5991c56866ddc0932679fdd09ec1f48bcb17`, source manifest
`4894253a0c16d522ba7076878252d2dff59fd0845c3a9df8f8309e3864ee043d`. Reserve every channel in
`docs/evidence/empower_context_registration_20261115.json`. Raw output is under ignored
`game/core/tmp/empower-context-20261115` in the client. No default changed. A concurrent draft/setup
adoption requires checking the new combination before applying a result measured on locked V3 and
the current conditional setup. Both older failed fits and closed confirmation banks stay unchanged.

The continuation finished all 17,280 development rows. Exact prior inputs/plans supplied 14,052 rows;
3,228 new fights supplied the missing interventions. Independent reconstruction checked every feature,
funded plan, paired input and reused source record. None of the 44 cross-validation recipes reached
the registered +0.5 pp development threshold. The highest mean was +0.219907 pp; a different recipe
was positive in all five folds but averaged only +0.202546 pp. No final model was fitted, qualification
and confirmation stayed unopened, and no runtime changed. Preserve
`docs/evidence/empower_context_results_20261115.json` and all reserved channels. The concurrent adopted
A19 draft/ranged policy is a new baseline for further research, not a reason to reopen these banks.

## Allocation continuation on adopted A19

`empower-allocation-adopted-20261115T021200Z` compares six fully funded alternatives: Empower L1/L2/L3
paid from spare physical damage followed by either the preferred physical axis or Armor. Its baseline
is the newly adopted contextual draft and ranged setup, prepared through the authoritative server.
It retains that baseline's real support splits, spell charges, final formation and barrels. Existing
paid Placement plans and manual builds remain unchanged. Every activated contrast therefore shares
the same free formation and spend limit. All selectors see only public setup and owned information.

The new bank contains 648 development boards and 1,728 fresh boards for each later stage. Prior open
Empower data may supply auxiliary training labels, but recipe selection scores only held-out boards
from the new adopted policy. Eight ridge recipes and three margins use whole-board fivefold selection,
with the unchanged +0.5 pp development threshold and three positive folds. Qualification and confirmation
retain the +0.5 pp mean, positive 95% lower bound, budget/map safety and minimum-activation gates.
Neither fresh stage may open without a fixed eligible model and complete prior-stage verification.

Reserve `docs/evidence/empower_allocation_registration_20261115.json`, registration
`72d5d0a369f569dac42cbbc0f2d783422086d5cd4b60564cadd2dcf1bdd6ff20`, source manifest
`b432a6a63a39de33ee4869ac0856ce11c645e47c6a57ab77bfdab49f2ccd4a82`. The source snapshot records the
server adoption overlays explicitly. Results must not be deployed if the eventual serving implementation
differs. Native formation compatibility needs a narrowly matched runtime adapter before any promotion.
The raw campaign lives under ignored `game/core/tmp/empower-allocation-20261115` in the client.
