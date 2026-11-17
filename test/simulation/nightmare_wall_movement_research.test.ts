import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { enumerateCandidates } from "../../src/ai/candidates";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import {
    appendNightmareGroundWall,
    proposeNightmareGroundWall,
} from "../../src/simulation/nightmare_ground_wall_research";
import { reserveNightmareWallMovement } from "../../src/simulation/nightmare_wall_movement_research";
import { captureDeterministicRandomState } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function fixture() {
    const combat = createCombatTestContext();
    const nightmare = createTestUnit({
        team: 2,
        name: "Nightmare",
        spells: ["Chaos:Fire Wall", "Chaos:Empower"],
        stackPower: 5,
    });
    placeUnit(combat.grid, combat.unitsHolder, nightmare, { x: 3, y: 3 });
    placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team: 1 }), { x: 3, y: 12 });
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        createTestUnit({ team: 1, name: "Angel", movementType: PBTypes.MovementVals.FLY, damageMax: 50 }),
        { x: 13, y: 12 },
    );
    const context = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: FightStateManager.getInstance().getFightProperties(),
        decisionOrigin: "root" as const,
    };
    const catalog = enumerateCandidates(nightmare, context, [
        { type: "end_turn", unitId: nightmare.getId(), reason: "manual" },
    ]).candidates;
    const wall = proposeNightmareGroundWall(nightmare, context, catalog);
    expect(wall).toBeDefined();
    const moves = catalog.filter((c) => c.actions.length === 1 && c.actions[0].type === "move_unit");
    expect(moves.length).toBeGreaterThan(0);
    const native = catalog.filter((c) => c.spellName).slice(0, 2);
    expect(native.length).toBeGreaterThan(0);
    const retained = appendNightmareGroundWall(native, wall);
    return { nightmare, context, catalog, wall, moves, retained };
}

describe("Nightmare wall movement comparison coverage", () => {
    test("adds a native movement comparison without replacing spells, wall geometry, features or identities", () => {
        const { nightmare, context, catalog, wall, moves, retained } = fixture();
        const means = catalog.map((c) => (c === moves[0] ? 0.4 : 0.9));
        const before = JSON.stringify({ catalog, retained, means });
        const random = captureDeterministicRandomState();
        const result = reserveNightmareWallMovement(nightmare, context, catalog, retained, means, wall);
        expect(result.length).toBe(retained.length + 1);
        for (let i = 0; i < retained.length; i++) expect(result[i]).toBe(retained[i]);
        expect(moves).toContain(result.at(-1)!);
        expect(catalog).toContain(result.at(-1)!);
        expect(JSON.stringify({ catalog, retained, means })).toBe(before);
        expect(captureDeterministicRandomState()).toEqual(random);
    });

    test("keeps a retained move even when an omitted move has a higher leaf score", () => {
        const { nightmare, context, catalog, wall, moves, retained } = fixture();
        const withMove = [...retained, moves[0]];
        expect(
            reserveNightmareWallMovement(
                nightmare,
                context,
                catalog,
                withMove,
                catalog.map(() => 1),
                wall,
            ),
        ).toBe(withMove);
    });

    test("uses finite native leaf evidence and stable catalog ties, with no extra evaluation", () => {
        const { nightmare, context, catalog, wall, moves, retained } = fixture();
        const first = moves[0];
        const duplicate = { ...first, features: { ...first.features } };
        const list = [...catalog, duplicate];
        const means = list.map((c) => (c === first || c === duplicate ? 0.25 : -Infinity));
        expect(reserveNightmareWallMovement(nightmare, context, list, retained, means, wall).at(-1)).toBe(first);
        means[list.indexOf(first)] = Number.NaN;
        expect(reserveNightmareWallMovement(nightmare, context, list, retained, means, wall).at(-1)).toBe(duplicate);
        means[means.length - 1] = -Infinity;
        expect(reserveNightmareWallMovement(nightmare, context, list, retained, means, wall)).toBe(retained);
        expect(reserveNightmareWallMovement(nightmare, context, catalog, retained, undefined, wall)).toBe(retained);
        expect(reserveNightmareWallMovement(nightmare, context, catalog, retained, [0], wall)).toBe(retained);
    });

    test("requires this unit's pure move, an original wall proposal and an actual root", () => {
        const { nightmare, context, catalog, wall, moves, retained } = fixture();
        const mean = catalog.map(() => 0.5);
        expect(reserveNightmareWallMovement(nightmare, context, catalog, retained, mean, undefined)).toBe(retained);
        expect(
            reserveNightmareWallMovement(nightmare, { decisionOrigin: "rollout" }, catalog, retained, mean, wall),
        ).toBe(retained);
        const other = createTestUnit({ team: 2, name: "Peasant" });
        expect(reserveNightmareWallMovement(other, context, catalog, retained, mean, wall)).toBe(retained);
        const mixed = { ...moves[0], actions: [...moves[0].actions, ...retained[0].actions] };
        expect(reserveNightmareWallMovement(nightmare, context, [mixed], retained, [1], wall)).toBe(retained);
        const alien = { ...moves[0], actions: [{ ...moves[0].actions[0], unitId: other.getId() }] };
        expect(reserveNightmareWallMovement(nightmare, context, [alien], retained, [1], wall)).toBe(retained);
    });

    test("stays outside serving imports", () => {
        const root = join(import.meta.dir, "../../src/ai");
        for (const name of new Bun.Glob("**/*.ts").scanSync(root))
            expect(readFileSync(join(root, name), "utf8")).not.toContain("nightmare_wall_movement_research");
        expect(readFileSync(join(root, "../simulation/search_driver.ts"), "utf8")).not.toContain(
            "nightmare_wall_movement_research",
        );
    });
});
