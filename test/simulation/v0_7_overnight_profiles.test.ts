/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

interface DescribedProfile {
    id: string;
    label: string;
    activeChallengers: boolean;
    finishWeight: number;
    denseMeleeMagicIsolation: boolean;
    auraCasterSpells: "off" | "windflow" | "resurrection,windflow";
    finishControlProfileId: string | null;
    shortlist?: number;
    environment: Record<string, string>;
}

interface ProfileContract {
    schemaVersion: number;
    protocol: string;
    scoutTemplates: string[];
    deepTemplates: string[];
    stageConfig: {
        checkpointGames: number;
        scoutGamesPerTemplate: number;
        deepGamesPerTemplate: number;
        finalGamesPerTemplate: number;
        deepKeep: number;
        decisionDeadlineMs: number;
        circuitBreakerMs: number;
    };
    profiles: DescribedProfile[];
}

const packageRoot = join(import.meta.dir, "../..");
const optimizer = join(packageRoot, "src/simulation/optimizer/v0_7_overnight.mjs");
const described = spawnSync(process.execPath, [optimizer, "--describe-profiles"], {
    cwd: packageRoot,
    encoding: "utf8",
});
if (described.status !== 0) {
    throw new Error(`Could not describe overnight profiles:\n${described.stderr}`);
}
const contract = JSON.parse(described.stdout) as ProfileContract;

describe("v0.7 overnight profile contract", () => {
    const allTemplates = [
        "mage_frontline",
        "mage_fireline",
        "melee_magic_utility",
        "melee_magic_brawler",
        "aura_support",
        "aura_offense",
        "ranged_precision",
        "ranged_control",
    ];

    it("binds six unique protocol-v7 identities and all-eight scout/deep coverage", () => {
        expect(contract.schemaVersion).toBe(1);
        expect(contract.protocol).toBe("v0.7-overnight-policy-factorial-v7");
        expect(contract.scoutTemplates).toEqual(allTemplates);
        expect(contract.deepTemplates).toEqual(allTemplates);
        expect(contract.stageConfig).toEqual({
            checkpointGames: 32,
            scoutGamesPerTemplate: 64,
            deepGamesPerTemplate: 512,
            finalGamesPerTemplate: 2048,
            deepKeep: 6,
            decisionDeadlineMs: 200,
            circuitBreakerMs: 275,
        });
        expect(contract.profiles).toHaveLength(6);
        expect(new Set(contract.profiles.map(({ id }) => id)).size).toBe(6);
        expect(new Set(contract.profiles.map(({ label }) => label)).size).toBe(6);

        for (const profile of contract.profiles) {
            expect(profile.finishWeight).toBe(0);
            expect(profile.finishControlProfileId).toBeNull();
            expect(profile.environment.SEARCH_LATE_RANGED_FINISH_WEIGHT).toBe("0");
            expect(profile.environment.SEARCH_DECISION_DEADLINE_MS).toBe("200");
            expect(profile.environment.SEARCH_CIRCUIT_BREAKER_MS).toBe("275");
            expect(profile.environment).toMatchObject({
                V07_SEARCH: "1",
                SEARCH_VERSIONS: "v0.7",
                SEARCH_HORIZON: "4",
                SEARCH_ROLLOUTS: "1",
                SEARCH_MAX_MELEE: "4",
                SEARCH_MAX_SHOTS: "3",
                SEARCH_MAX_THROWS: "2",
                SEARCH_ACTIVE_CHALLENGERS: "1",
                SEARCH_SHORTLIST: "2",
            });
            expect(profile.environment.V07_PLACEMENT_REVEAL).toBeUndefined();
        }
    });

    it("runs the complete dense-isolation x aura-router factorial in deterministic order", () => {
        expect(contract.profiles.map(({ label }) => label)).toEqual([
            "axis-control-h4-r1-s2-c4-3-2",
            "axis-dense-h4-r1-s2-c4-3-2",
            "axis-aura-wind-h4-r1-s2-c4-3-2",
            "axis-dense-aura-wind-h4-r1-s2-c4-3-2",
            "axis-aura-res-wind-h4-r1-s2-c4-3-2",
            "axis-dense-aura-res-wind-h4-r1-s2-c4-3-2",
        ]);
        expect(
            contract.profiles.map(({ denseMeleeMagicIsolation, auraCasterSpells }) => ({
                denseMeleeMagicIsolation,
                auraCasterSpells,
            })),
        ).toEqual([
            { denseMeleeMagicIsolation: false, auraCasterSpells: "off" },
            { denseMeleeMagicIsolation: true, auraCasterSpells: "off" },
            { denseMeleeMagicIsolation: false, auraCasterSpells: "windflow" },
            { denseMeleeMagicIsolation: true, auraCasterSpells: "windflow" },
            { denseMeleeMagicIsolation: false, auraCasterSpells: "resurrection,windflow" },
            { denseMeleeMagicIsolation: true, auraCasterSpells: "resurrection,windflow" },
        ]);
    });

    it("emits policy flags only on their treatment arms while freezing every search setting", () => {
        for (const profile of contract.profiles) {
            expect(profile.environment.V07_DENSE_MM_SALVAGE_ISOLATION).toBe(
                profile.denseMeleeMagicIsolation ? "1" : undefined,
            );
            expect(profile.environment.V07_AURA_CASTER_ROUTER).toBe(
                profile.auraCasterSpells === "off" ? undefined : "on",
            );
            expect(profile.environment.V07_AURA_CASTER_SPELLS).toBe(
                profile.auraCasterSpells === "off" ? undefined : profile.auraCasterSpells,
            );
        }

        const policyKeys = new Set([
            "V07_DENSE_MM_SALVAGE_ISOLATION",
            "V07_AURA_CASTER_ROUTER",
            "V07_AURA_CASTER_SPELLS",
        ]);
        const frozenEnvironments = new Set(
            contract.profiles.map(({ environment }) =>
                JSON.stringify(Object.fromEntries(Object.entries(environment).filter(([key]) => !policyKeys.has(key)))),
            ),
        );
        expect(frozenEnvironments.size).toBe(1);
    });
});
