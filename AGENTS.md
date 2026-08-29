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
Bring the branch you are standing on up to date with its remote **first** — `git fetch <remote> && git pull
--rebase <remote> <branch>` — before pushing, before opening or updating a PR, and before any deploy. Peers
push continuously, so "it was current when I started" is never true by the time you finish.

- **Resolve conflicts per HUNK, not per file.** `git checkout --theirs <file>` replaces the *entire* file and
  silently drops your unrelated edits elsewhere in it. Prefer `git merge -X theirs` / `-X ours`, which decide
  only the *conflicting* hunks and keep both sides' untouched work, or edit the markers by hand. Then verify
  both sides survived by grepping for a symbol from each — do not assume the merge kept them.
- **This package is consumed by pinned commit.** After pushing here, the client's submodule pointer and the
  server's `package.json` + `bun.lock` pins must be advanced to match, or those repos keep building against
  the old engine while their code expects the new one — which compiles and type-checks, then fails at runtime
  on a name the pinned engine does not have.
