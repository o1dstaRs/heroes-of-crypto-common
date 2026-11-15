import { afterEach, describe, expect, test } from "bun:test";

import { enumerateCandidates } from "../../src/ai/candidates";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { canUnitRespondToMelee } from "../../src/handlers/melee_response";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import {
    reserveRetaliationHandoffWait,
    retaliationHandoffOpportunity,
} from "../../src/simulation/retaliation_handoff_research";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));

function fixture(
    options: { actor?: TestUnitOptions; ally?: TestUnitOptions; enemy?: TestUnitOptions; distant?: boolean } = {},
) {
    const combat = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({ name: "First attacker", team: LEFT, maxHp: 1000, ...options.actor });
    const ally = createTestUnit({ name: "Ready ally", team: LEFT, maxHp: 1000, ...options.ally });
    const enemy = createTestUnit({ name: "Defender", team: RIGHT, maxHp: 1000, ...options.enemy });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 3, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 4, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, ally, options.distant ? { x: 9, y: 9 } : { x: 4, y: 7 });
    fp.startFight();
    fp.setTeamUnitsAlive(LEFT, 2);
    fp.setTeamUnitsAlive(RIGHT, 1);
    fp.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fp,
        decisionOrigin: "root",
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const incumbent: GameAction[] = [
        { type: "melee_attack", attackerId: actor.getId(), targetId: enemy.getId(), attackFrom: actor.getBaseCell() },
    ];
    let active = actor.getId();
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fp,
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => active,
        canLandRangeAttack: (unit: Unit) =>
            combat.attackHandler.canLandRangeAttack(unit, combat.grid.getEnemyAggrMatrixByUnitId(unit.getId())),
    });
    return {
        ...combat,
        fp,
        actor,
        ally,
        enemy,
        context,
        incumbent,
        engine,
        activate: (unit: Unit) => {
            active = unit.getId();
        },
    };
}

describe("offline retaliation handoff", () => {
    test("inspects public state without mutation or random draws; the engine accepts the handoff", () => {
        const h = fixture();
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        let draws = 0;
        setDeterministicRandomSource(() => {
            draws += 1;
            return 0.5;
        });
        expect(retaliationHandoffOpportunity(h.actor, h.context, h.incumbent)).toEqual({
            targetId: h.enemy.getId(),
            allyIds: [h.ally.getId()],
        });
        expect(draws).toBe(0);
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        expect(h.engine.apply({ type: "wait_turn", unitId: h.actor.getId() }).completed).toBe(true);
        h.activate(h.ally);
        expect(canUnitRespondToMelee(h.ally, h.enemy, h.fp)).toBe(true);
        expect(
            h.engine.apply({
                type: "melee_attack",
                attackerId: h.ally.getId(),
                targetId: h.enemy.getId(),
                attackFrom: h.ally.getBaseCell(),
            }),
        ).toMatchObject({ completed: true });
        expect(canUnitRespondToMelee(h.actor, h.enemy, h.fp)).toBe(false);
    });

    test("requires a ready adjacent ally and an unspent response", () => {
        const distant = fixture({ distant: true });
        expect(retaliationHandoffOpportunity(distant.actor, distant.context, distant.incumbent)).toBeUndefined();
        const acted = fixture();
        acted.fp.addAlreadyMadeTurn(LEFT, acted.ally.getId(), 1000);
        expect(retaliationHandoffOpportunity(acted.actor, acted.context, acted.incumbent)).toBeUndefined();
        const spent = fixture();
        spent.fp.addRepliedAttack(spent.enemy.getId());
        expect(retaliationHandoffOpportunity(spent.actor, spent.context, spent.incumbent)).toBeUndefined();
        const forced = fixture();
        forced.ally.getTarget = () => forced.actor.getId();
        expect(retaliationHandoffOpportunity(forced.actor, forced.context, forced.incumbent)).toBeUndefined();
    });

    test("uses canonical Time Denial, no-response, melee and hidden gates", () => {
        for (const options of [
            { actor: { abilities: ["Shadow Touch"] } },
            { ally: { abilities: ["Shadow Touch"] } },
            { actor: { abilities: ["Lightning Spin"] } },
            { ally: { abilities: ["Lightning Spin"] } },
            { ally: { abilities: ["No Melee"] } },
            { enemy: { abilities: ["Time Denial"] } },
            { enemy: { abilities: ["No Melee"] } },
        ]) {
            const h = fixture(options);
            expect(retaliationHandoffOpportunity(h.actor, h.context, h.incumbent)).toBeUndefined();
        }
    });

    test("hidden targets are ineligible", () => {
        const h = fixture();
        h.enemy.hasBuffActive = (name) => name === "Hidden";
        expect(retaliationHandoffOpportunity(h.actor, h.context, h.incumbent)).toBeUndefined();
    });

    test("cannot introduce waits in rollouts or substitute a different actor or action", () => {
        const h = fixture();
        expect(
            retaliationHandoffOpportunity(h.actor, { ...h.context, decisionOrigin: undefined }, h.incumbent),
        ).toBeUndefined();
        expect(
            retaliationHandoffOpportunity(h.actor, h.context, [{ type: "wait_turn", unitId: h.actor.getId() }]),
        ).toBeUndefined();
        expect(
            retaliationHandoffOpportunity(h.actor, h.context, [
                {
                    type: "melee_attack",
                    attackerId: h.ally.getId(),
                    targetId: h.enemy.getId(),
                    attackFrom: h.ally.getBaseCell(),
                },
            ]),
        ).toBeUndefined();
    });

    test("reserves an enumerated wait without growing the cap or replacing the best challenger", () => {
        const h = fixture();
        const catalog = enumerateCandidates(h.actor, h.context, h.incumbent).candidates;
        const wait = catalog.find((candidate) => candidate.kind === "wait")!;
        expect(wait).toBeDefined();
        const active = catalog
            .filter((candidate) => candidate.kind !== "wait" && candidate.kind !== "incumbent")
            .slice(0, 3);
        expect(active.length).toBe(3);
        const result = reserveRetaliationHandoffWait(catalog, active, 3);
        expect(result.length).toBe(active.length);
        expect(result[0]).toBe(active[0]);
        expect(result).toContain(wait);
        expect(active).not.toContain(wait);
        expect(
            reserveRetaliationHandoffWait(
                catalog.filter((candidate) => candidate !== wait),
                active,
                3,
            ),
        ).toBe(active);
        expect(reserveRetaliationHandoffWait(catalog, result, 3)).toBe(result);
        expect(reserveRetaliationHandoffWait(catalog, active.slice(0, 1), 1)).toEqual(active.slice(0, 1));
    });
});
