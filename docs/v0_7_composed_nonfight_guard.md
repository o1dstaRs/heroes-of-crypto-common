# v0.7 composed non-fight guard

This research-only guard composes the winning draft and setup policies only after
the two-lane non-fight campaign has a signed `complete_research_only`
`TERMINAL.json`. It never edits, bakes, promotes, or deploys a policy.

## Launch contract

The completed campaign commit and the guard harness commit are separate trust
anchors. Before launch, retain the campaign identities and artifact hashes in a
reviewed, read-only attestation outside both the source checkout and campaign
output. Capture that attestation when `TERMINAL.json` is accepted, not by
hashing mutable files in the launch shell. After the guard change is committed
and pushed, retain its reviewed commit in a second read-only attestation.

For example, the owner supplies `campaign.expected.env` with
`CAMPAIGN_RUN_SHA256`, `CAMPAIGN_TERMINAL_SHA256`,
`CAMPAIGN_CONFIG_SHA256`, `CAMPAIGN_PROVENANCE_SHA256`,
`CAMPAIGN_SOURCE_COMMIT`, `DRAFT_VERDICT_SHA256`,
`DRAFT_RUN_FINGERPRINT`, `SETUP_FINAL_SHA256`,
`SETUP_CHECKPOINT_SHA256`, and `RUN_ID`. `guard.expected.env` supplies
`GUARD_SOURCE_COMMIT`. Both records must be independently retained (for
example, owner-signed or append-only) and mode `0440`; the campaign output is
not the source of expected values at launch.

The value semantics are exact: `CAMPAIGN_RUN_SHA256` is the signed
`run.json` `.runSha256` field; `CAMPAIGN_TERMINAL_SHA256` is the signed
`TERMINAL.json` `.terminalSha256` field; `CAMPAIGN_CONFIG_SHA256` and
`CAMPAIGN_PROVENANCE_SHA256` are the signed run's `.configSha256` and
`.provenance.provenanceSha256` fields. `DRAFT_VERDICT_SHA256`,
`SETUP_FINAL_SHA256`, and `SETUP_CHECKPOINT_SHA256` are SHA-256 digests of the
exact raw file bytes. `DRAFT_RUN_FINGERPRINT` is the verdict's
`.runFingerprint` field. Commit and run ID values are their literal attested
strings.

Launch from clean, pushed `main` at `GUARD_SOURCE_COMMIT`:

```bash
set -a
source /absolute/attestations/campaign.expected.env
source /absolute/attestations/guard.expected.env
set +a

bun src/simulation/optimizer/v0_7_composed_nonfight_guard.ts \
  --out /absolute/outside-repo/composed-guard \
  --campaign-run /absolute/campaign/run.json \
  --campaign-terminal /absolute/campaign/TERMINAL.json \
  --campaign-run-sha256 "$CAMPAIGN_RUN_SHA256" \
  --campaign-terminal-sha256 "$CAMPAIGN_TERMINAL_SHA256" \
  --campaign-config-sha256 "$CAMPAIGN_CONFIG_SHA256" \
  --campaign-provenance-sha256 "$CAMPAIGN_PROVENANCE_SHA256" \
  --campaign-source-commit "$CAMPAIGN_SOURCE_COMMIT" \
  --guard-source-commit "$GUARD_SOURCE_COMMIT" \
  --draft-verdict /absolute/campaign/lanes/DRAFT/output/guard/verdict.json \
  --draft-verdict-sha256 "$DRAFT_VERDICT_SHA256" \
  --draft-run-fingerprint "$DRAFT_RUN_FINGERPRINT" \
  --setup-final /absolute/campaign/lanes/SETUP/output/final.json \
  --setup-final-sha256 "$SETUP_FINAL_SHA256" \
  --setup-checkpoint-sha256 "$SETUP_CHECKPOINT_SHA256" \
  --deadline-ms 1784306217027 \
  --run-id "$RUN_ID" \
  --workers 12
```

Replace `DRAFT` and `SETUP` with the signed lane names from `run.json`. The
harness verifies that these paths are the exact outputs named by the rendered
lane commands. The signed campaign repository and lane working directories may
be a different real checkout from the guard checkout; they must agree with each
other, while guard source provenance is bound independently. It also verifies
the draft run/state/signed guard reports and the
four targeted cohort evidence files, recomputes both draft guard decisions, and
recomputes the setup final/checkpoint decisions. All input bytes are copied
immutably into `OUT/inputs/` before seed scanning.

The guard requires `CAMPAIGN_SOURCE_COMMIT` to be a strict ancestor of
`GUARD_SOURCE_COMMIT`. It hashes and records the full binary diff and rejects
any changed path outside the explicit harness/support/test/documentation
allowlist. The signed campaign provenance remains bound independently; the
descendant contract does not rewrite or weaken it.

## Runtime and resume

The output directory has one atomic PID/start-identity owner lock. A second live
launcher fails; a dead owner can be reclaimed only when process identity proves
that it is stale. Every roster scan and fight runs only inside freshly spawned
sealed worker isolates, never the launcher isolate; this also holds for a
one-board run. Each worker's behavior environment, empty `execArgv`, Bun
transpiler cache setting, Bun executable hash, maps, and lap cap are bound into
the manifest.

Outcome-blind cohort selection persists `seed-plan.checkpoint.json` in chunks.
It stops early with an ineligible incomplete outcome when the reserved 30-minute
fight window is reached. Before `manifest.json` exists, a later invocation may
extend the deadline or change worker count/reserve while retaining the same
campaign, candidate, panels, runtime, source lineage, and seed-plan identity.
Once the ledger and manifest exist, deadline and worker controls are immutable
for the fight resume. No invocation may set a composed deadline later than the
signed campaign `hardDeadlineAtMs`; this run uses the exact preregistered
`1784306217027` hard stop.

Run2's draft lane stops search with a separate two-hour internal final-guard
reserve (expected search stop around 07:06 PDT and terminal around 07:30 PDT).
That reserve is intended to leave bounded time for this composed guard. If the
signed terminal arrives too late to complete outcome-blind preflight before the
30-minute fight reserve, or too late to finish fights by the hard stop, the
result is intentionally incomplete and ineligible. The operator must not extend
the deadline to recover qualification. A pool-level wall-clock timer terminates
in-flight worker isolates at the bound, including a worker that stops
responding, before the harness records the incomplete outcome.

Production mode cannot lower the preregistered 8,000 natural boards, 2,500
boards per named cohort, one-million scan allowance, 64 symmetry boards, or 8
replay boards. The completed setup campaign must contain at least 12,288
aggregate guard pairs and 4,096 pairs per diagnostic cohort. `--smoke` is an
explicit non-qualifying small run.

Qualification additionally requires at least 100 games and 50 decisive games
per named cohort. Candidate draw-or-Armageddon incidence must be no more than
one percentage point above a matched old-vs-old control evaluated on the exact
same natural boards.
