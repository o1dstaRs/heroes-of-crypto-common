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

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    PAIRED_SCENARIO_SEED_STEP,
    V07_ARCHETYPES,
    V07_ARCHETYPE_TAXONOMY,
    V07_ARCHETYPE_TEMPLATES,
    V07_ARCHETYPE_TEMPLATE_NAMES,
    aggregateV07ArchetypeCells,
    assessV07ArchetypeBattery,
    buildV07ArchetypeCellSpecs,
    loadV07ArchetypeCheckpoint,
    playV07ArchetypeGame,
    readV07ArchetypeSeedManifest,
    rosterSignature,
    saveV07ArchetypeCheckpoint,
    summarizeV07ArchetypeCell,
    v07ArchetypeRunFingerprint,
    v07ArchetypeTemplate,
    validateV07ArchetypeOptions,
    validateV07ArchetypeTemplates,
    type IActionTelemetry,
    type IV07ArchetypeBatteryOptions,
    type IV07ArchetypeCellReport,
    type IV07ArchetypeCellSpec,
    type IV07ArchetypeGameRecord,
} from "../../src/simulation/v0_7_archetype_battery";
import type { IIntegrityStats, IPairClusterStats, IRevisionProvenance } from "../../src/simulation/v0_7_acceptance";

const manifestPath = join(import.meta.dir, "../../src/simulation/manifests/v0_7_archetype_battery_v1.json");

const cleanRevision: IRevisionProvenance = {
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitDate: "2026-07-11T00:00:00Z",
    branch: "main",
    remote: "git@example.invalid:common.git",
    trackedClean: true,
    trackedDiffSha256: null,
};

function optionsFromManifest(): IV07ArchetypeBatteryOptions {
    const loaded = readV07ArchetypeSeedManifest(manifestPath);
    return {
        candidate: loaded.manifest.candidate,
        opponents: loaded.manifest.opponents,
        gamesPerCell: loaded.manifest.gamesPerCell,
        seeds: loaded.manifest.cells,
        concurrency: 12,
        seedsDeclaredFresh: loaded.manifest.freshSeedsDeclared,
        seedManifest: loaded.provenance,
    };
}

function emptyTelemetry(decisions = 0): IActionTelemetry {
    return { decisions, actionTypes: {}, spells: {}, creatures: {}, creatureActions: {} };
}

function record(
    spec: IV07ArchetypeCellSpec,
    game: number,
    winner: "candidate" | "opponent" | "draw",
    rejectedGreen = 0,
    rejectedRed = 0,
): IV07ArchetypeGameRecord {
    const candidateIsGreen = game % 2 === 0;
    const winnerSide =
        winner === "draw"
            ? "draw"
            : winner === "candidate"
              ? candidateIsGreen
                  ? "green"
                  : "red"
              : candidateIsGreen
                ? "red"
                : "green";
    return {
        template: spec.template,
        game,
        seed: (spec.baseSeed + Math.floor(game / 2) * PAIRED_SCENARIO_SEED_STEP) >>> 0,
        candidateIsGreen,
        greenVersion: candidateIsGreen ? spec.candidate : spec.opponent,
        redVersion: candidateIsGreen ? spec.opponent : spec.candidate,
        roster: rosterSignature(v07ArchetypeTemplate(spec.template).roster),
        winner: winnerSide,
        laps: 4,
        endReason: winner === "draw" ? "turn_cap" : "elimination",
        decidedByArmageddon: false,
        rejectedGreen,
        rejectedRed,
        candidateTelemetry: emptyTelemetry(1),
        opponentTelemetry: emptyTelemetry(2),
    };
}

function integrity(games = 3000): IIntegrityStats {
    return {
        games,
        draws: 0,
        armageddonDecided: 0,
        drawOrArmageddon: 0,
        drawOrArmageddonRate: 0,
        candidateRejections: 0,
        opponentRejections: 0,
        recordsMissingRejectionCounts: 0,
        candidateGamesAsGreen: games / 2,
        candidateGamesAsRed: games / 2,
        candidateWinsAsGreen: Math.floor(games * 0.3),
        candidateWinsAsRed: Math.floor(games * 0.3),
        endReasons: { elimination: games },
    };
}

function outcomes(winRate: number, games = 3000): IPairClusterStats {
    const candidateWins = Math.round(games * winRate);
    return {
        method: "paired-side-swap cluster sandwich",
        confidenceLevel: 0.95,
        games,
        pairClusters: games / 2,
        decisiveGames: games,
        candidateWins,
        opponentWins: games - candidateWins,
        draws: 0,
        candidateWinRate: candidateWins / games,
        deltaFromParityPp: (candidateWins / games - 0.5) * 100,
        standardErrorPp: 0.5,
        confidence95: { low: candidateWins / games - 0.015, high: candidateWins / games + 0.015 },
        moments: {
            clusters: games / 2,
            sumWinSquared: candidateWins,
            sumWinDecisive: candidateWins * 2,
            sumDecisiveSquared: games * 2,
        },
    };
}

function passingCells(options: IV07ArchetypeBatteryOptions): IV07ArchetypeCellReport[] {
    return buildV07ArchetypeCellSpecs(options).map((spec) => ({
        spec,
        outcomes: outcomes(spec.opponent === "v0.6" ? 0.58 : 0.7),
        integrity: integrity(),
        telemetry: { candidate: emptyTelemetry(), opponent: emptyTelemetry() },
    }));
}

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (/^(V04_|V05_|V06_|V07_|SEARCH_|Q2_|CEM_)/.test(key)) delete process.env[key];
    }
});

describe("v0.7 fixed archetype definitions", () => {
    it("derives exact enabled trait sets and excludes JSON-only creatures", () => {
        expect(V07_ARCHETYPE_TAXONOMY).toEqual({
            mage: ["Healer", "Satyr"],
            meleeMage: ["Angel", "Behemoth", "Harpy", "Ogre Mage", "Troll", "Valkyrie"],
            aura: [
                "Angel",
                "Crusader",
                "Griffin",
                "Leprechaun",
                "Peasant",
                "Pegasus",
                "Valkyrie",
                "White Tiger",
                "Wolf Rider",
            ],
            ranged: [
                "Arbalester",
                "Beholder",
                "Centaur",
                "Cyclops",
                "Elf",
                "Gargantuan",
                "Medusa",
                "Orc",
                "Tsar Cannon",
            ],
        });
        expect(Object.values(V07_ARCHETYPE_TAXONOMY).flat()).not.toContain("Champion");
        expect(Object.values(V07_ARCHETYPE_TAXONOMY).flat()).not.toContain("Faerie Dragon");
    });

    it("keeps eight live-composition rosters with exact exp-budget amounts and full trait coverage", () => {
        expect(() => validateV07ArchetypeTemplates()).not.toThrow();
        expect(V07_ARCHETYPE_TEMPLATES).toHaveLength(8);
        expect(V07_ARCHETYPE_TEMPLATES.map((template) => template.name)).toEqual([...V07_ARCHETYPE_TEMPLATE_NAMES]);
        expect(v07ArchetypeTemplate("mage_frontline").roster.map((unit) => [unit.creatureName, unit.amount])).toEqual([
            ["Squire", 132],
            ["Berserker", 109],
            ["Healer", 40],
            ["Satyr", 36],
            ["Crusader", 8],
            ["Hydra", 2],
        ]);
        for (const archetype of V07_ARCHETYPES) {
            const covered = new Set(
                V07_ARCHETYPE_TEMPLATES.filter((template) => template.archetype === archetype).flatMap((template) =>
                    template.roster.map((unit) => unit.creatureName),
                ),
            );
            expect(V07_ARCHETYPE_TAXONOMY[archetype].every((name) => covered.has(name))).toBe(true);
        }
        expect(
            V07_ARCHETYPE_TEMPLATES.filter((template) => template.archetype === "aura").every((template) =>
                template.roster.every((unit) => V07_ARCHETYPE_TAXONOMY.aura.includes(unit.creatureName)),
            ),
        ).toBe(true);
        expect(
            V07_ARCHETYPE_TEMPLATES.filter((template) => template.archetype === "ranged").every((template) =>
                template.roster.every((unit) => V07_ARCHETYPE_TAXONOMY.ranged.includes(unit.creatureName)),
            ),
        ).toBe(true);
    });
});

describe("v0.7 archetype seed and checkpoint provenance", () => {
    it("loads the preregistered panel and rejects overlapping derived streams", () => {
        const options = optionsFromManifest();
        expect(() => validateV07ArchetypeOptions(options)).not.toThrow();
        expect(buildV07ArchetypeCellSpecs(options)).toHaveLength(16);

        const overlapping: IV07ArchetypeBatteryOptions = {
            ...options,
            seeds: {
                ...options.seeds,
                mage_fireline: {
                    ...options.seeds.mage_fireline,
                    "v0.6": (options.seeds.mage_frontline["v0.6"] + PAIRED_SCENARIO_SEED_STEP) >>> 0,
                },
            },
        };
        expect(() => validateV07ArchetypeOptions(overlapping)).toThrow("Seed streams overlap");
    });

    it("binds checkpoints to the exact revision fingerprint", () => {
        const options = optionsFromManifest();
        const spec = buildV07ArchetypeCellSpecs(options)[0];
        const cell = passingCells(options)[0];
        const fingerprint = v07ArchetypeRunFingerprint(options, cleanRevision);
        const changed = v07ArchetypeRunFingerprint(options, { ...cleanRevision, commit: "different" });
        expect(fingerprint).toHaveLength(64);
        expect(changed).not.toBe(fingerprint);

        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-archetype-"));
        try {
            saveV07ArchetypeCheckpoint(directory, cell, fingerprint);
            expect(loadV07ArchetypeCheckpoint(directory, spec, fingerprint)).toEqual(cell);
            expect(loadV07ArchetypeCheckpoint(directory, spec, changed)).toBeUndefined();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

describe("v0.7 archetype attribution and evidence gates", () => {
    it("uses pair clusters and attributes wins/rejections after both side swaps", () => {
        const spec: IV07ArchetypeCellSpec = {
            archetype: "mage",
            template: "mage_frontline",
            candidate: "v0.7",
            opponent: "v0.6",
            baseSeed: 17,
            games: 4,
        };
        const summary = summarizeV07ArchetypeCell(spec, [
            record(spec, 0, "candidate", 2, 7),
            record(spec, 1, "candidate", 11, 3),
            record(spec, 2, "opponent"),
            record(spec, 3, "draw"),
        ]);
        expect(summary.outcomes.candidateWins).toBe(2);
        expect(summary.outcomes.opponentWins).toBe(1);
        expect(summary.outcomes.draws).toBe(1);
        expect(summary.outcomes.pairClusters).toBe(2);
        expect(summary.outcomes.candidateWinRate).toBeCloseTo(2 / 3);
        expect(summary.integrity.candidateGamesAsGreen).toBe(2);
        expect(summary.integrity.candidateGamesAsRed).toBe(2);
        expect(summary.integrity.candidateRejections).toBe(5);
        expect(summary.integrity.opponentRejections).toBe(18);
        expect(summary.telemetry.candidate.decisions).toBe(4);
        expect(summary.telemetry.opponent.decisions).toBe(8);

        const aggregate = aggregateV07ArchetypeCells([summary, summary]);
        expect(aggregate.outcomes.pairClusters).toBe(4);
        expect(aggregate.integrity.candidateRejections).toBe(10);
    });

    it("requires every strong/non-regression gate but keeps Armageddon template-specific and diagnostic", () => {
        const options = optionsFromManifest();
        const cells = passingCells(options);
        const ranged = cells.find(
            (cell) => cell.spec.template === "ranged_precision" && cell.spec.opponent === "v0.6",
        )!;
        ranged.integrity.armageddonDecided = 930;
        ranged.integrity.drawOrArmageddon = 930;
        ranged.integrity.drawOrArmageddonRate = 0.31;

        const pass = assessV07ArchetypeBattery(options, cleanRevision, cells);
        expect(pass.protocolPowered).toBe(true);
        expect(pass.evidenceVerdict).toBe("PASS");
        expect(pass.bakeDecision).toBe("NOT_EVALUATED");
        expect(pass.releaseInstruction).toBe("NO_BAKE_FROM_THIS_REPORT");
        expect(
            pass.resolutionDiagnostics.find(
                (diagnostic) => diagnostic.template === "ranged_precision" && diagnostic.opponent === "v0.6",
            ),
        ).toMatchObject({ armageddonRate: 0.31, policy: "DIAGNOSTIC_ONLY" });

        const regression = structuredClone(cells);
        const weak = regression.find(
            (cell) => cell.spec.template === "ranged_control" && cell.spec.opponent === "v0.6",
        )!;
        weak.outcomes = outcomes(0.49);
        const fail = assessV07ArchetypeBattery(options, cleanRevision, regression);
        expect(fail.evidenceVerdict).toBe("FAIL");
        expect(fail.gates.find((gate) => gate.name === "non-regression-ranged_control-vs-v0.6")?.passed).toBe(false);
    });
});

describe("v0.7 archetype real-engine smoke", () => {
    it("runs one mirrored ranged pair with identical rosters and complete engine diagnostics", () => {
        const spec: IV07ArchetypeCellSpec = {
            archetype: "ranged",
            template: "ranged_precision",
            candidate: "v0.7",
            opponent: "v0.6",
            baseSeed: 8675309,
            games: 2,
        };
        const first = playV07ArchetypeGame(spec, 0);
        const second = playV07ArchetypeGame(spec, 1);
        expect(first.seed).toBe(second.seed);
        expect(first.candidateIsGreen).toBe(true);
        expect(second.candidateIsGreen).toBe(false);
        expect(first.roster).toBe(second.roster);
        expect(first.rejectedGreen).toBe(0);
        expect(first.rejectedRed).toBe(0);
        expect(second.rejectedGreen).toBe(0);
        expect(second.rejectedRed).toBe(0);
        expect(first.candidateTelemetry.decisions).toBeGreaterThan(0);
        expect(second.candidateTelemetry.decisions).toBeGreaterThan(0);

        const summary = summarizeV07ArchetypeCell(spec, [first, second]);
        expect(summary.outcomes.games).toBe(2);
        expect(summary.outcomes.pairClusters).toBe(1);
        expect(summary.integrity.recordsMissingRejectionCounts).toBe(0);
        expect(summary.integrity.candidateGamesAsGreen).toBe(1);
        expect(summary.integrity.candidateGamesAsRed).toBe(1);
    });
});
