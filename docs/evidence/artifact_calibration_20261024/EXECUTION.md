# Frozen execution identity

Research only; no fitted table is enabled by this record. See [PROTOCOL.md](PROTOCOL.md) for the fixed
fitting and fresh-strength gates. Generated evidence stays outside Git in the client workspace at
`game/core/tmp/artifact-calibration-20261024`.

- Common source commit: `b2e67f429393a01de5d7f1fd1913bbd5b693c6ae`.
- Complete frozen source SHA-256:
  `b8a47746af6476c083ab2c4f2f5c5899bf269139ebbee07a0d61bdd8c8fd1426` (1,437 tracked files).
- Bun 1.4.4 on macOS arm64 and the Linux x64 9800X3D. Source and static server-profile captures are
  copied research snapshots; the live shared working tree is not the runtime.
- Both hosts matched all 36 complete smoke-game records and all 96 complete A/A records exactly,
  including outcomes, setups, action hashes and rejection counts. A/A scored exactly 50% with zero
  rejections. An initial local smoke before final harness hash checks was retained as excluded pilot
  evidence; the final identical-seed smoke was rerun before training.
- The draft-only preflight observed 300 scenarios, 292 with at least two native ranged creatures among
  their five own picks. Every live artifact has at least 39 observations in each training fold, above
  the registered minimum of 12. No combat outcomes informed that coverage check.
- Training is divided into fixed disjoint board ranges: local boards 0–89 with 12 workers; remote
  boards 90–149 with eight workers. Both run at nice 10. The complete union is 150 boards / 1,800 fights.
  The collector rejects missing, overlapping, incomplete or mismatched shards before fitting.
- The runner verifies source, static profile, runner, fitter, protocol and (when used) table hashes
  before and after a shard. The fitter checks those identities again before analyzing a complete stage.
- The fixed ridge solver passed an analytic balanced-design solution, neutral ties and insufficient
  coverage checks independently on both hosts. Those synthetic checks are not strength evidence.

The common build passed all 7,118 tests plus TypeScript. The new research seam and existing override
suites passed 10 tests with 1,205 assertions. The broader workspace check encountered a deployment
test timeout (passed in isolation), then concurrent formatting edits in two client asset-release tests;
it has not completed green. These are separate from the frozen study and do not authorize promotion.

Both complete ranges finished. The fixed calibration failed its advance gate; see [RESULTS.md](RESULTS.md).
No partial sample, selected subset or new fitting variant was substituted.
