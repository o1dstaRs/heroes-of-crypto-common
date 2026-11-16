import { afterEach, describe, expect, test } from "bun:test";
import { enumerateCandidates } from "../../src/ai/candidates";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import {
    bitterExperienceOpportunity,
    selectBitterExperienceOpportunity,
    reserveBitterExperienceCandidate,
    includeImprovingBitterExperienceTrade,
} from "../../src/simulation/bitter_experience_research";
import { createValueFeatureScratch, fillValueFeaturesV2 } from "../../src/simulation/value_features";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";
const LEFT = PBTypes.TeamVals.LEFT,
    RIGHT = PBTypes.TeamVals.RIGHT;
afterEach(() => setDeterministicRandomSource(undefined));
function fixture(damage = 10, amount = 40) {
    const combat = createCombatTestContext(),
        fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({
        name: "Peasant",
        team: LEFT,
        abilities: ["Bitter Experience"],
        maxHp: 8,
        amountAlive: amount,
        armor: 7,
        attack: 9,
        damageMin: 2,
        damageMax: 3,
    });
    const enemy = createTestUnit({
        name: "Weak responder",
        team: RIGHT,
        maxHp: 80,
        amountAlive: 1,
        damageMin: damage,
        damageMax: damage,
        attack: 7,
        armor: 7,
    });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 4, y: 6 });
    placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 5, y: 6 });
    fp.startFight();
    fp.setTeamUnitsAlive(LEFT, 1);
    fp.setTeamUnitsAlive(RIGHT, 1);
    fp.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fp,
        decisionOrigin: "root",
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const actions = [
        {
            type: "melee_attack" as const,
            attackerId: actor.getId(),
            targetId: enemy.getId(),
            attackFrom: actor.getBaseCell(),
        },
    ];
    const candidate = enumerateCandidates(actor, context, actions).candidates[0];
    const engine = new GameActionEngine({
        ...combat,
        fightProperties: fp,
        moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
        sceneLog: new SceneLogMock(),
        getCurrentActiveUnitId: () => actor.getId(),
        canLandRangeAttack: () => false,
    });
    return { ...combat, fp, actor, enemy, context, candidate, engine };
}
describe("Bitter Experience research", () => {
    test("pure inspection finds a cheap qualifying reply; even a killed defender replies at pre-hit strength", () => {
        const h = fixture();
        let draws = 0;
        setDeterministicRandomSource(() => {
            draws++;
            return 0.5;
        });
        const before = JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp));
        const opportunity = bitterExperienceOpportunity(h.actor, h.context, h.candidate);
        expect(opportunity).toMatchObject({ procChance: 1, maximumCasualties: 1, maximumHpLoss: 10 });
        expect(draws).toBe(0);
        expect(JSON.stringify(snapshotBattle(h.unitsHolder, h.grid, h.fp))).toBe(before);
        const armor = h.actor.getBaseArmor(),
            steps = h.actor.getSteps();
        expect(h.engine.apply(h.candidate.actions[0])).toMatchObject({ completed: true });
        expect(h.enemy.isDead()).toBe(true);
        expect(h.actor.getAmountAlive()).toBe(39);
        expect(h.actor.getUnitProperties().bitter_experience_stacks).toBe(1);
        expect(h.actor.getBaseArmor()).toBe(armor + 1);
        expect(h.actor.getSteps()).toBe(steps + 1);
    });
    test("excludes no-casualty, expensive, fatal, spent, blocked and absorbed replies", () => {
        for (const args of [
            [1, 40],
            [30, 40],
            [10, 1],
        ]) {
            const h = fixture(...(args as [number, number]));
            expect(bitterExperienceOpportunity(h.actor, h.context, h.candidate)).toBeUndefined();
        }
        for (const flag of ["unit", "fight", "break", "shield", "no-melee", "forced"]) {
            const h = fixture();
            if (flag === "unit") h.enemy.getResponded = () => true;
            if (flag === "fight") h.fp.addRepliedAttack(h.enemy.getId());
            if (flag === "break") h.actor.applyEffect(new EffectFactory().makeEffect("Break")!);
            if (flag === "shield") h.actor.willAbsorbIncomingHit = () => true;
            if (flag === "no-melee") h.enemy.canRespond = () => false;
            if (flag === "forced") h.enemy.getTarget = () => "someone-else";
            expect(bitterExperienceOpportunity(h.actor, h.context, h.candidate)).toBeUndefined();
        }
    });
    test("does not introduce proposals in rollouts or for unsupported movement", () => {
        const h = fixture();
        expect(
            bitterExperienceOpportunity(h.actor, { ...h.context, decisionOrigin: undefined }, h.candidate),
        ).toBeUndefined();
        const changed = {
            ...h.candidate,
            actions: h.candidate.actions.map((a) => (a.type === "melee_attack" ? { ...a, path: [{ x: 4, y: 6 }] } : a)),
        };
        expect(bitterExperienceOpportunity(h.actor, h.context, changed)).toBeUndefined();
    });
    test("ordinary immediate value features are blind to the earned armor and movement", () => {
        const h = fixture();
        const before = fillValueFeaturesV2([], h.unitsHolder, h.fp, LEFT, createValueFeatureScratch());
        // Test-only perturbation isolates these two stats from casualties or any other turn effects.
        const properties = h.actor.getUnitProperties();
        Object.assign(properties, { base_armor: properties.base_armor + 1, steps: properties.steps + 1 });
        expect(fillValueFeaturesV2([], h.unitsHolder, h.fp, LEFT, createValueFeatureScratch())).toEqual(before);
    });
    test("reserves one bounded comparison, keeps the leading challenger and requires a measured margin", () => {
        const h = fixture(),
            op = selectBitterExperienceOpportunity(h.actor, h.context, [h.candidate])!;
        expect(op).toBeDefined();
        const incumbent = { ...h.candidate },
            top = { ...h.candidate },
            last = { ...h.candidate };
        const kept = reserveBitterExperienceCandidate(op, incumbent, [top, last], 2);
        expect(kept).toEqual([top, last, h.candidate]);
        expect(reserveBitterExperienceCandidate(op, h.candidate, [top, last], 2)).toEqual([top, last]);
        expect(
            includeImprovingBitterExperienceTrade([incumbent, top, h.candidate], [0.5, 0.6, 0.605], [0, 1], op),
        ).toEqual([0, 1]);
        expect(
            includeImprovingBitterExperienceTrade([incumbent, top, h.candidate], [0.5, 0.6, 0.62], [0, 1], op),
        ).toEqual([0, 1, 2]);
    });
});
