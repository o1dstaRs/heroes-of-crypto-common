import { afterEach, expect, test } from "bun:test";

import { lastFuseDamage } from "../../src/abilities/last_fuse_ability";
import {
    ARTIFACT_POWER,
    ArtifactTier,
    TIER2_ARTIFACT_LIST,
    Tier2Artifact,
    ToTier2Artifact,
    formatArtifactDescription,
    getArtifactProperties,
} from "../../src/artifacts/artifact_properties";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { EffectFactory } from "../../src/effects/effect_factory";
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { TurnEngine } from "../../src/engine/turn_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { MoveHandler, type ISystemMoveResult } from "../../src/handlers/move_handler";
import { LIVE_TIER2_ARTIFACT_IDS } from "../../src/picks/pick_sim";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle, restoreBattle } from "../../src/simulation/battle_snapshot";
import type { Unit } from "../../src/units/unit";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import type { XY } from "../../src/utils/math";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
type PyreEvent = Extract<GameEvent, { type: "pyre_exploded" }>;

afterEach(() => setDeterministicRandomSource(undefined));

function board(eventMode?: "headless") {
    const context = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const add = (name: string, cell: XY, options: TestUnitOptions = {}) => {
        const unit = createTestUnit({
            name,
            team: RIGHT,
            maxHp: 100,
            amountAlive: 1,
            armor: 0,
            magicResist: 0,
            ...options,
        });
        placeUnit(context.grid, context.unitsHolder, unit, cell);
        return unit;
    };
    const arm = (...teams: Array<typeof LEFT | typeof RIGHT>) => {
        for (const team of teams) fight.setArtifactPerTeam(team, 2, Tier2Artifact.LAST_FUSE);
        context.unitsHolder.applyArtifacts(fight);
    };
    const engine = new GameActionEngine({
        fightProperties: fight,
        grid: context.grid,
        unitsHolder: context.unitsHolder,
        attackHandler: context.attackHandler,
        moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
        sceneLog: new SceneLogMock(),
        eventMode,
    });
    const cleanup = (unitIds: string[]) =>
        (engine as unknown as { cleanupDeadUnits(ids: string[]): GameEvent[] }).cleanupDeadUnits(unitIds);
    const turn = () =>
        new TurnEngine({
            fightProperties: fight,
            grid: context.grid,
            unitsHolder: context.unitsHolder,
            moveHandler: new MoveHandler(context.grid.getSettings(), context.grid, context.unitsHolder),
            sceneLog: new SceneLogMock(),
        });
    return { ...context, fight, add, arm, engine, cleanup, turn };
}

function kill(unit: Unit, attacker?: Unit): void {
    unit.applyDamage(unit.getCumulativeHp(), 0, new SceneLogMock(), false, attacker);
}

function pyres(events: GameEvent[]): PyreEvent[] {
    return events.filter((event): event is PyreEvent => event.type === "pyre_exploded");
}

function cluster(eventMode?: "headless") {
    const f = board(eventMode);
    const killer = f.add("Killer", { x: 3, y: 4 }, { team: LEFT, maxHp: 1000 });
    const victim = f.add("Victim", { x: 4, y: 4 }, { amountAlive: 5 });
    const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { maxHp: 1000 });
    f.arm(LEFT);
    return { ...f, killer, victim, neighbor };
}

test("Tier-2 id 17 is draftable and describes enemy kills without friendly damage", () => {
    expect(ToTier2Artifact["17"]).toBe(Tier2Artifact.LAST_FUSE);
    expect(LIVE_TIER2_ARTIFACT_IDS).toContain(Tier2Artifact.LAST_FUSE);
    expect(TIER2_ARTIFACT_LIST.find((artifact) => artifact.id === 17)?.imageKey).toBe("artifact_t2_last_fuse_256");
    expect(lastFuseDamage(500, 1)).toBe(125);
    expect(lastFuseDamage(1, 1)).toBe(25);
    const description = formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.LAST_FUSE));
    expect(description).toContain("Enemy stacks your army destroys");
    expect(description).toContain("25%");
    expect(description).toContain("25 damage per attacker stack power");
    expect(description).toContain("Your allies are not damaged");
    expect(description).not.toMatch(/\{\}|\[\]|<>/);
    expect(getSpellConfig("System", "Last Fuse").name).toBe("Last Fuse");
});

test("equipping Last Fuse grants no Fireforged Sword or stat changes and removing it clears the buff", () => {
    const f = board();
    const ally = f.add("Ally", { x: 2, y: 2 }, { team: LEFT, amountAlive: 4 });
    const enemy = f.add("Enemy", { x: 8, y: 7 });
    const before = [ally.getSteps(), ally.getUnitProperties().attack, ally.getUnitProperties().base_armor];
    f.arm(LEFT);
    f.arm(LEFT);
    expect(ally.getBuffPower("Last Fuse")).toBe(ARTIFACT_POWER.LAST_FUSE_PERCENT);
    expect(ally.getUnitProperties().applied_buffs.filter((name) => name === "Last Fuse")).toHaveLength(1);
    expect(ally.hasBuffActive("Fireforged Sword")).toBe(false);
    expect(enemy.hasBuffActive("Last Fuse")).toBe(false);
    expect([ally.getSteps(), ally.getUnitProperties().attack, ally.getUnitProperties().base_armor]).toEqual(before);
    f.fight.setArtifactPerTeam(LEFT, 2, 0);
    f.unitsHolder.applyArtifacts(f.fight);
    expect(ally.hasBuffActive("Last Fuse")).toBe(false);
});

for (const team of [LEFT, RIGHT]) {
    test(`team ${team} detonates a killed enemy and never damages its own adjacent units`, () => {
        const f = board();
        const other = team === LEFT ? RIGHT : LEFT;
        const killer = f.add("Killer", { x: 3, y: 4 }, { team, maxHp: 500 });
        const ally = f.add("Ally", { x: 4, y: 3 }, { team, maxHp: 500 });
        const victim = f.add("Victim", { x: 4, y: 4 }, { team: other, amountAlive: 5 });
        const diagonal = f.add("Diagonal", { x: 5, y: 5 }, { team: other, maxHp: 500 });
        const far = f.add("Far", { x: 6, y: 4 }, { team: other, maxHp: 500 });
        f.arm(team);
        kill(victim, killer);
        const events = pyres(f.cleanup([victim.getId()]));
        expect(events).toHaveLength(1);
        expect(events[0].unitId).toBe(victim.getId());
        expect(events[0].position).toEqual(victim.getPosition());
        expect(events[0].hits).toEqual([expect.objectContaining({ unitId: diagonal.getId(), amount: 125 })]);
        expect([killer, ally, far].map((unit) => unit.getCumulativeHp())).toEqual([500, 500, 500]);
        expect(diagonal.getCumulativeHp()).toBe(375);
        expect(killer.hasBuffActive("Fireforged Sword")).toBe(false);
    });
}

for (const cause of ["unowned", "environment", "friendly", "self", "nonlethal"] as const) {
    test(`${cause} damage does not trigger Last Fuse`, () => {
        const f = cluster();
        let attacker: Unit | undefined = f.killer;
        if (cause === "unowned") {
            f.fight.setArtifactPerTeam(LEFT, 2, 0);
            f.unitsHolder.applyArtifacts(f.fight);
        } else if (cause === "environment") attacker = undefined;
        else if (cause === "friendly" || cause === "self") {
            f.arm(RIGHT);
            attacker = cause === "self" ? f.victim : f.neighbor;
        }
        f.victim.applyDamage(cause === "nonlethal" ? 1 : 99999, 0, new SceneLogMock(), false, attacker);
        expect(pyres(f.cleanup(cause === "nonlethal" ? [] : [f.victim.getId()]))).toEqual([]);
        expect(f.neighbor.getCumulativeHp()).toBe(1000);
    });
}

test("losing an allied Last Fuse holder does not trigger a defensive explosion", () => {
    const f = cluster();
    kill(f.killer, f.victim);
    expect(pyres(f.cleanup([f.killer.getId()]))).toEqual([]);
    expect(f.victim.getCumulativeHp()).toBe(500);
});

test("the fatal blow uses actual remaining HP after attrition, without armor or magic mitigation", () => {
    const f = cluster();
    const warded = f.add("Warded", { x: 4, y: 5 }, { maxHp: 500, armor: 90, magicResist: 100 });
    f.victim.applyDamage(250, 0, new SceneLogMock(), false, f.killer);
    expect(f.victim.isDead()).toBe(false);
    expect(f.victim.applyDamage(99999, 0, new SceneLogMock(), false, f.killer)).toBe(250);
    const blast = pyres(f.cleanup([f.victim.getId()]))[0];
    expect(blast.hits.map((hit) => hit.amount)).toEqual([63, 63]);
    expect(f.neighbor.getCumulativeHp()).toBe(937);
    expect(warded.getCumulativeHp()).toBe(437);
});

for (const power of [1, 2, 3, 4, 5]) {
    test(`the attacker's captured power ${power} sets the ${power * 25} damage floor`, () => {
        const f = cluster();
        f.victim.applyDamage(499, 0, new SceneLogMock(), false);
        f.killer.setStackPower(power);
        f.victim.setStackPower(6 - power);
        expect(f.victim.applyDamage(99999, 0, new SceneLogMock(), false, f.killer)).toBe(1);
        expect(f.victim.getLastFuseKillSource()?.stackPower).toBe(power);
        f.killer.setStackPower(6 - power);
        expect(pyres(f.cleanup([f.victim.getId()]))[0].hits[0].amount).toBe(power * 25);
    });
}

for (const [width, height] of [
    [1, 2],
    [2, 1],
    [2, 2],
]) {
    test(`${width}x${height} enemy corpse hits its whole ring exactly once`, () => {
        const f = board();
        const killer = f.add("Killer", { x: 1, y: 1 }, { team: LEFT });
        const victim = f.add(
            "Victim",
            { x: 6, y: 6 },
            { amountAlive: 5, footprintWidth: width, footprintHeight: height },
        );
        const neighbors: Unit[] = [];
        for (let x = 6 - width; x <= 7; x++) {
            for (let y = 6 - height; y <= 7; y++) {
                if (x >= 7 - width && x <= 6 && y >= 7 - height && y <= 6) continue;
                neighbors.push(f.add(`Enemy ${x},${y}`, { x, y }, { maxHp: 500 }));
            }
        }
        f.arm(LEFT);
        kill(victim, killer);
        const blasts = pyres(f.cleanup([victim.getId(), victim.getId()]));
        expect(blasts).toHaveLength(1);
        expect(new Set(blasts[0].hits.map((hit) => hit.unitId)).size).toBe(neighbors.length);
        expect(neighbors.every((enemy) => enemy.getCumulativeHp() === 375)).toBe(true);
    });
}

test("a multi-cell enemy receives one blast and an edge corpse hits its diagonal safely", () => {
    const f = board();
    const killer = f.add("Killer", { x: 12, y: 12 }, { team: LEFT });
    const victim = f.add("Victim", { x: 0, y: 0 }, { amountAlive: 5 });
    const enemy = f.add("Enemy", { x: 2, y: 1 }, { maxHp: 500, footprintWidth: 2, footprintHeight: 2 });
    f.arm(LEFT);
    kill(victim, killer);
    expect(pyres(f.cleanup([victim.getId()]))[0].hits).toEqual([
        expect.objectContaining({ unitId: enemy.getId(), amount: 125 }),
    ]);
    expect(enemy.getCumulativeHp()).toBe(375);
});

test("Water Shield absorbs the untyped blast even when the killer is Fire Element", () => {
    const f = board();
    const killer = f.add("Fire Element", { x: 1, y: 1 }, { team: LEFT });
    const first = f.add("First", { x: 4, y: 5 }, { amountAlive: 5 });
    const second = f.add("Second", { x: 6, y: 5 }, { amountAlive: 5 });
    const shielded = f.add("Shielded", { x: 5, y: 5 }, { maxHp: 1000, abilities: ["Water Shield"] });
    shielded.trySeedWaterShield();
    f.arm(LEFT);
    kill(first, killer);
    expect(pyres(f.cleanup([first.getId()]))[0].hits).toEqual([]);
    expect(shielded.hasBuffActive("Water Shield")).toBe(false);
    expect(shielded.getCumulativeHp()).toBe(1000);
    kill(second, killer);
    expect(pyres(f.cleanup([second.getId()]))[0].hits).toEqual([
        expect.objectContaining({ unitId: shielded.getId(), amount: 125 }),
    ]);
});

for (const bothArmed of [false, true]) {
    test(`chain explosions retain the original killer's side with both armies armed: ${bothArmed}`, () => {
        const f = board();
        const killer = f.add("Killer", { x: 3, y: 4 }, { team: LEFT, maxHp: 500, stackPower: 3 });
        const victim = f.add("Victim", { x: 4, y: 4 }, { amountAlive: 5, stackPower: 1 });
        const chain = f.add("Chain", { x: 5, y: 4 }, { maxHp: 10, stackPower: 5 });
        const witness = f.add("Witness", { x: 6, y: 4 }, { maxHp: 500 });
        const ally = f.add("Ally", { x: 5, y: 3 }, { team: LEFT, maxHp: 500 });
        f.arm(...(bothArmed ? [LEFT, RIGHT] : [LEFT]));
        kill(victim, killer);
        const died = [victim.getId()];
        const events = f.cleanup(died);
        expect(died).toEqual([victim.getId()]);
        expect(pyres(events).map((event) => event.unitId)).toEqual([victim.getId(), chain.getId()]);
        expect(f.unitsHolder.getAllUnits().has(chain.getId())).toBe(false);
        expect(witness.getCumulativeHp()).toBe(425);
        expect(pyres(events).every((event) => event.sourceUnitId === killer.getId())).toBe(true);
        expect([killer, ally].map((unit) => unit.getCumulativeHp())).toEqual([500, 500]);
    });
}

for (const chained of [false, true]) {
    test(`native resurrection prevents a blast, chained: ${chained}`, () => {
        const f = cluster();
        const angel = f.add(
            "Angel",
            { x: chained ? 5 : 4, y: 5 },
            { maxHp: 40, amountAlive: 2, abilities: ["Resurrection"], spells: [":Resurrection"] },
        );
        expect(angel.canSelfResurrect()).toBe(true);
        const victim = chained ? f.victim : angel;
        kill(victim, f.killer);
        const events = f.cleanup([victim.getId()]);
        expect(pyres(events).map((event) => event.unitId)).toEqual(chained ? [f.victim.getId()] : []);
        expect(angel.isDead()).toBe(false);
        expect(angel.getLastFuseKillSource()).toBeUndefined();
        expect(events).toContainEqual(expect.objectContaining({ type: "unit_resurrected", unitId: angel.getId() }));
    });
}

for (const source of ["melee", "range", "spell"] as const) {
    test(`a lethal ${source} action detonates the killed enemy through the real engine`, () => {
        const f = board();
        const striker = f.add(
            "Striker",
            { x: 3, y: 5 },
            {
                team: LEFT,
                amountAlive: 20,
                stackPower: 5,
                attack: 50,
                damageMin: 100,
                damageMax: 100,
                attackType: source === "melee" ? PBTypes.AttackVals.MELEE : PBTypes.AttackVals.RANGE,
                rangeShots: 10,
                shotDistance: 16,
                spells: ["Life:Fire Strike"],
            },
        );
        const victim = f.add(
            "Victim",
            { x: source === "melee" ? 4 : 8, y: 5 },
            { amountAlive: 5, attack: 0, damageMin: 0, damageMax: 0 },
        );
        const chain = f.add("Chain", { x: source === "melee" ? 5 : 9, y: 5 }, { maxHp: 10 });
        f.arm(LEFT);
        victim.applyDamage(499, 0, new SceneLogMock(), false);
        f.fight.startFight();
        f.fight.setTeamUnitsAlive(LEFT, 1);
        f.fight.setTeamUnitsAlive(RIGHT, 2);
        f.fight.startTurn(LEFT, 1000);
        setDeterministicRandomSource(() => 0);
        const hpBefore = striker.getCumulativeHp();
        const result = f.engine.apply(
            source === "spell"
                ? {
                      type: "cast_spell",
                      casterId: striker.getId(),
                      spellName: "Fire Strike",
                      targetId: victim.getId(),
                      targetCell: victim.getBaseCell(),
                  }
                : source === "range"
                  ? { type: "range_attack", attackerId: striker.getId(), targetId: victim.getId() }
                  : {
                        type: "melee_attack",
                        attackerId: striker.getId(),
                        targetId: victim.getId(),
                        attackFrom: striker.getBaseCell(),
                    },
        );
        expect(result.completed).toBe(true);
        expect(pyres(result.events).map((event) => event.unitId)).toEqual([victim.getId(), chain.getId()]);
        expect(f.unitsHolder.getAllUnits().has(chain.getId())).toBe(false);
        expect(striker.getCumulativeHp()).toBe(hpBefore - (source === "melee" ? 1 : 0));
        const attack = result.events.find((event) => event.type === "unit_attacked");
        if (attack?.type === "unit_attacked") expect(attack.unitIdsDied).not.toContain(chain.getId());
    });
}

test("headless fights apply the blast without rendering events", () => {
    const f = cluster("headless");
    kill(f.victim, f.killer);
    expect(pyres(f.cleanup([f.victim.getId()]))).toEqual([]);
    expect(f.neighbor.getCumulativeHp()).toBe(875);
});

test("the closing board does not turn environmental destruction into an attributed kill", () => {
    const f = cluster();
    const events = (
        f.turn() as unknown as { handleSystemMoveResult(result: ISystemMoveResult): GameEvent[] }
    ).handleSystemMoveResult({ log: "", unitIdToNewPosition: new Map(), unitIdsDestroyed: [f.victim.getId()] });
    expect(pyres(events)).toEqual([]);
    expect(f.neighbor.getCumulativeHp()).toBe(1000);
});

test("poison and Armageddon deaths do not borrow the artifact from the dying unit", () => {
    for (const source of ["poison", "armageddon"]) {
        const f = cluster();
        f.arm(RIGHT);
        f.victim.applyDamage(499, 0, new SceneLogMock(), false);
        let events: GameEvent[];
        if (source === "poison") {
            const poison = new EffectFactory().makeEffect("Poison")!;
            poison.setPower(5);
            expect(f.victim.applyEffect(poison)).toBe(true);
            f.fight.startFight();
            events = (f.turn() as unknown as { activateNextUnit(unit: Unit): GameEvent[] }).activateNextUnit(f.victim);
        } else {
            while (f.fight.getArmageddonWave() < 1) f.fight.flipLap();
            events = (
                f.turn() as unknown as { applyArmageddonIfNeeded(units: Unit[]): GameEvent[] }
            ).applyArmageddonIfNeeded([f.victim]);
        }
        expect(pyres(events)).toEqual([]);
        expect(f.killer.getCumulativeHp()).toBe(1000);
        expect(f.neighbor.getCumulativeHp()).toBe(1000);
    }
});

test("the on-kill description stays correct after attrition and stack-power changes", () => {
    const f = cluster();
    const description = () => {
        const props = f.killer.getUnitProperties();
        return props.applied_buffs_descriptions[props.applied_buffs.indexOf("Last Fuse")];
    };
    const before = description();
    expect(before).toContain("Enemy stacks this unit destroys");
    expect(before).toContain("minimum of 25 damage");
    expect(before).toContain("25 per attacker stack power");
    f.killer.applyDamage(999, 0, new SceneLogMock(), false);
    f.killer.setStackPower(5);
    expect(description()).toContain("minimum of 125 damage");
    f.killer.setStackPower(2);
    expect(description()).toContain("minimum of 50 damage");
});

test("snapshot rollback restores fatal damage and killer ownership, while resurrection clears them", () => {
    const f = cluster();
    f.victim.applyDamage(250, 0, new SceneLogMock(), false);
    kill(f.victim, f.killer);
    const snapshot = snapshotBattle(f.unitsHolder, f.grid, f.fight);
    f.victim.reviveAfterDeath(1);
    expect(f.victim.getLastFuseKillSource()).toBeUndefined();
    kill(f.victim);
    expect(f.victim.getLastFuseKillSource()).toBeUndefined();
    restoreBattle(snapshot, f.unitsHolder, f.grid, f.fight);
    expect(f.victim.getLastFuseKillSource()?.team).toBe(LEFT);
    expect(f.victim.getLastFuseDamage()).toBe(63);
    expect(pyres(f.cleanup([f.victim.getId()]))[0].hits[0].amount).toBe(63);
});

test("a Last Fuse holder's lethal retaliation detonates the attacking enemy", () => {
    const f = board();
    const defender = f.add(
        "Defender",
        { x: 4, y: 4 },
        { team: LEFT, maxHp: 1000, attack: 50, damageMin: 10000, damageMax: 10000 },
    );
    const attacker = f.add("Attacker", { x: 3, y: 4 }, { attack: 1, damageMin: 1, damageMax: 1 });
    const neighbor = f.add("Enemy neighbor", { x: 3, y: 5 }, { maxHp: 1000 });
    f.arm(LEFT);
    f.fight.startFight();
    f.fight.setTeamUnitsAlive(LEFT, 1);
    f.fight.setTeamUnitsAlive(RIGHT, 2);
    f.fight.startTurn(RIGHT, 1000);
    setDeterministicRandomSource(() => 0);
    const result = f.engine.apply({
        type: "melee_attack",
        attackerId: attacker.getId(),
        targetId: defender.getId(),
        attackFrom: attacker.getBaseCell(),
    });
    expect(result.completed).toBe(true);
    expect(pyres(result.events)).toEqual([
        expect.objectContaining({
            unitId: attacker.getId(),
            sourceUnitId: defender.getId(),
            hits: [expect.objectContaining({ unitId: neighbor.getId(), amount: 25 })],
        }),
    ]);
    expect(neighbor.getCumulativeHp()).toBe(975);
});
