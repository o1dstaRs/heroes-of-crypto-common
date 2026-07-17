import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { V07_NONFIGHT_SETUP_ARTIFACT, type INonFightCandidatePolicy } from "../../src/ai/setup/setup_ship";
import { evaluateSetupPair } from "../../src/simulation/optimizer/v0_7_setup_overnight";

const REPLAY_SEEDS = [2147598935, 2147640168, 2147790257, 2147831490] as const;
// Re-pinned after 4490607 (balance: nerf Cursed Ward/Iron Plate/Keen Blade, boost Swift Boots, halve
// Longbow def penalty). Bisect confirmed the replay digest changes at exactly that commit and nowhere
// else — the drift is entirely the intended artifact rebalance flowing into evaluateSetupPair, not a
// resolver regression (the commit's army.ts COHORT filter is env-gated off and does not affect this).
const EXPECTED_REPLAY_SHA256 = "70e0621e0ac524bdd5b0060861a6d6e781576918a54115735099c3ae15f0e966";

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
