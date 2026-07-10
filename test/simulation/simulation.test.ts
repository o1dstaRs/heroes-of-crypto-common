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

import { AI_VERSIONS, getAIStrategy, LATEST_AI_VERSION } from "../../src/ai";
import type { IDecisionContext } from "../../src/ai";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { AttackHandler } from "../../src/handlers/attack_handler";
import { PathHelper } from "../../src/grid/path_helper";
import { PlacementPositionType } from "../../src/grid/placement_properties";
import { RectanglePlacement } from "../../src/grid/rectangle_placement";
import { buildRoster, creaturesByLevel, DEFAULT_ROSTER_COMPOSITION, makeRng } from "../../src/simulation/army";
import { runMatch } from "../../src/simulation/battle_engine";
import { runTournamentConcurrent } from "../../src/simulation/concurrent_tournament";
import { playGame, runTournament } from "../../src/simulation/tournament";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";

describe("AI strategy registry", () => {
    it("exposes v0.1 as a registered version and rejects unknown ones", () => {
        expect(AI_VERSIONS).toContain("v0.1");
        expect(LATEST_AI_VERSION).toBe(AI_VERSIONS[AI_VERSIONS.length - 1]);
        expect(getAIStrategy("v0.1").version).toBe("v0.1");
        expect(() => getAIStrategy("v9.9")).toThrow();
    });
});

describe("army / roster builder", () => {
    it("has creatures at every level used by the default composition", () => {
        for (const { level } of DEFAULT_ROSTER_COMPOSITION) {
            expect(creaturesByLevel(level).length).toBeGreaterThan(0);
        }
    });

    it("only fields creatures enabled in the game (excludes disabled ones like Faerie Dragon)", () => {
        const enabled = new Set([1, 2, 3, 4].flatMap((l) => creaturesByLevel(l).map((c) => c.creatureName)));
        // Faerie Dragon exists in creatures.json but has no CreatureVals enum id -> must be excluded.
        expect(enabled.has("Faerie Dragon")).toBe(false);
        // Sanity: rosters across many seeds never contain a disabled creature.
        for (let seed = 0; seed < 200; seed += 1) {
            for (const spec of buildRoster(makeRng(seed))) {
                expect(enabled.has(spec.creatureName)).toBe(true);
            }
        }
    });

    it("is deterministic for a given seed and respects the composition", () => {
        const a = buildRoster(makeRng(42));
        const b = buildRoster(makeRng(42));
        expect(a).toEqual(b);

        // 2xL1 + 2xL2 + 1xL3 + 1xL4 = 6 stacks.
        expect(a).toHaveLength(6);
        const byLevel = a.reduce<Record<number, number>>((acc, s) => {
            acc[s.level] = (acc[s.level] ?? 0) + 1;
            return acc;
        }, {});
        expect(byLevel).toEqual({ 1: 2, 2: 2, 3: 1, 4: 1 });

        // A different seed should (almost surely) produce a different roster.
        expect(buildRoster(makeRng(43))).not.toEqual(a);
    });
});

describe("battle engine", () => {
    it("runs a full match to a decisive outcome with both armies deployed", () => {
        const roster = buildRoster(makeRng(123));
        const result = runMatch({ greenVersion: "v0.1", redVersion: "v0.1", roster, seed: 123, maxLaps: 60 });

        expect(["green", "red", "draw"]).toContain(result.winner);
        expect(result.placements.green.length).toBe(roster.length);
        expect(result.placements.red.length).toBe(roster.length);
        expect(result.actions.length).toBeGreaterThan(0);
        expect(result.laps).toBeGreaterThan(0);
        expect(result.outcome.green.version).toBe("v0.1");
        expect(result.outcome.red.version).toBe("v0.1");

        // Placements sit on distinct cells within the board.
        const cells = [...result.placements.green, ...result.placements.red].map((p) => `${p.cell.x}:${p.cell.y}`);
        expect(new Set(cells).size).toBe(cells.length);

        // Every recorded action references a real creature and a known side.
        for (const action of result.actions) {
            expect(["green", "red"]).toContain(action.side);
            expect(action.creatureName.length).toBeGreaterThan(0);
        }
    });
});

describe("AI v0.2 out-of-ammo handling", () => {
    // Force the "cannot land a ranged shot" branch deterministically, independent of fight RNG.
    const cantLandRange = (ctx: ReturnType<typeof createCombatTestContext>): IDecisionContext => ({
        grid: ctx.grid,
        matrix: ctx.grid.getMatrix(),
        unitsHolder: ctx.unitsHolder,
        pathHelper: new PathHelper(testGridSettings),
        attackHandler: { canLandRangeAttack: () => false } as unknown as AttackHandler,
    });

    const setup = (shooterAbilities: string[]) => {
        const ctx = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Shooter",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 3,
            speed: 5,
            abilities: shooterAbilities,
        });
        const enemy = createTestUnit({
            name: "Enemy",
            team: PBTypes.TeamVals.UPPER,
            attackType: PBTypes.AttackVals.MELEE,
            maxHp: 100,
            amountAlive: 1,
        });
        placeUnit(ctx.grid, ctx.unitsHolder, shooter, { x: 5, y: 5 });
        placeUnit(ctx.grid, ctx.unitsHolder, enemy, { x: 8, y: 5 });
        return { ctx, shooter };
    };

    it("never proposes a doomed range attack when the unit cannot land one", () => {
        for (const abilities of [["No Melee"], []]) {
            const { ctx, shooter } = setup(abilities);
            const actions = getAIStrategy("v0.2").decideTurn(shooter, cantLandRange(ctx));
            expect(actions.some((a) => a.type === "range_attack")).toBe(false);
        }
    });

    it("a No-Melee shooter that can't shoot only advances or holds (no melee, no range)", () => {
        const { ctx, shooter } = setup(["No Melee"]);
        const actions = getAIStrategy("v0.2").decideTurn(shooter, cantLandRange(ctx));
        expect(actions.every((a) => a.type === "move_unit" || a.type === "end_turn")).toBe(true);
    });

    it("a melee-capable shooter that can't shoot switches to melee (or advances), never wastes the turn", () => {
        const { ctx, shooter } = setup([]);
        const actions = getAIStrategy("v0.2").decideTurn(shooter, cantLandRange(ctx));
        // Switches to melee (select + strike / move-and-strike) or at least advances toward the enemy.
        expect(actions.some((a) => a.type === "melee_attack" || a.type === "move_unit")).toBe(true);
        if (actions.some((a) => a.type === "melee_attack")) {
            expect(actions.some((a) => a.type === "select_attack_type")).toBe(true);
        }
    });

    it("deploys melee in front, range/casters behind, and the Sniper Arbalester in a back corner", () => {
        const mk = (name: string, type: number, abilities: string[] = []) =>
            createTestUnit({ name, team: PBTypes.TeamVals.LOWER, attackType: type, abilities });
        const arbalester = mk("Arbalester", PBTypes.AttackVals.RANGE, ["Sniper"]);
        const beholder = mk("Beholder", PBTypes.AttackVals.RANGE);
        const crusader = mk("Crusader", PBTypes.AttackVals.MELEE);
        const pikeman = mk("Pikeman", PBTypes.AttackVals.MELEE);
        const healer = mk("Healer", PBTypes.AttackVals.MAGIC);
        const satyr = mk("Satyr", PBTypes.AttackVals.MAGIC);
        const units = [arbalester, beholder, crusader, pikeman, healer, satyr];

        const zone = new RectanglePlacement(testGridSettings, PlacementPositionType.LOWER_LEFT, 3);
        const placed = getAIStrategy("v0.2").placeArmy(units, {
            team: PBTypes.TeamVals.LOWER,
            grid: undefined as never,
            unitsHolder: undefined as never,
            pathHelper: undefined as never,
            placement: zone,
        });

        // LOWER team: frontness == y (higher = closer to the enemy).
        const cellOf = (u: typeof arbalester) => placed.get(u.getId())!;
        const front = (u: typeof arbalester) => cellOf(u).y;
        for (const u of units) {
            expect(placed.has(u.getId())).toBe(true);
        }
        // Melee sit ahead of every backline unit (the wall screens them).
        const meleeFront = Math.min(front(crusader), front(pikeman));
        const backFront = Math.max(front(beholder), front(healer), front(satyr), front(arbalester));
        expect(meleeFront).toBeGreaterThan(backFront);
        // Arbalester is on the back row AND tucked to an edge (a corner), not in the central cluster.
        expect(front(arbalester)).toBeLessThanOrEqual(backFront);
        const centreX = 7.5; // zone spans x≈1..14 for size-3
        expect(Math.abs(cellOf(arbalester).x - centreX)).toBeGreaterThan(Math.abs(cellOf(healer).x - centreX));
    });

    it("when it CAN shoot, v0.2 fires the best visible edge with an explicit aim (v0.1 sends none)", () => {
        const ctx = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Shooter",
            team: PBTypes.TeamVals.LOWER,
            attackType: PBTypes.AttackVals.RANGE,
            rangeShots: 5,
            shotDistance: 16,
            attack: 20,
            damageMin: 10,
            damageMax: 12,
        });
        // A killable chip target vs a juicier high-HP stack, both in the open and in range.
        const chip = createTestUnit({ name: "Chip", team: PBTypes.TeamVals.UPPER, maxHp: 5, amountAlive: 1 });
        const juicy = createTestUnit({ name: "Juicy", team: PBTypes.TeamVals.UPPER, maxHp: 100, amountAlive: 30 });
        placeUnit(ctx.grid, ctx.unitsHolder, shooter, { x: 5, y: 8 });
        placeUnit(ctx.grid, ctx.unitsHolder, chip, { x: 9, y: 8 });
        placeUnit(ctx.grid, ctx.unitsHolder, juicy, { x: 5, y: 12 });

        const decision: IDecisionContext = {
            grid: ctx.grid,
            matrix: ctx.grid.getMatrix(),
            unitsHolder: ctx.unitsHolder,
            pathHelper: new PathHelper(testGridSettings),
            attackHandler: ctx.attackHandler,
        };
        const actions = getAIStrategy("v0.2").decideTurn(shooter, decision);
        const shot = actions.find((a) => a.type === "range_attack");
        expect(shot).toBeDefined();
        if (shot?.type === "range_attack") {
            // Best-shot always sends the chosen edge (aimCell + aimSide); v0.1 leaves these undefined.
            expect(shot.aimCell).toBeDefined();
            expect(typeof shot.aimSide).toBe("number");
            // The high-HP stack yields far more effective damage than the 5-hp chip, so it's preferred.
            expect(shot.targetId).toBe(juicy.getId());
        }
    });
});

describe("tournament", () => {
    it("tallies every game and invokes the per-game callback", () => {
        const games = 6;
        const records: number[] = [];
        let expectedA = 0;
        let expectedB = 0;
        const summary = runTournament({ versionA: "v0.1", versionB: "v0.1", games, baseSeed: 5, maxLaps: 60 }, (r) => {
            records.push(r.game);
            expect(["green", "red", "draw"]).toContain(r.result.winner);
            if (r.result.winner !== "draw") {
                const winnerEntrant = r.result.winner === "green" ? r.greenEntrant : r.greenEntrant === "a" ? "b" : "a";
                if (winnerEntrant === "a") expectedA += 1;
                else expectedB += 1;
            }
        });

        expect(records).toEqual([0, 1, 2, 3, 4, 5]);
        expect(summary.games).toBe(games);
        expect(summary.a.wins + summary.b.wins + summary.draws).toBe(games);
        expect(summary.a.wins).toBe(expectedA);
        expect(summary.b.wins).toBe(expectedB);
        expect(summary.avgLaps).toBeGreaterThan(0);
        // Sides swap each game, so across the run each version plays green and red.
        expect(Object.values(summary.endReasons).reduce((a, b) => a + b, 0)).toBe(games);
    });

    it("derives each game's side assignment from its index alone (parallel-safe)", () => {
        const options = { versionA: "v0.1", versionB: "v0.2", games: 4, baseSeed: 9, maxLaps: 60 };
        // Even games: A is green; odd games: A is red. Mirrored pairs share a roster.
        expect(playGame(options, 0).greenVersion).toBe("v0.1");
        expect(playGame(options, 1).greenVersion).toBe("v0.2");
        expect(playGame(options, 0).result.roster).toEqual(playGame(options, 1).result.roster);
    });

    it("runs concurrently across worker threads with the same coverage as sequential", async () => {
        const games = 4;
        const options = { versionA: "v0.1", versionB: "v0.2", games, baseSeed: 3, maxLaps: 60 };
        const sequential: ReturnType<typeof playGame>[] = [];
        runTournament(options, (record) => sequential.push(record));
        const concurrent: ReturnType<typeof playGame>[] = [];
        const summary = await runTournamentConcurrent(options, 4, (record) => concurrent.push(record));
        expect(summary.games).toBe(games);
        expect(summary.a.wins + summary.b.wins + summary.draws).toBe(games);
        concurrent.sort((a, b) => a.game - b.game);
        expect(concurrent).toEqual(sequential);
    }, 30000);

    it("runs single-threaded when concurrency <= 1 (delegates to runTournament)", async () => {
        const options = { versionA: "v0.1", versionB: "v0.2", games: 4, baseSeed: 7, maxLaps: 60 };
        const seen: number[] = [];
        const summary = await runTournamentConcurrent(options, 1, (r) => seen.push(r.game));
        expect(summary.games).toBe(4);
        expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    });
});

describe("battle engine determinism (seeded for reproducible measurement)", () => {
    it("reproduces a match exactly from the same seed, and a different seed can diverge", () => {
        const roster = buildRoster(makeRng(123));
        const cfg = (seed: number) => ({ greenVersion: "v0.2", redVersion: "v0.3", roster, seed, maxLaps: 60 });
        const a = runMatch(cfg(4242));
        const b = runMatch(cfg(4242));
        // These are fresh armies with fresh Unit instances. IDs, placements, actions and outcome all reproduce.
        expect(a.actions.some((action) => action.creatureName === "Wolf")).toBe(true); // summoned stack id included
        expect(b).toEqual(a);
        // The seeded source is cleared after each match, so a later default match is unaffected (no throw).
        const c = runMatch(cfg(99));
        expect(["green", "red", "draw"]).toContain(c.winner);
    });
});
