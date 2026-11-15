import { afterEach, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getPositionForCell } from "../../src/grid/grid_math";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, placeUnit, testGridSettings } from "../helpers/combat";

const previousFight = FightStateManager.getInstance().getFightProperties();
afterEach(() => {
    setDeterministicRandomSource(undefined);
    FightStateManager.getInstance().setFightProperties(previousFight);
});

function unit(faction: string, name: string, team: TeamType): Unit {
    const effects = new EffectFactory();
    return Unit.createUnit(
        getCreatureConfig(team, faction, name, "", 100),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        false,
    );
}

function fixture(name: string, counter = false, headless = false, artifactBarrels = false) {
    setDeterministicRandomSource(() => 0.99);
    const combat = createCombatTestContext(PBTypes.GridVals.BLOCK_CENTER);
    const giant = unit(name === "Cyclops" ? "Might" : "Nature", name, counter ? 2 : 1);
    const elf = unit("Nature", "Elf", counter ? 1 : 2);
    const attacker = counter ? elf : giant;
    const target = counter ? giant : elf;
    // The return blast lands beside the original shooter; the outward blast lands beside its target.
    const near = { x: 3, y: 7 };
    const far = { x: 12, y: 7 };
    const outside = { x: 7, y: 12 };
    combat.grid.setScatteredMountains(artifactBarrels ? [] : [near, far, outside]);
    if (artifactBarrels) {
        expect(combat.grid.placeArtifactBarrel(1, 0, near)).toBe(true);
        expect(combat.grid.placeArtifactBarrel(2, 0, far)).toBe(true);
        expect(combat.grid.placeArtifactBarrel(2, 1, outside)).toBe(true);
    }
    placeUnit(combat.grid, combat.unitsHolder, attacker, { x: 3, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 12, y: 6 });
    attacker.calculateAttackDamage = () => 1;
    target.calculateAttackDamage = () => 1;
    attacker.refreshPossibleAttackTypes(true);
    const fight = FightStateManager.getInstance().getFightProperties();
    fight.setGridType(PBTypes.GridVals.BLOCK_CENTER);
    fight.startFight();
    fight.setTeamUnitsAlive(1, 1);
    fight.setTeamUnitsAlive(2, 1);
    fight.startTurn(1, 1000);
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fight,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => attacker.getId(),
        eventMode: headless ? "headless" : "full",
    });
    return { ...combat, giant, elf, attacker, target, fight, engine, near, far, outside };
}

for (const name of ["Cyclops", "Gargantuan"]) {
    test.each([
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ])(`${name} clears blast barrels: counter=%s, artifact=%s`, (counter, artifact) => {
        const f = fixture(name, counter, false, artifact);
        const shots = f.giant.getRangeShots();
        const result = f.engine.apply({
            type: "range_attack",
            attackerId: f.attacker.getId(),
            targetId: f.target.getId(),
        });
        expect(result.completed).toBe(true);
        const blast = counter ? f.near : f.far;
        expect(f.grid.getOccupantUnitId(blast)).not.toBe("B");
        expect(f.grid.getOccupantUnitId(f.outside)).toBe("B");
        const obstacles = JSON.parse(JSON.stringify(result.events)).filter(
            (event: { type: string }) => event.type === "obstacle_attacked",
        );
        expect(obstacles).toHaveLength(1);
        expect(obstacles[0].attackerId).toBe(f.giant.getId());
        expect(obstacles[0].source).toBe("ranged_splash");
        expect(obstacles[0].hitsAfter).toBe(obstacles[0].hitsBefore);
        expect(f.grid.getScatteredMountainsStanding()).not.toContainEqual(blast);
        if (artifact) expect(f.grid.getArtifactBarrels().map((barrel) => barrel.cell)).not.toContainEqual(blast);
        expect(f.giant.getRangeShots()).toBeLessThan(shots);
        expect(f.fight.hasAlreadyMadeTurn(f.attacker.getId())).toBe(true);
    });

    test(`${name} never destroys barrels when the shot is rejected`, () => {
        const f = fixture(name);
        f.giant.getRangeShots = () => 0;
        expect(
            f.engine.apply({ type: "range_attack", attackerId: f.giant.getId(), targetId: f.elf.getId() }).completed,
        ).toBe(false);
        expect(f.grid.getScatteredMountainsStanding()).toHaveLength(3);
        expect(f.fight.hasAlreadyMadeTurn(f.giant.getId())).toBe(false);
    });

    test(`${name} direct barrel aim destroys the entire blast and spends ammunition without unit damage`, () => {
        const f = fixture(name);
        const targetCell = { x: 10, y: 11 };
        const neighbor = { x: 11, y: 11 };
        f.grid.setScatteredMountains([targetCell, neighbor, f.outside]);
        const shots = f.giant.getRangeShots();
        const result = f.engine.apply({
            type: "obstacle_attack",
            attackerId: f.giant.getId(),
            targetPosition: getPositionForCell(
                targetCell,
                testGridSettings.getMinX(),
                testGridSettings.getStep(),
                testGridSettings.getHalfStep(),
            ),
        });
        expect(result.completed).toBe(true);
        expect(f.grid.getOccupantUnitId(targetCell)).not.toBe("B");
        expect(f.grid.getOccupantUnitId(neighbor)).not.toBe("B");
        expect(f.grid.getOccupantUnitId(f.outside)).toBe("B");
        expect(result.events.some((event) => event.type === "area_attacked")).toBe(true);
        expect(f.giant.getRangeShots()).toBeLessThan(shots);
    });

    test(`${name} cannot destroy a barrel through a suppressed counterattack`, () => {
        const f = fixture(name, true);
        f.giant.canRespond = () => false;
        const result = f.engine.apply({
            type: "range_attack",
            attackerId: f.attacker.getId(),
            targetId: f.target.getId(),
        });
        expect(result.completed).toBe(true);
        expect(f.grid.getOccupantUnitId(f.near)).toBe("B");
        expect(result.events.filter((event) => event.type === "obstacle_attacked")).toHaveLength(0);
    });

    test(`${name} barrel destruction also runs without presentation events`, () => {
        const f = fixture(name, true, true);
        expect(
            f.engine.apply({ type: "range_attack", attackerId: f.attacker.getId(), targetId: f.target.getId() })
                .completed,
        ).toBe(true);
        expect(f.grid.getOccupantUnitId(f.near)).not.toBe("B");
    });
}
