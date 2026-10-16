import { describe, expect, test } from "bun:test";
import { enumerateCandidates } from "../../src/ai/candidates";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { openedV08FlyerScreen, preserveV08ClosedRangedScreen } from "../../src/ai/versions/v0_8_screen_hold";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

function board(options: { mirror?: boolean; width?: number; height?: number; far?: boolean; denial?: boolean } = {}) {
    const combat = createCombatTestContext();
    const team = options.mirror ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const enemyTeam = options.mirror ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const ward = createTestUnit({
        team,
        name: "Elf",
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 5,
        amountAlive: 20,
    });
    const screen = createTestUnit({
        team,
        name: "Peasant",
        amountAlive: 30,
        abilities: options.mindless ? ["AI Driven"] : [],
    });
    const width = options.width ?? 2,
        height = options.height ?? 2;
    const flyer = createTestUnit({
        team: enemyTeam,
        name: "Flyer",
        movementType: PBTypes.MovementVals.FLY,
        size: PBTypes.UnitSizeVals.LARGE,
        footprintWidth: width,
        footprintHeight: height,
        abilities: options.denial ? ["Time Denial"] : [],
    });
    const anchor = (x: number, y: number, w = 1) => ({ x: options.mirror ? 15 - x + w - 1 : x, y });
    placeUnit(combat.grid, combat.unitsHolder, ward, anchor(0, 0));
    placeUnit(combat.grid, combat.unitsHolder, screen, anchor(1, 1));
    placeUnit(combat.grid, combat.unitsHolder, flyer, anchor(options.far ? 12 : 4, 2, width));
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties: FightStateManager.getInstance().getFightProperties(),
        decisionOrigin: "root",
    };
    context.fightProperties!.setTeamUnitsAlive(team, 2);
    context.fightProperties!.setTeamUnitsAlive(enemyTeam, 1);
    const decision: GameAction[] = [
        { type: "move_unit", unitId: screen.getId(), path: [anchor(1, 1), anchor(2, 2), anchor(3, 3)] },
    ];
    return { screen, ward, flyer, context, decision };
}

describe("experimental closed ranged screen", () => {
    test("the native attack enumerator gains a shooter target after the blocking body moves", () => {
        const { screen, flyer, ward, context } = board();
        const choices = () =>
            enumerateCandidates(flyer, { ...context, matrix: context.grid.getMatrix() }, [
                { type: "defend_turn", unitId: flyer.getId() },
            ]).candidates;
        expect(choices().some((c) => c.kind === "melee" && c.targetId === ward.getId())).toBe(false);
        context.grid.cleanupAll(screen.getId(), screen.getAttackRange(), screen.isSmallSize());
        placeUnit(context.grid, context.unitsHolder, screen, { x: 3, y: 3 });
        expect(choices().some((c) => c.kind === "melee" && c.targetId === ward.getId())).toBe(true);
    });

    test("never issues hold orders to an AI Driven unit", () => {
        const { screen, context, decision } = board({ mindless: true });
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toBe(decision);
    });
    test("retains a screen against a flyer that can attack again next lap", () => {
        const { screen, flyer, context, decision } = board();
        context.fightProperties!.addAlreadyMadeTurn(flyer.getTeam(), flyer.getId());
        expect(openedV08FlyerScreen(screen, context, decision)).toBeDefined();
    });

    test("delays the move that opens a closed corner, without mutating board or actions", () => {
        const { screen, ward, flyer, context, decision } = board();
        const before = JSON.stringify([context.grid.getMatrix(), screen.getCells(), decision]);
        expect(openedV08FlyerScreen(screen, context, decision)).toMatchObject({
            wardId: ward.getId(),
            flyerId: flyer.getId(),
        });
        expect(preserveV08ClosedRangedScreen(screen, context, decision)).toEqual([
            { type: "wait_turn", unitId: screen.getId() },
        ]);
        expect(JSON.stringify([context.grid.getMatrix(), screen.getCells(), decision])).toBe(before);
    });
    test("mirrors the same screen geometry across physical sides", () => {
        const first = board();
        const a = openedV08FlyerScreen(first.screen, first.context, first.decision)?.openedLandings;
        const second = board({ mirror: true });
        expect(openedV08FlyerScreen(second.screen, second.context, second.decision)?.openedLandings).toBe(a);
        expect(a).toBeGreaterThan(0);
    });
    test("does not pretend a small flyer is blocked by the large-body screen", () => {
        const { screen, context, decision } = board({ width: 1, height: 1 });
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toBe(decision);
    });
    test("uses a rectangle's real footprint rather than a phantom square", () => {
        const { screen, context, decision } = board({ width: 2, height: 1 });
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toBe(decision);
    });
    test("does not hold for a flyer outside the two-activation threat window", () => {
        const { screen, context, decision } = board({ far: true });
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toBe(decision);
    });
    test("preserves attacks, move-attacks and spells", () => {
        const { screen, flyer, context, decision } = board();
        const strike: GameAction[] = [
            ...decision,
            { type: "melee_attack", attackerId: screen.getId(), targetId: flyer.getId(), attackFrom: { x: 3, y: 3 } },
        ];
        expect(preserveV08ClosedRangedScreen(screen, context, strike, true)).toBe(strike);
        const spell: GameAction[] = [
            { type: "cast_spell", casterId: screen.getId(), spellName: "Heal", targetId: screen.getId() },
        ];
        expect(preserveV08ClosedRangedScreen(screen, context, spell, true)).toBe(spell);
    });
    test("respects Time Denial and only defends when the experiment explicitly permits it", () => {
        const { screen, context, decision } = board({ denial: true });
        expect(preserveV08ClosedRangedScreen(screen, context, decision)).toBe(decision);
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toEqual([
            { type: "defend_turn", unitId: screen.getId() },
        ]);
    });
    test("does not repeat hourglass and can release instead of defending", () => {
        const { screen, context, decision } = board();
        context.fightProperties!.enqueueHourglass(screen.getId());
        expect(preserveV08ClosedRangedScreen(screen, context, decision)).toBe(decision);
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)[0].type).toBe("defend_turn");
    });
    test("keeps a move that still covers the landing space", () => {
        const { screen, context, decision } = board();
        decision[0] = { type: "move_unit", unitId: screen.getId(), path: [{ x: 1, y: 1 }] };
        expect(preserveV08ClosedRangedScreen(screen, context, decision, true)).toBe(decision);
    });
});
