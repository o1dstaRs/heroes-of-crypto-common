# Agent guidance

## Parallel agents / mainline workflow
Multiple agents run on this repo **at the same time**. Rules:
- **Always work on `main` (the shared working tree). Do NOT create git worktrees or branches.**
- **Never use `git stash`** (push/pop/apply) — it sweeps a peer's in-flight edits into your stash and
  restores a tree that never existed. To inspect pre-change behavior, read the committed version with
  `git show HEAD:<file>` instead of touching the working tree.
- **Never revert or discard files you didn't author** — no `git checkout -- <file>`, `git restore`,
  `git reset --hard`, or overwriting a peer's edits to "clean up" the tree.
- **Do NOT run `bun run build:proto`.** It is broken on Node 24 (`protoc-gen-js` plugin fails) **and** does
  `rm -rf src/generated` *before* regenerating — so it deletes every generated file, then fails, leaving the
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
