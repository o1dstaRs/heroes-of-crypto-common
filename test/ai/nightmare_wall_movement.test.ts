import { describe, expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import {
    appendNightmareGroundWall,
    proposeNightmareGroundWall,
    reserveNightmareWallMovement,
} from "../../src/ai/nightmare_wall_movement";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { GridType, TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import {
    appendNightmareGroundWall as frozenAppend,
    proposeNightmareGroundWall as frozenPropose,
} from "../../src/simulation/nightmare_ground_wall_research";
import { reserveNightmareWallMovement as frozenReserve } from "../../src/simulation/nightmare_wall_movement_research";
import { SearchDriver, withSearchEnvironment } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";
import { captureDeterministicRandomState } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function fixture(
    kind: "flyer" | "shooter" | "caster" | "walker" = "flyer",
    map: GridType = PBTypes.GridVals.NORMAL,
    team: TeamType = 2,
) {
    const combat = createCombatTestContext(map);
    const nightmare = createTestUnit({
        team,
        name: "Nightmare",
        spells: ["Chaos:Fire Wall", "Chaos:Empower"],
        stackPower: 5,
    });
    const enemyTeam = team === 2 ? 1 : 2;
    const ground = createTestUnit({ team: enemyTeam, amountAlive: 10, maxHp: 100, damageMax: 10 });
    const distraction = createTestUnit({
        team: enemyTeam,
        amountAlive: 30,
        damageMax: 50,
        movementType: kind === "flyer" ? PBTypes.MovementVals.FLY : PBTypes.MovementVals.WALK,
        attackType: kind === "shooter" ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: kind === "shooter" ? 10 : 0,
        spells: kind === "caster" ? ["Chaos:Fireball"] : [],
        stackPower: 5,
    });
    const flip = (x: number, y: number) => (team === 2 ? { x, y } : { x: 15 - x, y: 15 - y });
    placeUnit(combat.grid, combat.unitsHolder, nightmare, flip(3, 3));
    placeUnit(combat.grid, combat.unitsHolder, ground, flip(3, 12));
    placeUnit(combat.grid, combat.unitsHolder, distraction, flip(13, 12));
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const context: IDecisionContext = {
        ...combat,
        fightProperties,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        decisionOrigin: "root",
    };
    const catalog = enumerateCandidates(nightmare, context, [
        { type: "end_turn", unitId: nightmare.getId(), reason: "manual" },
    ]).candidates;
    return { ...combat, nightmare, ground, distraction, context, catalog, fightProperties };
}

interface ShortlistDriver {
    shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        deadline: number | null,
        version: string,
    ): readonly IEnumeratedCandidate[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        repeats: number,
        deadline: number | null,
    ): number[];
}

describe("user-adopted Nightmare wall and movement coverage", () => {
    for (const map of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER]) {
        for (const team of [1, 2] as const) {
            test(`matches the immutable proposal on map ${map}, team ${team}, and all output classes`, () => {
                for (const kind of ["flyer", "shooter", "caster", "walker"] as const) {
                    const s = fixture(kind, map, team);
                    const before = snapshotBattle(s.unitsHolder, s.grid, s.fightProperties);
                    const random = captureDeterministicRandomState();
                    const wall = proposeNightmareGroundWall(s.nightmare, s.context, s.catalog);
                    const frozen = frozenPropose(s.nightmare, s.context, s.catalog);
                    expect(wall).toEqual(frozen);
                    if (kind === "walker") expect(wall).toBeUndefined();
                    else expect(wall).toBeDefined();
                    const retained = s.catalog.filter((c) => c.spellName);
                    for (const means of [s.catalog.map(() => 0.5), s.catalog.map((_, i) => (i % 3 ? i : -Infinity))]) {
                        expect(
                            reserveNightmareWallMovement(
                                s.nightmare,
                                s.context,
                                s.catalog,
                                appendNightmareGroundWall(retained, wall),
                                means,
                                wall,
                            ),
                        ).toEqual(
                            frozenReserve(
                                s.nightmare,
                                s.context,
                                s.catalog,
                                frozenAppend(retained, frozen),
                                means,
                                frozen,
                            ),
                        );
                    }
                    expect(snapshotBattle(s.unitsHolder, s.grid, s.fightProperties)).toEqual(before);
                    expect(captureDeterministicRandomState()).toEqual(random);
                }
            });
        }
    }

    test("excludes concealed enemies, unavailable casts, other actors and rollout contexts", () => {
        const s = fixture();
        s.distraction.hasBuffActive = (name) => name === "Hidden";
        expect(proposeNightmareGroundWall(s.nightmare, s.context, s.catalog)).toBeUndefined();
        s.distraction.hasBuffActive = () => false;
        s.distraction.hasAbilityActive = (name) => name === "Hidden";
        expect(proposeNightmareGroundWall(s.nightmare, s.context, s.catalog)).toBeUndefined();
        expect(proposeNightmareGroundWall(s.nightmare, s.context, [])).toBeUndefined();
        expect(proposeNightmareGroundWall(s.ground, s.context, s.catalog)).toBeUndefined();
        expect(
            proposeNightmareGroundWall(s.nightmare, { ...s.context, decisionOrigin: "rollout" }, s.catalog),
        ).toBeUndefined();
    });

    test("the default shortlist preserves the native prefix and reuses exactly one leaf pre-pass", () => {
        const s = fixture();
        const means = s.catalog.map((c) => (c.spellName ? 1 : 0.25));
        let passes = 0;
        const make = (enabled: boolean, shortlist = "2") => {
            const driver = withSearchEnvironment(
                {
                    ...buildV08A19SearchEnvironment(),
                    SEARCH_SHORTLIST: shortlist,
                    SEARCH_A19_NIGHTMARE_WALL_MOVEMENT: enabled ? "1" : "0",
                },
                () =>
                    new SearchDriver(s.context as ILookaheadDeps, {
                        greenVersion: "v0.8",
                        redVersion: "v0.8",
                        offlineDeterministicWork: true,
                    }),
            ) as unknown as ShortlistDriver;
            driver.scoreCandidates = (_unit, catalog, _seed, mode, repeats, deadline) => {
                expect(catalog).toBe(s.catalog);
                expect(mode).toBe("leaf");
                expect(repeats).toBe(1);
                expect(deadline).toBe(123);
                passes++;
                return means;
            };
            return driver;
        };
        const old = make(false).shortlistCandidates(s.nightmare, s.catalog, 47, 123, "v0.8");
        expect(passes).toBe(1);
        const result = make(true).shortlistCandidates(s.nightmare, s.catalog, 47, 123, "v0.8");
        expect(passes).toBe(2);
        const wall = frozenPropose(s.nightmare, s.context, s.catalog);
        expect(result).toEqual(frozenReserve(s.nightmare, s.context, s.catalog, frozenAppend(old, wall), means, wall));
        expect(result.length).toBe(old.length + 2);
        old.forEach((candidate, index) => expect(result[index]).toBe(candidate));
        expect(result.at(-1)?.actions[0].type).toBe("move_unit");
        const nativeOtherVersion = make(false).shortlistCandidates(s.nightmare, s.catalog, 47, 123, "v0.9");
        expect(make(true).shortlistCandidates(s.nightmare, s.catalog, 47, 123, "v0.9")).toEqual(nativeOtherVersion);
        const beforeNoPass = passes;
        const unpruned = make(true, "100").shortlistCandidates(s.nightmare, s.catalog, 47, 123, "v0.8");
        expect(passes).toBe(beforeNoPass);
        expect(unpruned).toEqual(frozenAppend(s.catalog, wall));
    });

    test("the proposed wall executes through the authoritative action engine", () => {
        const s = fixture();
        const wall = proposeNightmareGroundWall(s.nightmare, s.context, s.catalog)!;
        s.fightProperties.startFight();
        s.fightProperties.setTeamUnitsAlive(2, 1);
        s.fightProperties.setTeamUnitsAlive(1, 2);
        s.fightProperties.startTurn(2, 1000);
        const engine = new GameActionEngine({
            ...s.context,
            fightProperties: s.fightProperties,
            moveHandler: new MoveHandler(testGridSettings, s.grid, s.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => s.nightmare.getId(),
            getCurrentEnemiesCellsWithinMovementRange: () => [],
        });
        expect(engine.apply(wall.candidate.actions[0]).completed).toBe(true);
        expect(s.fightProperties.getFireWalls().cells().length).toBeGreaterThan(0);
    });
});
