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
import { GameActionEngine } from "../../src/engine/action_engine";
import type { GameEvent } from "../../src/engine/events";
import { TurnEngine } from "../../src/engine/turn_engine";
import { EffectFactory } from "../../src/effects/effect_factory";
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

afterEach(() => setDeterministicRandomSource(undefined));

type PyreEvent = Extract<GameEvent, { type: "pyre_exploded" }>;

function board(eventMode?: "headless") {
    const context = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const add = (name: string, cell: XY, options: TestUnitOptions = {}) => {
        const unit = createTestUnit({
            name,
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
        for (const team of teams) {
            fight.setArtifactPerTeam(team, 2, Tier2Artifact.LAST_FUSE);
        }
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
    return { ...context, fight, add, arm, engine, cleanup };
}

function kill(unit: Unit): void {
    unit.applyDamage(unit.getCumulativeHp(), 0, new SceneLogMock(), false);
}

function pyres(events: GameEvent[]): PyreEvent[] {
    return events.filter((event): event is PyreEvent => event.type === "pyre_exploded");
}

test("the new Tier-2 wire id is draftable and the card is a flat explosion", () => {
    expect(ToTier2Artifact["17"]).toBe(Tier2Artifact.LAST_FUSE);
    expect(LIVE_TIER2_ARTIFACT_IDS).toContain(Tier2Artifact.LAST_FUSE);
    expect(TIER2_ARTIFACT_LIST.find((artifact) => artifact.id === 17)?.imageKey).toBe("artifact_t2_last_fuse_256");
    expect(lastFuseDamage(500, 1, ARTIFACT_POWER.LAST_FUSE_PERCENT)).toBe(100);
    expect(lastFuseDamage(1, 1, ARTIFACT_POWER.LAST_FUSE_PERCENT)).toBe(20);
    const description = formatArtifactDescription(getArtifactProperties(ArtifactTier.TIER_2, Tier2Artifact.LAST_FUSE));
    expect(description).toContain("20%");
    expect(description).toContain("explodes");
    expect(description).not.toMatch(/physical|magic/i);
    expect(description).not.toMatch(/\{\}|\[\]|<>/);
    expect(getSpellConfig("System", "Last Fuse").name).toBe("Last Fuse");
});

test("every ally carries the fuse, nobody pays a stat, and dropping it removes the buff", () => {
    const f = board();
    const ally = f.add("Ally", { x: 2, y: 2 }, { team: LEFT, amountAlive: 4 });
    const enemy = f.add("Enemy", { x: 8, y: 7 }, { team: RIGHT });
    const steps = ally.getSteps();
    const props = ally.getUnitProperties();
    const attack = props.attack;
    const armor = props.base_armor;
    f.arm(LEFT);
    f.arm(LEFT);
    expect(ally.getBuffPower("Last Fuse")).toBe(ARTIFACT_POWER.LAST_FUSE_PERCENT);
    expect(ally.getUnitProperties().applied_buffs.filter((name) => name === "Last Fuse")).toHaveLength(1);
    expect(enemy.hasBuffActive("Last Fuse")).toBe(false);
    expect(ally.getSteps()).toBe(steps);
    expect(ally.getUnitProperties().attack).toBe(attack);
    expect(ally.getUnitProperties().base_armor).toBe(armor);
    f.fight.setArtifactPerTeam(LEFT, 2, 0);
    f.unitsHolder.applyArtifacts(f.fight);
    expect(ally.hasBuffActive("Last Fuse")).toBe(false);
});

test("the blast uses actual killing damage after attrition; armor and magic resistance do not reduce it", () => {
    const f = board();
    const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const plain = f.add("Plain", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500, amountAlive: 2 });
    const warded = f.add(
        "Warded",
        { x: 4, y: 5 },
        { team: RIGHT, maxHp: 500, amountAlive: 2, armor: 90, magicResist: 100 },
    );
    f.arm(LEFT);
    victim.applyDamage(250, 0, new SceneLogMock(), false);
    expect(victim.getAmountDied()).toBe(2);
    expect(victim.isDead()).toBe(false);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    const blast = pyres(events);
    expect(blast).toHaveLength(1);
    expect(blast[0].position).toEqual(victim.getPosition());
    const amounts = new Map(blast[0].hits.map((hit) => [hit.unitId, hit.amount]));
    expect(amounts.get(plain.getId())).toBe(50);
    expect(amounts.get(warded.getId())).toBe(50);
    expect(plain.getCumulativeHp()).toBe(950);
    expect(warded.getCumulativeHp()).toBe(950);
});

test("diagonals are hit, allies and enemies a cell further away are not", () => {
    const f = board();
    const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const diagonal = f.add("Diagonal", { x: 5, y: 5 }, { team: RIGHT, maxHp: 500 });
    const far = f.add("Far", { x: 6, y: 4 }, { team: RIGHT, maxHp: 500 });
    const ally = f.add("Ally", { x: 3, y: 4 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events)[0].hits.map((hit) => hit.unitId)).toEqual([diagonal.getId()]);
    expect(diagonal.getCumulativeHp()).toBe(400);
    expect(far.getCumulativeHp()).toBe(500);
    expect(ally.getCumulativeHp()).toBe(500);
});

test("a large body bursts from its whole ring, not from the anchor cell alone", () => {
    const f = board();
    const victim = f.add(
        "Giant",
        { x: 6, y: 6 },
        { team: LEFT, amountAlive: 5, maxHp: 100, footprintWidth: 2, footprintHeight: 2 },
    );
    const corner = f.add("Corner", { x: 4, y: 4 }, { team: RIGHT, maxHp: 500 });
    const outside = f.add("Outside", { x: 8, y: 6 }, { team: RIGHT, maxHp: 500 });
    const ally = f.add("Ally", { x: 7, y: 6 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events)[0].hits.map((hit) => hit.unitId)).toEqual([corner.getId()]);
    expect(corner.getCumulativeHp()).toBe(400);
    expect(outside.getCumulativeHp()).toBe(500);
    expect(ally.getCumulativeHp()).toBe(500);
});

test("Water Shield swallows even a Fire Element blast, breaks, and the next blast lands", () => {
    const f = board();
    const first = f.add("Fire Element", { x: 4, y: 5 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const second = f.add("Second", { x: 6, y: 5 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const shielded = f.add(
        "Shielded",
        { x: 5, y: 5 },
        { team: RIGHT, maxHp: 500, amountAlive: 2, abilities: ["Water Shield"] },
    );
    shielded.trySeedWaterShield();
    f.arm(LEFT);
    kill(first);
    const firstEvents = f.cleanup([first.getId()]);
    expect(pyres(firstEvents)[0].hits).toEqual([]);
    expect(shielded.hasBuffActive("Water Shield")).toBe(false);
    expect(shielded.getCumulativeHp()).toBe(1000);
    kill(second);
    const secondEvents = f.cleanup([second.getId()]);
    expect(pyres(secondEvents)[0].hits).toEqual([
        expect.objectContaining({ unitId: shielded.getId(), amount: 100, unitsDied: 0 }),
    ]);
    expect(shielded.getCumulativeHp()).toBe(900);
});

test("a stack that resurrects does not explode", () => {
    const f = board();
    const victim = f.add(
        "Angel",
        { x: 4, y: 4 },
        {
            team: LEFT,
            amountAlive: 2,
            maxHp: 100,
            abilities: ["Resurrection"],
            spells: [":Resurrection"],
        },
    );
    const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500 });
    f.arm(LEFT);
    expect(victim.canSelfResurrect()).toBe(true);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events)).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "unit_resurrected", unitId: victim.getId() }));
    expect(f.unitsHolder.getAllUnits().get(victim.getId())?.isDead()).toBe(false);
    expect(neighbor.getCumulativeHp()).toBe(500);
});

test("a blast that destroys another Last Fuse stack chains, and that death stays off the strike's died list", () => {
    const f = board();
    const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const chain = f.add("Chain", { x: 5, y: 4 }, { team: RIGHT, amountAlive: 1, maxHp: 50 });
    const witness = f.add("Witness", { x: 6, y: 4 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT, RIGHT);
    kill(victim);
    const died = [victim.getId()];
    const events = f.cleanup(died);
    expect(died).toEqual([victim.getId()]);
    expect(f.unitsHolder.getAllUnits().has(chain.getId())).toBe(false);
    const blasts = pyres(events);
    expect(blasts.map((blast) => blast.unitId)).toEqual([victim.getId(), chain.getId()]);
    expect(blasts[0].hits).toEqual([expect.objectContaining({ unitId: chain.getId(), amount: 50, unitsDied: 1 })]);
    expect(blasts[1].hits).toEqual([expect.objectContaining({ unitId: witness.getId(), amount: 20, unitsDied: 0 })]);
    expect(witness.getCumulativeHp()).toBe(480);
    expect(events.filter((event) => event.type === "unit_destroyed").map((event) => event.unitId)).toEqual([
        victim.getId(),
        chain.getId(),
    ]);
});

test("a chain victim that resurrects does not burst", () => {
    const f = board();
    const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const chain = f.add(
        "Chain",
        { x: 5, y: 4 },
        {
            team: RIGHT,
            amountAlive: 2,
            maxHp: 40,
            abilities: ["Resurrection"],
            spells: [":Resurrection"],
        },
    );
    const witness = f.add("Witness", { x: 6, y: 4 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT, RIGHT);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events).map((blast) => blast.unitId)).toEqual([victim.getId()]);
    expect(events).toContainEqual(expect.objectContaining({ type: "unit_resurrected", unitId: chain.getId() }));
    expect(events.some((event) => event.type === "unit_destroyed" && event.unitId === chain.getId())).toBe(false);
    expect(chain.isDead()).toBe(false);
    expect(witness.getCumulativeHp()).toBe(500);
});

test("a melee strike's died list does not claim the stack the explosion killed", () => {
    setDeterministicRandomSource(() => 0);
    const f = board();
    const victim = f.add(
        "Pyre",
        { x: 4, y: 4 },
        { team: LEFT, amountAlive: 5, maxHp: 100, attack: 0, damageMin: 0, damageMax: 0 },
    );
    const attacker = f.add(
        "Striker",
        { x: 3, y: 4 },
        { team: RIGHT, amountAlive: 10, maxHp: 100, damageMin: 50, damageMax: 50, attack: 20 },
    );
    const chain = f.add(
        "Chain",
        { x: 5, y: 4 },
        { team: RIGHT, amountAlive: 1, maxHp: 10, damageMin: 1, damageMax: 1 },
    );
    const witness = f.add("Witness", { x: 6, y: 4 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT, RIGHT);
    victim.applyDamage(499, 0, new SceneLogMock(), false);
    expect(victim.getCumulativeHp()).toBe(1);
    f.fight.startFight();
    f.fight.setTeamUnitsAlive(LEFT, 2);
    f.fight.setTeamUnitsAlive(RIGHT, 2);
    f.fight.startTurn(RIGHT, 1000);
    const result = f.engine.apply({
        type: "melee_attack",
        attackerId: attacker.getId(),
        targetId: victim.getId(),
        attackFrom: { x: 3, y: 4 },
    });
    expect(result.completed).toBe(true);
    const attack = result.events.find((event) => event.type === "unit_attacked");
    expect(attack?.type).toBe("unit_attacked");
    if (attack?.type !== "unit_attacked") {
        return;
    }
    expect(attack.unitIdsDied).toContain(victim.getId());
    expect(attack.unitIdsDied).not.toContain(chain.getId());
    expect(f.unitsHolder.getAllUnits().has(chain.getId())).toBe(false);
    // The dying stack has only 1 HP: its power-1 minimum is 20.
    expect(attacker.getCumulativeHp()).toBeLessThanOrEqual(980);
    expect(attacker.getCumulativeHp()).toBeGreaterThan(970);
    expect(chain.getStackPower()).toBe(5);
    expect(witness.getCumulativeHp()).toBe(400);
    expect(pyres(result.events).map((blast) => blast.unitId)).toEqual([victim.getId(), chain.getId()]);
});

test("headless fights still apply the blast and omit the visual event", () => {
    const f = board("headless");
    const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500 });
    f.arm(LEFT);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events)).toEqual([]);
    expect(events).toContainEqual(
        expect.objectContaining({ type: "unit_destroyed", unitId: victim.getId(), reason: "dead_cleanup" }),
    );
    expect(neighbor.getCumulativeHp()).toBe(400);
});

test("the closing board does not burst a living stack, and does burst one it crushes already dead", () => {
    const crush = (alreadyDead: boolean) => {
        const f = board();
        const victim = f.add("Pyre", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
        const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500 });
        f.arm(LEFT);
        if (alreadyDead) {
            kill(victim);
        }
        const turn = new TurnEngine({
            fightProperties: f.fight,
            grid: f.grid,
            unitsHolder: f.unitsHolder,
            moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
            sceneLog: new SceneLogMock(),
        });
        const events = (
            turn as unknown as { handleSystemMoveResult(result: ISystemMoveResult): GameEvent[] }
        ).handleSystemMoveResult({
            log: "",
            unitIdToNewPosition: new Map(),
            unitIdsDestroyed: [victim.getId()],
        });
        return { events, neighbor, victim, unitsHolder: f.unitsHolder };
    };

    const living = crush(false);
    expect(pyres(living.events)).toEqual([]);
    expect(living.neighbor.getCumulativeHp()).toBe(500);
    expect(living.unitsHolder.getAllUnits().has(living.victim.getId())).toBe(false);

    const dead = crush(true);
    expect(pyres(dead.events).map((blast) => blast.unitId)).toEqual([dead.victim.getId()]);
    expect(dead.neighbor.getCumulativeHp()).toBe(400);
});

test("a one-HP stack still bursts for its power-1 minimum", () => {
    const f = board();
    const victim = f.add("Spark", { x: 4, y: 4 }, { team: LEFT, amountAlive: 1, maxHp: 1 });
    const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500 });
    f.arm(LEFT);
    kill(victim);
    const events = f.cleanup([victim.getId()]);
    expect(pyres(events)).toHaveLength(1);
    expect(neighbor.getCumulativeHp()).toBe(480);
});

for (const [width, height] of [
    [1, 2],
    [2, 1],
    [2, 2],
]) {
    for (const team of [LEFT, RIGHT]) {
        test(`${width}x${height} body on team ${team} hits every neighboring cell exactly once`, () => {
            const f = board();
            const opposite = team === LEFT ? RIGHT : LEFT;
            const victim = f.add(
                "Fuse",
                { x: 6, y: 6 },
                {
                    team,
                    amountAlive: 5,
                    maxHp: 100,
                    footprintWidth: width,
                    footprintHeight: height,
                },
            );
            const neighbors: Unit[] = [];
            for (let x = 6 - width; x <= 7; x++) {
                for (let y = 6 - height; y <= 7; y++) {
                    if (x >= 7 - width && x <= 6 && y >= 7 - height && y <= 6) continue;
                    neighbors.push(f.add(`Enemy ${x},${y}`, { x, y }, { team: opposite, maxHp: 500 }));
                }
            }
            f.arm(team);
            kill(victim);
            const blasts = pyres(f.cleanup([victim.getId(), victim.getId()]));
            expect(blasts).toHaveLength(1);
            expect(new Set(blasts[0].hits.map((hit) => hit.unitId)).size).toBe(neighbors.length);
            expect(neighbors.every((enemy) => enemy.getCumulativeHp() === 400)).toBe(true);
        });
    }
}

test("the hover damage recalculates after attrition, including snapshot-only buffs", () => {
    const f = board();
    const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    f.arm(LEFT);
    const description = () => {
        const props = victim.getUnitProperties();
        return props.applied_buffs_descriptions[props.applied_buffs.indexOf("Last Fuse")];
    };
    expect(description()).toContain("100 damage");
    victim.applyDamage(450, 0, new SceneLogMock(), false);
    expect(description()).toContain("20 damage");
    (victim as unknown as { buffs: unknown[] }).buffs = [];
    expect(victim.getLastFuseDamage()).toBe(20);
    expect(description()).toContain("20 damage");
});

test("Armageddon does not detonate a chain victim twice when processing its stale lap list", () => {
    const f = board();
    const first = f.add("First", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const chain = f.add("Chain", { x: 5, y: 4 }, { team: RIGHT, maxHp: 10 });
    const witness = f.add("Witness", { x: 6, y: 4 }, { team: LEFT, maxHp: 500 });
    f.arm(LEFT, RIGHT);
    first.applyDamage(499, 0, new SceneLogMock(), false);
    while (f.fight.getArmageddonWave() < 1) f.fight.flipLap();
    const turn = new TurnEngine({
        fightProperties: f.fight,
        grid: f.grid,
        unitsHolder: f.unitsHolder,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: new SceneLogMock(),
    });
    const events = (turn as unknown as { applyArmageddonIfNeeded(units: Unit[]): GameEvent[] }).applyArmageddonIfNeeded(
        [first, chain],
    );
    expect(pyres(events).map((event) => event.unitId)).toEqual([first.getId(), chain.getId()]);
    expect(events.filter((event) => event.type === "armageddon_applied").map((event) => event.unitId)).toEqual([
        first.getId(),
    ]);
    expect(witness.getCumulativeHp()).toBe(480);
});

for (const source of ["range", "spell"] as const) {
    test(`a lethal ${source} action detonates Last Fuse through the real engine`, () => {
        const f = board();
        const striker = f.add(
            "Striker",
            { x: 3, y: 5 },
            {
                team: RIGHT,
                amountAlive: 20,
                stackPower: 5,
                attack: 50,
                damageMin: 100,
                damageMax: 100,
                attackType: PBTypes.AttackVals.RANGE,
                rangeShots: 10,
                shotDistance: 16,
                spells: ["Life:Fire Strike"],
            },
        );
        const victim = f.add("Fuse", { x: 8, y: 5 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
        const neighbor = f.add("Neighbor", { x: 9, y: 5 }, { team: RIGHT, maxHp: 500 });
        f.arm(LEFT);
        victim.applyDamage(499, 0, new SceneLogMock(), false);
        f.fight.startFight();
        f.fight.setTeamUnitsAlive(LEFT, 1);
        f.fight.setTeamUnitsAlive(RIGHT, 2);
        f.fight.startTurn(RIGHT, 1000);
        setDeterministicRandomSource(() => 0);
        const result = f.engine.apply(
            source === "range"
                ? {
                      type: "range_attack",
                      attackerId: striker.getId(),
                      targetId: victim.getId(),
                  }
                : {
                      type: "cast_spell",
                      casterId: striker.getId(),
                      spellName: "Fire Strike",
                      targetId: victim.getId(),
                      targetCell: victim.getBaseCell(),
                  },
        );
        expect(result.completed).toBe(true);
        expect(pyres(result.events).map((event) => event.unitId)).toEqual([victim.getId()]);
        expect(neighbor.getCumulativeHp()).toBe(480);
    });
}

test("a lethal poison tick detonates before the poisoned stack can act", () => {
    const f = board();
    const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    const neighbor = f.add("Neighbor", { x: 5, y: 4 }, { team: RIGHT, maxHp: 500 });
    f.arm(LEFT);
    victim.applyDamage(499, 0, new SceneLogMock(), false);
    const poison = new EffectFactory().makeEffect("Poison")!;
    poison.setPower(5);
    expect(victim.applyEffect(poison)).toBe(true);
    f.fight.startFight();
    const turn = new TurnEngine({
        fightProperties: f.fight,
        grid: f.grid,
        unitsHolder: f.unitsHolder,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: new SceneLogMock(),
    });
    const events = (turn as unknown as { activateNextUnit(unit: Unit): GameEvent[] }).activateNextUnit(victim);
    expect(pyres(events).map((event) => event.unitId)).toEqual([victim.getId()]);
    expect(neighbor.getCumulativeHp()).toBe(480);
    expect(events.some((event) => event.type === "next_unit_selected")).toBe(false);
});

test("a blast wiping the remaining enemy ends the fight with a draw when both armies are gone", () => {
    const f = board();
    const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, amountAlive: 5, maxHp: 100 });
    f.add("Enemy", { x: 5, y: 4 }, { team: RIGHT, maxHp: 50 });
    f.arm(LEFT);
    f.fight.startFight();
    kill(victim);
    f.cleanup([victim.getId()]);
    const turn = new TurnEngine({
        fightProperties: f.fight,
        grid: f.grid,
        unitsHolder: f.unitsHolder,
        moveHandler: new MoveHandler(f.grid.getSettings(), f.grid, f.unitsHolder),
        sceneLog: new SceneLogMock(),
    });
    const result = turn.advanceAfterNoActiveUnit();
    expect(result.fightFinished).toBe(true);
    expect(result.events).toContainEqual({ type: "fight_finished", winningTeam: PBTypes.TeamVals.NO_TEAM });
});

for (const power of [1, 2, 3, 4, 5]) {
    test(`a power-${power} dying stack has a ${power * 20} minimum, independent of overkill`, () => {
        const f = board();
        const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, stackPower: power, maxHp: 1 });
        const neighbor = f.add("Enemy", { x: 5, y: 4 }, { team: RIGHT, maxHp: 1000 });
        f.arm(LEFT);
        expect(victim.getLastFuseDamage()).toBe(power * 20);
        const dealt = victim.applyDamage(99999, 0, new SceneLogMock(), false);
        expect(dealt).toBe(1);
        expect(pyres(f.cleanup([victim.getId()]))[0].hits[0].amount).toBe(power * 20);
        expect(neighbor.getCumulativeHp()).toBe(1000 - power * 20);
    });
}

test("20% can exceed the minimum, but overkill and previously lost HP are excluded", () => {
    const f = board();
    const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, amountAlive: 10, maxHp: 100, stackPower: 3 });
    f.add("Enemy", { x: 5, y: 4 }, { team: RIGHT, maxHp: 1000 });
    f.arm(LEFT);
    expect(victim.getLastFuseDamage()).toBe(200);
    victim.applyDamage(500, 0, new SceneLogMock(), false);
    expect(victim.getLastFuseDamage()).toBe(100);
    expect(victim.applyDamage(99999, 0, new SceneLogMock(), false)).toBe(500);
    expect(pyres(f.cleanup([victim.getId()]))[0].hits[0].amount).toBe(100);
});

test("the hover minimum follows a changed stack power without changing HP", () => {
    const f = board();
    const victim = f.add("Fuse", { x: 4, y: 4 }, { team: LEFT, maxHp: 1 });
    f.arm(LEFT);
    victim.setStackPower(5);
    const props = victim.getUnitProperties();
    expect(props.applied_buffs_descriptions[props.applied_buffs.indexOf("Last Fuse")]).toContain("100 damage");
});

test("a multi-cell enemy touching two cells takes a single blast", () => {
    const f = board();
    const victim = f.add("Fuse", {x: 5, y: 5}, {team: LEFT, amountAlive: 5, maxHp: 100, footprintWidth: 1, footprintHeight: 2});
    const enemy = f.add("Large enemy", {x: 7, y: 5}, {team: RIGHT, maxHp: 500, footprintWidth: 2, footprintHeight: 2});
    f.arm(LEFT);
    kill(victim);
    const blasts = pyres(f.cleanup([victim.getId()]));
    expect(blasts[0].hits).toEqual([expect.objectContaining({unitId: enemy.getId(), amount: 100})]);
    expect(enemy.getCumulativeHp()).toBe(400);
});

test("a corpse at the board edge still hits its diagonal enemy safely", () => {
    const f = board();
    const victim = f.add("Fuse", {x: 0, y: 0}, {team: LEFT, amountAlive: 5, maxHp: 100});
    const enemy = f.add("Enemy", {x: 1, y: 1}, {team: RIGHT, maxHp: 500});
    f.arm(LEFT);
    kill(victim);
    expect(pyres(f.cleanup([victim.getId()]))[0].hits.map(hit => hit.unitId)).toEqual([enemy.getId()]);
});

test("AI rollback restores the actual fatal hit used by a pending explosion", () => {
    const f = board();
    const victim = f.add("Fuse", {x: 4, y: 4}, {team: LEFT, maxHp: 100, amountAlive: 10, stackPower: 3});
    f.add("Enemy", {x: 5, y: 4}, {team: RIGHT, maxHp: 1000});
    f.arm(LEFT);
    victim.applyDamage(500, 0, new SceneLogMock(), false);
    kill(victim);
    const snapshot = snapshotBattle(f.unitsHolder, f.grid, f.fight);
    victim.reviveAfterDeath(1);
    kill(victim);
    expect(victim.getLastFuseDamage()).toBe(60);
    restoreBattle(snapshot, f.unitsHolder, f.grid, f.fight);
    expect(victim.getLastFuseDamage()).toBe(100);
    expect(pyres(f.cleanup([victim.getId()]))[0].hits[0].amount).toBe(100);
});
