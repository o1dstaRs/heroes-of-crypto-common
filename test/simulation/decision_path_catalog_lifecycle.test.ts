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

import { afterEach, describe, expect, it } from "bun:test";

import type { IAIStrategy, IDecisionContext } from "../../src/ai";
import { DecisionPathCatalog } from "../../src/ai/decision_path_catalog";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { restoreBattle, snapshotBattle } from "../../src/simulation/battle_snapshot";
import type { ILookaheadDeps } from "../../src/simulation/lookahead";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const savedSearch = process.env.V07_SEARCH;
const savedVersions = process.env.SEARCH_VERSIONS;

afterEach(() => {
    if (savedSearch === undefined) {
        delete process.env.V07_SEARCH;
    } else {
        process.env.V07_SEARCH = savedSearch;
    }
    if (savedVersions === undefined) {
        delete process.env.SEARCH_VERSIONS;
    } else {
        process.env.SEARCH_VERSIONS = savedVersions;
    }
});

describe("SearchDriver decision path catalog lifecycle", () => {
    it("creates a fresh rollout catalog and matrix after every apply/restore edge", () => {
        process.env.V07_SEARCH = "1";
        process.env.SEARCH_VERSIONS = "v0.8";

        const combat = createCombatTestContext();
        const actor = createTestUnit({
            team: PBTypes.TeamVals.LOWER,
            name: "Rollout Actor",
            attackType: PBTypes.AttackVals.MELEE,
            speed: 4.2,
        });
        const enemy = createTestUnit({
            team: PBTypes.TeamVals.UPPER,
            name: "Rollout Target",
            attackType: PBTypes.AttackVals.MELEE,
        });
        placeUnit(combat.grid, combat.unitsHolder, actor, { x: 6, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 10, y: 10 });

        const contexts: IDecisionContext[] = [];
        const strategy = {
            version: "catalog-lifecycle-recorder",
            decideTurn: (_unit: Unit, context: IDecisionContext) => {
                contexts.push(context);
                return [];
            },
        } as unknown as IAIStrategy;
        const pathHelper = new PathHelper(testGridSettings);
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        let activeUnitId = actor.getId();
        const deps = {
            engine: {},
            turnEngine: {},
            grid: combat.grid,
            unitsHolder: combat.unitsHolder,
            fightProperties,
            pathHelper,
            attackHandler: combat.attackHandler,
            strategyForTeam: () => strategy,
            getActiveUnitId: () => activeUnitId,
            setActiveUnitId: (id: string) => {
                activeUnitId = id;
            },
            damageDealtThisLap: () => false,
            captureDamageStats: () => [],
            restoreDamageStats: () => undefined,
        } as unknown as ILookaheadDeps;
        const driver = new SearchDriver(deps, {
            seed: 0xa13,
            greenVersion: "v0.8",
            redVersion: "v0.8",
        }) as unknown as {
            finishedSim: boolean;
            simPlayTurn(unit: Unit): void;
        };
        // Keep this focused on context construction. SearchDriver has already selected the real rollout
        // strategy, but a terminal simulation must not apply/recover/end any action after it decides.
        driver.finishedSim = true;

        const snapshot = snapshotBattle(combat.unitsHolder, combat.grid, fightProperties);
        const originalPosition = { ...actor.getPosition() };

        driver.simPlayTurn(actor);
        expect(contexts).toHaveLength(1);
        const first = contexts[0];
        expect(first.decisionOrigin).toBe("rollout");
        expect(first.pathHelper).toBe(pathHelper);
        expect(first.decisionPathCatalog).toBeInstanceOf(DecisionPathCatalog);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                first.decisionPathCatalog!,
                combat.grid,
                actor,
                first.matrix,
            ),
        ).toBe(true);

        const enemyTeam = PBTypes.TeamVals.UPPER;
        const firstPath = first.decisionPathCatalog!.getMovePath(
            actor.getBaseCell(),
            first.matrix,
            actor.getSteps(),
            combat.grid.getAggrMatrixByTeam(enemyTeam),
            actor.canFly(),
            actor.isSmallSize(),
            actor.canTraverseLava(),
        );

        // Model state churn on a candidate, including corruption of the detached decision matrix. The battle
        // restore repairs live state only; a wrongly retained rollout context/catalog would still carry 999.
        actor.setPosition(originalPosition.x + 42, originalPosition.y + 42);
        first.matrix[0][0] = 999;
        restoreBattle(snapshot, combat.unitsHolder, combat.grid, fightProperties);
        expect(actor.getPosition()).toEqual(originalPosition);

        driver.simPlayTurn(actor);
        expect(contexts).toHaveLength(2);
        const second = contexts[1];
        expect(second.decisionOrigin).toBe("rollout");
        expect(second.pathHelper).toBe(pathHelper);
        expect(second.matrix).not.toBe(first.matrix);
        expect(second.matrix).toEqual(combat.grid.getMatrix());
        expect(second.matrix[0][0]).not.toBe(999);
        expect(second.decisionPathCatalog).toBeInstanceOf(DecisionPathCatalog);
        expect(second.decisionPathCatalog).not.toBe(first.decisionPathCatalog);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                second.decisionPathCatalog!,
                combat.grid,
                actor,
                second.matrix,
            ),
        ).toBe(true);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                first.decisionPathCatalog!,
                combat.grid,
                actor,
                second.matrix,
            ),
        ).toBe(false);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                second.decisionPathCatalog!,
                combat.grid,
                actor,
                first.matrix,
            ),
        ).toBe(false);

        const secondPath = second.decisionPathCatalog!.getMovePath(
            actor.getBaseCell(),
            second.matrix,
            actor.getSteps(),
            combat.grid.getAggrMatrixByTeam(enemyTeam),
            actor.canFly(),
            actor.isSmallSize(),
            actor.canTraverseLava(),
        );
        expect(secondPath).toEqual(firstPath);
        expect(secondPath).not.toBe(firstPath);

        // Freshness is per simulated decision, not merely a side effect of snapshot restoration.
        driver.simPlayTurn(actor);
        expect(contexts).toHaveLength(3);
        expect(contexts[2].matrix).not.toBe(second.matrix);
        expect(contexts[2].decisionPathCatalog).toBeInstanceOf(DecisionPathCatalog);
        expect(contexts[2].decisionPathCatalog).not.toBe(second.decisionPathCatalog);
        expect(new Set(contexts.map(({ decisionPathCatalog }) => decisionPathCatalog)).size).toBe(3);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                contexts[2].decisionPathCatalog!,
                combat.grid,
                actor,
                contexts[2].matrix,
            ),
        ).toBe(true);
        expect(
            DecisionPathCatalog.canElideUnconsumedMeleeLayers(
                contexts[2].decisionPathCatalog!,
                combat.grid,
                actor,
                second.matrix,
            ),
        ).toBe(false);
    });
});
