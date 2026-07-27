/*
 * -----------------------------------------------------------------------------
 * An AOE volley that MISSES a unit must report it, not stay silent.
 *
 * Regression guard: processRangeAOEAbility wrote a "misses" line to the engine's own
 * scene log and pushed no perUnitDamage entry. Ranked rebuilds its log from events, so
 * the line never reached it, and with no entry the client had no position to pop MISS
 * over — an Area Throw that missed a dodging Scavenger said nothing at all.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { processRangeAOEAbility } from "../../src/abilities/aoe_range_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, DamageStatisticHolder, placeUnit } from "../helpers/combat";

/** Force every getRandomInt(0, 100) to `roll`, which decides each unit's miss check. */
const forceRoll = (roll: number) => setDeterministicRandomSource(() => roll / 0x100000000);

const runVolley = (missEverything: boolean) => {
    const { grid, unitsHolder } = createCombatTestContext();
    const attacker = createTestUnit({
        name: "Gargantuan",
        team: PBTypes.TeamVals.UPPER,
        abilities: ["Area Throw"],
        attack: 40,
        damageMin: 100,
        damageMax: 100,
        rangeShots: 2,
        stackPower: 5,
    });
    const scavenger = createTestUnit({
        name: "Scavenger",
        team: PBTypes.TeamVals.LOWER,
        maxHp: 10_000,
        abilities: ["Dodge"],
        stackPower: 5,
    });
    const bystander = createTestUnit({
        name: "Bystander",
        team: PBTypes.TeamVals.LOWER,
        maxHp: 10_000,
        abilities: ["Dodge"],
        stackPower: 5,
    });
    placeUnit(grid, unitsHolder, attacker, { x: 1, y: 1 });
    placeUnit(grid, unitsHolder, scavenger, { x: 7, y: 7 });
    placeUnit(grid, unitsHolder, bystander, { x: 7, y: 8 });

    // A roll of 0 is below any miss chance (always miss); 99 is above it (always hit).
    forceRoll(missEverything ? 0 : 99);
    try {
        return processRangeAOEAbility(
            attacker,
            [scavenger, bystander],
            attacker,
            1,
            unitsHolder,
            grid,
            new SceneLogMock(),
            new DamageStatisticHolder(),
            true,
        );
    } finally {
        setDeterministicRandomSource(undefined);
    }
};

describe("AOE volley miss reporting", () => {
    it("reports a dodged unit as a missed entry rather than dropping it", () => {
        const result = runVolley(true);

        // One entry per unit in the blast, each flagged as a miss and carrying no damage.
        expect(result.perUnitDamage).toHaveLength(2);
        for (const entry of result.perUnitDamage) {
            expect(entry.missed).toBe(true);
            expect(entry.amount).toBe(0);
            expect(entry.unitsDied).toBe(0);
            // The renderer pops MISS at this position, so it has to be real.
            expect(Number.isFinite(entry.position.x)).toBe(true);
            expect(Number.isFinite(entry.position.y)).toBe(true);
        }
    });

    it("leaves a landed volley's entries unflagged", () => {
        const result = runVolley(false);

        expect(result.perUnitDamage).toHaveLength(2);
        for (const entry of result.perUnitDamage) {
            expect(entry.missed).toBeUndefined();
            expect(entry.amount).toBeGreaterThan(0);
        }
    });
});
