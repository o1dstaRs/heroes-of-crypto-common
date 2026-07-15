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

    it("binds nine unique protocol-v6 identities and all-eight scout/deep coverage", () => {
        expect(contract.schemaVersion).toBe(1);
        expect(contract.protocol).toBe("v0.7-overnight-active-circuit-v6");
        expect(contract.scoutTemplates).toEqual(allTemplates);
        expect(contract.deepTemplates).toEqual(allTemplates);
        expect(contract.stageConfig).toEqual({
            checkpointGames: 32,
            scoutGamesPerTemplate: 64,
            deepGamesPerTemplate: 512,
            finalGamesPerTemplate: 2048,
            deepKeep: 3,
            decisionDeadlineMs: 200,
            circuitBreakerMs: 275,
        });
        expect(contract.profiles).toHaveLength(9);
        expect(new Set(contract.profiles.map(({ id }) => id)).size).toBe(9);
        expect(new Set(contract.profiles.map(({ label }) => label)).size).toBe(9);

        for (const profile of contract.profiles) {
            expect(Number.isFinite(profile.finishWeight)).toBe(true);
            expect(profile.finishWeight).toBeGreaterThanOrEqual(0);
            expect(profile.environment.SEARCH_LATE_RANGED_FINISH_WEIGHT).toBe(String(profile.finishWeight));
            expect(profile.environment.SEARCH_DECISION_DEADLINE_MS).toBe("200");
            expect(profile.environment.SEARCH_CIRCUIT_BREAKER_MS).toBe("275");
        }
    });

    it("runs complete h12, h8, and h4 finish trios in exact strength-first order", () => {
        expect(contract.profiles.map(({ label }) => label)).toEqual([
            "active-h12-r1-s3-finish-w0-c6-4-2",
            "active-h12-r1-s3-finish-w2-c6-4-2",
            "active-h12-r1-s3-finish-w4-c6-4-2",
            "active-h8-r1-s2-finish-w0-c4-3-2",
            "active-h8-r1-s2-finish-w2-c4-3-2",
            "active-h8-r1-s2-finish-w4-c4-3-2",
            "active-h4-r1-s2-finish-w0-c4-3-2",
            "active-h4-r1-s2-finish-w2-c4-3-2",
            "active-h4-r1-s2-finish-w4-c4-3-2",
        ]);
        expect(contract.profiles.every(({ environment }) => !["16", "24"].includes(environment.SEARCH_HORIZON))).toBe(
            true,
        );
    });

    it("isolates weights 0, 2, and 4 within every latency envelope", () => {
        const envelopes = [
            { horizon: "12", shortlist: 3, caps: ["6", "4", "2"] },
            { horizon: "8", shortlist: 2, caps: ["4", "3", "2"] },
            { horizon: "4", shortlist: 2, caps: ["4", "3", "2"] },
        ];
        expect(contract.profiles.filter(({ finishWeight }) => finishWeight > 0)).toHaveLength(6);

        for (const envelope of envelopes) {
            const sweep = contract.profiles.filter(
                ({ environment }) => environment.SEARCH_HORIZON === envelope.horizon,
            );
            expect(sweep.map(({ finishWeight }) => finishWeight)).toEqual([0, 2, 4]);
            expect(sweep.map(({ finishControlProfileId }) => finishControlProfileId)).toEqual([
                null,
                sweep[0]?.id,
                sweep[0]?.id,
            ]);
            expect(
                sweep.every(
                    ({ activeChallengers, shortlist }) => activeChallengers && shortlist === envelope.shortlist,
                ),
            ).toBe(true);
            expect(sweep[0]?.environment).toMatchObject({
                SEARCH_ROLLOUTS: "1",
                SEARCH_MAX_MELEE: envelope.caps[0],
                SEARCH_MAX_SHOTS: envelope.caps[1],
                SEARCH_MAX_THROWS: envelope.caps[2],
                SEARCH_ACTIVE_CHALLENGERS: "1",
                SEARCH_SHORTLIST: String(envelope.shortlist),
            });
            const environmentsWithoutFinishWeight = new Set(
                sweep.map(({ environment }) =>
                    JSON.stringify(
                        Object.fromEntries(
                            Object.entries(environment).filter(([key]) => key !== "SEARCH_LATE_RANGED_FINISH_WEIGHT"),
                        ),
                    ),
                ),
            );
            expect(environmentsWithoutFinishWeight.size).toBe(1);
        }
    });
});
