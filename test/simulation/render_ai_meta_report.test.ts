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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import { renderAiMetaReport } from "../../src/simulation/render_ai_meta_report";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

describe("render_ai_meta_report", () => {
    test("puts actual run dates and measured duration in the compact header", () => {
        const html = renderAiMetaReport({
            generatedAt: "2026-11-05T07:04:34.858Z",
            provenance: {
                fightVersion: "v0.8",
                fightProfile: { candidateId: "a19", search: { horizon: 64, rollouts: 2 } },
                timing: {
                    startedAt: "2026-11-04T17:01:08Z",
                    finishedAt: "2026-11-05T07:04:11.494Z",
                    wallSeconds: 50582.687,
                },
            },
            cohorts: [{ cohort: "ranked-draft", games: 4002 }],
            rankings: {},
        });
        const header = html.slice(html.indexOf('<header id="report-top"'), html.indexOf("</header>"));
        expect(header).toContain("v0.8 + A19");
        expect(header).toContain("H64 / R2 search");
        expect(header).toContain("Run dates and duration");
        expect(header).toContain('datetime="2026-11-04T17:01:08.000Z"');
        expect(header).toContain('datetime="2026-11-05T07:04:11.494Z"');
        expect(header).toContain('datetime="2026-11-05T07:04:34.858Z"');
        expect(header).toContain("14h 3m 3s");
        expect(header).toContain("2026-11-04 17:01 UTC");
        expect(html).toContain('timeZoneName:"short"');
    });

    test("missing run times stay explicit instead of becoming invalid dates or invented durations", () => {
        const html = renderAiMetaReport({ rankings: {} });
        const header = html.slice(html.indexOf('<header id="report-top"'), html.indexOf("</header>"));
        expect(header).toContain("Not reported");
        const metadata = header.match(/<dl class="run-meta"[\s\S]*?<\/dl>/)![0];
        expect(metadata).not.toContain("Invalid Date");
        expect(metadata).not.toContain("NaN");
        expect(metadata).not.toContain("0h 0m 0s");
    });

    test("embeds canonical synergy icons and re-tiered artifact art without changing recorded image identities", () => {
        const root = mkdtempSync(resolve(tmpdir(), "hoc-report-icons-"));
        const images = resolve(root, "canonical-images");
        const siteArtifacts = resolve(root, "site/public/assets/images/artifacts");
        mkdirSync(images, { recursive: true });
        mkdirSync(siteArtifacts, { recursive: true });
        const bytes = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
        writeFileSync(resolve(images, "synergy_morale_256.webp"), bytes);
        writeFileSync(resolve(siteArtifacts, "artifact_t1_tome_of_amplification_256.webp"), bytes);
        writeFileSync(resolve(siteArtifacts, "artifact_t1_rime_charm_256.webp"), bytes);
        try {
            const html = renderAiMetaReport(
                {
                    rankings: {
                        synergies: [{ key: "Life:2:2", name: "Life · Morale & Luck · L2", pairs: 100, scoreRate: 0.5 }],
                        artifactsT1: [
                            {
                                key: "tome",
                                name: "Tome of Amplification",
                                imageKey: "artifact_t2_tome_of_amplification_256",
                                pairs: 100,
                                scoreRate: 0.5,
                            },
                            {
                                key: "rime",
                                name: "Rime Charm",
                                imageKey: "artifact_t2_rime_charm_256",
                                pairs: 100,
                                scoreRate: 0.5,
                            },
                        ],
                    },
                },
                { repositoryRoot: root, imagesDirectory: images },
            );
            const embedded = JSON.parse(
                html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/)![1],
            );
            for (const id of [
                "synergy_morale_256",
                "artifact_t2_tome_of_amplification_256",
                "artifact_t2_rime_charm_256",
            ])
                expect(embedded.assets[id]).toBe(`data:image/webp;base64,${bytes.toString("base64")}`);
            expect(embedded.rows.filter((row: { category: string }) => row.category === "artifactsT1")).toHaveLength(2);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("shows elapsed wall time separately from overlapping shard durations", () => {
        const html = renderAiMetaReport({
            provenance: {
                startedAt: "2026-10-25T12:00:00Z",
                sharding: { processes: 6, workersPerProcess: 4, shardsFinishedAt: "2026-10-25T12:01:00Z" },
                timing: {
                    wallSeconds: 62,
                    cohorts: [{ cohort: "ranked-draft", wallSpanSeconds: 45 }],
                },
            },
            cohorts: [{ cohort: "ranked-draft", games: 1008, seconds: 240 }],
            rankings: {},
        });
        expect(html).toContain("0h 1m 2s");
        expect(html).toContain("16.258 fights/s");
        expect(html).toContain("6 processes × 4 workers");
        expect(html).toContain("0h 0m 45s</td><td>0h 4m 0s");
        expect(html).toContain("is not CPU time");
    });

    test("uses the shard completion timestamp instead of later report generation", () => {
        const html = renderAiMetaReport({
            generatedAt: "2026-10-25T14:00:00Z",
            provenance: {
                startedAt: "2026-10-25T12:00:00Z",
                sharding: { shardsFinishedAt: "2026-10-25T12:01:30Z" },
            },
            cohorts: [{ cohort: "uniform-mixed", games: 72, seconds: 300 }],
            rankings: {},
        });
        expect(html).toContain("0h 1m 30s");
        expect(html).toContain("0.800 fights/s");
    });

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
        expect(html).toContain("function mountArt(parent,row)");
        // Portrait art embeds read site/public from the CLIENT checkout (the renderer resolves it via
        // DEFAULT_REPOSITORY_ROOT). Inside the client workspace they embed; the common package's
        // standalone CI has no such checkout, and the renderer then (correctly) emits art-less rows.
        // Gate on the portrait art directory, not on the serialized key — an empty "portraits":{}
        // ships either way.
        const clientPortraitArt = existsSync(
            resolve(MODULE_DIR, "../../../..", "site/public/assets/images/units/portraits"),
        );
        if (clientPortraitArt) {
            expect(html).toContain('"portraits":{"tsar_cannon_512":{"art":"data:image/webp;base64,');
            expect(html).toContain('"fit":"contain","scale":2.16,"offsetX":-44,"offsetY":-14');
        } else {
            expect(html).toContain('"portraits":{}');
        }
        expect(html).not.toContain("<script src=");
        expect(html).not.toContain('<link rel="stylesheet"');
    });

    test("adds portal-style navigation, large-screen art, and themed scrollbars", () => {
        const html = renderAiMetaReport({ rankings: { units: [] } });

        expect(html).toContain('id="report-top"');
        expect(html).toContain('data-report-jump="overview"');
        expect(html).toContain('data-report-jump="full-rankings"');
        expect(html).toContain('id="full-rankings" data-report-section');
        expect(html).toContain('class="command-deck-label"');
        expect(html).toContain("html::-webkit-scrollbar-thumb");
        expect(html).toContain("scrollbar-color:rgba(220,177,88,.72) #0a0603");
        expect(html).toContain(".leader-art{height:clamp(220px,16.5vw,312px)");
        expect(html).toContain("function initReportNavigation()");
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
            'if(category.key!=="units"&&category.key!=="synergies"&&category.key!=="augmentLevels")candidates=candidates.slice(0,12)',
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

    test("shows every active augment level and puts flagged tiny samples after larger samples", () => {
        const html = renderAiMetaReport({ rankings: {} });
        const functions = ["lowSample", "compareForestRows", "renderForest"]
            .map((name) => {
                const start = html.indexOf(`function ${name}(`);
                return html.slice(start, html.indexOf("\nfunction ", start + 1));
            })
            .join("\n");
        type Element = {
            text?: string;
            children: Element[];
            style: Record<string, string>;
            append(...items: Element[]): void;
            replaceChildren(): void;
        };
        const node = (_tag = "div", _className?: string, text?: string): Element => ({
            text,
            children: [],
            style: {},
            append(...items) {
                this.children.push(...items);
            },
            replaceChildren() {
                this.children = [];
            },
        });
        const rows = Array.from({ length: 16 }, (_, index) => ({
            name: index >= 13 ? `Empower L${index - 12}` : `Augment ${index}`,
            category: "augmentLevels",
            sample: 100,
            rate: 0.6 - index * 0.02,
            level: 1,
        }));
        const host = node();
        const context = {
            node,
            rows,
            host,
            exactCohortRows: () => rows,
            eligibleLeader: () => true,
            mountArt: () => {},
            finite: Number.isFinite,
            sample: (row: { sample: number }) => String(row.sample),
            rate: String,
            mapLabel: () => "All",
        };
        runInNewContext(functions + ';renderForest({key:"augmentLevels",label:"Augment levels"},host)', context);
        expect(host.children[0].children).toHaveLength(16);
        expect(JSON.stringify(host)).toContain("Empower L3");
        rows.push({ name: "One win", category: "synergies", sample: 1, rate: 1, level: 3 });
        runInNewContext(functions + ';renderForest({key:"synergies",label:"Synergies"},host)', context);
        const last = host.children[0].children.at(-1)!;
        expect(JSON.stringify(last)).toContain("One win");
        expect(JSON.stringify(last)).toContain("n 1 · low sample");
        expect(html).not.toContain('numberFormat.format(count)+" supported"');
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
        expect(html).toContain("var hasSupport=supported(row)");
        expect(html).toContain('td(hasSupport?rate(row.scoreRate):"—","rate-cell")');
    });

    test("renders adjusted ally combinations and a per-unit counter picker", () => {
        const html = renderAiMetaReport({
            complete: false,
            interactions: {
                schema: "cross-fitted-ridge-unit-interactions-v1",
                scope: { maps: [1, 3, 4], cohorts: ["ranked-draft"], pairs: 30_000, games: 60_000 },
                minimumSupport: { allyPairs: 24, allyTrios: 24, counters: 24 },
                allyPairs: [
                    {
                        key: "alpha|bravo",
                        name: "Alpha + Bravo",
                        units: ["Alpha", "Bravo"],
                        pairs: 80,
                        games: 160,
                        scoreRate: 0.62,
                        expectedScoreRate: 0.51,
                        adjustedLiftPp: 11,
                        adjustedCiLowPp: 4,
                        adjustedCiHighPp: 18,
                    },
                ],
                allyTrios: [],
                counters: [
                    {
                        key: "alpha>nemesis",
                        name: "Alpha + Nemesis",
                        units: ["Alpha", "Nemesis"],
                        unit: "Alpha",
                        enemyUnit: "Nemesis",
                        pairs: 75,
                        games: 150,
                        scoreRate: 0.61,
                        expectedScoreRate: 0.5,
                        adjustedLiftPp: 11,
                        adjustedCiLowPp: 3,
                        adjustedCiHighPp: 19,
                    },
                ],
                topCounters: [
                    { unit: "Alpha", counters: [] },
                    { unit: "Ghost", counters: [] },
                ],
            },
            rankings: { units: [] },
        });

        expect(html).toContain("Unit co-play and counters");
        expect(html).toContain("Partial run — diagnostic only");
        expect(html).toContain("cohort/map filters above do not apply");
        expect(html).toContain("uncorrected for multiple comparisons");
        expect(html).toContain('id="ally-pairs"');
        expect(html).toContain('id="ally-trios"');
        expect(html).toContain('id="counter-unit"');
        expect(html).toContain("Top adjusted co-play residuals");
        expect(html).toContain('"name":"Alpha + Bravo"');
        expect(html).toContain('"enemyUnit":"Nemesis"');
        expect(html).toContain('"counterUnits":["Alpha","Ghost"]');
        expect(html).toContain("function renderInteractions()");
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
