# Agent guidance

## User-selected native v0.9 default

The user explicitly selected native v0.9 draft and combat as the default on 2026-11-05, after being told
that the embedded combat model is untrained. `DEFAULT_AI_VERSION` now selects `v0.9`; this does not promote
the learned combat artifact or claim a combat-strength gain. Preserve its anchor-only metadata and the
learned-model qualification gates. Existing encoded v0.8 seats retain A19. The `v09-native` AI-meta profile
uses the locked V3 draft, native v0.9 on both combat seats, and no A19 search. The older activation notes
below describe the earlier draft-only activation and remain historical evidence.

Use `bun fmt --no-script <paths>` for targeted formatting and add `--check` for a read-only check.
Do not invoke Prettier separately. `--no-script` avoids running this package's whole-source `fmt`
script when you only intend to format your own files. Keep the required build and lint checks.

## Locked v0.9 draft default

The user explicitly activated the improved model as the default draft for v0.9 seats. The immutable
`doctrine-draft-v3-20261104` checkpoint, weights, seed registration, evaluation evidence and decision
regressions live in `src/simulation/v0_9/checkpoints/doctrine_draft_v3_20261104/`. Use
`lockedDoctrineDraftModel()` from `src/simulation/v0_9/doctrine_draft_checkpoint.ts` to load it.
Use `createLockedDoctrineDraftResearchChoices()` from that module to reproduce its draft behavior;
create one instance per draft seat/game and retain it through collision retries.
Its initial development gain was 2.28 match-score percentage points over the original policy
(95% interval +1.20 to +3.38). Fresh, prospectively registered overall confirmation passed at
**+3.34 points (+2.20 to +4.49)**, with positive intervals for both five- and six-point doctrines.
The separate `overall_confirmation_20261105.json` fixture preserves that result, independent
verification and all 1,080 paired board scores; `lockedDoctrineDraftOverallConfirmation()` validates
and loads it. Keep V3 as a required comparison for further draft iterations; create a new checkpoint
rather than overwriting or refitting it. The V4 continuation failed to improve over V3 and is not promoted.

The server's `getRankedAiProfile("v0.9")` binds `selectV09DoctrineDraftChoice()` from
`src/ai/setup/doctrine_draft_policy.ts` to the fixed `ranked-unit-strength-a19-side-v4-w16-r4` candidate policy.
Its native v0.9 profile was separately qualified on 1,512 fresh boards / 18,144 battles: **+1.76
match-score points (+0.91 to +2.62)** overall, +2.78 for five points and +2.50 for six points;
seven-point decisions reproduce the original policy. The secondary information ablation measured
**+0.347 points (+0.025 to +0.694)** pooled. Individual doctrine information intervals cross zero.
`native_qualification_20261105.json` preserves both comparisons and every paired board delta;
`lockedDoctrineDraftNativeQualification()` validates it. The registered runner is
`src/simulation/v0_9/doctrine_draft_native.ts`; its source commit and seed banks are recorded in
`docs/evidence/v0_9_native_draft_registration_20261105.json`. Exclude these banks from future work too.

The server persists each seat's consumed override atomically with an accepted bundle, creature pick,
or collision reveal. Reuse that persisted state after retries/restarts. Refresh the pick between
sequential bundle decisions so the next seat can use the first bundle only through its legal projection.
Keep the 5/6/7 budget and visibility rules. This activation does not change `DEFAULT_AI_VERSION` or
the native combat artifact. The original model's `productionPromotion: false` is historical fit
metadata and must not be rewritten to express the separate runtime activation.

The draft default is not a newly qualified combat model. Its original additional
early-information gain was +0.42 points (0.00 to +0.84), so the original scouting-specific gate failed
and its confirmation bank stays closed. Preserve that distinction in reports. The user's request
explicitly authorizes these small versioned checkpoint fixtures; ordinary run output remains ignored.
See `docs/v0_9_doctrine_training.md` for the protocol, results and continuation requirements.
The separate prospective overall-strength confirmation is registered in
`docs/evidence/v0_9_locked_draft_overall_confirmation_20261105.json`. It compares the fixed V3
checkpoint with the original policy on V4's fresh development bank; it does not reopen or alter
the old failed scouting-specific experiment. The fresh overall result does not establish an incremental
scouting benefit on A19. Preserve both historical conclusions alongside the separate native qualification.
V4's complete seed registration is saved in `docs/evidence/v0_9_doctrine_draft_v4_registration_20261105.json`;
exclude every bank, including its unopened confirmation bank, from future campaigns.
The earlier target was ranked A19 (`a19-neural-r2-placement-v2`). The new native qualification uses
`artifact-fit-v6:v07-nonfight-4eda84635fe7`, native v0.9 combat without search, and live sequential
bundle commitments. Another profile still needs its own evaluation. New candidates must improve
over this locked default on fresh boards; never overwrite its weights or change failed studies retroactively.

## Parallel agents / mainline workflow

Multiple agents run on this repo **at the same time**. Rules:

- **Always work on `main` (the shared working tree). Do NOT create git worktrees or branches.**
- **Never use `git stash`** (push/pop/apply) — it sweeps a peer's in-flight edits into your stash and
  restores a tree that never existed. To inspect pre-change behavior, read the committed version with
  `git show HEAD:<file>` instead of touching the working tree.
- **Never revert or discard files you didn't author** — no `git checkout -- <file>`, `git restore`,
  `git reset --hard`, or overwriting a peer's edits to "clean up" the tree.
- **Do NOT run `bun run build:proto`.** It is broken on Node 24 (`protoc-gen-js` plugin fails) **and** does
  `rm -rf src/generated` _before_ regenerating — so it deletes every generated file, then fails, leaving the
  tree empty and destroying peers' uncommitted generated edits. The generated protobuf is **hand-maintained**:
  edit `src/generated/protobuf/v1/*` (`types.ts` / `types.d.ts` / `types_pb.js` + `creature_gen.ts`) by hand
  when adding a creature/enum. If generated files ever go missing, **hand-recreate** them — never `git checkout`
  to "restore" (that reverts peers' uncommitted work).
- Each agent **owns and is responsible for driving/fixing its own changes** — the build may briefly be red or
  the working tree may churn because another agent is mid-edit; that agent will fix it.
- Stage and commit **only your own files** (`git add <paths>`, never `git add -A`); re-`git fetch` right before
  pushing. Expect your commit to land alongside others'. Verify with `bun test` (transpiles independently of a
  peer's in-progress tsc errors) rather than blocking on a shared `tsc`.

## Sync with the remote before pushing, opening a PR, or deploying

Before you push, before you open **or update** a PR, and before **any** deploy, bring the branch you are
standing on up to date with its remote:

```bash
git fetch <remote>                       # check `git remote -v`; normally origin
git -c rebase.autoStash=false pull --rebase -X ours <remote> <branch> # the branch you are ON, not always main
```

Peers push continuously, so "it was current when I started" is never true by the time you finish.

**Remote changes take precedence in conflicting hunks.** During a rebase, `ours` is the upstream-based
history and `theirs` is the local commit being replayed, so use `--rebase -X ours`. For an ordinary merge
of the remote branch, the corresponding option is `-X theirs`. Preserve nonconflicting local work; never
replace whole files with `git checkout --ours/--theirs`, or use the whole-tree `-s ours` strategy. Resolve
any remaining conflicts per hunk with the remote intent taking precedence, then verify both the remote
change and unrelated local changes survived. Never stash a peer's edits to make the pull succeed.

**Deployment must enforce freshness across common, client, and server.** Sync before validation and
building. Record the branches and commits being built; fetch those same remote branches again immediately
before each upload. If a checkout, upstream, or remote commit changed, stop and rebuild from newly synced
checkouts. Never rebase after a build and upload the older output. Deploy only clean, published commits
through the guarded client/server deploy commands; manual rsync must not bypass them.

**This package is consumed by pinned commit.** After pushing here, the client's submodule pointer and the
server's `package.json` + `bun.lock` pins must be advanced to match, or those repos keep building against
the old engine while their code expects the new one. Re-check all three pins after every rebase or merge,
including the actual common checkout: the client's `ignore = all` submodule setting hides pin drift from
normal `git status`. Commit the server manifest and regenerated lockfile together, reinstall its dependency,
then rerun the affected checks before deploying.
