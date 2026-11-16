import { afterEach, expect, test } from "bun:test";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import {
    inspectPeasantResponseCost,
    isPeasantResponseSequence,
    reservePeasantPostmoveCandidate,
} from "../../src/simulation/peasant_postmove_research";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));
function fixture(damage = 10, amount = 40, separated = false) {
    const combat = createCombatTestContext(),
        fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({
            name: "Peasant",
            team: PBTypes.TeamVals.LEFT,
            abilities: ["Bitter Experience"],
            maxHp: 8,
            amountAlive: amount,
            armor: 7,
            attack: 9,
            damageMin: 2,
            damageMax: 3,
        }),
        enemy = createTestUnit({
            team: PBTypes.TeamVals.RIGHT,
            maxHp: 80,
            amountAlive: 1,
            damageMin: damage,
            damageMax: damage,
            attack: 7,
            armor: 7,
        });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: separated ? 4 : 5 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 6 });
    fp.startFight();
    fp.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fp.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fp.startTurn(PBTypes.TeamVals.LEFT, 1000);
    const context: IDecisionContext = {
            ...combat,
            fightProperties: fp,
            decisionOrigin: "root",
            matrix: combat.grid.getMatrix(),
            pathHelper: new PathHelper(combat.grid.getSettings()),
        },
        strike = {
            type: "melee_attack" as const,
            attackerId: actor.getId(),
            targetId: enemy.getId(),
            attackFrom: { x: 4, y: 5 },
        };
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fp,
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => actor.getId(),
        canLandRangeAttack: () => false,
    });
    return { ...combat, actor, enemy, context, strike, fp, engine };
}

test("prices the response only after legal movement and retains pre-primary defender strength", () => {
    const h = fixture(10, 40, true);
    expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toBeUndefined();
    const move = {
        type: "move_unit" as const,
        unitId: h.actor.getId(),
        path: [h.actor.getBaseCell(), h.strike.attackFrom],
        targetCells: [h.strike.attackFrom],
    };
    expect(isPeasantResponseSequence(h.actor.getId(), [move, h.strike])).toBe(true);
    expect(h.engine.apply(move).completed).toBe(true);
    const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
    let draws = 0;
    setDeterministicRandomSource(() => {
        draws++;
        return 0.5;
    });
    expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toMatchObject({
        procChance: 1,
        maximumHpLoss: 10,
        maximumCasualties: 1,
    });
    expect(draws).toBe(0);
    expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
    expect(h.engine.apply(h.strike).completed).toBe(true);
    expect(h.enemy.isDead()).toBe(true);
    expect(h.actor.getAmountAlive()).toBe(39);
    expect(h.actor.getUnitProperties().bitter_experience_stacks).toBe(1);
});

test("uses a proportional HP price rather than excluding three cheap casualties in a large stack", () => {
    const h = fixture(25, 100);
    expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toMatchObject({
        maximumHpLoss: 25,
        maximumCasualties: 3,
    });
    const small = fixture(25, 40);
    expect(inspectPeasantResponseCost(small.actor, small.context, small.strike)).toBeUndefined();
});

test("declines no-bonus, fatal, expensive and uncertain high-damage exchanges", () => {
    for (const [damage, amount] of [
        [1, 40],
        [400, 40],
        [30, 40],
    ]) {
        const h = fixture(damage, amount);
        expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toBeUndefined();
    }
    const h = fixture();
    h.enemy.calculateAttackDamageMax = () => 100;
    expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toBeUndefined();
});

test("retains response, visibility, shield, Break and root-origin restrictions", () => {
    for (const flag of ["replied", "hidden", "shield", "break", "no-response", "rollout", "complex"]) {
        const h = fixture();
        if (flag === "replied") h.fp.addRepliedAttack(h.enemy.getId());
        if (flag === "hidden") h.enemy.hasAbilityActive = (name) => name === "Hidden";
        if (flag === "shield") h.actor.willAbsorbIncomingHit = () => true;
        if (flag === "break") h.actor.applyEffect(new EffectFactory().makeEffect("Break")!);
        if (flag === "no-response") h.enemy.canRespond = () => false;
        if (flag === "rollout") h.context.decisionOrigin = "rollout";
        if (flag === "complex") h.enemy.hasAbilityActive = (name) => name === "Fire Shield";
        expect(inspectPeasantResponseCost(h.actor, h.context, h.strike)).toBeUndefined();
    }
});

test("rejects hazards, combined-path attacks, extra strikes and actions after the strike", () => {
    const h = fixture();
    const move = {
        type: "move_unit" as const,
        unitId: h.actor.getId(),
        path: [
            { x: 4, y: 4 },
            { x: 4, y: 5 },
        ],
    };
    for (const actions of [
        [{ ...move, hasLavaCell: true }, h.strike],
        [{ ...move, hasWaterCell: true }, h.strike],
        [{ ...h.strike, path: move.path }],
        [h.strike, h.strike],
        [h.strike, move],
    ])
        expect(isPeasantResponseSequence(h.actor.getId(), actions)).toBe(false);
});

test("adds one omitted comparison by native leaf value, keeps all native choices and existing reservations", () => {
    const h = fixture(),
        candidates = enumerateCandidates(h.actor, h.context, [h.strike]).candidates,
        native = candidates.slice(0, 2),
        cost = inspectPeasantResponseCost(h.actor, h.context, h.strike)!;
    expect(candidates.length).toBeGreaterThan(3);
    const leaves = [
        { candidate: candidates[0], value: 1, cost },
        { candidate: candidates[2], value: 0.4, cost },
        { candidate: candidates[3], value: 0.6, cost: { ...cost, expectedHpLoss: cost.expectedHpLoss + 1 } },
    ];
    expect(reservePeasantPostmoveCandidate(native, leaves, 2)).toEqual([...native, candidates[3]]);
    expect(reservePeasantPostmoveCandidate(native, leaves, 1)).toBe(native);
    expect(reservePeasantPostmoveCandidate(native, [leaves[0]], 2)).toBe(native);
    expect(reservePeasantPostmoveCandidate(native, [{ ...leaves[0], candidate: { ...candidates[0] } }], 2)).toBe(
        native,
    );
    expect(reservePeasantPostmoveCandidate(native, [{ ...leaves[1], value: -Infinity }], 2)).toBe(native);
});
