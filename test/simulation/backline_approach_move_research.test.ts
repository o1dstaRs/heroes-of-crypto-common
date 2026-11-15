import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates } from "../../src/ai/candidates";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import {
    hasBacklineApproachTargetOutput,
    reserveBacklineApproachMove,
    selectBacklineApproachMove,
} from "../../src/simulation/backline_approach_move_research";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));
const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
function fixture(width = 1, height = 1) {
    const c = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({
        name: "Angel",
        team: LEFT,
        movementType: PBTypes.MovementVals.FLY,
        amountAlive: 20,
        maxHp: 100,
        footprintWidth: width,
        footprintHeight: height,
    });
    const blocker = createTestUnit({ name: "Squire", team: RIGHT, maxHp: 1000 });
    const target = createTestUnit({
        name: "Elf",
        team: RIGHT,
        attackType: PBTypes.AttackVals.RANGE,
        rangeShots: 20,
        maxHp: 1000,
    });
    placeUnit(c.grid, c.unitsHolder, actor, { x: 4, y: 6 });
    placeUnit(c.grid, c.unitsHolder, blocker, { x: 10, y: 6 });
    placeUnit(c.grid, c.unitsHolder, target, { x: 4, y: 14 });
    fp.startFight();
    fp.setTeamUnitsAlive(LEFT, 1);
    fp.setTeamUnitsAlive(RIGHT, 2);
    fp.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        ...c,
        fightProperties: fp,
        decisionOrigin: "root",
        matrix: c.grid.getMatrix(),
        pathHelper: new PathHelper(c.grid.getSettings()),
    };
    const incumbent = [{ type: "wait_turn" as const, unitId: actor.getId() }];
    const moves = enumerateCandidates(actor, context, incumbent, { maxMoveDestinations: 0 }).candidates.filter(
        (x) => x.kind === "move",
    );
    const retained = enumerateCandidates(actor, context, incumbent, { maxMoveDestinations: 1 }).candidates.filter(
        (x) => x.kind === "move",
    );
    const engine = new GameActionEngine({
        ...c,
        fightProperties: fp,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(c.grid.getSettings(), c.grid, c.unitsHolder),
        getCurrentActiveUnitId: () => actor.getId(),
        canLandRangeAttack: () => false,
    });
    return { ...c, actor, target, fp, context, incumbent, moves, retained, engine };
}

describe("offline backliner approach moves", () => {
    test("serving entry points cannot reach the experimental helper", () => {
        const root = resolve(import.meta.dir, "../..");
        const forbidden = resolve(root, "src/simulation/backline_approach_move_research.ts");
        const pending = [resolve(root, "src/index.ts"), resolve(root, "src/simulation/battle_engine.ts")];
        const seen = new Set<string>();
        const scanner = new Bun.Transpiler({ loader: "ts" });
        while (pending.length) {
            const file = pending.pop()!;
            if (seen.has(file)) continue;
            seen.add(file);
            expect(file).not.toBe(forbidden);
            if (extname(file) === ".json") continue;
            for (const dependency of scanner.scanImports(readFileSync(file, "utf8"))) {
                if (!dependency.path.startsWith(".")) continue;
                const base = resolve(dirname(file), dependency.path);
                const target = [
                    base,
                    `${base}.ts`,
                    `${base}.tsx`,
                    `${base}.js`,
                    `${base}.json`,
                    resolve(base, "index.ts"),
                ].find((path) => existsSync(path) && statSync(path).isFile());
                expect(target).toBeDefined();
                pending.push(target!);
            }
        }
        expect(seen.size).toBeGreaterThan(100);
    });
    test("uses complete legal footprints without changing state or RNG; the native engine accepts each proposal", () => {
        for (const [w, h] of [
            [1, 1],
            [2, 1],
            [1, 2],
            [2, 2],
        ]) {
            const f = fixture(w, h);
            const before = JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fp));
            let draws = 0;
            setDeterministicRandomSource(() => {
                draws++;
                return 0.5;
            });
            const selected = selectBacklineApproachMove(f.actor, f.context, f.moves, f.retained, f.incumbent);
            expect(selected).toBeDefined();
            expect(selected!.baselineDistance - selected!.selectedDistance).toBeGreaterThanOrEqual(1);
            expect(f.moves).toContain(selected!.candidate);
            expect(JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fp))).toBe(before);
            expect(draws).toBe(0);
            expect(f.engine.apply(selected!.candidate.actions[0]).completed).toBe(true);
            setDeterministicRandomSource(undefined);
        }
    });
    test("an already equally good retained or incumbent move needs no extra choice", () => {
        const f = fixture();
        const s = selectBacklineApproachMove(f.actor, f.context, f.moves, f.retained, f.incumbent)!;
        expect(selectBacklineApproachMove(f.actor, f.context, f.moves, [s.candidate], f.incumbent)).toBeUndefined();
        expect(
            selectBacklineApproachMove(f.actor, f.context, f.moves, f.retained, s.candidate.actions),
        ).toBeUndefined();
    });
    test("does not expand rollout choices, slow walkers, single-body supports, or hidden/exhausted targets", () => {
        for (const mode of ["rollout", "slow", "support", "hidden", "empty", "late"] as const) {
            const f = fixture();
            if (mode === "rollout") f.context.decisionOrigin = "rollout";
            if (mode === "slow") {
                f.actor.canFly = () => false;
                f.actor.getSteps = () => 4;
            }
            if (mode === "support") f.actor.getAmountAlive = () => 1;
            if (mode === "hidden") f.target.hasAbilityActive = (name) => name === "Hidden";
            if (mode === "empty") f.target.getRangeShots = () => 0;
            if (mode === "late") f.fp.getCurrentLap = () => 7;
            expect(selectBacklineApproachMove(f.actor, f.context, f.moves, f.retained, f.incumbent)).toBeUndefined();
        }
    });
    test("damage casters qualify even with melee attack type; empty charges and support spells do not", () => {
        const mage = createTestUnit({
            name: "Battle Mage",
            attackType: PBTypes.AttackVals.MELEE_MAGIC,
            stackPower: 5,
            spells: ["Chaos:Fire Strike"],
        });
        expect(hasBacklineApproachTargetOutput(mage)).toBe(true);
        for (const spell of mage.getSpells()) spell.setAmount(0);
        expect(hasBacklineApproachTargetOutput(mage)).toBe(false);
        const support = createTestUnit({ name: "Healer", spells: ["Life:Heal"], stackPower: 5 });
        expect(hasBacklineApproachTargetOutput(support)).toBe(false);
    });
    test("reserving the proposal keeps the ordinary search count and best challenger", () => {
        const f = fixture();
        const base = f.moves.slice(0, 5),
            extra = f.moves[6];
        const changed = reserveBacklineApproachMove(extra, base);
        expect(changed.length).toBe(base.length);
        expect(changed[0]).toBe(base[0]);
        expect(changed.at(-1)).toBe(extra);
        expect(reserveBacklineApproachMove(extra, changed)).toBe(changed);
        expect(reserveBacklineApproachMove(undefined, base)).toBe(base);
        const one = base.slice(0, 1);
        expect(reserveBacklineApproachMove(extra, one)).toBe(one);
    });
});
