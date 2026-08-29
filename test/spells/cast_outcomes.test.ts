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

import { beforeEach, describe, expect, it } from "bun:test";

import creaturesJson from "../../src/configuration/creatures.json";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

/**
 * Craft and the Runes resolve by a ROLL, and two of their outcomes — Craft's "nothing" and a failed rune —
 * leave the board completely untouched. A ranked client therefore cannot see them: a snapshot diff has no
 * change to notice, and re-running the roll in the authoritative replay would show each player a DIFFERENT
 * answer (the replay runs with unseeded RNG). The engine states the roll on `spell_cast.outcomes` instead,
 * which is the only honest source, and these tests pin that contract.
 */
const blacksmith = creaturesJson.Life.Blacksmith;

const setupBlacksmith = (allyCells: { x: number; y: number }[]) => {
    const context = createCombatTestContext(PBTypes.GridVals.NORMAL);
    const fightProperties = FightStateManager.getInstance().getFightProperties();
    fightProperties.setGridType(PBTypes.GridVals.NORMAL);
    fightProperties.startFight();

    const caster = createTestUnit({
        name: "Blacksmith",
        team: PBTypes.TeamVals.LEFT,
        spells: blacksmith.spells,
        abilities: ["Blacksmith Tools"],
        amountAlive: 5,
        stackPower: 5,
        maxHp: 10_000,
        initiative: 5,
        morale: 4,
    });
    placeUnit(context.grid, context.unitsHolder, caster, { x: 1, y: 1 });

    const allies = allyCells.map((cell, index) => {
        const ally = createTestUnit({
            name: `Friend ${index}`,
            team: PBTypes.TeamVals.LEFT,
            maxHp: 10_000,
            initiative: 2,
            morale: 4,
        });
        placeUnit(context.grid, context.unitsHolder, ally, cell);
        return ally;
    });

    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1 + allies.length);
    fightProperties.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 1);
    fightProperties.startTurn(PBTypes.TeamVals.LEFT, 1000);

    const sceneLog = new SceneLogMock();
    const engine = new GameActionEngine({
        fightProperties,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog,
        attackHandler: context.attackHandler,
        getCurrentActiveUnitId: () => caster.getId(),
    });

    return { ...context, fightProperties, caster, allies, engine };
};

const castEvent = (events: GameEvent[]): Extract<GameEvent, { type: "spell_cast" }> => {
    const event = events.find((e): e is Extract<GameEvent, { type: "spell_cast" }> => e.type === "spell_cast");
    expect(event).toBeDefined();
    return event!;
};

describe("cast outcomes on spell_cast", () => {
    beforeEach(() => {
        FightStateManager.getInstance().reset();
    });

    it("reports one Craft outcome per ally caught in the 2x2, naming any ability it granted", () => {
        const setup = setupBlacksmith([
            { x: 4, y: 4 },
            { x: 5, y: 4 },
        ]);

        const result = setup.engine.apply({
            type: "cast_spell",
            casterId: setup.caster.getId(),
            spellName: "Craft",
            targetCell: { x: 4, y: 4 },
        });

        expect(result.completed).toBe(true);
        const outcomes = castEvent(result.events).outcomes ?? [];
        expect(outcomes).toHaveLength(setup.allies.length);
        expect(new Set(outcomes.map((o) => o.unitId))).toEqual(new Set(setup.allies.map((a) => a.getId())));
        for (const entry of outcomes) {
            expect(["stun", "nothing", "double", "frozen"]).toContain(entry.outcome);
            // A granted ability is named so the client pops the right icon without guessing from a diff;
            // the two outcomes that grant nothing must not claim one.
            if (entry.outcome === "double" || entry.outcome === "frozen") {
                expect(entry.grantedAbility).toStartWith("Crafted ");
            } else {
                expect(entry.grantedAbility).toBeUndefined();
            }
        }
    });

    // The whole point: "nothing" changes no state, so before this it was invisible to ranked. Rolling the
    // 2x2 repeatedly is enough to see one — the neutral-luck chance is 40%.
    it("states a 'nothing' outcome even though it leaves the board untouched", () => {
        let sawNothing = false;
        for (let attempt = 0; attempt < 40 && !sawNothing; attempt += 1) {
            FightStateManager.getInstance().reset();
            const setup = setupBlacksmith([{ x: 4, y: 4 }]);
            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.caster.getId(),
                spellName: "Craft",
                targetCell: { x: 4, y: 4 },
            });
            const outcomes = castEvent(result.events).outcomes ?? [];
            sawNothing = outcomes.some((o) => o.outcome === "nothing");
        }
        expect(sawNothing).toBe(true);
    });

    it("reports a rune as enchanted with its running total, or failed", () => {
        let sawEnchanted = false;
        let sawFailed = false;

        for (let attempt = 0; attempt < 40 && !(sawEnchanted && sawFailed); attempt += 1) {
            FightStateManager.getInstance().reset();
            const setup = setupBlacksmith([{ x: 2, y: 1 }]);
            const target = setup.allies[0];
            const result = setup.engine.apply({
                type: "cast_spell",
                casterId: setup.caster.getId(),
                spellName: "Armor Rune",
                targetId: target.getId(),
            });

            expect(result.completed).toBe(true);
            const outcomes = castEvent(result.events).outcomes ?? [];
            expect(outcomes).toHaveLength(1);
            expect(outcomes[0].unitId).toBe(target.getId());

            if (outcomes[0].outcome === "enchanted") {
                sawEnchanted = true;
                // The running total the card shows as "+N" — the client prints it rather than re-deriving.
                expect(outcomes[0].amount).toBeGreaterThanOrEqual(1);
            } else {
                sawFailed = true;
                expect(outcomes[0].outcome).toBe("failed");
                // A failed rune grants nothing, so there is no total to report.
                expect(outcomes[0].amount).toBeUndefined();
            }
        }

        expect(sawEnchanted).toBe(true);
        expect(sawFailed).toBe(true);
    });
});
