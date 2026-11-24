/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { IAIStrategy } from "../../src/ai/ai_strategy";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { buildV08A13SearchEnvironment, V08_A13_GENOME } from "../../src/ai/versions/v0_8_a13_profile";
import { V08A19BoarBattleMageFlankPlacementStrategy } from "../../src/ai/versions/v0_8_a19_boar_battle_mage_flank_placement";
import { V08A19CompactPlacementStrategy } from "../../src/ai/versions/v0_8_a19_compact_placement";
import { V08A19F184LowerHumanPlacementStrategy } from "../../src/ai/versions/v0_8_a19_f184_lower_human_placement";
import {
    buildV08A19SearchEnvironment,
    createV08A19Strategy,
    V08_A19_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A19_GENOME,
    V08_A19_GENOME_SHA256,
    V08_A19_PROFILE,
    V08_A19_SEARCH,
    V08_A19_SEARCH_RULES,
    V08_A19_SOURCE_LEDGER,
} from "../../src/ai/versions/v0_8_a19_profile";
import { V08A19RankedPlacementStrategy } from "../../src/ai/versions/v0_8_a19_ranked_placement";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { runMatch } from "../../src/simulation/battle_engine";
import { fingerprintV08AlignedV1 } from "../../src/simulation/optimizer/v0_8_aligned_96h_v1_protocol";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import {
    createV08A19SearchDriver,
    shouldUseDefaultV08A19Search,
    V08_A19_SEARCH_OVERRIDE_ENV,
} from "../../src/simulation/v0_8_a19_search";
import { createV08A13SearchDriver, V08_A13_SEARCH_OVERRIDE_ENV } from "../../src/simulation/v0_8_a13_search";

const ENV_KEYS = [
    V08_A19_SEARCH_OVERRIDE_ENV,
    V08_A13_SEARCH_OVERRIDE_ENV,
    "V08_A19_SEARCH_ENV_OVERRIDES",
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "V08_VISIBLE_EDGE_SCREEN_PRESSURE",
    "SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION",
    "SEARCH_A19_MELEE_BARREL_DELIBERATION",
    "SEARCH_A19_NEUTRAL_BARREL_DELIBERATION",
    "SEARCH_A19_NIGHTMARE_WALL_MOVEMENT",
    "SEARCH_A19_CERTIFIED_SELECTION_BOUNDS",
    "SEARCH_A19_ROLLOUT_ALLOCATION",
    "SEARCH_A19_COMPLEMENTARY_R2",
    "V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT",
    "V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT",
] as const;
const savedEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

const restoreEnvironment = (): void => {
    for (const key of ENV_KEYS) {
        const value = savedEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
};

beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(restoreEnvironment);

describe("v0.8+A19 production profile", () => {
    it("keeps unqualified Mage kill priority off unless a research override explicitly enables it", () => {
        process.env.V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT = "1";
        process.env.V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT = "1";
        expect(buildV08A19SearchEnvironment().V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT).toBe("0");
        expect(buildV08A19SearchEnvironment().V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT).toBe("0");
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT: "1" });
        expect(buildV08A19SearchEnvironment().V08_MAGE_DAMAGE_KILL_PRIORITY_LEFT).toBe("1");
        expect(buildV08A19SearchEnvironment().V08_MAGE_DAMAGE_KILL_PRIORITY_RIGHT).toBe("0");
    });

    it("is one flat production identity with complementary R2 and the full horizon and shortlist", () => {
        const environment = buildV08A19SearchEnvironment();

        expect(V08_A19_PROFILE).toMatchObject({
            schema: "hoc.v0_8_a19_production_profile.v33",
            battleMageTargets: "battle-mage-impact-coverage-v1",
            candidateId: "a19",
            productionVersion: "v0.8",
            researchOnly: false,
            authoritativeSniperDonorProtection: {
                id: "sniper-donor-preservation-v1",
                checkpoint: "a19-preserve-sniper-20261118",
            },
            // Profile v15: the draft and setup policy and the artifact rule are recorded with their evidence status.
            strikerRush: {
                policyId: "a19-striker-rush-v1",
                adoptedAt: "2026-11-20",
                adoption: "standing-user-instruction",
                registrationSha256: "d2786fd4acf80d1a02d59cd2ad733e0d78a23a420b54f457bf13d944b24a50b0",
                qualification: "strength-confirmed-quality-and-cost-gates-failed",
            },
            artifactBeneficiary: { policyId: "artifact-fit-v8", qualification: "changed-case-diagnostic" },
            // Profile v16: every registered gate of this one passed.
            shooterlessMovement: {
                policyId: "a19-shooterless-movement-v1",
                adoptedAt: "2026-11-20",
                adoption: "standing-user-instruction",
                registrationSha256: "28ca93f78b560d0a8e5217e88f28f4dd8ca2077176fabd899ce676c9ec701945",
                qualification: "registered-confirmation-passed",
            },
            // Profile v17: the striker a seat drafts depends on the opposing creatures it can see.
            strikerMatchup: {
                policyId: "a19-striker-matchup-v1",
                adoptedAt: "2026-11-20",
                adoption: "standing-user-instruction",
                registrationSha256: "764d9b96b46a323f2ffc3542bf1d39107babbbc43268f33a69b70e3b256db593",
                qualification: "registered-confirmation-passed",
            },
            // Profile v18: confirmed on strength; its quality gate failed and stays recorded as failed.
            strikerRushMixed: {
                policyId: "a19-striker-rush-mixed-v1",
                adoptedAt: "2026-11-20",
                adoption: "standing-user-instruction",
                registrationSha256: "ad387b7c4c3e815a1432b3f853b0895dfcd2b0a567e3a9a9c1ad9d9e579d715a",
                qualification: "strength-confirmed-quality-gate-failed",
            },
            // Profile v19: the mixed-army rush from one shooter.
            strikerRushOneShooter: {
                policyId: "a19-striker-rush-one-shooter-v1",
                adoptedAt: "2026-11-20",
                adoption: "standing-user-instruction",
                registrationSha256: "8654e5a54721df0c4ccd74ecc6bbfd31c404203b36bd295c82669febaa241b62",
                qualification: "strength-confirmed-quality-gate-failed",
            },
            // Profile v20: the Tier-2 pick for a striker army.
            tier2Striker: {
                policyId: "a19-tier2-striker-v1",
                adoptedAt: "2026-11-21",
                adoption: "standing-user-instruction",
                registrationSha256: "3e1c94aead03725988f8fc298aeb0e960eb873c1fbb04abc57c31f204112a3b4",
                qualification: "strength-confirmed-quality-gate-failed",
            },
            // Profile v21: the owner-requested keep-attack fix.
            keepAttack: {
                policyId: "a19-keep-attack-v1",
                adoptedAt: "2026-11-21",
                adoption: "owner-request",
                registrationSha256: "01cec0b5e01e328838864415a1884e7ddf35abbe879ff74ed42c3ffca15e0999",
                qualification: "non-inferiority-confirmed",
            },
            // Profile v22: the owner-requested rejection fixes.
            rejectionFixes: {
                policyId: "a19-rejection-fixes-v1",
                components: ["a19-coherent-melee-approach-v1", "a19-engine-reachable-routes-v1"],
                adoptedAt: "2026-11-21",
                adoption: "owner-request",
                registrationSha256: "0613b1987e120e72cb874aae41fb01b781c3acbb46382d3fed41d960620bbea0",
                qualification: "non-inferiority-confirmed",
            },
            // Profile v23: deep search when it fits the bot seat's think budget.
            deepFit: {
                policyId: "a19-deep-fit-v1",
                adoptedAt: "2026-11-22",
                adoption: "standing-user-instruction",
                registrationSha256: "aa99e261a3d7ee4f33fbe95d3cc349aa0651e01a1c1539b8e59f4a7084122616",
                qualification: "strength-confirmed-quality-gate-failed",
            },
            // Profile v24: the owner adopted the Wild Regeneration gift fix; its owner guard (W3) failed and stays failed.
            wildRegenGift: {
                policyId: "a19-wild-regen-gift-v1",
                adoptedAt: "2026-11-22",
                adoption: "owner-explicit-decision",
                registrationSha256: "15861f7f825265f6b376b134bc1ea71f7944d364ab7fc65a2e49bd116823f712",
                qualification: "behaviour-confirmed-owner-guard-failed",
            },
            // Profile v25: decoy-aware targeting, confirmed against the owner's checkerboard decoy fort.
            decoyAware: {
                policyId: "a19-decoy-aware-v1",
                adoptedAt: "2026-11-22",
                adoption: "standing-user-instruction",
                registrationSha256: "9e2d00ea2bfdd5b610d2f2cf54f661b58c2aa541c929d42bc6850e3f62f1f146",
                qualification: "strength-confirmed",
            },
            // Profile v26: the gated counter draft, confirmed against the default AI.
            counterDraft: {
                policyId: "a19-counter-draft-v1",
                adoptedAt: "2026-11-22",
                adoption: "standing-user-instruction",
                registrationSha256: "7d5b23d507419eac1246f70e81916103c02ad577e0d04eb675db91e46e73bebb",
                qualification: "strength-confirmed",
            },
            // Profile v27: Lava Striders by map (rule A; the lava-map rule failed and is not adopted).
            lavaMapArtifact: {
                policyId: "a19-lava-map-artifact-v1",
                adoptedAt: "2026-11-22",
                adoption: "standing-user-instruction",
                registrationSha256: "09fdcef677947b48b52c0baee2d6beb296aa9add6dad05c55d92a587d80a364f",
                qualification: "strength-confirmed",
            },
            // Profile v28: Valkyrie moves with the strikers in the rush formation.
            valkyrieStriker: {
                policyId: "a19-valkyrie-striker-v1",
                adoptedAt: "2026-11-23",
                adoption: "standing-user-instruction",
                registrationSha256: "cb9274594d957678298c35f0569777cbb89a446068ade351e1efe4cdc98f3536",
                qualification: "strength-confirmed",
            },
            // Profile v29: the deep-fit budget fills the owner-approved 4 s (4,000 rollout turns).
            deepFit4000: {
                policyId: "a19-deep-fit-4000-v1",
                adoptedAt: "2026-11-23",
                adoption: "standing-user-instruction",
                registrationSha256: "6f7431f0fb0d533eb3c9604e331bdc891b338ff32655b2f8a03c9007a2568729",
                qualification: "strength-confirmed",
            },
            // Profile v30: the bot seat's stock search gets a 2,500 ms live deadline (registered confirmation SD).
            stockDeadline: {
                policyId: "a19-stock-deadline-v1",
                adoptedAt: "2026-11-24",
                adoption: "standing-user-instruction",
                registrationSha256: "0861b6ac1fa9f09ad5831b15ddcdf3103a9bb79f328fa7a8128a42ab8c20eef1",
                qualification: "strength-confirmed",
            },
            // Profile v31: WAIT comparisons of the bot seat's searches run under the clock (registered confirmation WC).
            waitClock: {
                policyId: "a19-wait-clock-v1",
                adoptedAt: "2026-11-24",
                adoption: "owner-request",
                registrationSha256: "2820fe568be7bda58822bca3ab62bb14233dd84d648a93b68e81a96feb98ec0e",
                qualification: "non-inferiority-confirmed",
            },
            // Profile v32: a principal blessing carrier keeps with its army in laps 1-3 (owner request).
            carrierCohesion: {
                policyId: "a19-carrier-cohesion-v2",
                adoptedAt: "2026-11-24",
                adoption: "owner-request",
                registrationSha256: "1f2adb866f41bf506f147df36d08f23e909d6990b8f31c0a722c9f5c19124b2a",
                qualification: "non-inferiority-confirmed",
            },
            // Profile v33: at level 4 Magic Dragon once the opposing Arachna Queen is visible (owner request).
            queenCounter: {
                policyId: "a19-queen-counter-v1",
                adoptedAt: "2026-11-24",
                adoption: "owner-request",
                registrationSha256: "e208b2f6a36d20fa2c86aa310d451a96d6b55a34b77e3b8163a54e23169efc12",
                qualification: "strength-confirmed",
            },
        });
        expect(V08_A19_SEARCH).toMatchObject({
            gate: 0.03,
            horizon: 64,
            rollouts: 2,
            chanceSampling: "actor-antithetic",
            shortlist: 6,
            maxMelee: 10,
            maxShots: 4,
            maxThrows: 2,
            decisionDeadlineMs: 1000,
            circuitBreakerMs: 1500,
            waitDeadlinePolicy: "operation_bounded",
        });
        expect(environment).toMatchObject({
            V07_SEARCH: "1",
            SEARCH_VERSIONS: "v0.8",
            SEARCH_GATE: "0.03",
            SEARCH_HORIZON: "64",
            SEARCH_ROLLOUTS: "2",
            SEARCH_SHORTLIST: "6",
            SEARCH_MAX_MELEE: "10",
            SEARCH_DECISION_DEADLINE_MS: "1000",
            SEARCH_CIRCUIT_BREAKER_MS: "1500",
            V07_PLACEMENT_REVEAL: "on",
            V08_AGGRESSIVE: "1",
            ...V08_A19_SEARCH_RULES,
            SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
            SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
        });
        for (const value of Object.values(V08_A19_SEARCH_RULES)) expect(value).toBe("1");
        // The re-score bank and the broad Armageddon-defend research arm no longer exist anywhere.
        expect(environment).not.toHaveProperty("SEARCH_A19_NONREGRESSIVE_OVERRIDE_VALIDATION");
        expect(environment).not.toHaveProperty("SEARCH_A19_POOLED_OVERRIDE_VALIDATION");
        expect(environment).not.toHaveProperty("SEARCH_A19_ARMAGEDDON_DEFEND_CANDIDATE");
        // Everything else is the a13 base, untouched.
        const base = buildV08A13SearchEnvironment("v0.8");
        for (const [key, value] of Object.entries(base)) {
            if (key in V08_A19_SEARCH_RULES) continue;
            if (
                [
                    "SEARCH_HORIZON",
                    "SEARCH_ROLLOUTS",
                    "SEARCH_SHORTLIST",
                    "SEARCH_MAX_MELEE",
                    "SEARCH_DECISION_DEADLINE_MS",
                    "SEARCH_CIRCUIT_BREAKER_MS",
                    "SEARCH_A19_CERTIFIED_SELECTION_BOUNDS",
                    "SEARCH_A19_CERTIFIED_TIGHT_BOUNDS",
                    "SEARCH_A19_MATERIAL_ARBITRATION",
                    "SEARCH_A19_ROLLOUT_ALLOCATION",
                ].includes(key)
            ) {
                continue;
            }
            expect(environment[key]).toBe(value);
        }
    });

    it("seals complementary R2 on for live and offline drivers with an explicit rollback", () => {
        process.env.SEARCH_A19_COMPLEMENTARY_R2 = "0";
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        for (const offlineDeterministicWork of [false, true]) {
            const driver = createV08A19SearchDriver({} as ILookaheadDeps, { ...match, offlineDeterministicWork });
            expect(driver).toMatchObject({ rollouts: 2, horizon: 64, complementaryR2: true });
        }
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
            SEARCH_ROLLOUTS: "4",
            SEARCH_A19_COMPLEMENTARY_R2: "0",
        });
        expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            rollouts: 4,
            complementaryR2: false,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_COMPLEMENTARY_R2: "yes" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow("SEARCH_A19_COMPLEMENTARY_R2");
    });

    it("seals measured melee barrel deliberation on while retaining an explicit rollback", () => {
        process.env.SEARCH_A19_MELEE_BARREL_DELIBERATION = "0";
        expect(buildV08A19SearchEnvironment().SEARCH_A19_MELEE_BARREL_DELIBERATION).toBe("1");
        const match = { greenVersion: "v0.8", redVersion: "v0.8", offlineDeterministicWork: true };
        expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19MeleeBarrelDeliberation: true,
            horizon: 64,
            rollouts: 2,
            shortlist: 6,
        });
        process.env.SEARCH_A19_MELEE_BARREL_DELIBERATION = "1";
        expect(createV08A13SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19MeleeBarrelDeliberation: false,
            horizon: 12,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_MELEE_BARREL_DELIBERATION: "0" });
        expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19MeleeBarrelDeliberation: false,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_MELEE_BARREL_DELIBERATION: "invalid" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow(
            "SEARCH_A19_MELEE_BARREL_DELIBERATION must be 0 or 1",
        );
    });

    it("seals the user-adopted neutral barrel comparison for live and offline A19, with a strict rollback", () => {
        process.env.SEARCH_A19_NEUTRAL_BARREL_DELIBERATION = "0";
        expect(buildV08A19SearchEnvironment().SEARCH_A19_NEUTRAL_BARREL_DELIBERATION).toBe("1");
        expect(buildV08A13SearchEnvironment("v0.8").SEARCH_A19_NEUTRAL_BARREL_DELIBERATION).toBeUndefined();
        // Adopted on confirmed strength; the two failed registered gates stay part of the profile record.
        expect(V08_A19_PROFILE.neutralBarrelDeliberation).toEqual({
            policyId: "a19-neutral-barrel-deliberation-v1",
            adoptedAt: "2026-11-19",
            adoption: "explicit-user-instruction",
            registrationSha256: "8d4a618a9f3533b6a9a91e1784cfe197725996aa97c0a0284529a969badefc81",
            qualification: "strength-confirmed-quality-and-cost-gates-failed",
        });
        for (const offlineDeterministicWork of [false, true]) {
            const match = { greenVersion: "v0.8", redVersion: "v0.8", offlineDeterministicWork };
            expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
                a19NeutralBarrelDeliberation: true,
                a19MeleeBarrelDeliberation: true,
                horizon: 64,
                rollouts: 2,
                shortlist: 6,
            });
        }
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        process.env.SEARCH_A19_NEUTRAL_BARREL_DELIBERATION = "1";
        expect(createV08A13SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19NeutralBarrelDeliberation: false,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_NEUTRAL_BARREL_DELIBERATION: "0" });
        expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19NeutralBarrelDeliberation: false,
            a19MeleeBarrelDeliberation: true,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_NEUTRAL_BARREL_DELIBERATION: "yes" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow(
            "SEARCH_A19_NEUTRAL_BARREL_DELIBERATION must be 0 or 1",
        );
    });

    it("seals user-adopted Nightmare coverage for live and offline A19, with a strict rollback", () => {
        process.env.SEARCH_A19_NIGHTMARE_WALL_MOVEMENT = "0";
        expect(V08_A19_PROFILE.nightmareWallMovement).toMatchObject({
            policyId: "nightmare-wall-movement-coverage-v1",
            adoption: "explicit-user-instruction",
            qualification: "closed-development-failed",
        });
        for (const offlineDeterministicWork of [false, true]) {
            const match = { greenVersion: "v0.8", redVersion: "v0.8", offlineDeterministicWork };
            expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
                a19NightmareWallMovement: true,
                horizon: 64,
                rollouts: 2,
                shortlist: 6,
            });
        }
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        process.env.SEARCH_A19_NIGHTMARE_WALL_MOVEMENT = "1";
        expect(createV08A13SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19NightmareWallMovement: false,
        });
        expect(shouldUseDefaultV08A19Search({ greenVersion: "v0.9", redVersion: "v0.9" })).toBe(false);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_NIGHTMARE_WALL_MOVEMENT: "0" });
        expect(createV08A19SearchDriver({} as ILookaheadDeps, match)).toMatchObject({
            a19NightmareWallMovement: false,
        });
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_NIGHTMARE_WALL_MOVEMENT: "yes" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow(
            "SEARCH_A19_NIGHTMARE_WALL_MOVEMENT must be 0 or 1",
        );
    });

    it("keeps the unqualified barrel candidate off unless explicitly overridden for research", () => {
        process.env.SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION = "1";
        expect(buildV08A19SearchEnvironment().SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION).toBe("0");
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION: "1" });
        expect(buildV08A19SearchEnvironment().SEARCH_A19_ARTIFACT_BARREL_SHOT_PROJECTION).toBe("1");
    });

    it("seals Last Fuse primary trades into A19, retains the older catalog for rollback and validates the override", () => {
        expect(buildV08A19SearchEnvironment().SEARCH_A19_LAST_FUSE_PRIMARY_TRADES).toBe("1");
        expect(buildV08A13SearchEnvironment("v0.8").SEARCH_A19_LAST_FUSE_PRIMARY_TRADES).toBeUndefined();
        const stock = createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" });
        expect((stock as unknown as { a19LastFusePrimaryTrades: boolean }).a19LastFusePrimaryTrades).toBe(true);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "0" });
        const old = createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" });
        expect((old as unknown as { a19LastFusePrimaryTrades: boolean }).a19LastFusePrimaryTrades).toBe(false);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_LAST_FUSE_PRIMARY_TRADES: "yes" });
        expect(() =>
            createV08A19SearchDriver({} as ILookaheadDeps, { greenVersion: "v0.8", redVersion: "v0.8" }),
        ).toThrow("SEARCH_A19_LAST_FUSE_PRIMARY_TRADES must be 0 or 1");
    });

    it("seals spin coverage into A19 while retaining a validated rollback switch", () => {
        expect(buildV08A19SearchEnvironment().SEARCH_A19_LIGHTNING_SPIN_COVERAGE).toBe("1");
        expect(buildV08A13SearchEnvironment("v0.8").SEARCH_A19_LIGHTNING_SPIN_COVERAGE).toBeUndefined();
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        const enabled = createV08A19SearchDriver({} as ILookaheadDeps, match);
        expect((enabled as unknown as { a19LightningSpinCoverage: boolean }).a19LightningSpinCoverage).toBe(true);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_LIGHTNING_SPIN_COVERAGE: "0" });
        const disabled = createV08A19SearchDriver({} as ILookaheadDeps, match);
        expect((disabled as unknown as { a19LightningSpinCoverage: boolean }).a19LightningSpinCoverage).toBe(false);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_LIGHTNING_SPIN_COVERAGE: "yes" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow(
            "SEARCH_A19_LIGHTNING_SPIN_COVERAGE must be 0 or 1",
        );
    });

    it("seals the measured selection bounds on and retains an explicit rollback", () => {
        process.env.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS = "1";
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        const stock = createV08A19SearchDriver({} as ILookaheadDeps, match);
        expect((stock as unknown as { certifiedSelectionBounds: boolean }).certifiedSelectionBounds).toBe(true);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "0" });
        const research = createV08A19SearchDriver({} as ILookaheadDeps, match);
        expect((research as unknown as { certifiedSelectionBounds: boolean }).certifiedSelectionBounds).toBe(false);
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "yes" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps, match)).toThrow(
            "SEARCH_A19_CERTIFIED_SELECTION_BOUNDS must be 0 or 1",
        );
    });

    it("seals adaptive rollout allocation off unless explicitly overridden for research", () => {
        process.env.SEARCH_A19_ROLLOUT_ALLOCATION = "validation";
        expect(buildV08A19SearchEnvironment().SEARCH_A19_ROLLOUT_ALLOCATION).toBe("uniform");
        expect(buildV08A13SearchEnvironment("v0.8").SEARCH_A19_ROLLOUT_ALLOCATION).toBeUndefined();
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_ROLLOUT_ALLOCATION: "halving" });
        expect(buildV08A19SearchEnvironment().SEARCH_A19_ROLLOUT_ALLOCATION).toBe("halving");
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_A19_ROLLOUT_ALLOCATION: "adaptive" });
        expect(() => createV08A19SearchDriver({} as ILookaheadDeps)).toThrow("SEARCH_A19_ROLLOUT_ALLOCATION");
    });

    it("fingerprints its genome and sealed environment", () => {
        expect(V08_A19_GENOME.controls).toMatchObject({
            ...V08_A13_GENOME.controls,
            shortlist: 6,
            decisionDeadlineMs: 1000,
        });
        expect(V08_A19_GENOME.search).toMatchObject({
            ...V08_A13_GENOME.search,
            horizon: 64,
            rollouts: 2,
            maxMelee: 10,
        });
        // The deep budget sits outside the v0.7 aligned-campaign grid, so the genome is hashed canonically as-is.
        expect(fingerprintV08AlignedV1(V08_A19_GENOME)).toBe(V08_A19_GENOME_SHA256);
        expect(fingerprintV08AlignedV1(buildV08A19SearchEnvironment())).toBe(V08_A19_BEHAVIOR_ENVIRONMENT_SHA256);
    });

    it("pins the bytes of every source its behavior depends on", () => {
        expect(V08_A19_PROFILE.sourceLedger).toBe(V08_A19_SOURCE_LEDGER);
        expect(V08_A19_SOURCE_LEDGER.map(({ role }) => role)).toEqual([
            "terrain-placement-reflection",
            "melee-barrel-rollback-environment",
            "nightmare-wall-movement",
            "battle-mage-targets",
            "native-v08-combat",
            "search-driver",
            "unit-support-setup",
            "healer-support-setup",
            "wandering-mage-support",
            "satyr-contact-support",
            "unit-support-adapter",
            "gravechain-coverage",
            "last-fuse-trades",
            "last-fuse-catalog",
            "ranged-target-selection",
            "ranged-action-validation",
            "player-ranged-aim",
            "summon-placement",
            "last-fuse-estimates",
            "lightning-spin-tactics",
            "ranged-shields",
            "selection-bounds",
            "rollout-allocation",
            "chance-sampling",
            "scored-arbitration",
            "material-arbitration",
            "armageddon-endgame",
            "f184-lower-placement",
            "boar-battle-mage-flank-placement",
            "compact-placement",
            "ranked-placement",
            "ai-registry-promotion",
            "default-search-factory",
            "default-search-routing",
            "neural-policy",
            "neural-adapter",
            "neural-model",
            "neural-correction",
            "neural-observation",
            "neural-inference",
            "neural-batch256-weights",
            "neural-lr0003-weights",
            "final-placement-adapter",
            "final-placement-proposals",
            "final-placement-model",
            "final-placement-seed",
            "final-placement-policy",
            "final-placement-weights",
            "final-placement-relations",
            "final-placement-v2-weights",
            "revealed-ranged-identity",
            "revealed-ranged-draft",
            "revealed-ranged-setup",
            "keep-attack",
            "coherent-melee-approach",
            "engine-reachable-routes",
            "deep-fit",
            "wild-regen-gift",
            "decoy-aware",
            "decoy-aware-redirect",
            "counter-draft",
            "counter-draft-model",
            "lava-map-artifact",
            "valkyrie-striker",
            "carrier-cohesion",
            "queen-counter",
        ]);
        for (const { source, sha256 } of V08_A19_SOURCE_LEDGER) {
            const bytes = readFileSync(new URL(`../../${source}`, import.meta.url));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
        }
    });

    it("composes exact f184 -> flank -> compact -> ranked placement over a fresh native v0.8", () => {
        const strategy = createV08A19Strategy();
        const layer = (value: unknown): unknown => (value as { base: unknown }).base;

        expect(strategy).toBeInstanceOf(V08A19F184LowerHumanPlacementStrategy);
        expect(layer(strategy)).toBeInstanceOf(V08A19BoarBattleMageFlankPlacementStrategy);
        expect(layer(layer(strategy))).toBeInstanceOf(V08A19CompactPlacementStrategy);
        expect(layer(layer(layer(strategy)))).toBeInstanceOf(V08A19RankedPlacementStrategy);
        expect(layer(layer(layer(layer(strategy))))).toBeInstanceOf(StrategyV0_8);
        expect(strategy.version).toBe("v0.8");
        expect(createV08A19Strategy()).not.toBe(strategy);
        expect(V08_A19_PROFILE.placementPolicy.precedence).toEqual([
            "exact-f184-lower",
            "boar-battle-mage-far-flank",
            "l4-scoped-compact",
            "generic-ranked-placement",
            "plain-v0.8",
        ]);
    });

    it("merges research overrides last and refuses malformed ones", () => {
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_ROLLOUTS: "2" });
        expect(buildV08A19SearchEnvironment().SEARCH_ROLLOUTS).toBe("2");
        expect(buildV08A19SearchEnvironment().SEARCH_SHORTLIST).toBe("6");

        process.env.V08_A19_SEARCH_ENV_OVERRIDES = "{not json";
        expect(() => buildV08A19SearchEnvironment()).toThrow("V08_A19_SEARCH_ENV_OVERRIDES is not valid JSON");
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({ SEARCH_ROLLOUTS: 2 });
        expect(() => buildV08A19SearchEnvironment()).toThrow(
            "V08_A19_SEARCH_ENV_OVERRIDES.SEARCH_ROLLOUTS must be a string",
        );
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = "[]";
        expect(() => buildV08A19SearchEnvironment()).toThrow("must be a JSON object");
    });

    it("is the ordinary v0.8 search while retaining explicit research and rollback controls", () => {
        const match = { greenVersion: "v0.8", redVersion: "v0.7" };
        expect(shouldUseDefaultV08A19Search(match)).toBe(true);
        expect(shouldUseDefaultV08A19Search({ greenVersion: "v0.8s", redVersion: "v0.7" })).toBe(false);

        process.env.V07_SEARCH = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        delete process.env.V07_SEARCH;

        process.env[V08_A13_SEARCH_OVERRIDE_ENV] = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        delete process.env[V08_A19_SEARCH_OVERRIDE_ENV];
        delete process.env[V08_A13_SEARCH_OVERRIDE_ENV];

        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "0";
        expect(shouldUseDefaultV08A19Search(match)).toBe(false);
        process.env[V08_A19_SEARCH_OVERRIDE_ENV] = "1";
        process.env.Q2_ORACLE = "1";
        expect(shouldUseDefaultV08A19Search(match)).toBe(true);
    });

    it("keeps the sealed A19 environment active for every live and rollout strategy decision", () => {
        const observedDynamicFlags: Array<string | undefined> = [];
        const recordingStrategy = (): IAIStrategy => {
            const base = new StrategyV0_8();
            return {
                version: base.version,
                placeArmy: base.placeArmy.bind(base),
                decideTurn: (unit, context) => {
                    observedDynamicFlags.push(process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE);
                    return base.decideTurn(unit, context);
                },
            };
        };

        process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE = "1";
        runMatch({
            greenVersion: "v0.8",
            redVersion: "v0.8",
            greenStrategyOverride: recordingStrategy(),
            redStrategyOverride: recordingStrategy(),
            roster: [{ faction: "Nature", creatureName: "Trent", level: 2, size: 1, amount: 24 }],
            seed: 20260805,
            maxLaps: 1,
        });

        expect(observedDynamicFlags.length).toBeGreaterThan(0);
        expect(observedDynamicFlags.every((value) => value === undefined)).toBe(true);
        expect(process.env.V08_VISIBLE_EDGE_SCREEN_PRESSURE).toBe("1");
    });

    it("reads the sealed A19 search switches from the overlay when process.env cannot hold them", () => {
        delete process.env.V07_SEARCH;
        const match = { greenVersion: "v0.8", redVersion: "v0.8" };
        const outside = new SearchDriver({} as ILookaheadDeps, match);
        expect(outside.appliesTo("v0.8")).toBe(false);

        withSearchEnvironment(buildV08A19SearchEnvironment(), () => {
            const inside = new SearchDriver({} as ILookaheadDeps, match);
            expect(inside.appliesTo("v0.8")).toBe(true);
            expect(process.env.V07_SEARCH).toBeUndefined();
        });

        const driver = createV08A19SearchDriver({} as ILookaheadDeps, match);
        expect(driver.appliesTo("v0.8")).toBe(true);
        expect(process.env.V07_SEARCH).toBeUndefined();
    });
});
