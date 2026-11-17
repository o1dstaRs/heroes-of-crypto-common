import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { FireWalls, fireWallCells } from "../../src/spells/fire_walls";
import {
    assessNightmareRouteWall,
    auditNightmareWallRoute,
    nightmareWallOpportunityAllowed,
} from "../../src/simulation/nightmare_route_preservation_research";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function contextOf(combat: ReturnType<typeof createCombatTestContext>): IDecisionContext {
    return {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: FightStateManager.getInstance().getFightProperties(),
        decisionOrigin: "root",
    };
}
function crossing(flyer = false, resist = 0, width = 1) {
    const combat = createCombatTestContext();
    const mover = createTestUnit({
        team: 2,
        amountAlive: 10,
        maxHp: 100,
        magicResist: resist,
        movementType: flyer ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
        footprintWidth: width,
        footprintHeight: 1,
    });
    const enemy = createTestUnit({ team: 1 });
    placeUnit(combat.grid, combat.unitsHolder, mover, { x: 3, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 10, y: 8 });
    const context = contextOf(combat),
        before = context.fightProperties!.getFireWalls(),
        after = new FireWalls();
    after.addAll(fireWallCells({ x: 5, y: 8 }, 2), 3);
    return { combat, mover, enemy, context, before, after };
}
function proposalScene(friendly = false, immobile = false, contact = false) {
    const combat = createCombatTestContext();
    const nightmare = createTestUnit({
        team: 2,
        name: "Nightmare",
        spells: ["Chaos:Fire Wall", "Chaos:Empower"],
        stackPower: 5,
    });
    const ground = createTestUnit({ team: 1, amountAlive: 10, damageMax: 10 });
    (ground as unknown as { unitProperties: { steps: number } }).unitProperties.steps = immobile ? 0 : 3;
    const flyer = createTestUnit({ team: 1, amountAlive: 30, damageMax: 50, movementType: PBTypes.MovementVals.FLY });
    placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, ground, { x: 3, y: 12 });
    placeUnit(combat.grid, combat.unitsHolder, flyer, { x: 13, y: 12 });
    if (friendly) placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team: 2 }), { x: 3, y: 8 });
    if (contact)
        placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team: 1, amountAlive: 1, damageMax: 1 }), {
            x: 4,
            y: 3,
        });
    const context = contextOf(combat);
    const catalog = enumerateCandidates(nightmare, context, [
        { type: "end_turn", unitId: nightmare.getId(), reason: "manual" },
    ]).candidates;
    return { combat, nightmare, context, catalog };
}

describe("Nightmare route preservation research", () => {
    test("prices the native ground toll separately from avoiding additional burns", () => {
        const s = crossing();
        const audit = auditNightmareWallRoute(s.mover, s.context, s.before, s.after, s.enemy.getCells());
        expect(audit.baselineDistance).toBe(4);
        expect(audit.safeDistance).toBeGreaterThan(4);
        expect(audit.bestApproachPreserved).toBe(false);
        expect(s.before.size()).toBe(0);
        s.before.addAll(s.after.cells(), 3);
        const actual = auditNightmareWallRoute(s.mover, s.context, s.before, s.before, s.enemy.getCells());
        expect(actual.baselineDistance).toBe(5);
        expect(actual.baselineDistance).toBeGreaterThan(audit.baselineDistance);
        // Native reach includes a burning landing; the safe-route proxy additionally excludes it.
        expect(audit.safeDistance).toBe(6);
    });
    test("ground immunity avoids burns but still pays the crossing step", () => {
        const s = crossing(false, 100);
        expect(
            auditNightmareWallRoute(s.mover, s.context, s.before, s.after, s.enemy.getCells()).bestApproachPreserved,
        ).toBe(false);
    });
    test("flight preserves crossing but not a burning landing", () => {
        const s = crossing(true);
        expect(
            auditNightmareWallRoute(s.mover, s.context, s.before, s.after, s.enemy.getCells()).bestApproachPreserved,
        ).toBe(true);
        const landing = new FireWalls();
        landing.addAll(fireWallCells({ x: 6, y: 8 }, 2), 3);
        expect(
            auditNightmareWallRoute(s.mover, s.context, s.before, landing, s.enemy.getCells()).bestApproachPreserved,
        ).toBe(false);
    });
    test("uses the real rectangular body and preserves an unobstructed alternative", () => {
        const s = crossing(false, 0, 2);
        expect(s.mover.getFootprintWidth()).toBe(2);
        expect(
            auditNightmareWallRoute(s.mover, s.context, s.before, s.after, s.enemy.getCells()).bestApproachPreserved,
        ).toBe(false);
        const away = new FireWalls();
        away.addAll(fireWallCells({ x: 5, y: 2 }, 2), 3);
        expect(
            auditNightmareWallRoute(s.mover, s.context, s.before, away, s.enemy.getCells()).bestApproachPreserved,
        ).toBe(true);
    });
    test("accepts an enemy approach wall without changing the board or the old proposal", () => {
        const s = proposalScene();
        const before = JSON.stringify({
            matrix: s.context.matrix,
            units: [...s.context.unitsHolder.getAllUnits().values()].map((u) => [
                u.getId(),
                u.getCells(),
                u.getCumulativeHp(),
            ]),
            walls: s.context.fightProperties!.getFireWalls().toJSON(),
            catalog: s.catalog,
        });
        const result = assessNightmareRouteWall(s.nightmare, s.context, s.catalog);
        expect(result.reason).toBe("proposed");
        expect(result.proposal).toBe(result.original);
        expect(
            JSON.stringify({
                matrix: s.context.matrix,
                units: [...s.context.unitsHolder.getAllUnits().values()].map((u) => [
                    u.getId(),
                    u.getCells(),
                    u.getCumulativeHp(),
                ]),
                walls: s.context.fightProperties!.getFireWalls().toJSON(),
                catalog: s.catalog,
            }),
        ).toBe(before);
    });
    test("declines friendly obstruction, unpressured enemies and an available direct attack", () => {
        for (const [friendly, immobile, contact, reason] of [
            [true, false, false, "friendly_route"],
            [false, true, false, "no_enemy_pressure"],
            [false, false, true, "direct_attack"],
        ] as const) {
            const s = proposalScene(friendly, immobile, contact);
            expect(assessNightmareRouteWall(s.nightmare, s.context, s.catalog).reason).toBe(reason);
        }
    });
    test("protects known hidden allies while declining a non-live path context", () => {
        const s = proposalScene(true);
        const ally = [...s.context.unitsHolder.getAllUnits().values()].find(
            (u) => u.getTeam() === 2 && u !== s.nightmare,
        )!;
        const original = ally.hasBuffActive.bind(ally);
        ally.hasBuffActive = (name) => name === "Hidden" || original(name);
        expect(assessNightmareRouteWall(s.nightmare, s.context, s.catalog).reason).toBe("friendly_route");
        const other = createCombatTestContext();
        expect(assessNightmareRouteWall(s.nightmare, s.context, s.catalog).reason).toBe("context");
        expect(other.grid).toBeDefined();
    });
    test("requires complete full forecasts and a strict productive margin without mutating forecasts", () => {
        const s = proposalScene();
        const wall = s.catalog.find((c) => c.spellName === "Fire Wall")!;
        const empower = s.catalog.find((c) => c.spellName === "Empower")!;
        const candidates: IEnumeratedCandidate[] = [empower, wall];
        expect(nightmareWallOpportunityAllowed(candidates, [0.5, 0.5], [2, 2], 1)).toBe(false);
        expect(nightmareWallOpportunityAllowed(candidates, [0.5, 0.51], [2, 2], 1)).toBe(false);
        const scores = [0.5, 0.511];
        expect(nightmareWallOpportunityAllowed(candidates, scores, [2, 2], 1)).toBe(true);
        expect(scores).toEqual([0.5, 0.511]);
        expect(nightmareWallOpportunityAllowed(candidates, scores, [1, 2], 1)).toBe(false);
        expect(nightmareWallOpportunityAllowed(candidates, scores, [2, 1], 1)).toBe(false);
        expect(nightmareWallOpportunityAllowed([wall, wall], [0.5, 0.5], [2, 2], 1)).toBe(true);
        expect(nightmareWallOpportunityAllowed(candidates, scores, [2], 1)).toBe(false);
    });
    test("stays outside serving and preserves the original checkpoint", () => {
        const root = join(import.meta.dir, "../../src/ai");
        for (const name of new Bun.Glob("**/*.ts").scanSync(root))
            expect(readFileSync(join(root, name), "utf8")).not.toContain("nightmare_route_preservation_research");
        const bytes = readFileSync(join(import.meta.dir, "../../src/simulation/nightmare_ground_wall_research.ts"));
        expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(
            "83d590e8ad804382bf649891c8114a29e3ea5db2da937b8492f476ea5dffd85c",
        );
    });
});
