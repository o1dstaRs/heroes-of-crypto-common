import { describe, expect, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAIStrategy, type IDecisionContext } from "../../src/ai";
import { enumerateCandidates } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameAction } from "../../src/engine/actions";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getCellsAroundFootprint } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { getA19NeuralState } from "../../src/simulation/a19_neural";
import { makeRng } from "../../src/simulation/army";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { firstSummonableAnchor, summonFootprintOf } from "../../src/spells/spell_helper";
import { Unit } from "../../src/units/unit";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function native(name: string, team: TeamType, amount: number, summoned = false): Unit {
    const effects = new EffectFactory();
    const unit = Unit.createUnit(
        getCreatureConfig(team, "Nature", name, "", amount),
        testGridSettings,
        team,
        PBTypes.UnitVals.CREATURE,
        new AbilityFactory(effects),
        effects,
        summoned,
    );
    unit.setStackPower(5);
    return unit;
}

function fixture(team: TeamType = LEFT, anchor: XY = { x: 3, y: 3 }, kind = "summoned") {
    const combat = createCombatTestContext();
    const satyr = native("Satyr", team, 32);
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    placeUnit(combat.grid, combat.unitsHolder, satyr, anchor);
    const ring = getCellsAroundFootprint(testGridSettings, satyr.getCells());
    for (const cell of ring) {
        placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team, amountAlive: 1 }), cell);
    }
    const wolf = native("Wolf", kind === "enemy" ? enemyTeam : team, 3, kind !== "drafted");
    if (kind !== "absent") placeUnit(combat.grid, combat.unitsHolder, wolf, { x: 8, y: 8 });
    const enemy = createTestUnit({ team: enemyTeam, amountAlive: 10 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 12, y: 12 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties,
    };
    let activeId = satyr.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => activeId,
        getCurrentEnemiesCellsWithinMovementRange: () => [],
    };
    const engine = new GameActionEngine(engineContext);
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(team, 1_000);
    const spell = satyr.getSpells().find((candidate) => candidate.getName() === "Summon Wolves")!;
    const footprint = summonFootprintOf(spell);
    expect(firstSummonableAnchor(spell, context.matrix, ring, footprint.width, footprint.height)).toBeUndefined();
    const incumbent: GameAction[] = [
        { type: "cast_spell", casterId: satyr.getId(), spellName: "Courage", targetId: satyr.getId() },
    ];
    const summons = () =>
        enumerateCandidates(satyr, context, incumbent).candidates.filter(
            (candidate) => candidate.spellName === "Summon Wolves",
        );
    return {
        ...combat,
        satyr,
        wolf,
        context,
        engine,
        engineContext,
        spell,
        summons,
        getActiveUnitId: () => activeId,
        setActiveUnitId: (id: string) => {
            activeId = id;
        },
    };
}

describe("Satyr reinforces existing wolves without requiring a new spawn cell", () => {
    for (const team of [LEFT, RIGHT]) {
        for (const anchor of [
            { x: 3, y: 3 },
            { x: 0, y: 0 },
            { x: 15, y: 15 },
            { x: 7, y: 0 },
        ]) {
            test(`team ${team}, surrounded at ${anchor.x},${anchor.y}: native AI adds 48 wolves`, () => {
                const f = fixture(team, anchor);
                expect(f.summons()).toHaveLength(1);
                const decision = getAIStrategy("v0.8").decideTurn(f.satyr, f.context);
                expect(decision).toEqual(f.summons()[0].actions);
                const before = f.spell.getAmount();
                const result = f.engine.apply(decision[0]);
                expect(result.completed).toBe(true);
                expect(result.rejectionReason).toBeUndefined();
                expect(f.wolf.getAmountAlive()).toBe(51);
                expect(f.spell.getAmount()).toBe(before - 1);
                expect(result.events).toContainEqual(
                    expect.objectContaining({
                        type: "unit_summoned",
                        unitId: f.wolf.getId(),
                        amount: 48,
                        merged: true,
                    }),
                );
            });
        }
    }

    test.each(["absent", "enemy", "drafted"])("does not invent reinforcement for %s wolves", (kind) => {
        const f = fixture(LEFT, { x: 3, y: 3 }, kind);
        expect(f.summons()).toHaveLength(0);
        const result = f.engine.apply({ type: "cast_spell", casterId: f.satyr.getId(), spellName: "Summon Wolves" });
        expect(result.completed).toBe(false);
        expect(result.rejectionReason).toBe("spell_not_available");
    });

    test.each(["spent", "broken"])("still rejects a %s caster", (state) => {
        const f = fixture();
        if (state === "spent") {
            f.satyr.useSpell("Summon Wolves");
            f.satyr.useSpell("Summon Wolves");
        } else {
            f.satyr.applyEffect(new EffectFactory().makeEffect("Break"));
        }
        expect(f.summons()).toHaveLength(0);
        const result = f.engine.apply({ type: "cast_spell", casterId: f.satyr.getId(), spellName: "Summon Wolves" });
        expect(result.completed).toBe(false);
        expect(f.wolf.getAmountAlive()).toBe(3);
    });

    test.each([LEFT, RIGHT])(
        "team %s: full A19 search evaluates reinforcement without spending live wolves or charges",
        (team) => {
            const random = getDeterministicRandomSource();
            setDeterministicRandomSource(makeRng(711_197));
            try {
                const f = fixture(team);
                const fightProperties = f.context.fightProperties!;
                const driver = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () =>
                    createV08A19SearchDriver(
                        {
                            ...f,
                            fightProperties,
                            pathHelper: f.context.pathHelper,
                            turnEngine: new TurnEngine(f.engineContext),
                            strategyForTeam: () => getAIStrategy("v0.8"),
                            damageDealtThisLap: () => f.damageStatisticHolder.has(fightProperties.getCurrentLap()),
                            captureDamageStats: () => [...f.damageStatisticHolder.get()],
                            restoreDamageStats: (saved) => {
                                f.damageStatisticHolder.clear();
                                for (const value of saved) f.damageStatisticHolder.add(value);
                            },
                        },
                        { greenVersion: "v0.8", redVersion: "v0.8", seed: 711_197, offlineDeterministicWork: true },
                    ),
                );
                driver.onFightReady();
                const incumbent = getAIStrategy("v0.8").decideTurn(f.satyr, f.context);
                const before = f.spell.getAmount();
                const decision = driver.chooseDecision(f.satyr, "v0.8", incumbent, f.context);
                expect(getA19NeuralState(driver)?.decisions).toBeGreaterThan(0);
                expect(f.wolf.getAmountAlive()).toBe(3);
                expect(
                    f.satyr
                        .getSpells()
                        .find((spell) => spell.getName() === "Summon Wolves")
                        ?.getAmount(),
                ).toBe(before);
                expect(f.getActiveUnitId()).toBe(f.satyr.getId());
                expect(decision[0]).toMatchObject({ type: "cast_spell", spellName: "Summon Wolves" });
                expect(f.engine.apply(decision[0]).completed).toBe(true);
                expect(f.wolf.getAmountAlive()).toBe(51);
            } finally {
                setDeterministicRandomSource(random);
            }
        },
    );
});
