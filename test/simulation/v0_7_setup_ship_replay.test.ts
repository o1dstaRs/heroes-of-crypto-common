import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import { V07_NONFIGHT_SETUP_ARTIFACT, type INonFightCandidatePolicy } from "../../src/ai/setup/setup_ship";
import { evaluateSetupPair } from "../../src/simulation/optimizer/v0_7_setup_overnight";

const REPLAY_SEEDS = [2147598935, 2147640168, 2147790257, 2147831490] as const;
// Re-pinned after 4a68de8 fixed full-unit HP-cap refreshes and 9845c43 adjusted three creature stats.
// Clean-source isolation showed 4a68de8 alone changed only both traces for seed 2147598935 (whose roster
// contains Behemoth/Unyielding Power), while 9845c43 independently changed roster/combat traces. Two
// exact-9845c43 runs produced this byte-identical digest; this fixture is intentionally balance sensitive.
// Re-pinned again after the lap-start morale-roll fix: applyMoraleRolls now reads each unit's true
// accumulated morale instead of the stale ±20 that a Morale/Dismorale buff locks live morale to. That
// shifts which units proc Morale/Dismorale each lap, so the seeded combat traces legitimately change.
// Re-pinned again after Behemoth's armor -2 (30 -> 28): seed 2147598935's roster fields Behemoth, so its
// combat trace legitimately changes. Two runs on the fixed engine produced this byte-identical digest.
// Re-pinned again after enabling Abomination (catalog id 41): the larger L4 pool shifts every seeded
// roster draw, so all traces legitimately change. Two runs produced this byte-identical digest.
// Re-pinned again after enabling Champion (42) and Frenzied Boar (43) grew the L4 pool to 11 —
// same legitimate roster-draw shift. Two runs produced this byte-identical digest.
// Re-pinned again after enabling Arachna Queen (44) grew the L4 pool to 12 and shifted the same seeded
// roster draws. Two runs produced this byte-identical digest.
// Re-pinned again after raising L4 auto-bans 3 -> 5 (LIVE_AUTO_BANS_BY_LEVEL): banning more of the L4 pool
// shifts the same seeded roster draws. Two runs produced this byte-identical digest.
// Re-pinned after hardening v0.1 melee target legality and preferring enemies that already replied this lap;
// the affected seeded combat actions legitimately change. Two runs produced this byte-identical digest.
// Re-pinned after enabling Dryad expanded the Nature L1 catalog and shifted the deterministic roster draws.
// The full and focused suites independently produced this byte-identical digest.
// Re-pinned after Blacksmith expanded the Life L1 catalog and the hasUnactedTeammate wait gate changed
// eligible seeded combat waits. Two isolated runs produced this digest with zero rejected actions.
// Re-pinned after four stacked changes that each legitimately move the seeded combat traces. Per-commit
// isolation separated them, starting from 905bbcf (the last commit reproducing 8585a28):
//   2e88592  Wounding Charm grants a full-strength Deep Wounds card   8585a28 -> ea81764
//   c642eab  Break lasts two laps                                     ea81764 -> 9f83bc2
//   208ee33  mindless "AI Driven" units pinned to v0.1                9f83bc2 -> caf1913
//   v0.1 mindless units fall through OBSTACLE_ATTACK                  caf1913 -> the value below
// Isolation also confirmed two commits in that range leave this fixture byte-identical: 4efb68b (a13
// shortlist 3 -> 2, a v0.8 search control this v0.7 fixture does not exercise) and 1e2314e (Deep Wounds
// luck counted once). Two isolated runs produced the digest below.
const EXPECTED_REPLAY_SHA256 = "6d84c0669c0f3c1884a118f8573fa904261135eae510d6f459ba640fcfb3dfce";

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
