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
    shortlist?: number;
    environment: Record<string, string>;
}

interface ProfileContract {
    schemaVersion: number;
    protocol: string;
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
    it("binds 21 unique protocol-v5 identities to an explicit nonnegative finish weight", () => {
        expect(contract.schemaVersion).toBe(1);
        expect(contract.protocol).toBe("v0.7-overnight-active-circuit-v5");
        expect(contract.profiles).toHaveLength(21);
        expect(new Set(contract.profiles.map(({ id }) => id)).size).toBe(21);
        expect(new Set(contract.profiles.map(({ label }) => label)).size).toBe(21);

        for (const profile of contract.profiles) {
            expect(Number.isFinite(profile.finishWeight)).toBe(true);
            expect(profile.finishWeight).toBeGreaterThanOrEqual(0);
            expect(profile.environment.SEARCH_LATE_RANGED_FINISH_WEIGHT).toBe(String(profile.finishWeight));
        }
    });

    it("runs the h16 finish sweep first, all sub-h24 controls next, and h24 references last", () => {
        expect(contract.profiles.map(({ label }) => label)).toEqual([
            "active-h16-r1-s3-finish-w0-c7-4-3",
            "active-h16-r1-s3-finish-w1-c7-4-3",
            "active-h16-r1-s3-finish-w2-c7-4-3",
            "active-h16-r1-s3-finish-w4-c7-4-3",
            "active-h16-r1-c7-4-3",
            "active-h16-r1-c4-3-2",
            "active-h16-r1-s4-c4-3-2",
            "active-h12-r1-c6-4-2",
            "active-h12-r1-s4-c6-4-2",
            "active-h8-r1-c5-4-2",
            "active-h8-r1-c4-3-2",
            "active-h4-r1-c4-3-2",
            "b9ce-reference-h24-r4",
            "b9ce-h24-r2-c9-4-4",
            "b9ce-h24-r1-c9-4-4",
            "active-h24-r4-c9-4-4",
            "active-h24-r2-c9-4-4",
            "active-h24-r1-c9-4-4",
            "active-h24-r1-s3-c9-4-4",
            "active-h24-r1-s4-c9-4-4",
            "active-h24-r1-c4-3-2",
        ]);
        expect(contract.profiles.slice(0, 4).map(({ finishWeight }) => finishWeight)).toEqual([0, 1, 2, 4]);
        expect(contract.profiles.slice(0, 12).every(({ environment }) => environment.SEARCH_HORIZON !== "24")).toBe(
            true,
        );
        expect(contract.profiles.slice(12).every(({ environment }) => environment.SEARCH_HORIZON === "24")).toBe(true);
    });

    it("isolates weights 0, 1, 2, and 4 on the h16/r1/shortlist-3 arm", () => {
        const labels = [
            "active-h16-r1-s3-finish-w0-c7-4-3",
            "active-h16-r1-s3-finish-w1-c7-4-3",
            "active-h16-r1-s3-finish-w2-c7-4-3",
            "active-h16-r1-s3-finish-w4-c7-4-3",
        ];
        const sweep = labels.map((label) => contract.profiles.find((profile) => profile.label === label));

        expect(sweep.every((profile) => profile !== undefined)).toBe(true);
        expect(sweep.map((profile) => profile?.finishWeight)).toEqual([0, 1, 2, 4]);
        expect(contract.profiles.filter(({ finishWeight }) => finishWeight > 0)).toHaveLength(3);

        const environmentsWithoutFinishWeight = new Set<string>();
        for (const profile of sweep) {
            expect(profile?.activeChallengers).toBe(true);
            expect(profile?.shortlist).toBe(3);
            expect(profile?.environment).toMatchObject({
                SEARCH_HORIZON: "16",
                SEARCH_ROLLOUTS: "1",
                SEARCH_MAX_MELEE: "7",
                SEARCH_MAX_SHOTS: "4",
                SEARCH_MAX_THROWS: "3",
                SEARCH_ACTIVE_CHALLENGERS: "1",
                SEARCH_SHORTLIST: "3",
            });
            const environment = Object.fromEntries(
                Object.entries(profile?.environment ?? {}).filter(
                    ([key]) => key !== "SEARCH_LATE_RANGED_FINISH_WEIGHT",
                ),
            );
            environmentsWithoutFinishWeight.add(JSON.stringify(environment));
        }
        expect(environmentsWithoutFinishWeight.size).toBe(1);
    });
});
