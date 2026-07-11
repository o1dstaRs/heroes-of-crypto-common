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

import { describe, expect, it } from "bun:test";

import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    expandValueFeaturesV2,
    extractValueFeatures,
    extractValueFeaturesV2,
    extractValueFeaturesV2Raw,
    VALUE_FEATURE_NAMES,
    VALUE_FEATURE_NAMES_V2,
    VALUE_FEATURE_NAMES_V2_RAW,
} from "../../src/simulation/value_features";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const RANGE = PBTypes.AttackVals.RANGE;

const rawAt = (raw: number[], name: string): number => raw[VALUE_FEATURE_NAMES_V2_RAW.indexOf(name)];

describe("value features V2 (Phase-B multi-cohort leaf basis)", () => {
    it("raw V2 prefixes the exact base-20 vector and appends the composition block", () => {
        const combat = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const shooter = createTestUnit({ name: "Shooter", team: LOWER, attackType: RANGE, rangeShots: 8 });
        const bruiser = createTestUnit({ name: "Bruiser", team: LOWER });
        const enemy = createTestUnit({ name: "Enemy", team: UPPER });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, bruiser, { x: 5, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 3, y: 10 });

        const base = extractValueFeatures(combat.unitsHolder, fightProperties, LOWER);
        const raw = extractValueFeaturesV2Raw(combat.unitsHolder, fightProperties, LOWER);
        expect(raw).toHaveLength(VALUE_FEATURE_NAMES_V2_RAW.length);
        expect(raw.slice(0, VALUE_FEATURE_NAMES.length)).toEqual(base);
        expect(rawAt(raw, "ownRangedFrac")).toBe(0.5);
        expect(rawAt(raw, "enemyRangedFrac")).toBe(0);
        expect(rawAt(raw, "shotsAdv")).toBeGreaterThan(0); // we hold all remaining shots
        expect(raw.every((x) => Number.isFinite(x))).toBe(true);
    });

    it("deployed V2 = raw + xRg_ rangedness-interaction copy; all-melee boards zero the copy", () => {
        const rawLen = VALUE_FEATURE_NAMES_V2_RAW.length;
        const ownIdx = VALUE_FEATURE_NAMES_V2_RAW.indexOf("ownRangedFrac");
        const enemyIdx = VALUE_FEATURE_NAMES_V2_RAW.indexOf("enemyRangedFrac");
        const raw = new Array(rawLen).fill(0).map((_, i) => (i + 1) / 100);
        raw[ownIdx] = 1;
        raw[enemyIdx] = 0.5; // rangedness 0.75
        const x = expandValueFeaturesV2(raw);
        expect(x).toHaveLength(VALUE_FEATURE_NAMES_V2.length);
        expect(x.slice(0, rawLen)).toEqual(raw);
        expect(x[rawLen]).toBeCloseTo(raw[0] * 0.75, 12);
        raw[ownIdx] = 0;
        raw[enemyIdx] = 0;
        expect(expandValueFeaturesV2(raw).slice(rawLen)).toEqual(new Array(rawLen).fill(0));
    });

    it("extractValueFeaturesV2 is the expanded raw extraction", () => {
        const combat = createCombatTestContext();
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        const shooter = createTestUnit({ name: "Shooter", team: LOWER, attackType: RANGE, rangeShots: 8 });
        const enemy = createTestUnit({ name: "Enemy", team: UPPER });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 3, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, enemy, { x: 3, y: 10 });
        const raw = extractValueFeaturesV2Raw(combat.unitsHolder, fightProperties, LOWER);
        expect(extractValueFeaturesV2(combat.unitsHolder, fightProperties, LOWER)).toEqual(expandValueFeaturesV2(raw));
    });
});
