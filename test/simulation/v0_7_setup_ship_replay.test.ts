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
// Re-pinned 2026-08-15 for two ENGINE damage fixes: Deep Wounds is applied once instead of twice (the
// attack handler and Double Punch each folded 1 + power/100 into the ability multiplier that
// calculateAttackDamage then applied again, so wounded stacks took (1 + p/100)^2), and Through Shot now
// prices its pierce with the ATTACKER's team synergy instead of the defender's. Both change real damage, so
// every seeded trace holding a Deep Wounds carrier or a Through Shot shooter diverges from that point on.
// Two isolated runs reproduced this value byte-identically.
// Previous approved digest: 7a2f5efd2cc176321441766570bfe944976d7ca9d826a58f14a3c418ec08596f
// Re-pinned 2026-08-16 for the squared ranged falloff: the bands are now squares of WHOLE cells
// (the fractional shot_distance stat is floored on the board) measured in king moves, and the band's
// last cell keeps full strength, so every seeded trace holding a shooter diverges from its first shot.
// Two isolated runs reproduced this value byte-identically.
// Previous approved digest: 11d24bcbfe0ac4a3ed9656efb33889ba831679cbb0ae4a5e11271afe5eb8d1a9
// Re-pinned 2026-08-22 for a poison + Abomination balance pass: Venom Cloud's on-hit share 30 -> 20,
// the poison stack share 70% -> 50%, Abomination hp 600 -> 550 and armor 50 -> 49. Abomination is
// fielded across the seeded draws and the Wyvern's aura prices real damage, so any trace holding
// either diverges from that point on. Two isolated runs reproduced this value byte-identically.
// Previous approved digest: 2d3e9727f3c79de48196b3d48a35c7855dab172406739a942c9afdc2d69ec2ed
// Re-pinned 2026-08-25 for the mounted class shipping 2x1 (Point X3): Griffin, Wolf, White Tiger,
// Unicorn, Mantis, Pegasus, Manticore, Nightmare, Centaur, Wolf Rider, Nomad, Hyena and Wyvern now
// declare footprint 2x1 with the size-2 art tier in creatures.json. Mounted stacks are fielded across
// the seeded draws, and a two-cell body changes placement, pathing and adjacency from the first lap, so
// every trace holding one diverges from its placement on. Two isolated runs reproduced this value
// byte-identically.
// Previous approved digest: 5d5b7a69138fa716091e005b8850228e1118adbcc7264742a8a72b20bfa11a47
// Re-pinned 2026-08-26 for the DEPLOYED wait-scorer default: v07BakedWaitWeights now resolves to
// SIDE_2X1_WAIT_WEIGHTS_2026_08_26 (owner sign-off; confirmed 58.30% vs shipped on 1,500 fresh-seed
// pairs), so every v0.7-lineage seeded trace re-times its waits. Two isolated runs reproduced this
// value byte-identically.
// Previous approved digest: 3735bb4d7dd68666c98600f0d569dc2b9c8de1845cdfc54244b094d352b1ba50
const EXPECTED_REPLAY_SHA256 = "16bdeb8e89b6705d7c08f18bc7c7fde614f47be7c57e3c64591571b8f07e8f7f";

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
