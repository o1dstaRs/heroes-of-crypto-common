import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_HALF_DAMAGE_FACTOR,
    chakramSeparation,
    resolveChakramTrajectory,
} from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LOWER;
const RED = PBTypes.TeamVals.UPPER;

function setup() {
    const context = createCombatTestContext();
    const zena = createTestUnit({ name: "Zena", team: GREEN, abilities: ["Chakram"] });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
    return { ...context, zena };
}

function enemy(context: ReturnType<typeof setup>, name: string, cell: { x: number; y: number }) {
    const unit = createTestUnit({ name, team: RED });
    placeUnit(context.grid, context.unitsHolder, unit, cell);
    return unit;
}

describe("Zena's Chakram — separation chain", () => {
    it("bounces only to enemies separated by 1 or 2 empty cells, never to touching ones", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        // Adjacent to the primary (no gap) and 3+ cells from every other unit the disc strikes.
        const touching = enemy(context, "Touching", { x: 8, y: 7 });
        const bounce = enemy(context, "Bounce", { x: 6, y: 11 }); // gap 2 from primary, gap 3 from Touching
        enemy(context, "FarAway", { x: 14, y: 8 }); // gap 3+ from everyone hit
        void primary;

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).toContain("Bounce");
        expect(names).not.toContain("Touching");
        expect(names).not.toContain("FarAway");
        expect(names).not.toContain("Primary"); // the shot itself hit it; the disc never re-hits
        expect(trajectory.damageFactorByUnitId[bounce.getId()]).toBe(CHAKRAM_HALF_DAMAGE_FACTOR);
        expect(touching.getId() in trajectory.damageFactorByUnitId).toBe(false);
    });

    it("halves the bounce onto a target two cells removed and keeps 1-cell bounces at full", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const near = enemy(context, "Near", { x: 8, y: 10 }); // gap 1 from primary
        const far = enemy(context, "Far", { x: 8, y: 13 }); // gap 2 from Near

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["Near", "Far"]);
        expect(trajectory.damageFactorByUnitId[near.getId()]).toBe(1);
        expect(trajectory.damageFactorByUnitId[far.getId()]).toBe(CHAKRAM_HALF_DAMAGE_FACTOR);
    });

    it("visits nearest-first and hits every reachable enemy exactly once", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        // Both qualify from the primary; the 1-gap one must be taken before the 2-gap one.
        const nearer = enemy(context, "Nearer", { x: 6, y: 8 }); // gap 1
        const further = enemy(context, "Further", { x: 11, y: 8 }); // gap 2

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names[0]).toBe("Nearer");
        expect(names).toContain("Further");
        expect(new Set(names).size).toBe(names.length); // once at most, each
        expect(trajectory.damageFactorByUnitId[nearer.getId()]).toBe(1);
        expect(trajectory.damageFactorByUnitId[further.getId()]).toBe(CHAKRAM_HALF_DAMAGE_FACTOR);
    });

    it("never hits allies and never lets them relay the chain", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const ally = createTestUnit({ name: "Ally", team: GREEN });
        placeUnit(context.grid, context.unitsHolder, ally, { x: 8, y: 10 }); // would be a perfect 1-gap bounce
        // Enemy only reachable THROUGH the ally's position (gap 1 from ally, gap 3+ from primary).
        enemy(context, "BehindAlly", { x: 8, y: 13 });

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).not.toContain("Ally");
        expect(names).not.toContain("BehindAlly"); // ally cannot relay the chain
    });

    it("the Arrows Wingshield owner is never struck and stops the chain", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const angel = createTestUnit({ name: "Angel", team: RED, abilities: ["Arrows Wingshield Aura"] });
        placeUnit(context.grid, context.unitsHolder, angel, { x: 8, y: 10 }); // nearest bounce = the shield
        enemy(context, "BehindAngel", { x: 8, y: 12 });
        void angel;

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).toEqual([]); // shield caught the disc before anyone else was reachable
        // The halting hop still flew for the visual, but landed no hit.
        const lastStep = trajectory.steps.at(-1);
        expect(lastStep?.hitUnitIds).toEqual([]);
    });

    it("is deterministic: two computations agree hop for hop", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        enemy(context, "A", { x: 6, y: 8 });
        enemy(context, "B", { x: 10, y: 10 });
        enemy(context, "C", { x: 4, y: 10 });

        const one = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const two = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        expect(one.hitUnits.map((u) => u.getId())).toEqual(two.hitUnits.map((u) => u.getId()));
        expect(one.steps).toEqual(two.steps);
    });

    it("measures separation between footprints, not base cells", () => {
        const context = setup();
        const small = createTestUnit({ name: "Small", team: RED });
        placeUnit(context.grid, context.unitsHolder, small, { x: 4, y: 4 });
        const other = createTestUnit({ name: "Other", team: RED });
        placeUnit(context.grid, context.unitsHolder, other, { x: 6, y: 4 });
        expect(chakramSeparation(small, other)).toBe(2); // one empty column between them
    });
});
