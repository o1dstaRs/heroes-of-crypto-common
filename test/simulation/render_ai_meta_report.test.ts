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
                        pairs: 5_500,
                        scoreRate: 0.48,
                    },
                ],
                synergies: [
                    {
                        key: "Chaos:2:1",
                        name: "Chaos · Break on Attack · L1",
                        imageKey: "synergy_break_on_attack_256",
                        kind: "synergy",
                        level: 1,
                        cohort: "ranged",
                        pairs: 2_400,
                        scoreRate: 0.54,
                        pickRate: 0.18,
                    },
                ],
                artifactsT1: [
                    {
                        key: "cursed_ward",
                        name: "Cursed Ward",
                        imageKey: "artifact_t1_cursed_ward_256",
                        cohort: "ranged",
                        games: 9_000,
                        pairs: 4_500,
                        scoreRate: 0.52,
                        winRate: 53,
                        ciLow: 0.52,
                        ciHigh: 0.54,
                        liftPp: 3,
                    },
                ],
                artifactsT2: [],
                augmentPlans: [
                    { key: "A2-M2-S3", name: "Balanced marksmen", cohort: "ranged", pairs: 200, winRate: 0.51 },
                ],
                augmentLevels: [
                    {
                        key: "sniper-3",
                        kind: "Sniper",
                        level: 3,
                        cohort: "ranged",
                        pairs: 300,
                        winRate: 0.55,
                        pickRate: 0.7,
                    },
                ],
            },
        });

        expect(html.startsWith("<!doctype html>")).toBe(true);
        expect(html).toContain("AI Meta Performance Report");
        expect(html).toContain("Controlled strength and associative composition");
        expect(html).toContain("composition-confounded associations");
        expect(html).toContain("Score-rate forest plots");
        expect(html).toContain('data-sort="scoreRate">Score rate');
        expect(html).toContain('data-sort="winRate">Win rate');
        expect(html).toContain('"scoreRate":0.52,"winRate":0.53,"rate":0.52');
        expect(html).toContain('id="cohort-tabs"');
        expect(html).toContain('id="map-filter"');
        expect(html).toContain('id="filter-coverage"');
        expect(html).toContain('id="scatter"');
        expect(html).toContain('id="heatmap"');
        expect(html).toContain('id="ranking-body"');
        expect(html).toContain("Tsar Cannon");
        expect(html).toContain("artifact_t1_cursed_ward_256");
        expect(html).toContain("Chaos · Break on Attack · L1");
        expect(html).toContain("synergy_break_on_attack_256");
        expect(html).toContain('"key":"synergies","label":"Synergies"');
        expect(html).toContain('"map":"all"');
        expect(html).toMatch(/data:image\/(?:webp|svg\+xml);base64,/);
        expect(html).not.toContain("<script src=");
        expect(html).not.toContain('<link rel="stylesheet"');
    });

    test("filters orthogonal cohort and map rankings with live maps as the default", () => {
        const liveUnits = Array.from({ length: 18 }, (_, index) => ({
            key: `live-unit-${index + 1}`,
            name: `Live Unit ${index + 1}`,
            cohort: "all",
            map: "live",
            level: (index % 4) + 1,
            pairs: 2_000 - index,
            scoreRate: 0.7 - index / 100,
        }));
        const html = renderAiMetaReport({
            cohorts: [
                {
                    cohort: "ranked-draft",
                    games: 150_000,
                    mapGames: { 1: 37_500, 2: 37_500, 3: 37_500, 4: 37_500 },
                },
            ],
            rankings: {
                units: [
                    ...liveUnits,
                    { key: "all-unit", name: "All Simulated Unit", cohort: "all", map: "all", scoreRate: 0.51 },
                    { key: "normal-unit", name: "Normal Unit", cohort: "all", map: 1, scoreRate: 0.52 },
                    { key: "lava-unit", name: "Lava Unit", cohort: "all", map: 3, scoreRate: 0.53 },
                    { key: "block-unit", name: "Block Unit", cohort: "all", map: 4, scoreRate: 0.54 },
                    { key: "water-unit", name: "Water Unit", cohort: "all", map: 2, scoreRate: 0.55 },
                    { key: "legacy-unit", name: "Legacy Unit", cohort: "all", scoreRate: 0.5 },
                ],
            },
        });

        expect(html).toContain('"map":"live"');
        expect(html).toContain('"map":"1"');
        expect(html).toContain('"map":"2"');
        expect(html).toContain('"key":"legacy-unit","name":"Legacy Unit"');
        expect(html).toContain('"mapGames":{"1":37500,"2":37500,"3":37500,"4":37500}');
        expect(html).toContain("Live rankings exclude Water");
        expect(html).toContain("Water · NON-LIVE");
        expect(html).toContain('var defaultMap=reportedMaps.has("live")?"live"');
        expect(html).toContain(
            'if(category.key!=="units"&&category.key!=="synergies")candidates=candidates.slice(0,12)',
        );
        expect(html).not.toContain('slice(0,category.key==="units"?16:12)');
        expect(html).toContain('var unitLevel=row.category==="units"&&row.level?"L"+row.level+" · ":""');
        expect(html).toContain("selectedMapRows(rows).forEach");
        expect(html).toContain('data-sort="map">Map');
        expect(html).toContain("empty.colSpan=13");
        expect(html).toContain(".filter-row{display:flex;flex-wrap:wrap");
        expect(html).toContain(".cohort-tabs{display:flex;flex:1 1 100%;flex-wrap:wrap");
        expect(html).toContain("flex-wrap:nowrap;overflow-x:auto;padding-bottom:5px");
    });

    test("keeps complete source, map, and execution-host provenance after a detailed fight profile", () => {
        const detailedSearch = Object.fromEntries(
            Array.from({ length: 30 }, (_, index) => [`control${index + 1}`, index + 1]),
        );
        const html = renderAiMetaReport({
            provenance: {
                title: "v0.8 evidence",
                fightProfile: { name: "v0.8+a13", search: detailedSearch },
                maps: [1, 3, 4],
                commonCommit: "abc123",
                sourceSha256: "f".repeat(64),
                executionHost: {
                    platform: "linux",
                    architecture: "x64",
                    cpuModel: "AMD Ryzen 7 9800X3D",
                    logicalCpus: 16,
                },
            },
            rankings: { units: [] },
        });

        expect(html).toContain('"key":"maps","value":"[1,3,4]"');
        expect(html).toContain('"key":"commonCommit","value":"abc123"');
        expect(html).toContain('"key":"sourceSha256","value":"');
        expect(html).toContain('"key":"executionHost.cpuModel","value":"AMD Ryzen 7 9800X3D"');
        expect(html).toContain('"key":"executionHost.logicalCpus","value":"16"');
    });

    test("keeps zero-support buckets auditable without allowing them into comparative views", () => {
        const html = renderAiMetaReport({
            rankings: {
                artifactsT2: [
                    { key: "unsupported", name: "Unsupported", cohort: "all", pairs: 0, scoreRate: 0.99 },
                    { key: "supported", name: "Supported", cohort: "all", pairs: 12, scoreRate: 0.6 },
                ],
            },
        });

        expect(html).toContain("Unsupported");
        expect(html).toMatch(/"key":"unsupported"[^}]+"pairs":0[^}]+"scoreRate":0\.99[^}]+"rate":null/);
        expect(html).toMatch(/"key":"supported"[^}]+"pairs":12[^}]+"rate":0\.6/);
        expect(html).toContain("function supported(row){return finite(row.pairs)&&row.pairs>0}");
        expect(html).toContain(".filter(supported)");
        expect(html).toContain("if(!supported(row)||!finite(row.rate)");
    });

    test("labels a direct legacy four-map aggregate as non-live evidence", () => {
        const html = renderAiMetaReport({
            provenance: { maps: [1, 2, 3, 4] },
            cohorts: [
                {
                    cohort: "ranked-draft",
                    games: 150_000,
                    mapGames: { 1: 37_500, 2: 37_500, 3: 37_500, 4: 37_500 },
                },
            ],
            rankings: {
                units: [{ key: "legacy", name: "Legacy aggregate", cohort: "all", pairs: 75_000, scoreRate: 0.51 }],
            },
        });

        expect(html).toContain("Aggregate includes NON-LIVE Water");
        expect(html).toContain("This legacy summary includes Water");
        expect(html).toContain("All simulated · includes NON-LIVE Water");
        expect(html).toContain('"key":"legacy","name":"Legacy aggregate"');
        expect(html).toContain('"map":"all"');
        expect(html).not.toContain("Live rankings exclude Water");
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
