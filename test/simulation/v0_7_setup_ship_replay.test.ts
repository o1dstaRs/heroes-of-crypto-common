import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { V07_NONFIGHT_SETUP_ARTIFACT, type INonFightCandidatePolicy } from "../../src/ai/setup/setup_ship";
import { evaluateSetupPair } from "../../src/simulation/optimizer/v0_7_setup_overnight";

const REPLAY_SEEDS = [2147598935, 2147640168, 2147790257, 2147831490] as const;
const EXPECTED_REPLAY_SHA256 = "13535c6cf6631afa7967df32e454ad3edbbcb6eb1fd7318c45bbf685c53181d8";

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
