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

import { describe, expect, test } from "bun:test";

import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

describe("render_ai_meta_report", () => {
    test("renders sparse mixed rankings as a standalone interactive document", () => {
        const html = renderAiMetaReport({
            schemaVersion: 1,
            generatedAt: "2026-07-17T12:00:00.000Z",
            provenance: {
                aiVersion: "v0.7",
                setupPolicy: "v07-nonfight-4eda84635fe7",
                seed: 123,
            },
            cohorts: [
                { id: "ranged", label: "Ranged", games: 150_000, description: "Two or more ranged stacks." },
                { id: "melee", label: "Melee", games: 150_000 },
            ],
            rankings: {
                units: [
                    {
                        key: "tsar_cannon",
                        name: "Tsar Cannon",
                        imageKey: "tsar_cannon_512",
                        cohort: "ranged",
                        pairs: 25_000,
                        wins: 13_200,
                        losses: 11_800,
                        pickRate: 22.4,
                    },
                    {
                        key: "tsar_cannon",
                        name: "Tsar Cannon",
                        imageKey: "tsar_cannon_512",
                        cohort: "melee",
                        games: 11_000,
                        scoreRate: 0.48,
                    },
                ],
                artifactsT1: [
                    {
                        key: "cursed_ward",
                        name: "Cursed Ward",
                        imageKey: "artifact_t1_cursed_ward_256",
                        cohort: "ranged",
                        games: 9_000,
                        scoreRate: 0.52,
                        winRate: 53,
                        ciLow: 0.52,
                        ciHigh: 0.54,
                        liftPp: 3,
                    },
                ],
                artifactsT2: [],
                augmentPlans: [{ key: "A2-M2-S3", name: "Balanced marksmen", cohort: "ranged", winRate: 0.51 }],
                augmentLevels: [
                    { key: "sniper-3", kind: "Sniper", level: 3, cohort: "ranged", winRate: 0.55, pickRate: 0.7 },
                ],
            },
        });

        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("AI Meta Performance Report");
        expect(html).toContain("Strength comes from controlled exploration");
        expect(html).toContain("Score-rate forest plots");
        expect(html).toContain('data-sort="scoreRate">Score rate');
        expect(html).toContain('data-sort="winRate">Win rate');
        expect(html).toContain('"scoreRate":0.52,"winRate":0.53,"rate":0.52');
        expect(html).toContain('id="cohort-tabs"');
        expect(html).toContain('id="scatter"');
        expect(html).toContain('id="heatmap"');
        expect(html).toContain('id="ranking-body"');
        expect(html).toContain("Tsar Cannon");
        expect(html).toContain("artifact_t1_cursed_ward_256");
        expect(html).toMatch(/data:image\/(?:webp|svg\+xml);base64,/);
        expect(html).not.toContain("<script src=");
        expect(html).not.toContain('<link rel="stylesheet"');
    });

    test("missing and hostile optional fields cannot break or escape the embedded JSON", () => {
        const html = renderAiMetaReport({
            schemaVersion: "draft",
            provenance: { note: "</script><script>globalThis.compromised=true</script>" },
            cohorts: ["only-cohort"],
            rankings: {
                units: [null, { key: "unknown", name: "Unknown Unit", cohort: "only-cohort" }],
                artifactsT1: "not-an-array",
            },
        });

        expect(html).toContain("Unknown Unit");
        expect(html).toContain("No rate data for");
        expect(html).not.toContain("</script><script>globalThis.compromised");
        expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003e");
    });

    test("an empty arbitrary value still produces a complete report", () => {
        const html = renderAiMetaReport(undefined, { title: "Empty analysis" });
        expect(html).toContain("Empty analysis");
        expect(html).toContain("No provenance fields were supplied.");
        expect(html).toContain('"rows":[]');
        expect(html).toContain("</html>");
    });
});
