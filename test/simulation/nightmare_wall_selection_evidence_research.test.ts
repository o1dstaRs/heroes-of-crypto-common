import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enumerateCandidates } from "../../src/ai/candidates";
import { selectV08A19MaterialCandidateIndex } from "../../src/ai/versions/v0_8_a19_material_arbitration";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PathHelper } from "../../src/grid/path_helper";
import { applyNightmareWallOpportunityGate } from "../../src/simulation/nightmare_wall_selection_evidence_research";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function candidates() {
    const combat = createCombatTestContext();
    const nightmare = createTestUnit({
        team: 2,
        name: "Nightmare",
        spells: ["Chaos:Fire Wall", "Chaos:Empower"],
        stackPower: 5,
    });
    placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team: 1 }), { x: 12, y: 12 });
    const catalog = enumerateCandidates(
        nightmare,
        {
            ...combat,
            matrix: combat.grid.getMatrix(),
            pathHelper: new PathHelper(testGridSettings),
            fightProperties: FightStateManager.getInstance().getFightProperties(),
            decisionOrigin: "root",
        },
        [{ type: "end_turn", unitId: nightmare.getId(), reason: "manual" }],
    ).candidates;
    const wall = catalog.find((c) => c.spellName === "Fire Wall")!;
    const empower = catalog.find((c) => c.spellName === "Empower")!;
    expect(wall).toBeDefined();
    expect(empower).toBeDefined();
    return [empower, wall];
}

describe("Nightmare selection evidence adapter", () => {
    test("masks the cached array used by the real material selector, retaining raw forecasts", () => {
        const catalog = candidates();
        const returnedMeans = [0.5, 0.5];
        const materialEvidence = { means: returnedMeans, materials: [0.3, 0.9] };
        expect(
            selectV08A19MaterialCandidateIndex(
                catalog,
                materialEvidence.means,
                materialEvidence.materials,
                0,
                2,
                "ties",
            ),
        ).toBe(1);
        const report = applyNightmareWallOpportunityGate(catalog, returnedMeans, [2, 2], 1);
        expect(report.allowed).toBe(false);
        expect(report.rawMeans).toEqual([0.5, 0.5]);
        expect(materialEvidence.means).toBe(returnedMeans);
        expect(returnedMeans).toEqual([0.5, -Infinity]);
        const selected = selectV08A19MaterialCandidateIndex(
            catalog,
            materialEvidence.means,
            materialEvidence.materials,
            0,
            2,
            "ties",
        );
        expect(selected).toBe(0);
    });
    test("retains a fully scored wall that exceeds the registered margin", () => {
        const catalog = candidates();
        const means = [0.5, 0.75];
        const report = applyNightmareWallOpportunityGate(catalog, means, [2, 2], 1);
        expect(report).toEqual({ allowed: true, rawMeans: [0.5, 0.75] });
        expect(means).toEqual([0.5, 0.75]);
        expect(report.rawMeans).not.toBe(means);
        expect(selectV08A19MaterialCandidateIndex(catalog, means, [0.3, 0.9], 1, 2, "ties")).toBe(1);
    });
    test("rejects partial forecasts and malformed array alignment", () => {
        const catalog = candidates();
        const means = [0.5, 0.75];
        expect(applyNightmareWallOpportunityGate(catalog, means, [2, 1], 1).allowed).toBe(false);
        expect(means).toEqual([0.5, -Infinity]);
        expect(() => applyNightmareWallOpportunityGate(catalog, [0.5, 0.75], [2], 1)).toThrow(
            "Invalid Nightmare wall selection evidence",
        );
        expect(() => applyNightmareWallOpportunityGate(catalog, [0.5, 0.75], [2, 2], -1)).toThrow(
            "Invalid Nightmare wall selection evidence",
        );
    });
    test("remains outside serving imports", () => {
        const root = join(import.meta.dir, "../../src/ai");
        for (const name of new Bun.Glob("**/*.ts").scanSync(root))
            expect(readFileSync(join(root, name), "utf8")).not.toContain("nightmare_wall_selection_evidence_research");
        expect(readFileSync(join(root, "../simulation/search_driver.ts"), "utf8")).not.toContain(
            "nightmare_wall_selection_evidence_research",
        );
    });
});
