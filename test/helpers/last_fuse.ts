import { expect } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "./combat";

export function lastFuseBoard(
    options: {
        ranged?: boolean;
        team?: typeof PBTypes.TeamVals.LEFT | typeof PBTypes.TeamVals.RIGHT;
        direction?: XY;
        attacker?: TestUnitOptions;
        target?: TestUnitOptions;
        neighbor?: TestUnitOptions;
        fuse?: boolean;
        enemyFuse?: boolean;
        remainingHp?: number;
        response?: boolean;
    } = {},
) {
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const team = options.team ?? PBTypes.TeamVals.LEFT;
    const enemy = team === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const direction = options.direction ?? { x: 1, y: 0 };
    const targetCell = { x: 8, y: 8 };
    const distance = options.ranged ? 4 : 1;
    const stand = { x: targetCell.x - distance * direction.x, y: targetCell.y - distance * direction.y };
    const attacker = createTestUnit({
        name: "Attacker",
        team,
        maxHp: 1000,
        attack: 10,
        damageMin: 1000,
        damageMax: 1000,
        attackType: options.ranged ? PBTypes.AttackVals.RANGE : PBTypes.AttackVals.MELEE,
        rangeShots: 10,
        shotDistance: 16,
        ...options.attacker,
    });
    const target = createTestUnit({ name: "Target", team: enemy, maxHp: 100, armor: 10, ...options.target });
    const neighbor = createTestUnit({ name: "Enemy neighbor", team: enemy, maxHp: 1000, ...options.neighbor });
    const ally = createTestUnit({ name: "Friendly neighbor", team, maxHp: 1000 });
    const far = createTestUnit({ name: "Far enemy", team: enemy, maxHp: 1000 });
    placeUnit(combat.grid, combat.unitsHolder, attacker, stand);
    placeUnit(combat.grid, combat.unitsHolder, target, targetCell);
    placeUnit(combat.grid, combat.unitsHolder, neighbor, { x: 8 + direction.x, y: 8 + direction.y });
    placeUnit(combat.grid, combat.unitsHolder, ally, { x: 8 - direction.y, y: 8 + direction.x });
    placeUnit(combat.grid, combat.unitsHolder, far, { x: 1, y: 1 });
    if (options.remainingHp !== undefined)
        target.applyDamage(target.getCumulativeHp() - options.remainingHp, 0, new SceneLogMock(), false);
    const fight = FightStateManager.getInstance().getFightProperties();
    if (options.fuse !== false) fight.setArtifactPerTeam(team, 2, Tier2Artifact.LAST_FUSE);
    if (options.enemyFuse) fight.setArtifactPerTeam(enemy, 2, Tier2Artifact.LAST_FUSE);
    combat.unitsHolder.applyArtifacts(fight);
    for (const unit of [attacker, target, neighbor]) {
        unit.trySeedWaterShield();
        unit.refreshPossibleAttackTypes(options.ranged ?? false);
    }
    if (!options.response) {
        target.setResponded(true);
        fight.addRepliedAttack(target.getId());
    }
    fight.startFight();
    fight.setTeamUnitsAlive(team, 2);
    fight.setTeamUnitsAlive(enemy, 3);
    fight.startTurn(team, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fight,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const actions: GameAction[] = [
        options.ranged
            ? { type: "range_attack", attackerId: attacker.getId(), targetId: target.getId() }
            : { type: "melee_attack", attackerId: attacker.getId(), targetId: target.getId(), attackFrom: stand },
    ];
    const fire = () => {
        setDeterministicRandomSource(() => 0);
        const before = target.getCumulativeHp() + neighbor.getCumulativeHp() + far.getCumulativeHp();
        const friendly = attacker.getCumulativeHp() + ally.getCumulativeHp();
        const engine = new GameActionEngine({
            ...combat,
            fightProperties: fight,
            moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
            sceneLog: new SceneLogMock(),
            getCurrentActiveUnitId: () => attacker.getId(),
        });
        const result = engine.apply(actions[0]);
        expect(result.completed).toBe(true);
        return {
            result,
            enemyDamage: before - target.getCumulativeHp() - neighbor.getCumulativeHp() - far.getCumulativeHp(),
            friendlyDamage: friendly - attacker.getCumulativeHp() - ally.getCumulativeHp(),
        };
    };
    return { ...combat, context, fight, attacker, target, neighbor, ally, far, stand, actions, fire };
}
