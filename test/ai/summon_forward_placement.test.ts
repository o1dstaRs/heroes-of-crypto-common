import { describe, expect, spyOn, test } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { getAIStrategy } from "../../src/ai";
import { enumerateCandidates } from "../../src/ai/candidates";
import { getCreatureConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { getCellsAroundFootprint, getFootprintCellsForAnchor } from "../../src/grid/grid_math";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { makeRng } from "../../src/simulation/army";
import { createV08A19SearchDriver } from "../../src/simulation/v0_8_a19_search";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../../src/utils/lib";
import { Unit } from "../../src/units/unit";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function creature(name: string, team: TeamType, amount: number, summoned = false): Unit {
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

function fixture(team: TeamType, side: boolean, onlyFront = false) {
    const combat = createCombatTestContext();
    const satyr = creature("Satyr", team, 20);
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    const anchor = { x: 7, y: 7 };
    const front: XY = side ? { x: team === LEFT ? 9 : 6, y: 7 } : { x: 7, y: team === LEFT ? 8 : 6 };
    placeUnit(combat.grid, combat.unitsHolder, satyr, anchor);
    const frontCells = getFootprintCellsForAnchor(front, 2, 1);
    if (onlyFront) {
        for (const cell of getCellsAroundFootprint(testGridSettings, [...satyr.getCells(), ...frontCells])) {
            placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team }), cell);
        }
    }
    placeUnit(combat.grid, combat.unitsHolder, createTestUnit({ team: enemyTeam }), { x: 13, y: 13 });
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setSideOrientedPlacement(side);
    const context: IDecisionContext = {
        ...combat,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(testGridSettings),
        fightProperties,
    };
    let wolf: Unit | undefined;
    let activeId = satyr.getId();
    const engineContext = {
        ...combat,
        fightProperties,
        moveHandler: new MoveHandler(testGridSettings, combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => activeId,
        createSummonedUnit: ({ amount }: { amount: number }) => (wolf = creature("Wolf", team, amount, true)),
    };
    const engine = new GameActionEngine(engineContext);
    expect(engine.apply({ type: "start_fight" }).completed).toBe(true);
    fightProperties.startTurn(team, 1_000);
    const summons = () =>
        enumerateCandidates(satyr, context, [{ type: "end_turn", unitId: satyr.getId() }]).candidates.filter(
            (c) => c.spellName === "Summon Wolves",
        );
    return {
        ...combat,
        context,
        engine,
        engineContext,
        satyr,
        front,
        summons,
        getWolf: () => wolf,
        getActiveUnitId: () => activeId,
        setActiveUnitId: (id: string) => {
            activeId = id;
        },
    };
}

describe("forward summon placement", () => {
    for (const team of [LEFT, RIGHT]) {
        for (const side of [false, true]) {
            test(`team ${team}, side=${side}: exposes a forward Wolf placement on an open board`, () => {
                const f = fixture(team, side);
                const candidates = f.summons();
                const forward = candidates.find((c) => c.targetCell?.x === f.front.x && c.targetCell?.y === f.front.y);
                expect(forward).toBeDefined();
                expect(candidates.length).toBeLessThanOrEqual(2);
                expect(f.engine.apply(forward!.actions[0]).completed).toBe(true);
                expect(f.getWolf()?.getBaseCell()).toEqual(f.front);
                expect(f.getWolf()?.getAmountAlive()).toBe(30);
                expect(f.satyr.getBaseCell()).toEqual({ x: 7, y: 7 });
            });

            test(`team ${team}, side=${side}: casts when the only free body is in front`, () => {
                const f = fixture(team, side, true);
                const forward = f.summons().find((c) => c.targetCell?.x === f.front.x && c.targetCell?.y === f.front.y);
                expect(forward).toBeDefined();
                expect(f.engine.apply(forward!.actions[0]).completed).toBe(true);
                expect(f.getWolf()?.getBaseCell()).toEqual(f.front);
            });

            test(`team ${team}, side=${side}: automatic engine placement finds the same front-only space`, () => {
                const f = fixture(team, side, true);
                expect(
                    f.engine.apply({ type: "cast_spell", casterId: f.satyr.getId(), spellName: "Summon Wolves" })
                        .completed,
                ).toBe(true);
                expect(f.getWolf()?.getBaseCell()).toEqual(f.front);
            });
        }

        test(`team ${team}: does not add different placement choices when reinforcing an existing Wolf`, () => {
            const f = fixture(team, true);
            const existing = creature("Wolf", team, 3, true);
            placeUnit(f.grid, f.unitsHolder, existing, { x: 11, y: 10 });
            const candidates = f.summons();
            expect(candidates).toHaveLength(1);
            expect(f.engine.apply(candidates[0].actions[0]).completed).toBe(true);
            expect(existing.getAmountAlive()).toBe(33);
            expect(existing.getBaseCell()).toEqual({ x: 11, y: 10 });
            expect(f.getWolf()).toBeUndefined();
        });

        test(`team ${team}: full A19 search evaluates the forward body and rolls its summon back`, () => {
            const random = getDeterministicRandomSource();
            setDeterministicRandomSource(makeRng(811_801));
            try {
                const f = fixture(team, true);
                const apply = f.engine.apply.bind(f.engine);
                let forwardAttempts = 0;
                const observed = spyOn(f.engine, "apply").mockImplementation((action) => {
                    if (
                        action.type === "cast_spell" &&
                        action.spellName === "Summon Wolves" &&
                        action.targetCell?.x === f.front.x &&
                        action.targetCell?.y === f.front.y
                    )
                        forwardAttempts++;
                    return apply(action);
                });
                try {
                    const fightProperties = f.context.fightProperties!;
                    const driver = createV08A19SearchDriver(
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
                        { greenVersion: "v0.8", redVersion: "v0.8", seed: 811_801, offlineDeterministicWork: true },
                    );
                    driver.onFightReady();
                    const beforeIds = [...f.unitsHolder.getAllUnits().keys()];
                    const spellAmount = () =>
                        f.satyr
                            .getSpells()
                            .find((s) => s.getName() === "Summon Wolves")!
                            .getAmount();
                    const charges = spellAmount();
                    driver.chooseDecision(
                        f.satyr,
                        "v0.8",
                        getAIStrategy("v0.8").decideTurn(f.satyr, f.context),
                        f.context,
                    );
                    expect(forwardAttempts).toBeGreaterThan(0);
                    expect([...f.unitsHolder.getAllUnits().keys()]).toEqual(beforeIds);
                    expect(spellAmount()).toBe(charges);
                    expect(f.grid.getOccupantUnitId({ x: 7, y: 7 })).toBe(f.satyr.getId());
                    expect(f.getActiveUnitId()).toBe(f.satyr.getId());
                } finally {
                    observed.mockRestore();
                }
            } finally {
                setDeterministicRandomSource(random);
            }
        });
    }
});
