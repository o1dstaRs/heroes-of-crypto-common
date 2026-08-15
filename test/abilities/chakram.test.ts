import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_HALF_DAMAGE_FACTOR,
    chakramHopDistance,
    chakramMaxTargets,
    chakramSeparation,
    resolveChakramTrajectory,
} from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LOWER;
const RED = PBTypes.TeamVals.UPPER;

function setup(stackPower = 5) {
    const context = createCombatTestContext();
    const zena = createTestUnit({ name: "Zena", team: GREEN, abilities: ["Chakram"], stackPower });
    placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
    return { ...context, zena };
}

function enemy(context: ReturnType<typeof setup>, name: string, cell: { x: number; y: number }) {
    const unit = createTestUnit({ name, team: RED });
    placeUnit(context.grid, context.unitsHolder, unit, cell);
    return unit;
}

describe("Zena's Chakram — separation chain", () => {
    it("never bounces through occupied gaps: a solid block yields the primary hit only", () => {
        // The live report that pinned this: a shoulder-to-shoulder army with "no single hole". Diagonal
        // neighbours-of-neighbours measure two apart — the GEOMETRY of a gap — but every separating cell
        // holds a body, and the disc cannot cut through a wall.
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        enemy(context, "WallA", { x: 9, y: 9 }); // diagonal-adjacent to the primary
        const behindWall = enemy(context, "BehindWall", { x: 10, y: 10 }); // sep 2 from primary, gap filled by WallA

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits).toEqual([]);
        expect(behindWall.getId() in trajectory.damageFactorByUnitId).toBe(false);
    });

    it("bounces again once the blocking body is gone — same geometry, open air", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const reachable = enemy(context, "Reachable", { x: 10, y: 10 }); // sep 2, bridge (9,9) EMPTY

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["Reachable"]);
        expect(trajectory.damageFactorByUnitId[reachable.getId()]).toBe(1);
    });

    it("an ally's body blocks the gap exactly like an enemy's", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const ally = createTestUnit({ name: "Ally", team: GREEN });
        placeUnit(context.grid, context.unitsHolder, ally, { x: 9, y: 9 });
        enemy(context, "BehindAllyWall", { x: 10, y: 10 });

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits).toEqual([]);
    });

    it("a walled-off half-damage bounce is blocked too", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        // A vertical wall hugging the primary's right side seals every 2-cell chain toward the far target.
        enemy(context, "WallTop", { x: 9, y: 9 });
        enemy(context, "WallMid", { x: 9, y: 8 });
        enemy(context, "WallBot", { x: 9, y: 7 });
        enemy(context, "FarBehindWall", { x: 11, y: 8 }); // sep 3 from primary — gap 2, fully sealed

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        // The wall units touch the struck primary (never bounced to), and the far target has no open bridge.
        expect(trajectory.hitUnits).toEqual([]);
    });

    it("caps total targets at stack power from one through five", () => {
        for (let stackPower = 1; stackPower <= 5; stackPower += 1) {
            const context = setup(stackPower);
            const primary = enemy(context, "Primary", { x: 8, y: 4 });
            for (let index = 1; index <= 5; index += 1) {
                enemy(context, `Bounce ${index}`, { x: 8, y: 4 + index * 2 });
            }

            const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

            expect(chakramMaxTargets(context.zena.getStackPower())).toBe(stackPower);
            expect(trajectory.hitUnits).toHaveLength(stackPower - 1);
            expect(1 + trajectory.hitUnits.length).toBe(stackPower);
        }
    });

    it("automatically prints the live total-target limit on the ability card", () => {
        for (let stackPower = 1; stackPower <= 5; stackPower += 1) {
            const context = setup(stackPower);
            context.zena.adjustBaseStats(false, 1, 0, 0, 0, 0, 0);
            const properties = context.zena.getUnitProperties();
            const chakramIndex = properties.abilities.indexOf("Chakram");
            const description = properties.abilities_descriptions[chakramIndex];

            expect(description).toContain(`Maximum targets: ${stackPower}.`);
            expect(description).not.toContain("{}");
        }
    });

    it("prints the holder's current limit when Chakram is granted at runtime", () => {
        const holder = createTestUnit({ name: "Borrower", team: GREEN, stackPower: 3 });

        holder.grantAbility("Chakram");

        const properties = holder.getUnitProperties();
        const chakramIndex = properties.abilities.indexOf("Chakram");
        expect(properties.abilities_descriptions[chakramIndex]).toContain("Maximum targets: 3.");
    });

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

/**
 * One cell in between is one cell in between, whichever way it lies. A straight gap, a knight-style
 * offset and a pure diagonal are the SAME reach for the disc — they differ only in how the eye reads
 * them on the board.
 */
describe("Zena's Chakram — one cell in between reads the same in every direction", () => {
    // Offsets from a unit, each leaving exactly one empty cell between the two footprints.
    const ONE_CELL_BETWEEN: ReadonlyArray<readonly [string, number, number]> = [
        ["straight", 2, 0],
        ["knight-offset", 1, 2],
        ["knight-offset mirrored", 2, 1],
        ["pure diagonal", 2, 2],
    ];

    it("ranks every one-cell gap as the same hop distance", () => {
        const origin = { x: 8, y: 8 };
        for (const [label, dx, dy] of ONE_CELL_BETWEEN) {
            const hop = chakramHopDistance(origin, { x: origin.x + dx, y: origin.y + dy });
            expect(`${label}: ${hop}`).toBe(`${label}: 2`);
        }
    });

    it("separates the same in every direction, so each keeps FULL bounce damage", () => {
        for (const [label, dx, dy] of ONE_CELL_BETWEEN) {
            const context = setup();
            const primary = enemy(context, "Primary", { x: 8, y: 8 });
            const neighbour = enemy(context, "Neighbour", { x: 8 + dx, y: 8 + dy });

            expect(`${label}: ${chakramSeparation(primary, neighbour)}`).toBe(`${label}: 2`);

            const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
            expect(`${label}: ${trajectory.hitUnits.map((u) => u.getName()).join(",")}`).toBe(`${label}: Neighbour`);
            expect(`${label}: ${trajectory.damageFactorByUnitId[neighbour.getId()]}`).toBe(`${label}: 1`);
        }
    });

    // The regression this guards: the hop tie-break used to be SQUARED EUCLIDEAN, which scores the same
    // three gaps 4 / 5 / 8. With only one bounce left the disc always took the straight gap and the
    // diagonal neighbour was passed over, even though both stand one cell away.
    //
    // Unit ids are generated, so a SINGLE trial cannot tell the two rules apart: under the old rule the
    // straight unit always won, and it happened to hold the lower id about half the time. Repeating the
    // scenario with fresh ids does separate them — under the fix the lower id wins EVERY time, under the
    // old rule it wins only when geometry and id agree, so the run fails long before the last trial.
    it("does not spend its last bounce on the straight gap in preference to the diagonal one", () => {
        const TRIALS = 24;
        const winners: string[] = [];

        for (let trial = 0; trial < TRIALS; trial += 1) {
            const context = setup(2); // stack power 2 -> primary + exactly ONE bounce
            const primary = enemy(context, "Primary", { x: 8, y: 8 });
            const straight = enemy(context, "Straight", { x: 10, y: 8 }); // squared-euclid 4
            const diagonal = enemy(context, "Diagonal", { x: 10, y: 10 }); // squared-euclid 8

            expect(chakramSeparation(primary, straight)).toBe(chakramSeparation(primary, diagonal));

            const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
            expect(trajectory.hitUnits).toHaveLength(1);

            const lowerId = [straight, diagonal].sort((a, b) => (a.getId() < b.getId() ? -1 : 1))[0];
            winners.push(trajectory.hitUnits[0]?.getId() === lowerId.getId() ? "id" : "geometry");
        }

        // Every hop settled on identity, never on which way the gap happened to lie.
        expect(winners.filter((w) => w === "geometry")).toEqual([]);
    });

    it("ranks a one-cell diagonal gap as nearer than a two-cell straight one", () => {
        // Chebyshev keeps the ordering meaningful: equal gaps tie, but a genuinely closer unit still wins.
        expect(chakramHopDistance({ x: 8, y: 8 }, { x: 10, y: 10 })).toBeLessThan(
            chakramHopDistance({ x: 8, y: 8 }, { x: 11, y: 8 }),
        );
    });
});
