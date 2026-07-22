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

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
    AI_VERSIONS,
    DEFAULT_AI_VERSION,
    getAIStrategy,
    LATEST_AI_VERSION,
    type IDecisionContext,
    type IEnumeratedCandidate,
} from "../../src/ai";
import { StrategyV0_8 } from "../../src/ai/versions/v0_8";
import { StrategyV0_8S } from "../../src/ai/versions/v0_8s";
import { selectV08STargetPressureCandidate, V08S_URGENT_FINISH_START_LAP } from "../../src/ai/versions/v0_8s_finish";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { buildRoster, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { Spell } from "../../src/spells/spell";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const SEARCH_ENV_KEYS = [
    "V07_SEARCH",
    "Q2_WAIT_ABLATION",
    "Q2_ORACLE",
    "SEARCH_VERSIONS",
    "V08_A13_SEARCH",
    "V08_RANGED_POSITION_VERSIONS",
] as const;
const savedSearchEnv = Object.fromEntries(SEARCH_ENV_KEYS.map((key) => [key, process.env[key]]));
const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const RANGE = PBTypes.AttackVals.RANGE;

const candidate = (
    actor: Unit,
    target: Unit,
    options: {
        damage: number;
        kill?: 0 | 1;
        kind?: "melee" | "shot";
        move?: boolean;
        primaryDamage?: number;
    },
): IEnumeratedCandidate => {
    const kind = options.kind ?? "melee";
    return {
        kind,
        targetId: target.getId(),
        actions: [
            ...(options.move ? [{ type: "move_unit", unitId: actor.getId(), path: [{ x: 6, y: 6 }] } as const] : []),
            kind === "shot"
                ? ({ type: "range_attack", attackerId: actor.getId(), targetId: target.getId() } as const)
                : ({
                      type: "melee_attack",
                      attackerId: actor.getId(),
                      targetId: target.getId(),
                      attackFrom: actor.getBaseCell(),
                  } as const),
        ],
        ...(kind === "shot"
            ? {
                  shotFeatures: {
                      primaryTargetDamage: options.primaryDamage ?? options.damage,
                  } as IEnumeratedCandidate["shotFeatures"],
              }
            : {}),
        features: {
            moraleDelta: 0,
            luckDelta: 0,
            enemiesNotYetActedFrac: 0,
            alliesNotYetActedFrac: 0,
            lap: 6,
            hourglassSpent: 0,
            spendsRangeShot: kind === "shot" ? 1 : 0,
            spendsSpellCharge: 0,
            burnsResurrectionCharge: 0,
            expectedDamage: options.damage,
            expectedKill: options.kill ?? 0,
        },
    };
};

function schedulerFixture(): {
    actor: Unit;
    context: IDecisionContext;
    placeTarget: (target: Unit, cell: { x: number; y: number }) => Unit;
} {
    const combat = createCombatTestContext();
    const actor = createTestUnit({ team: LOWER, name: "Scheduler", attackType: MELEE, attack: 10 });
    placeUnit(combat.grid, combat.unitsHolder, actor, { x: 5, y: 5 });
    return {
        actor,
        context: {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties: FightStateManager.getInstance().getFightProperties(),
        },
        placeTarget: (target, cell) => {
            placeUnit(combat.grid, combat.unitsHolder, target, cell);
            return target;
        },
    };
}

beforeEach(() => {
    for (const key of SEARCH_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
    for (const key of SEARCH_ENV_KEYS) {
        const value = savedSearchEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe("v0.8 search measurement alias", () => {
    it("is registered immediately before v0.8 without becoming latest or default", () => {
        const alias = getAIStrategy("v0.8s");
        expect(alias).toBeInstanceOf(StrategyV0_8);
        expect(alias.version).toBe("v0.8s");
        expect(Object.getOwnPropertyNames(StrategyV0_8S.prototype)).toEqual(["constructor"]);
        expect(AI_VERSIONS.indexOf("v0.8s")).toBe(AI_VERSIONS.indexOf("v0.8") - 1);
        expect(LATEST_AI_VERSION).toBe("v0.8");
        expect(DEFAULT_AI_VERSION).toBe("v0.8");
    });

    it("plays byte-identically to v0.8 before the lap-6 experiment boundary", () => {
        process.env.V08_A13_SEARCH = "0";
        // Isolate the measurement alias from the separately scoped production ranged-positioning probe.
        // By default that probe intentionally applies to v0.8 but not its v0.8s control seat.
        process.env.V08_RANGED_POSITION_VERSIONS = "";
        const seed = 20260719;
        const roster = buildRoster(makeRng(seed));
        const config = { redVersion: "v0.7", roster, seed, maxLaps: 5 } as const;
        const baseline = runMatch({ ...structuredClone(config), greenVersion: "v0.8" });
        const aliased = runMatch({ ...structuredClone(config), greenVersion: "v0.8s" });

        expect(aliased.outcome.green.version).toBe("v0.8s");
        aliased.outcome.green.version = "v0.8";
        expect(aliased).toEqual(baseline);
    });

    it("pins plain v0.7 and the baked a13 direct-policy baseline byte-for-byte", () => {
        process.env.V08_A13_SEARCH = "0";
        const seed = 20260719;
        const digest = (version: "v0.7" | "v0.8"): string => {
            const roster = buildRoster(makeRng(seed));
            const result = runMatch({ greenVersion: version, redVersion: "v0.7", roster, seed, maxLaps: 60 });
            return createHash("sha256").update(JSON.stringify(result)).digest("hex");
        };

        expect(digest("v0.7")).toBe("0a76410be0f38bee72cd4a882f56061c9a6013c0d1e1b66cffc167ea782ea88a");
        expect(digest("v0.8")).toBe("0c2e35f661fe9bcd9f34bc2f41ebcd41a6a6af3512b5bc9fc90fbd56e5521c92");
    });

    it("takes an immediate kill before harder unfinished work", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const killable = placeTarget(createTestUnit({ team: UPPER, name: "Kill now", maxHp: 10, amountAlive: 1 }), {
            x: 5,
            y: 6,
        });
        const blocker = placeTarget(
            createTestUnit({ team: UPPER, name: "Long blocker", maxHp: 100, amountAlive: 10 }),
            { x: 7, y: 5 },
        );
        const kill = candidate(actor, killable, { damage: 10, kill: 1 });
        const hard = candidate(actor, blocker, { damage: 1 });

        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [hard, kill])).toBe(kill);
    });

    it("groups delivery by target and prefers kill, damage, then stationary attack", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const target = placeTarget(createTestUnit({ team: UPPER, name: "Shared target", maxHp: 100, amountAlive: 1 }), {
            x: 5,
            y: 6,
        });
        const moving = candidate(actor, target, { damage: 20, move: true });
        const stationary = candidate(actor, target, { damage: 20 });
        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [moving, stationary])).toBe(stationary);

        const stronger = candidate(actor, target, { damage: 30, move: true });
        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [stationary, stronger])).toBe(stronger);

        const kill = candidate(actor, target, { damage: 10, kill: 1, move: true });
        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [stronger, kill])).toBe(kill);
    });

    it("prices repeated Wild Regeneration into hardest-work target selection", () => {
        const regeneration = schedulerFixture();
        const ordinary = regeneration.placeTarget(
            createTestUnit({ team: UPPER, name: "Ordinary", maxHp: 15, amountAlive: 10 }),
            { x: 5, y: 6 },
        );
        const regenerating = regeneration.placeTarget(
            createTestUnit({
                team: UPPER,
                name: "Regenerator",
                maxHp: 100,
                amountAlive: 1,
                abilities: ["Wild Regeneration"],
            }),
            { x: 7, y: 5 },
        );
        const ordinaryDelivery = candidate(regeneration.actor, ordinary, { damage: 100 });
        const regenerationDelivery = candidate(regeneration.actor, regenerating, { damage: 100 });
        expect(
            selectV08STargetPressureCandidate(regeneration.actor, regeneration.context.unitsHolder, [
                ordinaryDelivery,
                regenerationDelivery,
            ]),
        ).toBe(regenerationDelivery);
    });

    it("defers nonlethal melee into fresh Dulling Defense while another positive target exists", () => {
        const dulling = schedulerFixture();
        const plainTank = dulling.placeTarget(
            createTestUnit({ team: UPPER, name: "Plain tank", maxHp: 120, amountAlive: 1 }),
            { x: 5, y: 6 },
        );
        const dullingTank = dulling.placeTarget(
            createTestUnit({
                team: UPPER,
                name: "Dulling tank",
                maxHp: 100,
                amountAlive: 1,
                abilities: ["Dulling Defense"],
            }),
            { x: 7, y: 5 },
        );
        const plainDelivery = candidate(dulling.actor, plainTank, { damage: 20 });
        const dullingDelivery = candidate(dulling.actor, dullingTank, { damage: 20 });
        expect(
            selectV08STargetPressureCandidate(dulling.actor, dulling.context.unitsHolder, [
                plainDelivery,
                dullingDelivery,
            ]),
        ).toBe(plainDelivery);
        expect(selectV08STargetPressureCandidate(dulling.actor, dulling.context.unitsHolder, [dullingDelivery])).toBe(
            dullingDelivery,
        );
    });

    it("preserves the exact same-target incumbent unless an alternative creates an immediate kill", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const target = placeTarget(createTestUnit({ team: UPPER, name: "Same target", maxHp: 100, amountAlive: 1 }), {
            x: 5,
            y: 6,
        });
        const incumbent = {
            ...candidate(actor, target, { damage: 10 }),
            kind: "incumbent" as const,
        } satisfies IEnumeratedCandidate;
        const strongerStandCell = candidate(actor, target, { damage: 30, move: true });
        const finishingStandCell = candidate(actor, target, { damage: 10, kill: 1, move: true });

        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [strongerStandCell, incumbent])).toBe(
            incumbent,
        );
        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [incumbent, finishingStandCell])).toBe(
            finishingStandCell,
        );
    });

    it("finishes the most-wounded reachable target before opening fresh hard work", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const wounded = createTestUnit({ team: UPPER, name: "Wounded focus", maxHp: 100, amountAlive: 1 });
        wounded.applyDamage(60, 0, new SceneLogMock());
        placeTarget(wounded, { x: 5, y: 6 });
        const freshHard = placeTarget(
            createTestUnit({ team: UPPER, name: "Fresh hard", maxHp: 100, amountAlive: 10 }),
            { x: 7, y: 5 },
        );
        const focusedDelivery = candidate(actor, wounded, { damage: 10 });
        const freshDelivery = candidate(actor, freshHard, { damage: 1 });

        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [freshDelivery, focusedDelivery])).toBe(
            focusedDelivery,
        );
    });

    it("uses primary-target shot damage rather than aggregate AOE damage for remaining work", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const splashPrimary = placeTarget(
            createTestUnit({ team: UPPER, name: "Splash primary", maxHp: 100, amountAlive: 1 }),
            { x: 5, y: 6 },
        );
        const directPrimary = placeTarget(
            createTestUnit({ team: UPPER, name: "Direct primary", maxHp: 200, amountAlive: 1 }),
            { x: 7, y: 5 },
        );
        const splash = candidate(actor, splashPrimary, { kind: "shot", damage: 200, primaryDamage: 10 });
        const direct = candidate(actor, directPrimary, { kind: "shot", damage: 80, primaryDamage: 80 });

        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [direct, splash])).toBe(splash);
    });

    it("never forces a positive-primary shot whose friendly-fire-adjusted damage is non-positive", () => {
        const { actor, context, placeTarget } = schedulerFixture();
        const unsafeTarget = placeTarget(
            createTestUnit({ team: UPPER, name: "Unsafe primary", maxHp: 100, amountAlive: 1 }),
            { x: 5, y: 6 },
        );
        const cleanTarget = placeTarget(
            createTestUnit({ team: UPPER, name: "Clean primary", maxHp: 100, amountAlive: 1 }),
            { x: 7, y: 5 },
        );
        const friendlyFire = candidate(actor, unsafeTarget, {
            kind: "shot",
            damage: -50,
            primaryDamage: 100,
            kill: 1,
        });
        const clean = candidate(actor, cleanTarget, { kind: "shot", damage: 10, primaryDamage: 10 });

        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [friendlyFire])).toBeUndefined();
        expect(selectV08STargetPressureCandidate(actor, context.unitsHolder, [friendlyFire, clean])).toBe(clean);
    });

    it("keeps a non-dominant stronger-ranged screen waiting through lap 8 and forces an advance at lap 9", () => {
        const combat = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const screen = createTestUnit({ team: LOWER, name: "Screen", attackType: MELEE, speed: 2 });
        const ownShooter = createTestUnit({
            team: LOWER,
            name: "Strong shooter",
            attackType: RANGE,
            amountAlive: 1,
            rangeShots: 10,
            damageMin: 100,
            damageMax: 100,
        });
        const enemyShooter = createTestUnit({
            team: UPPER,
            name: "Weak shooter",
            attackType: RANGE,
            amountAlive: 1,
            maxHp: 100,
            rangeShots: 1,
            damageMin: 1,
            damageMax: 1,
        });
        placeUnit(combat.grid, combat.unitsHolder, screen, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, ownShooter, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, enemyShooter, { x: 12, y: 13 });
        fightProperties.setTeamUnitsAlive(LOWER, 2);
        fightProperties.setTeamUnitsAlive(UPPER, 1);
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };
        while (fightProperties.getCurrentLap() < V08S_URGENT_FINISH_START_LAP - 1) fightProperties.flipLap();

        expect(new StrategyV0_8S().decideTurn(screen, context)).toEqual([
            { type: "wait_turn", unitId: screen.getId() },
        ]);
        fightProperties.flipLap();
        const urgent = new StrategyV0_8S().decideTurn(screen, context);
        expect(urgent.some((action) => action.type === "wait_turn")).toBe(false);
        expect(urgent.some((action) => action.type === "move_unit")).toBe(true);
    });

    it("closes on a sole surviving enemy summon in the lap-9 sprint", () => {
        const combat = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const actor = createTestUnit({ team: LOWER, name: "Summon finisher", attackType: MELEE, speed: 2 });
        const ownShooter = createTestUnit({
            team: LOWER,
            name: "Strong shooter",
            attackType: RANGE,
            amountAlive: 1,
            rangeShots: 10,
            damageMin: 100,
            damageMax: 100,
        });
        const summonedEnemy = createTestUnit({
            team: UPPER,
            name: "Last summon",
            attackType: RANGE,
            maxHp: 100,
            amountAlive: 1,
            rangeShots: 1,
            damageMin: 1,
            damageMax: 1,
            summoned: true,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, ownShooter, { x: 2, y: 2 });
        placeUnit(combat.grid, combat.unitsHolder, summonedEnemy, { x: 12, y: 13 });
        fightProperties.setTeamUnitsAlive(LOWER, 2);
        // Summons are intentionally absent from original-stack accounting. The terminal sprint must use the
        // living board state instead of treating this fight as already empty.
        fightProperties.setTeamUnitsAlive(UPPER, 0);
        while (fightProperties.getCurrentLap() < V08S_URGENT_FINISH_START_LAP) fightProperties.flipLap();
        const context: IDecisionContext = {
            grid: combat.grid,
            matrix: combat.grid.getMatrix(),
            unitsHolder: combat.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: combat.attackHandler,
            fightProperties,
        };

        const production = new StrategyV0_8().decideTurn(actor, context);
        const alias = new StrategyV0_8S().decideTurn(actor, context);
        expect(alias).toEqual(production);
        expect(production.some((action) => action.type === "wait_turn" || action.type === "defend_turn")).toBe(false);
        const move = production.find((action) => action.type === "move_unit");
        expect(move).toBeDefined();
        const destination = move?.type === "move_unit" ? move.path.at(-1) : undefined;
        expect(destination).toBeDefined();
        const enemyCell = summonedEnemy.getBaseCell();
        const distance = (cell: { x: number; y: number }): number =>
            Math.abs(cell.x - enemyCell.x) + Math.abs(cell.y - enemyCell.y);
        expect(distance(destination!)).toBeLessThan(distance(actor.getBaseCell()));
    });

    it("keeps taking a clean shot regardless of ranged posture instead of turning superiority into a skip", () => {
        const decide = (ownAmount: number, ownDamage: number, enemyAmount: number, enemyDamage: number) => {
            const combat = createCombatTestContext();
            const fightProperties = FightStateManager.getInstance().getFightProperties();
            const shooter = createTestUnit({
                team: LOWER,
                name: "Own shooter",
                attackType: RANGE,
                amountAlive: ownAmount,
                damageMin: ownDamage,
                damageMax: ownDamage,
                rangeShots: 1,
                shotDistance: 1,
                speed: 2,
            });
            const ownScreen = createTestUnit({ team: LOWER, name: "Own screen", attackType: MELEE });
            const enemyShooter = createTestUnit({
                team: UPPER,
                name: "Enemy shooter",
                attackType: RANGE,
                amountAlive: enemyAmount,
                damageMin: enemyDamage,
                damageMax: enemyDamage,
                rangeShots: 1,
                shotDistance: 1,
            });
            const enemyScreen = createTestUnit({ team: UPPER, name: "Enemy screen", attackType: MELEE });
            placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 5, y: 2 });
            placeUnit(combat.grid, combat.unitsHolder, ownScreen, { x: 7, y: 2 });
            placeUnit(combat.grid, combat.unitsHolder, enemyScreen, { x: 5, y: 8 });
            placeUnit(combat.grid, combat.unitsHolder, enemyShooter, { x: 12, y: 14 });
            enemyShooter.applyBuff(
                new Spell({
                    spellProperties: getSpellConfig("System", "Hidden"),
                    amount: 1,
                }),
            );
            fightProperties.setTeamUnitsAlive(LOWER, 2);
            fightProperties.setTeamUnitsAlive(UPPER, 2);
            const context: IDecisionContext = {
                grid: combat.grid,
                matrix: combat.grid.getMatrix(),
                unitsHolder: combat.unitsHolder,
                pathHelper: new PathHelper(testGridSettings),
                attackHandler: combat.attackHandler,
                fightProperties,
            };
            return new StrategyV0_8S().decideTurn(shooter, context);
        };

        // The weaker ranged side must act rather than wait for the superior shooter to dictate the engagement.
        const actuallyWeaker = decide(1, 10, 100, 1);
        expect(actuallyWeaker.some((action) => action.type === "wait_turn")).toBe(false);
        expect(actuallyWeaker.some((action) => action.type === "range_attack")).toBe(true);

        // The stronger ranged side may hold its screen, but the shooter itself still takes an available shot.
        const actuallyStronger = decide(100, 1, 1, 10);
        expect(actuallyStronger.some((action) => action.type === "wait_turn")).toBe(false);
        expect(actuallyStronger.some((action) => action.type === "range_attack")).toBe(true);
    });
});
