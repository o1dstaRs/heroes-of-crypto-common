# Guarded intercept research

The user clarified that the offensive counterstrategy should react to revealed shooters and damage
casters during ranked play. The closed Armor-funded movement study excluded mage-heavy armies and
kept drafting fixed. This continuation tests a guarded mobile draft change together with selective
free forward placement. It does not enable a new serving policy.

Status: **completed without a finalist; default unchanged**. All 1,431 distinct battles and 3,456
logical rows completed. Independent transport, input, score and whole-family bootstrap checks passed,
as did all 96 HTML report filter combinations. No confirmation bank was allocated or opened.
The closed capsule is `game/core/tmp/guarded-intercept-free-20261115` in the client; preserve its
`completion-receipt.json`, source seal, raw results and execution amendments. The separately owned
`ranked-geometry-confirm-20261115` campaign remains independent.

## Completed results

The primary population has 162 families and 648 paired draft-order/seat cases. Draws count as half a win.
Current behavior scored 59.336420% (381 wins, seven draws, 260 losses); the combined candidate scored
56.404321% (364 wins, three draws, 281 losses). All three experimental point estimates were negative.

| Candidate                              |      Score | Change vs current | Simultaneous 95% interval |
| -------------------------------------- | ---------: | ----------------: | ------------------------: |
| Free forward placement only            | 58.796296% |      -0.540123 pp | -1.622288 to +0.542041 pp |
| Guarded draft only                     | 56.018519% |      -3.317901 pp | -7.921560 to +1.285758 pp |
| Guarded draft + free forward placement | 56.404321% |      -2.932099 pp | -7.649357 to +1.785159 pp |

The combined candidate was +0.385802 pp versus guarded draft alone (simultaneous 95% -1.697531 to
+2.469136), and -2.391975 pp versus forward placement alone (-7.021681 to +2.237730). It failed the
prespecified +1 pp baseline and +0.5 pp component gates. All intervals cross zero: this is no established
gain, rather than proof that every conditional rush policy must lose.

Its five-, six- and seven-point means versus current were -4.166667, -1.157407 and -3.472222 pp.
Against current/shooter-biased/caster-biased opponents, the changes were -0.231481, -3.472222 and
-5.092593 pp. Pressure was unchanged. On the 98 baseline-visible mage-heavy cases, the combined
change was -2.551020 pp. Neither doctrine slices nor the mage population provide a qualifying rescue.
Opponent labels describe drafting styles and should not be mistaken for exact final compositions.

Melee contact with a shooter or damage caster occurred in 86.42% of combined-policy cases, versus
73.46% for current. Mean contact lap among cases that reached contact fell from 2.9055 to 2.4143;
enemy backline actions before contact or fight end fell from 8.5509 to 6.6929. Those mechanism changes
did not establish a final score benefit. Conditional contact metrics depend on survival/fight duration;
they do not isolate the causal cost of a particular unit replacement or formation change.

The independent verifier reconstructed every full battle input hash, all aliases and scores, unchanged
same-draft spending/bodies/enemy openings, and all 5,161 sealed files. A separate direct-sampling
implementation reproduced the five simultaneous bootstrap intervals. All battles had zero action
rejections, missing neural starts or model errors. The thirty extra correctness executions are excluded
from inference.

A concurrent engine commit, `dd8aff092c926089edad6508d12705c5fcc271cd`, routes ranged splash barrel
destruction through counterattacks. It landed after this study froze `3d4d28c4`; it is not a changed
strategy in this experiment, and these numerical results do not qualify that newer engine. The frozen
sources and closed failed candidate were not modified to incorporate it.

## Fixed policy and controls

Only the combined `guarded/free` candidate can advance. The four factorial arms are current behavior,
guarded draft only, free forward placement only, and both together. Diagnostic arms cannot become a
post-hoc finalist. All retain the adopted V3/contextual draft foundation, native authoritative setup,
placement/support rules, and v0.8 A19 H64/R2/K6 combat.

The draft overlay changes at most one non-bundle choice after three own types have been selected.
It needs at least two distinct publicly visible shooters/damage casters, or one such level-3/4 type.
The native choice remains when it is already mobile or the army already has two mobile offensive types.
A shooter is replaced only when two other own shooters are already present. Alternatives must retain
the intrinsic score within 5% of the native score scale and coherence within 0.1. Public Chaos Movement
threshold completions are preferred within that qualified mobile pool; otherwise the native picker
chooses among the qualified options. V3 and contextual override state remain separate from this flag.

At Setup, the same public threat condition and at least two offensive melee types are required.
Only the two fastest qualifying main stacks advance toward the opposing edge, within two lateral cells
of their native anchors. Qualification uses flight or at least five native placement-time steps;
these are not claimed to be the final augmented fight-start statistics. One-unit support pieces and
Craft/buff casters are excluded. Both bodies must qualify, and all moves must fit the legal own zone.
Every native augment, unit amount and split remains unchanged within the draft mode. The algorithm
does not inspect concealed enemy placement, augments, artifacts, stack sizes or future rolls.

Within each draft mode, enemy openings are identical. Across draft modes, the opponent may legally
react to changed revealed picks. Paired offers, maps, doctrines and random channels remain fixed;
this measures the full interaction rather than artificially freezing later opponent decisions.

## Measurement and admission

Registration SHA-256:
`356f98a9e4daae66d7144d7fc85fb12fbc267d4952ebac852dfe49bcbe23b98a`.
Frozen common is `3d4d28c4e7a3930f4b2230c30c96459c1fa25278`; server is
`0db1fde7100946f264b8b309a53d4fde1239150e`. All 5,161 source/dependency/harness files are sealed.

There are 216 offer families: 54 each against current, shooter-biased, caster-biased and fast-pressure
opponents. Three maps and all nine doctrine pairs are balanced. Two draft orders and two physical seats
give four dependent permutations, with four arms each: 3,456 logical rows and 1,431 distinct battles.
Only identical complete battle inputs within a family/permutation are deduplicated, with explicit aliases.
The first three opponent styles form the 162-family primary population; pressure is a safety check.

The unscored census found draft overrides in 142 families, forward changes in 63, and 73 active
mage-heavy cases. All three budgets have coverage. Three complete cases reproduced their exact inputs,
action/event traces and metrics in local cold processes and on Puffalo. Their controls also reproduced
the prior frozen adopted harness. Thirty correctness executions add no independent families.

Draw-aware scores average four permutations within each family. Twenty thousand stratified whole-family
bootstrap resamples, NumPy seed 151127, provide simultaneous max-standardized 95% intervals over five
contrasts: each experimental arm versus current, and combined versus each single-component arm.
The combined candidate must gain at least 1 percentage point over current and 0.5 over each component,
with nonnegative current-opponent and all-doctrine means, pressure no worse than -2 points, and a
nonnegative prespecified baseline-visible mage-heavy diagnostic. Passing development only permits a
distinct confirmation with at least 864 families and positive simultaneous intervals versus all three
controls. It does not authorize activation or a favorable subgroup rescue.

## Execution-only migration

After the original local partition completed all 717 battles, the remaining Puffalo queue was moved
onto its eight released local workers. The first idle-CPU detector could not establish quiescence and
restored its dispatcher without terminating a worker. A separate, recorded boundary method then stopped
only this capsule's dispatcher and queued a non-job marker behind each actor's current input. Each
immutable actor finished its complete four-arm case before reading that marker and exiting. The
expected boundary-only input errors in those actor logs are not combat rejections or failed outcomes.

All 202 completed remote cases were retained; the remaining 230 case keys were selected solely by
completion, without inspecting scores. The recovery runner differs only in its case-list input and
continues to verify every original sealed file before invoking the unchanged actor. Original raw files,
source hashes, seed channels, population, arms and statistical gates remain unchanged. See
`execution-migration-amendment-v2.json`, `migration-drain.json` and `recovery-registration.json` in the
capsule. The final consolidated remote partition contains its original rows plus separately named
recovery files; independent verification checks the complete union and transport hashes.

## Closed, unscored paid-reach prototype

`guarded-reach-20261115` precedes this capsule and closed before any combat outcomes. Its census had
zero paid selections. Inspection found that server placement-time `getSteps()` does not include the
augments/artifacts applied at fight start, and extra Placement could change native split bodies.
Its coarse geometric proxy therefore cannot support claims about real funded reach breakpoints.
The original source, failed census and closeout receipt remain untouched. No paid policy was evaluated
or promoted by the free study.

The four-arm study uses those same outcome-unopened 216 families, explicitly for development. Its
unchanged free/draft components were frozen separately before any outcomes. This is not independent
confirmation of a policy selected after inspecting those families' covariates. Any later paid study
needs a public own-stat projection that includes the actual fight-start effects, accounts for changed
stack/spell capacity, and compares fully funded plans with an appropriate free formation.

## Reproducible seed exclusion

The allocation namespace is `guarded-reach-20261115-fresh-development-v1`. Take SHA-256 of UTF-8
`namespace:<counter>` for every counter 1 through 224 inclusive, interpreting the first four bytes as
a little-endian uint32 preimage. Conservatively reserve each preimage plus offsets 0 through 7 and
each corresponding `permuteRankedDraftSeed` value, including rejected scans. The accepted 216 families
use 3,456 channels; the original audit excluded 11,104,550 previous or reserved channels. The paid
prototype and free study deliberately share this unopened development bank; neither bank may be
reused as fresh confirmation. `reserved-channels.json`, `seed-admission.json` and
`exclusion-ledgers.json` retain the exact allocation and source hashes.
