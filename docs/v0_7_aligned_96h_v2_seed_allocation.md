# v0.7 Aligned 96-Hour v2 Seed Allocation Appendix

Status: implementation-only, research-only. No production allocation has been performed. Do not invoke a production
allocation, select or reveal a final seed plan, or start the aligned run until the composed ranked sequence has emitted
and verified its terminal seal.

## Security Boundary

`v0_7_aligned_96h_v2_seed_allocator.ts` is a pure allocator. It does not read or write files, inspect Git, launch a
process, or use the network. Callers inject exact bytes for every corpus artifact and committed manifest.

The construction uses HMAC-SHA-256 with a caller-held 32-byte secret. Every candidate binds the construction version,
allocation domain and id, complete allocation-request hash, panel purpose and id, cell, scenario ordinal, physical
candidate seat (or shared fixed-template stream), setup/combat stream, stream ordinal, and retry attempt. The first four
digest bytes are interpreted as an unsigned big-endian uint32. A collision advances only that logical slot's attempt,
so an unrelated collision cannot shift another slot's candidate stream.

The allocator checks each candidate against:

- the complete local same-cutoff seed set;
- the complete Zinc same-cutoff seed set;
- structured expansion of every supplied committed manifest;
- every seed already accepted into train, confirm, or final.

Seed-set parsing accepts the full `0..4294967295` domain as strictly increasing, duplicate-free, newline-terminated
decimal rows. It does not infer freshness from a 7-digit regular expression or from textual numeric-token searches.

## Corpus Inputs

Each local/Zinc input contains the first and replay outputs from the same scan cutoff:

- exact scan-summary bytes;
- exact canonical seed-set bytes;
- the corresponding replay bytes.

Ingestion rejects any byte drift, cutoff mismatch, unsupported scanner policy, summary/set SHA mismatch, row-count
mismatch, duplicate, noncanonical decimal token, or value outside uint32. The public corpus attestation binds both
summary hashes, both set hashes, byte counts, file-snapshot hashes, scan policy, cutoff, and the exact union denyset.

Committed JSON is parsed structurally. Supported committed reservation shapes are the 96-hour panel/series,
acceptance/archetype/cross manifests, Wait v2 cells, Wait v3 cohorts, pure-ranged terminal reservation, and the compact
composed affine reservation. Composed expansion reconstructs every scenario-root, setup-proposal, and combat slot,
applies the exact logical-label ordinal overrides, and verifies counts, base seeds, uniqueness, and the reserved-envelope
hash. An unknown numeric value beneath a seed-named field fails closed.

## Commit And Reveal

The pre-freeze artifact is stored by the runner at `seed-allocation/commitment.json`. It contains:

- exact train and confirm injected plans;
- `trainPlanSha256` and `confirmPlanSha256` (the evaluator protocol fingerprints);
- the final panel descriptor, `finalPlanSha256`, opaque `finalTaskCount`, and opaque `finalTasksSha256`, but no final
  plan, task identity, scenario, or seed value;
- `allocationRequestSha256`, `corpusAttestationSha256`, `denysetSha256`, and `secretCommitmentSha256`;
- `allPlanCommitmentsSha256`, collision counts, a collision transcript hash, and `commitmentSha256`.

Train, confirm, and final are allocated together in a fixed order before the commitment hash is produced. This makes
their cross-plan disjointness and the final plan immutable while withholding final seed material.

After selection, the runner must persist an immutable candidate-freeze artifact. The reveal API requires a binding to
the same `commitmentSha256`, the frozen genome SHA, and the freeze artifact's self-hash. It regenerates all three plans
from the original request, corpus and secret, requires the public commitment to reproduce byte-for-byte canonically,
then returns `seed-allocation/final-reveal.json` with the exact final plan and `finalPlanRevealSha256`.

On restart, `resolveV07AlignedV2SeedPlans` validates both artifact self-hashes, the supplied immutable freeze, all three
evaluator plan contracts, all plan fingerprints, metadata, and cross-plan disjointness. The runner can then use
`resolveV07AlignedV2SeedPlanByBinding` with `{ panelId, panelFingerprint }`; the fingerprint is exactly
`fingerprintV07AlignedV2SeedPlan(plan)`. Transition ledgers should persist artifact references, not duplicate the large
raw plans.

The allocator self-hashes are semantic hashes of canonical unsigned envelopes. Persistence must keep a separate hash
of the complete serialized file bytes. A precise reference is therefore `{ path, bytesSha256, artifactSha256 }`, where
`artifactSha256` is `commitmentSha256` or `finalPlanRevealSha256`; those two hashes are not interchangeable.

## Fixed Sizes

Production mode requires exactly 1,000 confirmation scenarios and 2,000 final scenarios per cell. The train count is
fixed by the request. Panel ids must be distinct. Synthetic mode caps every panel at eight scenarios per cell so a dry
run cannot be mistaken for production evidence.

## Synthetic Dry Run

The dry run uses small in-memory local/Zinc denysets, a synthetic compact historical manifest, a fixed test secret, and
one scenario per cell. It exercises ingestion, commitment, final withholding, freeze binding, reveal, restart
resolution, and cross-plan disjointness. Its report contains only synthetic hashes and counts.

```bash
bun -e 'import { runV07AlignedV2SyntheticSeedAllocationDryRun as run } from "./src/simulation/optimizer/v0_7_aligned_96h_v2_seed_allocator"; console.log(JSON.stringify(run(), null, 2))'
```

This command is permitted before the composed seal only because every input is explicitly synthetic. It must not be
replaced with real scan artifacts, committed-manifest bytes, or a production allocation request before that seal.
