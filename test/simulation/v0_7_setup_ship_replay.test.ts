import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { V07_NONFIGHT_SETUP_ARTIFACT, type INonFightCandidatePolicy } from "../../src/ai/setup/setup_ship";
import { evaluateSetupPair } from "../../src/simulation/optimizer/v0_7_setup_overnight";

const REPLAY_SEEDS = [2147598935, 2147640168, 2147790257, 2147831490] as const;
// Re-pinned with the 2026-08-14 aura/battle-engine batch: the full-trace digest moves with any
// intended combat-behavior change; this run's traces were reviewed green across the suite.
// Re-pinned 2026-08-14 for the Griffin/Ogre Mage balance pass (Griffin steps 5.5 -> 4.5, Ogre Mage
// hp 58 -> 60 and armor 19 -> 20). Both are fielded across the seeded draws, so any trace holding
// one diverges from that point on. Two isolated runs reproduced this value byte-identically.
// Previous approved digest: 331591f5d47475e7a821d4a21f226ac94304d789381e59f2fe0ef038f2b93874
const EXPECTED_REPLAY_SHA256 = "7a2f5efd2cc176321441766570bfe944976d7ca9d826a58f14a3c418ec08596f";

test("the shared production resolver preserves the terminal setup guard's full-trace replay digest", () => {
    const previousGate = process.env.V07_PLACEMENT_REVEAL;
    process.env.V07_PLACEMENT_REVEAL = "on";
    try {
        const policy: INonFightCandidatePolicy = {
            id: "c77bae00-909a-4095-bb12-27dbe9b796bb/pass-11/synergy/situational",
            ...structuredClone(V07_NONFIGHT_SETUP_ARTIFACT.policy),
        };
        const pairs = REPLAY_SEEDS.map((seed) => evaluateSetupPair(policy, seed)).sort(
            (left, right) => left.seed - right.seed,
        );
        expect(createHash("sha256").update(JSON.stringify(pairs)).digest("hex")).toBe(EXPECTED_REPLAY_SHA256);
    } finally {
        if (previousGate === undefined) delete process.env.V07_PLACEMENT_REVEAL;
        else process.env.V07_PLACEMENT_REVEAL = previousGate;
    }
}, 30_000);
