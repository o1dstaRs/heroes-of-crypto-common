import { describe, expect, it } from "bun:test";

import {
    CHAKRAM_HALF_DAMAGE_FACTOR,
    chakramClockwiseSweep,
    chakramHopDistance,
    chakramMaxTargets,
    chakramSeparation,
    resolveChakramFlightMisses,
    resolveChakramTrajectory,
} from "../../src/abilities/chakram_ability";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

const GREEN = PBTypes.TeamVals.LEFT;
const RED = PBTypes.TeamVals.RIGHT;

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

    it("never bounces past a neighbour standing in the way — a shoulder-to-shoulder row", () => {
        // A B C on one row. A and C measure two apart, which LOOKS like a 1-cell gap, but the cell
        // between them is B. The disc used to curve around B through the empty cell beside it; a filled
        // space is not a gap, whichever way you walk around it.
        const context = setup(5);
        const a = enemy(context, "A", { x: 5, y: 8 });
        enemy(context, "B", { x: 6, y: 8 });
        enemy(context, "C", { x: 7, y: 8 });

        const trajectory = resolveChakramTrajectory(context.zena, a, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits).toEqual([]);
    });

    it("never bounces past a neighbour standing in the way — a diagonal stair", () => {
        const context = setup(5);
        const a = enemy(context, "A", { x: 5, y: 9 });
        enemy(context, "B", { x: 6, y: 8 });
        enemy(context, "C", { x: 7, y: 7 });

        const trajectory = resolveChakramTrajectory(context.zena, a, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits).toEqual([]);
    });

    it("still bounces along a row once the middle body steps aside", () => {
        // Same A and C, no B: now the cell between them really is open air.
        const context = setup(5);
        const a = enemy(context, "A", { x: 5, y: 8 });
        const c = enemy(context, "C", { x: 7, y: 8 });

        const trajectory = resolveChakramTrajectory(context.zena, a, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["C"]);
        expect(trajectory.damageFactorByUnitId[c.getId()]).toBe(1);
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

    it("stops after a half-damage bounce, however many enemies wait beyond it", () => {
        const context = setup(5); // room for four bounces, so only the rule can end this flight
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const wide = enemy(context, "Wide", { x: 11, y: 11 }); // gap 2 from the primary — the long stretch
        enemy(context, "Beyond", { x: 13, y: 13 }); // gap 1 from Wide: a perfectly good onward bounce

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        // The disc spent itself crossing two empty cells: it strikes Wide at half and goes home.
        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["Wide"]);
        expect(trajectory.damageFactorByUnitId[wide.getId()]).toBe(CHAKRAM_HALF_DAMAGE_FACTOR);
        expect(trajectory.steps).toHaveLength(1);
    });

    it("keeps relaying through 1-cell bounces, which cost it nothing", () => {
        const context = setup(5);
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        enemy(context, "First", { x: 10, y: 10 }); // gap 1
        enemy(context, "Second", { x: 12, y: 12 }); // gap 1 from First

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["First", "Second"]);
        expect(Object.values(trajectory.damageFactorByUnitId)).toEqual([1, 1]);
    });

    it("takes the nearest bounce first and hits each victim exactly once", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        // Both qualify from the primary; the 1-gap one must be taken before the 2-gap one.
        const nearer = enemy(context, "Nearer", { x: 6, y: 8 }); // gap 1
        const onward = enemy(context, "Onward", { x: 4, y: 7 }); // gap 1 from Nearer — the chain continues

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const names = trajectory.hitUnits.map((u) => u.getName());

        expect(names).toEqual(["Nearer", "Onward"]);
        expect(new Set(names).size).toBe(names.length); // once at most, each
        expect(trajectory.damageFactorByUnitId[nearer.getId()]).toBe(1);
        expect(trajectory.damageFactorByUnitId[onward.getId()]).toBe(1);
    });

    it("never doubles back across ground it has already flown", () => {
        // The zigzag this kills: Left and Right both sit within reach of the PRIMARY, on opposite sides.
        // Reckoning from the whole struck set, the disc used to fan out to Left and then cut back through
        // the primary's cell to reach Right — re-appearing at a point it had already passed. The disc has
        // ONE position: after Left it can only continue from Left, and Right is 5 cells away, so the
        // flight ends there and comes home.
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const left = enemy(context, "Left", { x: 6, y: 8 }); // gap 1 from primary
        const right = enemy(context, "Right", { x: 11, y: 8 }); // gap 2 from primary, but gap 4 from Left

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        // Zena throws north, so sweeping clockwise reaches Right (90 degrees round) before Left (270).
        // Right is the FARTHER of the two — a half-damage 2-cell gap against Left's full-damage 1-cell
        // gap — which is the clockwise rule doing its job: bearing picks the target, distance only says
        // whether it is in reach at all and what the bounce is worth.
        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["Right"]);
        // Struck at HALF, because it is the 2-cell gap — and Left, the full-damage neighbour, is skipped.
        expect(trajectory.damageFactorByUnitId[right.getId()]).toBe(CHAKRAM_HALF_DAMAGE_FACTOR);
        expect(left.getId() in trajectory.damageFactorByUnitId).toBe(false);
        // One hop either way: from Right, Left is 5 cells off and out of reach, so the disc comes home
        // rather than flying back over the primary's cell.
        expect(trajectory.steps).toHaveLength(1);
        expect(trajectory.steps[0].fromCell).toEqual(primary.getBaseCell());
    });

    it("each hop launches from the previous victim, so the path is unbroken end to end", () => {
        // A genuine chain: every link is in reach of the one before it, so the disc traces a single
        // forward-only run. Each hop must start exactly where the previous hop landed.
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 4 });
        const first = enemy(context, "First", { x: 8, y: 6 });
        const second = enemy(context, "Second", { x: 8, y: 8 });
        const third = enemy(context, "Third", { x: 8, y: 10 });

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["First", "Second", "Third"]);
        const launchedFrom = trajectory.steps.map((step) => step.fromCell);
        expect(launchedFrom).toEqual([primary.getBaseCell(), first.getBaseCell(), second.getBaseCell()]);
        // Every hop starts where the previous one ended: no gaps, no jumps back.
        const landedOn = [primary, first, second, third].map((u) => u.getBaseCell());
        trajectory.steps.forEach((step, index) => {
            expect(step.fromCell).toEqual(landedOn[index]);
            expect(step.circleCells.at(-1)).toEqual(landedOn[index + 1]);
        });
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
        const angel = createTestUnit({ name: "Angel", team: RED, abilities: ["Arrows Wingshield Blessing"] });
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
    it("chooses between two equal gaps by bearing, not by which one lies straight ahead", () => {
        // Both stand one cell from the primary, so separation cannot choose. Zena throws north: the
        // diagonal sits 45 degrees clockwise round, the straight one 90, so the diagonal is taken.
        // Repeated because unit ids are generated — if identity were still deciding this, the run would
        // disagree with itself long before the last trial.
        const TRIALS = 24;
        const winners = new Set<string>();

        for (let trial = 0; trial < TRIALS; trial += 1) {
            const context = setup(2); // stack power 2 -> primary + exactly ONE bounce
            const primary = enemy(context, "Primary", { x: 8, y: 8 });
            const straight = enemy(context, "Straight", { x: 10, y: 8 });
            const diagonal = enemy(context, "Diagonal", { x: 10, y: 10 });

            expect(chakramSeparation(primary, straight)).toBe(chakramSeparation(primary, diagonal));

            const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
            expect(trajectory.hitUnits).toHaveLength(1);
            winners.add(trajectory.hitUnits[0]!.getName());
        }

        expect([...winners]).toEqual(["Diagonal"]);
    });

    it("ranks a one-cell diagonal gap as nearer than a two-cell straight one", () => {
        // Chebyshev keeps the ordering meaningful: equal gaps tie, but a genuinely closer unit still wins.
        expect(chakramHopDistance({ x: 8, y: 8 }, { x: 10, y: 10 })).toBeLessThan(
            chakramHopDistance({ x: 8, y: 8 }, { x: 11, y: 8 }),
        );
    });
});

/**
 * The disc curves. Of the enemies in reach it takes whichever it meets first sweeping CLOCKWISE from the
 * direction it is already travelling — not whichever happens to be nearest, and nothing is rolled.
 */
describe("Zena's Chakram — the flight sweeps clockwise", () => {
    it("measures a clockwise turn from the heading, with straight ahead costing nothing", () => {
        const EAST = 0;
        const NORTH = Math.PI / 2;
        const SOUTH = -Math.PI / 2;
        const WEST = Math.PI;

        // Travelling east: straight on is no turn, south is a quarter turn clockwise, north is three.
        expect(chakramClockwiseSweep(EAST, EAST)).toBeCloseTo(0, 10);
        expect(chakramClockwiseSweep(EAST, SOUTH)).toBeCloseTo(Math.PI / 2, 10);
        expect(chakramClockwiseSweep(EAST, WEST)).toBeCloseTo(Math.PI, 10);
        expect(chakramClockwiseSweep(EAST, NORTH)).toBeCloseTo((3 * Math.PI) / 2, 10);
    });

    it("always reports a turn in [0, 2pi), whichever way the angles wrap", () => {
        for (const heading of [-Math.PI, -1, 0, 1, Math.PI, 3]) {
            for (const bearing of [-Math.PI, -2, 0, 2, Math.PI, 3]) {
                const sweep = chakramClockwiseSweep(heading, bearing);
                expect(sweep >= 0 && sweep < 2 * Math.PI).toBe(true);
            }
        }
    });

    /**
     * Zena throws NORTH. Two enemies sit one cell either side of the primary, both equally reachable and
     * both exactly as near — so distance cannot choose between them and the old nearest-first rule fell
     * through to unit id. Sweeping clockwise from a northward heading reaches EAST first.
     */
    it("takes the clockwise neighbour when two are equally close", () => {
        const context = setup(2); // primary + exactly one bounce
        const primary = enemy(context, "Primary", { x: 8, y: 8 }); // Zena is at (8,2): heading is north
        const east = enemy(context, "East", { x: 10, y: 8 });
        const west = enemy(context, "West", { x: 6, y: 8 });

        expect(chakramSeparation(primary, east)).toBe(chakramSeparation(primary, west));

        const trajectory = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        expect(trajectory.hitUnits.map((u) => u.getName())).toEqual(["East"]);
    });

    it("keeps turning the same way across several bounces", () => {
        const context = setup(5); // room for four bounces
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        // A ring around the primary, each two cells out so every one is a legal 1-gap bounce.
        enemy(context, "East", { x: 10, y: 8 });
        enemy(context, "South", { x: 8, y: 6 });
        enemy(context, "West", { x: 6, y: 8 });

        const flight = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const order = flight.hitUnits.map((u) => u.getName());

        // Never the counter-clockwise neighbour before the clockwise one.
        expect(order.indexOf("West")).toBeGreaterThan(order.indexOf("East"));
    });

    it("is still deterministic: two computations agree hop for hop", () => {
        const context = setup(5);
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        enemy(context, "A", { x: 10, y: 8 });
        enemy(context, "B", { x: 8, y: 6 });
        enemy(context, "C", { x: 6, y: 8 });

        const one = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        const two = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        expect(one.hitUnits.map((u) => u.getName())).toEqual(two.hitUnits.map((u) => u.getName()));
    });
});

describe("Zena's Chakram — a dodge ends the flight", () => {
    it("does not bounce at all when the throw itself is dodged", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        enemy(context, "Bounce", { x: 10, y: 10 });
        const planned = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        expect(planned.hitUnits.map((u) => u.getName())).toEqual(["Bounce"]);

        const outcome = resolveChakramFlightMisses(planned, primary, true, () => false);

        // Nothing was struck, so there is nothing for the disc to ricochet off.
        expect(outcome.trajectory.hitUnits).toEqual([]);
        expect(outcome.trajectory.steps).toEqual([]);
        // Only the primary is accounted for — the bounce was never even rolled for.
        expect(outcome.missByUnitId).toEqual({ [primary.getId()]: true });
    });

    it("stops at the victim that dodges and never reaches the one behind it", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const first = enemy(context, "First", { x: 10, y: 10 });
        const second = enemy(context, "Second", { x: 12, y: 12 });
        const planned = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);
        expect(planned.hitUnits.map((u) => u.getName())).toEqual(["First", "Second"]);

        const rolledFor: string[] = [];
        const outcome = resolveChakramFlightMisses(planned, primary, false, (victim) => {
            rolledFor.push(victim.getName());
            return victim.getId() === first.getId();
        });

        // The dodging victim keeps its own hop — the disc visibly flies at it and is dodged — and stays
        // among the affected units so the client has something to pop MISS over.
        expect(outcome.trajectory.hitUnits.map((u) => u.getName())).toEqual(["First"]);
        expect(outcome.trajectory.steps).toHaveLength(1);
        // The enemy behind is never rolled for, because the disc never got there.
        expect(rolledFor).toEqual(["First"]);
        expect(second.getId() in outcome.missByUnitId).toBe(false);
    });

    it("flies the whole planned flight when nothing dodges", () => {
        const context = setup();
        const primary = enemy(context, "Primary", { x: 8, y: 8 });
        const first = enemy(context, "First", { x: 10, y: 10 });
        const second = enemy(context, "Second", { x: 12, y: 12 });
        const planned = resolveChakramTrajectory(context.zena, primary, context.unitsHolder, context.grid);

        const outcome = resolveChakramFlightMisses(planned, primary, false, () => false);

        expect(outcome.trajectory.hitUnits.map((u) => u.getName())).toEqual(["First", "Second"]);
        expect(outcome.trajectory.steps).toHaveLength(planned.steps.length);
        expect(outcome.trajectory.damageFactorByUnitId).toEqual(planned.damageFactorByUnitId);
        // Every reached unit carries a verdict, so the damage tail never rolls a second time for any of them.
        expect(outcome.missByUnitId).toEqual({
            [primary.getId()]: false,
            [first.getId()]: false,
            [second.getId()]: false,
        });
    });
});

describe("Zena's Chakram — the engine stops the disc on a dodge", () => {
    /** A throwing Zena plus the enemies her disc would chain through, in flight order. */
    function engineSetup() {
        const context = createCombatTestContext();
        const zena = createTestUnit({
            name: "Zena",
            team: GREEN,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 8,
            abilities: ["Chakram"],
            stackPower: 5,
            amountAlive: 1,
        });
        zena.calculateAttackDamage = () => 10;
        placeUnit(context.grid, context.unitsHolder, zena, { x: 8, y: 2 });
        const victims = (["Primary", "First", "Second"] as const).map((name, index) => {
            const unit = createTestUnit({ name, team: RED, amountAlive: 3, maxHp: 100 });
            placeUnit(context.grid, context.unitsHolder, unit, { x: 8 + index * 2, y: 8 + index * 2 });
            return unit;
        });
        const [primary] = victims;
        return { ...context, zena, primary, victims };
    }

    /** Throw the disc, dodged by exactly the named victims. */
    function throwChakram(context: ReturnType<typeof engineSetup>, dodgedNames: string[]) {
        context.zena.calculateMissChance = (enemyUnit) => (dodgedNames.includes(enemyUnit.getName()) ? 100 : 0);
        const damageForAnimation = createVisibleDamage(context.primary);
        // getRandomInt(0, 100) -> 0, so a unit misses exactly when its miss chance is above zero.
        setDeterministicRandomSource(() => 0);
        try {
            const result = context.attackHandler.handleRangeAttack(
                context.unitsHolder,
                [1],
                1,
                damageForAnimation,
                context.zena,
                [[context.primary]],
                undefined,
                context.primary.getPosition(),
            );
            expect(result.completed).toBe(true);
        } finally {
            setDeterministicRandomSource(undefined);
        }
        return { damageForAnimation, hurt: context.victims.filter((u) => u.getCumulativeHp() < 300) };
    }

    it("damages the whole chain when nothing dodges", () => {
        const context = engineSetup();

        const { hurt, damageForAnimation } = throwChakram(context, []);

        expect(hurt.map((u) => u.getName())).toEqual(["Primary", "First", "Second"]);
        expect(damageForAnimation.chakramArcs).toHaveLength(2);
    });

    it("never bounces off a primary that dodged the throw", () => {
        const context = engineSetup();

        const { hurt, damageForAnimation } = throwChakram(context, ["Primary"]);

        expect(hurt).toEqual([]);
        expect(damageForAnimation.chakramArcs ?? []).toEqual([]);
    });

    it("drops the rest of the chain once a bounce is dodged", () => {
        const context = engineSetup();

        const { hurt, damageForAnimation } = throwChakram(context, ["First"]);

        // The disc reached First and was dodged, so Second was never in its path at all.
        expect(hurt.map((u) => u.getName())).toEqual(["Primary"]);
        // The dodged hop is still flown and still reported, so the client pops MISS over First.
        expect(damageForAnimation.chakramArcs).toHaveLength(1);
        expect(damageForAnimation.splash).toContainEqual(
            expect.objectContaining({ unitId: context.victims[1].getId(), amount: 0, missed: true }),
        );
    });
});
