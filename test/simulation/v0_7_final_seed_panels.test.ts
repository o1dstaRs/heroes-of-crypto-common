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

import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PAIRED_SCENARIO_SEED_STEP } from "../../src/simulation/v0_7_archetype_battery";

const manifest = <T>(name: string): T =>
    JSON.parse(readFileSync(join(import.meta.dir, `../../src/simulation/manifests/${name}`), "utf8")) as T;

interface ArchetypeManifest {
    gamesPerCell: number;
    cells: Record<string, Record<string, number>>;
}

interface AcceptanceManifest {
    headline: { seeds: number[]; gamesPerSeed: number };
    cohorts: { gamesPerSeed: number; seeds: Record<string, number[]> };
}

interface CrossManifest {
    gamesPerCell: number;
    cells: Record<string, number>;
}

function deterministicSeed(label: string): number {
    return createHash("sha256").update(`hoc-v07-final-frozen-cdb4332|${label}|0`).digest().readUInt32BE(0);
}

describe("v0.7 final preregistered seed panels", () => {
    it("keeps all 135,000 prior and final derived scenarios globally disjoint", () => {
        const seen = new Map<number, string>();
        const addStream = (baseSeed: number, scenarios: number, label: string): void => {
            for (let scenario = 0; scenario < scenarios; scenario += 1) {
                const seed = (baseSeed + scenario * PAIRED_SCENARIO_SEED_STEP) >>> 0;
                expect(seen.get(seed), `seed ${seed}: ${label} overlaps ${seen.get(seed)}`).toBeUndefined();
                seen.set(seed, label);
            }
        };

        for (const version of ["v1", "v2", "v3", "v4"] as const) {
            const panel = manifest<ArchetypeManifest>(`v0_7_archetype_battery_${version}.json`);
            for (const [template, opponents] of Object.entries(panel.cells)) {
                for (const [opponent, baseSeed] of Object.entries(opponents)) {
                    addStream(baseSeed, panel.gamesPerCell / 2, `archetype-${version}:${template}:${opponent}`);
                }
            }
        }

        for (const name of ["v0_7_acceptance_archetype_final.json", "v0_7_acceptance_archetype_final_v2.json"]) {
            const panel = manifest<AcceptanceManifest>(name);
            panel.headline.seeds.forEach((baseSeed, index) =>
                addStream(baseSeed, panel.headline.gamesPerSeed / 2, `${name}:headline:${index}`),
            );
            for (const [cohort, seeds] of Object.entries(panel.cohorts.seeds)) {
                seeds.forEach((baseSeed, index) =>
                    addStream(baseSeed, panel.cohorts.gamesPerSeed / 2, `${name}:${cohort}:${index}`),
                );
            }
        }

        const cross = manifest<CrossManifest>("v0_7_cross_archetype_v1.json");
        for (const [matchup, baseSeed] of Object.entries(cross.cells)) {
            addStream(baseSeed, cross.gamesPerCell / 4, `cross-v1:${matchup}`);
        }

        expect(seen.size).toBe(135_000);
    });

    it("reproduces every final-panel base seed from the frozen SHA-256 derivation", () => {
        const archetype = manifest<ArchetypeManifest>("v0_7_archetype_battery_v4.json");
        for (const [template, opponents] of Object.entries(archetype.cells)) {
            for (const [opponent, seed] of Object.entries(opponents)) {
                expect(seed).toBe(deterministicSeed(`archetype-v4:${template}:${opponent}`));
            }
        }

        const acceptance = manifest<AcceptanceManifest>("v0_7_acceptance_archetype_final_v2.json");
        acceptance.headline.seeds.forEach((seed, index) => {
            expect(seed).toBe(deterministicSeed(`acceptance-v2:headline:${index}`));
        });
        for (const [cohort, seeds] of Object.entries(acceptance.cohorts.seeds)) {
            seeds.forEach((seed, index) => {
                expect(seed).toBe(deterministicSeed(`acceptance-v2:${cohort}:${index}`));
            });
        }

        const cross = manifest<CrossManifest>("v0_7_cross_archetype_v1.json");
        for (const [matchup, seed] of Object.entries(cross.cells)) {
            expect(seed).toBe(deterministicSeed(`cross-v1:${matchup}`));
        }
    });
});
