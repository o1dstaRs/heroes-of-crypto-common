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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    QUARTET_SCENARIO_SEED_STEP,
    V07_CROSS_ARCHETYPE_MATCHUPS,
    V07_CROSS_ARCHETYPE_MATCHUP_DEFINITIONS,
    V07_CROSS_ARCHETYPE_PROTOCOL,
    V07_CROSS_QUARTET_ASSIGNMENTS,
    aggregateV07CrossArchetypeCells,
    assessV07CrossArchetypeEvidence,
    buildV07CrossArchetypeCellSpecs,
    loadV07CrossArchetypeCheckpoint,
    readV07CrossArchetypeSeedManifest,
    runV07CrossArchetypeCell,
    runV07CrossArchetypeEvidence,
    saveV07CrossArchetypeCheckpoint,
    summarizeV07CrossArchetypeCell,
    v07CrossArchetypeRunFingerprint,
    validateV07CrossArchetypeOptions,
    type IV07CrossArchetypeCellReport,
    type IV07CrossArchetypeCellSpec,
    type IV07CrossArchetypeGameRecord,
    type IV07CrossArchetypeOptions,
    type IV07CrossArchetypeSeedManifest,
} from "../../src/simulation/v0_7_cross_archetype";
import {
    rosterSignature,
    v07ArchetypeTemplate,
    type IActionTelemetry,
} from "../../src/simulation/v0_7_archetype_battery";
import type { IRevisionProvenance } from "../../src/simulation/v0_7_acceptance";

const cleanRevision: IRevisionProvenance = {
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitDate: "2026-07-11T00:00:00Z",
    branch: "main",
    remote: "git@example.invalid:common.git",
    trackedClean: true,
    trackedDiffSha256: null,
};

const testSeeds = {
    mage_frontline_vs_mage_fireline: 101,
    melee_magic_utility_vs_melee_magic_brawler: 1_000_101,
    aura_support_vs_mage_frontline: 2_000_101,
    ranged_precision_vs_ranged_control: 3_000_101,
} as const;

function options(gamesPerCell = 4): IV07CrossArchetypeOptions {
    return {
        candidate: "v0.7",
        opponent: "v0.6",
        gamesPerCell,
        seeds: testSeeds,
        concurrency: 2,
        seedsDeclaredFresh: true,
        seedManifest: null,
    };
}

function emptyTelemetry(decisions = 0): IActionTelemetry {
    return { decisions, actionTypes: {}, spells: {}, creatures: {}, creatureActions: {} };
}

function gameRecord(
    spec: IV07CrossArchetypeCellSpec,
    game: number,
    winner: "candidate" | "opponent" | "draw",
    rejectedGreen = 0,
    rejectedRed = 0,
): IV07CrossArchetypeGameRecord {
    const assignment = V07_CROSS_QUARTET_ASSIGNMENTS[game % 4];
    const candidateIsGreen = assignment.candidateSide === "green";
    const template = (slot: "A" | "B") => (slot === "A" ? spec.templateA : spec.templateB);
    const candidateTemplate = template(assignment.candidateRosterSlot);
    const opponentTemplate = candidateTemplate === spec.templateA ? spec.templateB : spec.templateA;
    const greenTemplate = template(assignment.greenRosterSlot);
    const redTemplate = template(assignment.redRosterSlot);
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
        matchup: spec.matchup,
        game,
        seed: (spec.baseSeed + Math.floor(game / 4) * QUARTET_SCENARIO_SEED_STEP) >>> 0,
        candidateIsGreen,
        candidateTemplate,
        opponentTemplate,
        greenVersion: candidateIsGreen ? spec.candidate : spec.opponent,
        redVersion: candidateIsGreen ? spec.opponent : spec.candidate,
        greenTemplate,
        redTemplate,
        greenRoster: rosterSignature(v07ArchetypeTemplate(greenTemplate).roster),
        redRoster: rosterSignature(v07ArchetypeTemplate(redTemplate).roster),
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

function fixedWinnerRecords(
    spec: IV07CrossArchetypeCellSpec,
    winnerAtOffset: readonly ("candidate" | "opponent" | "draw")[],
): IV07CrossArchetypeGameRecord[] {
    return Array.from({ length: spec.games }, (_, game) => gameRecord(spec, game, winnerAtOffset[game % 4]));
}

afterEach(() => {
    for (const key of Object.keys(process.env)) {
        if (/^(V04_|V05_|V06_|V07_|SEARCH_|Q2_|CEM_)/.test(key)) delete process.env[key];
    }
});

describe("v0.7 cross-archetype quartet protocol", () => {
    it("fixes four non-diagonal cells and balances side independently from roster assignment", () => {
        const specs = buildV07CrossArchetypeCellSpecs(options());
        expect(specs.map((spec) => spec.matchup)).toEqual([...V07_CROSS_ARCHETYPE_MATCHUPS]);
        expect(
            V07_CROSS_QUARTET_ASSIGNMENTS.map((assignment) => [
                assignment.candidateRosterSlot,
                assignment.candidateSide,
            ]),
        ).toEqual([
            ["A", "green"],
            ["B", "red"],
            ["B", "green"],
            ["A", "red"],
        ]);
        for (const spec of specs) {
            expect(spec.templateA).toBe(V07_CROSS_ARCHETYPE_MATCHUP_DEFINITIONS[spec.matchup].templateA);
            expect(spec.templateB).toBe(V07_CROSS_ARCHETYPE_MATCHUP_DEFINITIONS[spec.matchup].templateB);
        }
    });

    it("attributes quartet outcomes and rejection counts to candidate version after every assignment swap", () => {
        const spec = buildV07CrossArchetypeCellSpecs(options())[0];
        const summary = summarizeV07CrossArchetypeCell(spec, [
            gameRecord(spec, 0, "candidate", 2, 7),
            gameRecord(spec, 1, "candidate", 11, 3),
            gameRecord(spec, 2, "opponent"),
            gameRecord(spec, 3, "draw"),
        ]);
        expect(summary.outcomes.candidateWins).toBe(2);
        expect(summary.outcomes.opponentWins).toBe(1);
        expect(summary.outcomes.draws).toBe(1);
        expect(summary.outcomes.quartetClusters).toBe(1);
        expect(summary.outcomes.candidateWinRate).toBeCloseTo(2 / 3);
        expect(summary.integrity.candidateGamesAsGreen).toBe(2);
        expect(summary.integrity.candidateGamesAsRed).toBe(2);
        expect(summary.integrity.candidateGamesWithTemplateA).toBe(2);
        expect(summary.integrity.candidateGamesWithTemplateB).toBe(2);
        expect(summary.integrity.candidateAssignmentMatrix).toEqual({
            "A-green": 1,
            "A-red": 1,
            "B-green": 1,
            "B-red": 1,
        });
        expect(summary.integrity.candidateRejections).toBe(5);
        expect(summary.integrity.opponentRejections).toBe(18);
        expect(summary.telemetry.candidate.decisions).toBe(4);
        expect(summary.telemetry.opponent.decisions).toBe(8);

        const aggregate = aggregateV07CrossArchetypeCells([summary, summary]);
        expect(aggregate.outcomes.quartetClusters).toBe(2);
        expect(aggregate.integrity.candidateAssignmentMatrix["A-green"]).toBe(2);
        expect(aggregate.integrity.candidateRejections).toBe(10);
    });

    it("rejects a record whose roster assignment is mislabeled even when side and versions are valid", () => {
        const spec = buildV07CrossArchetypeCellSpecs(options())[0];
        const records = fixedWinnerRecords(spec, ["candidate", "opponent", "candidate", "opponent"]);
        records[1] = { ...records[1], candidateTemplate: spec.templateA };
        expect(() => summarizeV07CrossArchetypeCell(spec, records)).toThrow(
            "violates fixed quartet side/roster assignment",
        );
    });
});

describe("v0.7 cross-archetype provenance", () => {
    it("rejects overlap between derived quartet seed streams", () => {
        const overlapping = options(8);
        overlapping.seeds = {
            ...overlapping.seeds,
            melee_magic_utility_vs_melee_magic_brawler:
                (overlapping.seeds.mage_frontline_vs_mage_fireline + QUARTET_SCENARIO_SEED_STEP) >>> 0,
        };
        expect(() => validateV07CrossArchetypeOptions(overlapping)).toThrow("Seed streams overlap");
    });

    it("binds atomic checkpoints to the exact revision and panel fingerprint", () => {
        const panel = options();
        const spec = buildV07CrossArchetypeCellSpecs(panel)[0];
        const cell = summarizeV07CrossArchetypeCell(
            spec,
            fixedWinnerRecords(spec, ["candidate", "candidate", "opponent", "opponent"]),
        );
        const fingerprint = v07CrossArchetypeRunFingerprint(panel, cleanRevision);
        const changed = v07CrossArchetypeRunFingerprint(panel, { ...cleanRevision, commit: "different" });
        expect(fingerprint).toHaveLength(64);
        expect(changed).not.toBe(fingerprint);

        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-cross-checkpoint-"));
        try {
            saveV07CrossArchetypeCheckpoint(directory, cell, fingerprint);
            expect(loadV07CrossArchetypeCheckpoint(directory, spec, fingerprint)).toEqual(cell);
            expect(loadV07CrossArchetypeCheckpoint(directory, spec, changed)).toBeUndefined();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("requires the exact persisted powered protocol and reports complete quartet gates", () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v07-cross-manifest-"));
        const manifestPath = join(directory, "panel.json");
        const manifest: IV07CrossArchetypeSeedManifest = {
            schemaVersion: 1,
            manifestId: "test-only-cross-panel",
            createdAt: "2026-07-11T00:00:00Z",
            candidate: V07_CROSS_ARCHETYPE_PROTOCOL.candidate,
            opponent: V07_CROSS_ARCHETYPE_PROTOCOL.opponent,
            gamesPerCell: V07_CROSS_ARCHETYPE_PROTOCOL.gamesPerCell,
            cells: { ...testSeeds },
            freshSeedsDeclared: true,
            declaration: "Test fixture only; not a powered evaluation seed panel.",
        };
        try {
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
            const loaded = readV07CrossArchetypeSeedManifest(manifestPath);
            const panel: IV07CrossArchetypeOptions = {
                candidate: loaded.manifest.candidate,
                opponent: loaded.manifest.opponent,
                gamesPerCell: loaded.manifest.gamesPerCell,
                seeds: loaded.manifest.cells,
                concurrency: 12,
                seedsDeclaredFresh: loaded.manifest.freshSeedsDeclared,
                seedManifest: loaded.provenance,
            };
            const cells = buildV07CrossArchetypeCellSpecs(panel).map((spec) =>
                summarizeV07CrossArchetypeCell(
                    spec,
                    fixedWinnerRecords(spec, ["candidate", "candidate", "candidate", "opponent"]),
                ),
            );
            cells.find(
                (cell) => cell.spec.matchup === "mage_frontline_vs_mage_fireline",
            )!.telemetry.candidate.actionTypes.cast_spell = 1;
            cells.find(
                (cell) => cell.spec.matchup === "melee_magic_utility_vs_melee_magic_brawler",
            )!.telemetry.candidate.spells.Resurrection = 1;
            cells.find(
                (cell) => cell.spec.matchup === "ranged_precision_vs_ranged_control",
            )!.telemetry.candidate.actionTypes.range_attack = 1;
            const assessment = assessV07CrossArchetypeEvidence(panel, cleanRevision, cells);
            expect(assessment.protocolPowered).toBe(true);
            expect(assessment.evidenceVerdict).toBe("PASS");
            expect(assessment.gates.find((gate) => gate.name === "quartet-record-completeness")).toMatchObject({
                passed: true,
            });
            expect(assessment.gates.find((gate) => gate.name === "pooled-cross-archetype-confidence")).toMatchObject({
                passed: true,
            });
            expect(assessment.gates.find((gate) => gate.name === "expected-archetype-branch-exposure")).toMatchObject({
                passed: true,
            });
            expect(assessment.gates.find((gate) => gate.name === "archetype-action-coverage")).toMatchObject({
                passed: true,
            });

            const incomplete = assessV07CrossArchetypeEvidence(panel, cleanRevision, cells.slice(1));
            expect(incomplete.protocolPowered).toBe(false);
            expect(incomplete.evidenceVerdict).toBe("INCONCLUSIVE");
            expect(incomplete.protocolCompletenessReasons.join(" ")).toContain("collected 3/4");

            const wrongSpec = structuredClone(cells);
            wrongSpec[0].spec.baseSeed += 1;
            const mismatched = assessV07CrossArchetypeEvidence(panel, cleanRevision, wrongSpec);
            expect(mismatched.protocolPowered).toBe(false);
            expect(mismatched.protocolCompletenessReasons.join(" ")).toContain("preregistered spec");
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it("refuses behavior-changing environment instead of silently sanitizing evidence", async () => {
        process.env.V07_WAIT_WEIGHTS = "0,0,0,0,0,0,0,0,0";
        await expect(runV07CrossArchetypeEvidence(options())).rejects.toThrow("behavior-changing environment");
    });
});

describe("v0.7 expected branch exposure diagnostics", () => {
    it("labels fixed-roster opportunities as expected, not runtime-observed branch hits", () => {
        const specs = buildV07CrossArchetypeCellSpecs(options());
        const reports = new Map<string, IV07CrossArchetypeCellReport>();
        for (const spec of specs) {
            reports.set(
                spec.matchup,
                summarizeV07CrossArchetypeCell(
                    spec,
                    fixedWinnerRecords(spec, ["candidate", "opponent", "candidate", "opponent"]),
                ),
            );
        }
        expect(reports.get("mage_frontline_vs_mage_fireline")?.expectedBranchExposures).toMatchObject({
            policy: "EXPECTED_FROM_VALIDATED_FIXED_ROSTERS_NOT_RUNTIME_BRANCH_INSTRUMENTATION",
            auraAnchorGames: 0,
            meleeMagicAnchorGames: 0,
            meleeMagicSalvageGames: 0,
            rangedVsAreaThrowGames: 0,
        });
        expect(reports.get("aura_support_vs_mage_frontline")?.expectedBranchExposures).toMatchObject({
            auraAnchorGames: 2,
            meleeMagicAnchorGames: 0,
            meleeMagicSalvageGames: 0,
            rangedVsAreaThrowGames: 0,
        });
        expect(reports.get("melee_magic_utility_vs_melee_magic_brawler")?.expectedBranchExposures).toMatchObject({
            auraAnchorGames: 0,
            meleeMagicAnchorGames: 2,
            meleeMagicSalvageGames: 2,
            rangedVsAreaThrowGames: 0,
        });
        expect(reports.get("ranged_precision_vs_ranged_control")?.expectedBranchExposures).toMatchObject({
            auraAnchorGames: 0,
            meleeMagicAnchorGames: 0,
            meleeMagicSalvageGames: 0,
            rangedVsAreaThrowGames: 2,
        });
        const aggregate = aggregateV07CrossArchetypeCells([...reports.values()]);
        expect(aggregate.expectedBranchExposures).toMatchObject({
            auraAnchorGames: 2,
            meleeMagicAnchorGames: 2,
            meleeMagicSalvageGames: 2,
            rangedVsAreaThrowGames: 2,
        });
    });
});

describe("v0.7 cross-archetype real-engine worker smoke", () => {
    it("runs one ranged quartet through worker concurrency with complete engine diagnostics", async () => {
        const spec = buildV07CrossArchetypeCellSpecs(options()).find(
            (candidate) => candidate.matchup === "ranged_precision_vs_ranged_control",
        )!;
        const summary = await runV07CrossArchetypeCell(spec, 2);
        expect(summary.outcomes.games).toBe(4);
        expect(summary.outcomes.quartetClusters).toBe(1);
        expect(summary.integrity.candidateAssignmentMatrix).toEqual({
            "A-green": 1,
            "A-red": 1,
            "B-green": 1,
            "B-red": 1,
        });
        expect(summary.integrity.recordsMissingRejectionCounts).toBe(0);
        expect(summary.integrity.candidateRejections).toBe(0);
        expect(summary.telemetry.candidate.decisions).toBeGreaterThan(0);
        expect(summary.telemetry.opponent.decisions).toBeGreaterThan(0);
        expect(summary.expectedBranchExposures.rangedVsAreaThrowGames).toBe(2);
    });
});
