# Current ranked meta collection

Use `ranked-current-a19-work` for a new default-policy study. It selects
`premium-ranked-current-v1` evidence (v7), runs the current server draft deciders,
and carries the V3, contextual and delivery override budgets across collision
retries. The sibling server is resolved relative to the source tree, or through
`HOC_SERVER_LOC`. Both server and common source bytes and dependency manifests
are recorded. Freeze both trees before running on a shared main checkout.

Install dependencies inside the isolated frozen trees, then link the frozen
server's `node_modules/@heroesofcrypto/common` to that capsule's common tree.
Preserve the installed package separately before replacing that dependency entry.
Do this only inside the owned capsule, never in the shared server checkout. A
separate installed copy has separate RNG/UUID/fight-state singletons, even when
its source bytes match. Bun runtime resolver hooks did not bind those imports in
the tested runtime. The adapter now checks real resolved paths and module identity
before any draft/setup; an unbound dependency fails closed. Repeat the identity
check after every install, which can replace the link.

The adapter uses the native public ranked Setup contract, funded purchases,
support splits, initial spellbooks, final formations and accepted barrel cells.
Every fight checks the applied opening before full A19 deterministic-work combat.
This is the v0.8 combat engine with current adopted draft/setup policies, not the
native untrained v0.9 combat model or a live deadline qualification. Optional
human bans are still skipped. Only ranked-draft exercises picking; six prescribed
cohorts use synthetic armies and artifact assignments.

## Keep populations separate

The native ranked cohort does not add exploration to default choices. Doctrines
are independently uniform per army. `premium-ranked-v4` remains the historical
V3/headless learning population with 20% exploration per eligible decision. Keep
its own profile, source, seeds, outputs and aggregates; filtering an exploratory
run for unchanged choices does not create a default-policy control. Neither
population supplies matched alternative-action labels or demonstrates a policy gain.

## Recovery and artifacts

Each completed seat-paired family is atomically written, synced and checksummed
under `pairs/`. To resume, use `AI_META_RESUME=1` with the **exact original** CLI
arguments and frozen sources. Live locks, foreign locks, corrupt records and
changed registration identities fail closed. Only missing original pair indexes
are scheduled. An in-flight incomplete pair may repeat; a durable complete pair
must not. Raw archives and summaries rebuild deterministically from saved pairs.
The shard driver retries the same window directory using this contract.

An artifact-only retry uses `ai_meta_outputs.ts` and runs zero fights. A completed
batch requires audited `premium.sqlite`, `premium-readiness.json` and
`ai-meta.outputs.json`. The production snapshot is never replaced automatically.
Raw archives remain necessary for full traces unless the snapshot was explicitly
built with `--include-traces`.

## Attribution and useful observations

Native purchases can change when armies swap physical sides. `army_fight` stores
each actual plan and W/D/L score. Upgrade-filtered retrieval uses those outcomes,
then clusters by the original family. Never assign the second fight's score to
the first fight's purchases. Native examples expose both fight observations
instead of a misleading single plan.

`setup_payoff` records first-decision effective stacks, quantities, spell entries,
movement/shots, active synergy levels and committed combat metrics by creature.
`trainingSetupPayoffs` admits only training families. Its payload is post-setup
diagnostic data, **not legal draft-time input**. Use the separate training draft
reader for projected pick observations. Adjacency is not measured aura benefit;
recorded damage attribution is incomplete; composition and items confound
synergy/upgrade associations. The raw-to-SQL audit checks every normalized setup
and payoff row.

The standalone report includes own-doctrine W/D/L and all nine doctrine matchups,
with cohort/map filters and whole-family uncertainty. Both armies are counted,
so pooled self-play is 50% by symmetry. No supported data means unavailable,
not zero strength. A 42-fight seven-cohort acceptance pilot checks contracts;
it cannot establish balance rankings or improvements.

## Before a large run

Run focused pipeline tests and a frozen-source acceptance pilot. Verify exact
replay across worker layouts, missing-case resume, raw/SQL identity, legal draft
visibility, native opening application, rejection counts and final HTML. Measure
disk bytes and elapsed time with capture enabled on the intended host. Include
space for checkpoints, raw archives, SQLite, verification copies and headroom.
Do not lower search budgets or silently change policy to improve throughput.
