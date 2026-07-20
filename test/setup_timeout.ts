import { setDefaultTimeout } from "bun:test";

// Preloaded via bunfig.toml [test].preload for every `bun test` run in this package.
//
// Many tests here are CPU-heavy by design: they reconstruct 268k-seed diagnostic
// plans, partition 768-game batches, and hash source ledgers. Their wall-clock time
// scales with machine load, so under parallel builds / CI they can blow past Bun's
// 5000ms default and fail as "timed out after 5000ms" even though nothing is wrong.
//
// Raise the default so load spikes don't flake the gate. Tests that are genuinely
// long (real multi-game simulations) still set their own higher explicit timeouts
// (e.g. 60_000 / 120_000), which override this default.
setDefaultTimeout(30_000);
