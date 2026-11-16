import { afterEach, describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { createAIStrategy, DEFAULT_AI_VERSION, type IDecisionContext } from "../../src/ai";
import { enumerateCandidates, findBestLegalStationaryRangeAttack } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { isRangeAttackSideSelectable, getRangeAttackSideCenter, RangeAttackCellSide } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { Unit } from "../../src/units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, placeUnit, testGridSettings as gs } from "../helpers/combat";

const savedFight = FightStateManager.getInstance().getFightProperties();
const savedRandom = captureDeterministicRandomState();
afterEach(() => {
    FightStateManager.getInstance().setFightProperties(savedFight);
    restoreDeterministicRandomState(savedRandom);
});

const fixture = (mirrorX = false, mirrorY = false) => {
    const combat = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
    const cell = (x: number, y: number) => ({ x: mirrorX ? 15 - x : x, y: mirrorY ? 15 - y : y });
    const create = (faction: string, name: string, team: PBTypes.TeamVals, count: number, anchor: XY) => {
        const effects = new EffectFactory();
        const unit = Unit.createUnit(
            getCreatureConfig(team, faction, name, "", count),
            gs,
            team,
            PBTypes.UnitVals.CREATURE,
            new AbilityFactory(effects),
            effects,
            false,
        );
        placeUnit(combat.grid, combat.unitsHolder, unit, anchor);
        return unit;
    };
    // The far UP edge of Fairy misses Troglodyte, but that edge faces away from Elf. The cursor only
    // offers RIGHT/DOWN here, and both hit Troglodyte first. Keep all three actual creature configs.
    const elf = create("Nature", "Elf", PBTypes.TeamVals.RIGHT, 91, cell(13, 9));
    const fairy = create("Nature", "Fairy", PBTypes.TeamVals.LEFT, 139, cell(1, 12));
    const screen = create("Chaos", "Troglodyte", PBTypes.TeamVals.LEFT, 125, cell(3, 11));
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.startFight();
    fight.startTurn(elf.getTeam(), 1000);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(gs),
        fightProperties: fight,
    };
    return { ...combat, context, elf, fairy, screen, cell };
};

describe("ranged decisions use player-selectable rays", () => {
    for (const mirrorX of [false, true])
        for (const mirrorY of [false, true]) {
            test(`screened Fairy is not reachable by aiming at its back edge (${mirrorX}, ${mirrorY})`, () => {
                const f = fixture(mirrorX, mirrorY);
                const side = mirrorY ? RangeAttackCellSide.DOWN : RangeAttackCellSide.UP;
                const targetCell = f.fairy.getBaseCell();
                const to = getRangeAttackSideCenter(gs, targetCell, side, f.elf.getPosition());
                const raw = f.attackHandler.evaluateRangeAttack(
                    f.unitsHolder.getAllUnits(),
                    f.elf,
                    f.elf.getPosition(),
                    to,
                );
                // This is why merely checking the engine ray isn't sufficient: it really misses the screen.
                expect(raw.affectedUnits[0][0]).toBe(f.fairy);
                expect(
                    isRangeAttackSideSelectable(
                        f.context.matrix,
                        gs,
                        targetCell,
                        side,
                        f.elf.getPosition(),
                        f.fairy.getPosition(),
                        true,
                        true,
                        f.elf.getTeam(),
                    ),
                ).toBe(false);

                setDeterministicRandomSource(() => 0.5);
                const incumbent = createAIStrategy(DEFAULT_AI_VERSION).decideTurn(f.elf, f.context);
                const { candidates } = enumerateCandidates(f.elf, f.context, incumbent, { maxShotAims: 100 });
                const shots = candidates.flatMap((candidate) =>
                    candidate.actions.filter((action) => action.type === "range_attack"),
                );
                expect(shots.some((shot) => shot.targetId === f.screen.getId())).toBe(true);
                expect(shots.some((shot) => shot.targetId === f.fairy.getId())).toBe(false);
                expect(findBestLegalStationaryRangeAttack(f.elf, f.context)?.aimTargetId).not.toBe(f.fairy.getId());
            });
        }

    test("an exposed front edge remains available when the screen no longer crosses it", () => {
        const f = fixture();
        // One extra column makes the RIGHT-edge ray pass just above the screening cell.
        f.grid.cleanupAll(f.elf.getId(), f.elf.getAttackRange(), f.elf.isSmallSize());
        placeUnit(f.grid, f.unitsHolder, f.elf, { x: 14, y: 9 });
        f.context.matrix = f.grid.getMatrix();
        const { candidates } = enumerateCandidates(f.elf, f.context, [], { maxShotAims: 100 });
        expect(
            candidates.some((candidate) =>
                candidate.actions.some(
                    (action) =>
                        action.type === "range_attack" &&
                        action.targetId === f.fairy.getId() &&
                        action.aimSide === RangeAttackCellSide.RIGHT,
                ),
            ),
        ).toBe(true);
    });
});
