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

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { EffectFactory } from "../../src/effects/effect_factory";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type {
    AttackType,
    GridType,
    MovementType,
    TeamType,
    UnitLevelType,
    UnitSizeType,
    UnitType,
} from "../../src/generated/protobuf/v1/types_gen";
import { Grid } from "../../src/grid/grid";
import { GRID_SIZE, MAX_X, MAX_Y, MIN_X, MIN_Y, MOVEMENT_DELTA, UNIT_SIZE_DELTA } from "../../src/grid/grid_constants";
import { getPositionForCell } from "../../src/grid/grid_math";
import { GridSettings } from "../../src/grid/grid_settings";
import { AttackHandler } from "../../src/handlers/attack_handler";
import type { IVisibleDamage } from "../../src/scene/animations";
import type { IDamageStatistic } from "../../src/scene/scene_stats";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import type { IStatisticHolder } from "../../src/scene/statistic_holder_interface";
import { Unit } from "../../src/units/unit";
import { UnitProperties } from "../../src/units/unit_properties";
import { UnitsHolder } from "../../src/units/units_holder";
import type { XY } from "../../src/utils/math";

export const testGridSettings = new GridSettings(
    GRID_SIZE,
    MAX_Y,
    MIN_Y,
    MAX_X,
    MIN_X,
    MOVEMENT_DELTA,
    UNIT_SIZE_DELTA,
);

export interface TestUnitOptions {
    name?: string;
    team?: TeamType;
    attackType?: AttackType;
    attack?: number;
    armor?: number;
    magicResist?: number;
    luck?: number;
    damageMin?: number;
    damageMax?: number;
    rangeShots?: number;
    amountAlive?: number;
    maxHp?: number;
    exp?: number;
    stackPower?: number;
    attackRange?: number;
    shotDistance?: number;
    morale?: number;
    speed?: number;
    movementType?: MovementType;
    size?: UnitSizeType;
    level?: UnitLevelType;
    unitType?: UnitType;
    spells?: string[];
    abilities?: string[];
    auraEffects?: string[];
    auraRanges?: number[];
    auraIsBuff?: boolean[];
    summoned?: boolean;
}

export interface CombatTestContext {
    grid: Grid;
    unitsHolder: UnitsHolder;
    damageStatisticHolder: DamageStatisticHolder;
    attackHandler: AttackHandler;
}

export class DamageStatisticHolder implements IStatisticHolder<IDamageStatistic> {
    private readonly values: IDamageStatistic[] = [];

    public add(singleDamageStatistic: IDamageStatistic): void {
        this.values.push(singleDamageStatistic);
    }

    public get(): IDamageStatistic[] {
        return this.values;
    }

    public has(lap: number): boolean {
        return this.values.some((value) => value.lap === lap);
    }
}

export function createCombatTestContext(gridType: GridType = PBTypes.GridVals.NORMAL): CombatTestContext {
    FightStateManager.getInstance().reset();

    const grid = new Grid(testGridSettings, gridType);
    const damageStatisticHolder = new DamageStatisticHolder();
    return {
        grid,
        unitsHolder: new UnitsHolder(grid),
        damageStatisticHolder,
        attackHandler: new AttackHandler(testGridSettings, grid, new SceneLogMock(), damageStatisticHolder),
    };
}

export function createTestUnit(options: TestUnitOptions = {}): Unit {
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const abilities = options.abilities ?? [];
    const abilityDescriptions = abilities.map(() => "");
    const abilityStackPowered = abilities.map(() => false);
    const abilityAuras = abilities.map(() => false);
    const spells = options.spells ?? [];
    const auraEffects = options.auraEffects ?? [];
    const auraRanges = options.auraRanges ?? [];
    const auraIsBuff = options.auraIsBuff ?? [];
    const noStrings: string[] = [];
    const noNumbers: number[] = [];

    return Unit.createUnit(
        new UnitProperties(
            PBTypes.FactionVals.MIGHT,
            options.name ?? "Test Unit",
            options.maxHp ?? 10,
            3,
            options.morale ?? 0,
            options.luck ?? 0,
            options.speed ?? 1,
            options.armor ?? 10,
            options.attackType ?? PBTypes.AttackVals.MELEE,
            options.attack ?? 10,
            options.damageMin ?? 1,
            options.damageMax ?? 1,
            options.attackRange ?? 1,
            options.rangeShots ?? 0,
            options.shotDistance ?? 16,
            options.magicResist ?? 0,
            options.movementType ?? PBTypes.MovementVals.WALK,
            options.exp ?? 0,
            options.size ?? PBTypes.UnitSizeVals.SMALL,
            options.level ?? PBTypes.UnitLevelVals.FIRST,
            spells,
            abilities,
            abilityDescriptions,
            abilityStackPowered,
            abilityAuras,
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            noStrings,
            noStrings,
            noStrings,
            noNumbers,
            noNumbers,
            noNumbers,
            auraEffects,
            auraRanges,
            auraIsBuff,
            noStrings,
            options.amountAlive ?? 1,
            0,
            options.team ?? PBTypes.TeamVals.UPPER,
            options.unitType ?? PBTypes.UnitVals.CREATURE,
            "",
            "",
            options.stackPower ?? 1,
            "",
        ),
        testGridSettings,
        options.team ?? PBTypes.TeamVals.UPPER,
        options.unitType ?? PBTypes.UnitVals.CREATURE,
        abilityFactory,
        effectFactory,
        options.summoned ?? false,
    );
}

export function placeUnit(grid: Grid, unitsHolder: UnitsHolder, unit: Unit, cell: XY): void {
    const position = getPositionForCell(
        cell,
        testGridSettings.getMinX(),
        testGridSettings.getStep(),
        testGridSettings.getHalfStep(),
    );
    unit.setPosition(position.x, position.y);
    grid.occupyCell(
        cell,
        unit.getId(),
        unit.getTeam(),
        unit.getAttackRange(),
        unit.hasAbilityActive("Made of Fire"),
        unit.hasAbilityActive("Made of Water"),
    );
    unitsHolder.addUnit(unit);
}

export function createVisibleDamage(unit: Unit): IVisibleDamage {
    return {
        amount: 0,
        render: false,
        unitPosition: unit.getPosition(),
        unitIsSmall: unit.isSmallSize(),
    };
}
