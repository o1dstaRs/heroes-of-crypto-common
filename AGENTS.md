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
