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

import { enumerateCandidates, type IDecisionContext } from "../../src/ai";
import { meleeAttackTypeSelectionPrefix, normalizeMeleeMagicSelection } from "../../src/ai/melee_attack_type";
import type { GameAction } from "../../src/engine/actions";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { playV07SelfplayPassiveAuditGame } from "../../src/simulation/v0_7_selfplay_passive_audit";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const MAGIC = PBTypes.AttackVals.MAGIC;

describe("v0.7 melee-magic attack selection", () => {
    it("drops an inherited MELEE selector when MELEE_MAGIC is already selected", () => {
        const unit = createTestUnit({ team: LOWER, attackType: MELEE_MAGIC });
        unit.refreshPossibleAttackTypes(true);
        const strike: GameAction = {
            type: "melee_attack",
            attackerId: unit.getId(),
            targetId: "enemy",
            attackFrom: { x: 1, y: 1 },
        };
        const decision: GameAction[] = [
            { type: "select_attack_type", unitId: unit.getId(), attackType: MELEE },
            strike,
        ];

        expect(normalizeMeleeMagicSelection(unit, decision)).toEqual([strike]);
    });

    it("rewrites an inherited MELEE selector when the actor must switch from MAGIC", () => {
        const unit = createTestUnit({ team: LOWER, attackType: MELEE_MAGIC, spells: ["System:Resurrection"] });
        unit.refreshPossibleAttackTypes(true);
        expect(unit.selectAttackType(MAGIC)).toBe(true);
        const decision: GameAction[] = [
            { type: "select_attack_type", unitId: unit.getId(), attackType: MELEE },
            {
                type: "melee_attack",
                attackerId: unit.getId(),
                targetId: "enemy",
                attackFrom: { x: 1, y: 1 },
            },
        ];

        expect(normalizeMeleeMagicSelection(unit, decision)[0]).toEqual({
            type: "select_attack_type",
            unitId: unit.getId(),
            attackType: MELEE_MAGIC,
        });
    });

    it("preserves the exact decision reference outside the melee-magic-only capability", () => {
        const unit = createTestUnit({ team: LOWER, attackType: MELEE });
        unit.refreshPossibleAttackTypes(true);
        const decision: GameAction[] = [{ type: "end_turn", unitId: unit.getId(), reason: "manual" }];

        expect(normalizeMeleeMagicSelection(unit, decision)).toBe(decision);
    });

    it("emits a legal MELEE_MAGIC prefix for enumerated attacks after a magic selection", () => {
        const c = createCombatTestContext();
        const unit = createTestUnit({
            team: LOWER,
            attackType: MELEE_MAGIC,
            spells: ["System:Resurrection"],
            speed: 2,
        });
        const enemy = createTestUnit({ team: UPPER, attackType: MELEE });
        placeUnit(c.grid, c.unitsHolder, unit, { x: 4, y: 4 });
        placeUnit(c.grid, c.unitsHolder, enemy, { x: 4, y: 5 });
        unit.refreshPossibleAttackTypes(true);
        expect(unit.selectAttackType(MAGIC)).toBe(true);
        const context: IDecisionContext = {
            grid: c.grid,
            matrix: c.grid.getMatrix(),
            unitsHolder: c.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: c.attackHandler,
        };

        expect(meleeAttackTypeSelectionPrefix(unit)).toEqual([
            { type: "select_attack_type", unitId: unit.getId(), attackType: MELEE_MAGIC },
        ]);
        const candidate = enumerateCandidates(unit, context, []).candidates.find((item) => item.kind === "melee");
        expect(candidate?.actions[0]).toEqual({
            type: "select_attack_type",
            unitId: unit.getId(),
            attackType: MELEE_MAGIC,
        });
    });

    it.each([
        ["aura_offense", 2_995_275_550],
        ["aura_support", 1_346_911_710],
        ["melee_magic_brawler", 2_089_126_630],
    ] as const)("replays the %s smoke seed with no rejected strategy action", (template, seed) => {
        const result = playV07SelfplayPassiveAuditGame({ template, game: 0, seed, maxLaps: 3 });

        expect(result.tally.integrity.rejectedActions).toBe(0);
        expect(result.tally.integrity.recoveryTurns).toBe(0);
    });
});
