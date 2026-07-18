# Agent guidance

## Parallel agents / mainline workflow
Multiple agents run on this repo **at the same time**. Rules:
- **Always work on `main` (the shared working tree). Do NOT create git worktrees or branches.**
- **Never use `git stash`** (push/pop/apply) — it sweeps a peer's in-flight edits into your stash and
  restores a tree that never existed. To inspect pre-change behavior, read the committed version with
  `git show HEAD:<file>` instead of touching the working tree.
- **Never revert or discard files you didn't author** — no `git checkout -- <file>`, `git restore`,
  `git reset --hard`, or overwriting a peer's edits to "clean up" the tree.
- Each agent **owns and is responsible for driving/fixing its own changes** — the build may briefly be red or
  the working tree may churn because another agent is mid-edit; that agent will fix it.
- Stage and commit **only your own files** (`git add <paths>`, never `git add -A`); re-`git fetch` right before
  pushing. Expect your commit to land alongside others'. Verify with `bun test` (transpiles independently of a
  peer's in-progress tsc errors) rather than blocking on a shared `tsc`.
