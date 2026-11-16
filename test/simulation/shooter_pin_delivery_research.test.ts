import { afterEach, expect, test } from "bun:test";
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
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { selectShooterPinDelivery } from "../../src/simulation/shooter_pin_delivery_research";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

afterEach(() => setDeterministicRandomSource(undefined));
function fixture(width = 1, height = 1, caster = false) {
    const c = createCombatTestContext();
    const fp = FightStateManager.getInstance().getFightProperties();
    const actor = createTestUnit({
        name: "Angel",
        team: PBTypes.TeamVals.LEFT,
        movementType: PBTypes.MovementVals.FLY,
        amountAlive: 20,
        maxHp: 1000,
        footprintWidth: width,
        footprintHeight: height,
    });
    Object.assign(actor.getUnitProperties(), { steps: 6 });
    const screen = createTestUnit({ name: "Squire", team: PBTypes.TeamVals.RIGHT, maxHp: 10000 });
    const shooter = createTestUnit({
        name: caster ? "Battle Mage" : "Elf",
        team: PBTypes.TeamVals.RIGHT,
        attackType: caster ? PBTypes.AttackVals.MELEE_MAGIC : PBTypes.AttackVals.RANGE,
        rangeShots: caster ? 0 : 20,
        amountAlive: 20,
        maxHp: 1000,
        spells: caster ? ["Chaos:Fire Strike"] : [],
    });
    placeUnit(c.grid, c.unitsHolder, actor, { x: 7, y: 5 });
    placeUnit(c.grid, c.unitsHolder, screen, { x: 9, y: 6 });
    placeUnit(c.grid, c.unitsHolder, shooter, { x: 10, y: 8 });
    fp.startFight();
    fp.setTeamUnitsAlive(PBTypes.TeamVals.LEFT, 1);
    fp.setTeamUnitsAlive(PBTypes.TeamVals.RIGHT, 2);
    fp.startTurn(PBTypes.TeamVals.LEFT, 1000);
    const context: IDecisionContext = {
        ...c,
        fightProperties: fp,
        decisionOrigin: "root",
        matrix: c.grid.getMatrix(),
        pathHelper: new PathHelper(c.grid.getSettings()),
    };
    const incumbent = [{ type: "wait_turn" as const, unitId: actor.getId() }];
    const candidates = enumerateCandidates(actor, context, incumbent, { maxMeleePairs: 0 }).candidates.filter(
        (c) => c.kind === "melee" && c.targetId === screen.getId() && c.actions.some((a) => a.type === "move_unit"),
    );
    const ordinary = candidates.find((c) => c.standCell?.x === 8 && c.standCell.y === 5)!;
    expect(ordinary).toBeDefined();
    const engine = new GameActionEngine({
        ...c,
        fightProperties: fp,
        sceneLog: new SceneLogMock(),
        moveHandler: new MoveHandler(c.grid.getSettings(), c.grid, c.unitsHolder),
        getCurrentActiveUnitId: () => actor.getId(),
        canLandRangeAttack: (u) => c.attackHandler.canLandRangeAttack(u, c.grid.getEnemyAggrMatrixByUnitId(u.getId())),
    });
    return { ...c, actor, screen, shooter, fp, context, candidates, ordinary, engine };
}

test("a same-target move-and-strike really pins an additional shooter, for rectangular footprints too", () => {
    for (const [width, height] of [
        [1, 1],
        [2, 1],
        [1, 2],
        [2, 2],
    ]) {
        const f = fixture(width, height);
        const before = JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fp));
        let draws = 0;
        setDeterministicRandomSource(() => {
            draws++;
            return 0.5;
        });
        const selected = selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary]);
        expect(selected).toBeDefined();
        expect(selected!.baselinePinWeight).toBe(0);
        expect(selected!.pinWeight).toBeGreaterThan(0);
        expect(selected!.shooterIds).toEqual([f.shooter.getId()]);
        expect(selected!.candidate.targetId).toBe(f.screen.getId());
        expect(selected!.candidate.features.expectedDamage).toBe(f.ordinary.features.expectedDamage);
        expect(JSON.stringify(snapshotBattle(f.unitsHolder, f.grid, f.fp))).toBe(before);
        expect(draws).toBe(0);
        expect(
            f.attackHandler.canLandRangeAttack(f.shooter, f.grid.getEnemyAggrMatrixByUnitId(f.shooter.getId())),
        ).toBe(true);
        for (const action of selected!.candidate.actions) expect(f.engine.apply(action).completed).toBe(true);
        expect(
            f.attackHandler.canLandRangeAttack(f.shooter, f.grid.getEnemyAggrMatrixByUnitId(f.shooter.getId())),
        ).toBe(false);
        setDeterministicRandomSource(undefined);
    }
});

test("spell output alone is not credited as contact suppression", () => {
    const f = fixture(1, 1, true);
    expect(f.shooter.getSpells().length).toBeGreaterThan(0);
    expect(selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])).toBeUndefined();
});

test("retained delivery, spent turns, exhausted ammo, hidden targets and native rollout keep ordinary choices", () => {
    const f = fixture();
    const selected = selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])!;
    expect(
        selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary, selected.candidate]),
    ).toBeUndefined();
    expect(
        selectShooterPinDelivery(f.actor, { ...f.context, decisionOrigin: "rollout" }, f.candidates, [f.ordinary]),
    ).toBeUndefined();
    const oldActed = f.fp.hasAlreadyMadeTurn;
    f.fp.hasAlreadyMadeTurn = (id) => id === f.shooter.getId();
    expect(selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])).toBeUndefined();
    f.fp.hasAlreadyMadeTurn = oldActed;
    const oldShots = f.shooter.getRangeShots;
    f.shooter.getRangeShots = () => 0;
    expect(selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])).toBeUndefined();
    f.shooter.getRangeShots = oldShots;
    const oldAbility = f.shooter.hasAbilityActive.bind(f.shooter);
    f.shooter.hasAbilityActive = (name) => name === "Hidden" || oldAbility(name);
    expect(selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])).toBeUndefined();
});

test("does not exchange the original attack class for a weaker hit or different target", () => {
    const f = fixture();
    const selected = selectShooterPinDelivery(f.actor, f.context, f.candidates, [f.ordinary])!;
    for (const field of ["expectedDamage", "expectedKill"] as const) {
        const changed = {
            ...f.ordinary,
            features: { ...f.ordinary.features, [field]: f.ordinary.features[field] + 1 },
        };
        expect(selectShooterPinDelivery(f.actor, f.context, [selected.candidate], [changed])).toBeUndefined();
    }
    const changed = {
        ...f.ordinary,
        actions: f.ordinary.actions.map((a) => (a.type === "melee_attack" ? { ...a, targetId: "different" } : a)),
    };
    expect(selectShooterPinDelivery(f.actor, f.context, [selected.candidate], [changed])).toBeUndefined();
});

test("the helper is unreachable from serving entry points", () => {
    const root = resolve(import.meta.dir, "../..");
    const forbidden = resolve(root, "src/simulation/shooter_pin_delivery_research.ts");
    const pending = [resolve(root, "src/index.ts"), resolve(root, "src/simulation/battle_engine.ts")];
    const seen = new Set<string>(),
        scanner = new Bun.Transpiler({ loader: "ts" });
    while (pending.length) {
        const file = pending.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        expect(file).not.toBe(forbidden);
        if (extname(file) === ".json") continue;
        for (const dep of scanner.scanImports(readFileSync(file, "utf8"))) {
            if (!dep.path.startsWith(".")) continue;
            const base = resolve(dirname(file), dep.path);
            const target = [
                base,
                `${base}.ts`,
                `${base}.tsx`,
                `${base}.js`,
                `${base}.json`,
                resolve(base, "index.ts"),
            ].find((p) => existsSync(p) && statSync(p).isFile());
            expect(target).toBeDefined();
            pending.push(target!);
        }
    }
    expect(seen.size).toBeGreaterThan(100);
});
