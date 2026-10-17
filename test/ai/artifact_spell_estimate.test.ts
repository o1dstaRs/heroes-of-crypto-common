import { afterEach, describe, expect, test } from "bun:test";

import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { selectV08DamageSpellCandidate } from "../../src/ai/versions/v0_8";
import { lastFuseDamage } from "../../src/abilities/last_fuse_ability";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { GameActionEngine } from "../../src/engine/action_engine";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { MoveHandler } from "../../src/handlers/move_handler";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { snapshotBattle } from "../../src/simulation/battle_snapshot";
import { projectSpellDamageAgainstUnit } from "../../src/spells/spell_cast_projection";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, placeUnit, type TestUnitOptions } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;

function fixture(
    options: {
        ring?: "mage" | "archmage";
        fuse?: boolean;
        spell?: string;
        caster?: TestUnitOptions;
        target?: TestUnitOptions;
        neighbor?: TestUnitOptions;
        expose?: boolean;
        aegis?: boolean;
    } = {},
) {
    const combat = createCombatTestContext();
    const fight = FightStateManager.getInstance().getFightProperties();
    const caster = createTestUnit({
        name: "Caster",
        team: LEFT,
        attackType: PBTypes.AttackVals.MELEE_MAGIC,
        maxHp: 500,
        stackPower: 5,
        spells: [options.spell ?? "Nature:Lightning Strike"],
        ...options.caster,
    });
    const target = createTestUnit({ name: "Fuse", team: RIGHT, maxHp: 10, stackPower: 5, ...options.target });
    const neighbor =
        options.expose || options.neighbor
            ? createTestUnit({ name: "Exposed enemy", team: RIGHT, maxHp: 500, ...options.neighbor })
            : undefined;
    const safe = createTestUnit({ name: "Safe target", team: RIGHT, maxHp: 1000 });
    placeUnit(combat.grid, combat.unitsHolder, caster, { x: 3, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, target, { x: 9, y: 8 });
    if (neighbor) placeUnit(combat.grid, combat.unitsHolder, neighbor, { x: 10, y: 9 });
    placeUnit(combat.grid, combat.unitsHolder, safe, { x: 9, y: 3 });
    if (options.fuse !== false) fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.LAST_FUSE);
    if (options.aegis) fight.setArtifactPerTeam(RIGHT, 2, Tier2Artifact.AEGIS_OF_THE_ARCANE);
    if (options.ring === "mage") fight.setArtifactPerTeam(LEFT, 1, Tier1Artifact.MAGES_RING);
    if (options.ring === "archmage") fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.ARCHMAGES_RING);
    combat.unitsHolder.applyArtifacts(fight);
    for (const unit of [caster, target, neighbor].filter((unit) => unit !== undefined)) unit.trySeedWaterShield();
    caster.refreshPossibleAttackTypes(false);
    fight.startFight();
    const placed = [caster, target, safe, ...(neighbor ? [neighbor] : [])];
    fight.setTeamUnitsAlive(LEFT, placed.filter((unit) => unit.getTeam() === LEFT).length);
    fight.setTeamUnitsAlive(RIGHT, placed.filter((unit) => unit.getTeam() === RIGHT).length);
    fight.startTurn(LEFT, 1000);
    const context: IDecisionContext = {
        ...combat,
        fightProperties: fight,
        matrix: combat.grid.getMatrix(),
        pathHelper: new PathHelper(combat.grid.getSettings()),
    };
    const catalog = () => {
        const before = JSON.stringify(snapshotBattle(combat.unitsHolder, combat.grid, fight));
        setDeterministicRandomSource(() => {
            throw new Error("Artifact spell estimates must be RNG-free");
        });
        const candidates = enumerateCandidates(caster, context, [
            { type: "defend_turn", unitId: caster.getId() },
        ]).candidates;
        expect(JSON.stringify(snapshotBattle(combat.unitsHolder, combat.grid, fight))).toBe(before);
        return candidates;
    };
    const fire = (candidate: IEnumeratedCandidate) => {
        setDeterministicRandomSource(() => 0);
        const tracked = [caster, target, safe, ...(neighbor ? [neighbor] : [])];
        const before = new Map(tracked.map((unit) => [unit.getId(), unit.getCumulativeHp()]));
        const engine = new GameActionEngine({
            ...combat,
            fightProperties: fight,
            sceneLog: new SceneLogMock(),
            moveHandler: new MoveHandler(combat.grid.getSettings(), combat.grid, combat.unitsHolder),
            getCurrentActiveUnitId: () => caster.getId(),
        });
        const results = candidate.actions.map((action) => engine.apply(action));
        expect(results.every((result) => result.completed)).toBe(true);
        const blasts = results.flatMap((result) => result.events).filter((event) => event.type === "pyre_exploded");
        const loss = (unit: (typeof tracked)[number]) => {
            const hp = before.get(unit.getId()) ?? 0;
            return combat.unitsHolder.getAllUnits().has(unit.getId()) ? hp - unit.getCumulativeHp() : hp;
        };
        const friendlyLoss = tracked
            .filter((unit) => unit.getTeam() === LEFT)
            .reduce((sum, unit) => sum + loss(unit), 0);
        const enemyLoss = tracked.filter((unit) => unit.getTeam() === RIGHT).reduce((sum, unit) => sum + loss(unit), 0);
        return { blasts, friendlyLoss, enemyLoss, netDamage: loss(target) - friendlyLoss };
    };
    return { ...combat, fight, caster, target, neighbor, safe, context, catalog, fire };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("artifact spell decisions", () => {
    test.each([1, 2, 3, 4, 5])("Last Fuse spells use caster power %s independently of target power", (stackPower) => {
        const h = fixture({
            expose: true,
            caster: { stackPower },
            target: { maxHp: 1, stackPower: 6 - stackPower },
            neighbor: { maxHp: 1000 },
        });
        const cast = h
            .catalog()
            .find((candidate) => candidate.kind === "spell" && candidate.targetId === h.target.getId())!;
        expect(cast.features.expectedDamage).toBe(1 + 25 * stackPower);
        expect(h.fire(cast).enemyLoss).toBe(1 + 25 * stackPower);
    });

    test.each([undefined, "mage", "archmage"] as const)(
        "%s ring does not turn an absorbed spell into damage or a kill",
        (ring) => {
            const h = fixture({ ring, fuse: false, target: { abilities: ["Water Shield"] } });
            const candidates = h.catalog();
            const cast = candidates.find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
            expect(cast.features).toMatchObject({ expectedDamage: 0, expectedKill: 0 });
            expect(selectV08DamageSpellCandidate(h.caster, candidates)?.targetId).toBe(h.safe.getId());
            expect(h.fire(cast).netDamage).toBe(0);
        },
    );

    test.each([undefined, "mage"] as const)(
        "%s ring prices a Last Fuse execution against a neighboring enemy",
        (ring) => {
            const h = fixture({ ring, expose: true });
            const candidates = h.catalog();
            const cast = candidates.find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
            const blast = lastFuseDamage(
                h.target.getCumulativeHp(),
                h.caster.getStackPower(),
                h.caster.getBuffPower("Last Fuse"),
            );
            const priced = h.target.getCumulativeHp() + blast;
            expect(cast.features).toMatchObject({ expectedDamage: priced, expectedKill: 1 });
            expect(selectV08DamageSpellCandidate(h.caster, candidates)?.targetId).toBe(h.target.getId());
            expect(h.fire(cast)).toMatchObject({ friendlyLoss: 0, enemyLoss: priced });
        },
    );

    test("Archmage's Ring occupies the tier-2 slot, so that loadout has no Last Fuse blast", () => {
        const h = fixture({ ring: "archmage", expose: true });
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        const priced = h.target.getCumulativeHp();
        expect(h.caster.hasBuffActive("Last Fuse")).toBe(false);
        expect(cast.features).toMatchObject({ expectedDamage: priced, expectedKill: 1 });
        expect(h.fire(cast)).toMatchObject({ blasts: [], friendlyLoss: 0, enemyLoss: priced });
    });

    test.each(["Nature:Lightning Strike", "Life:Fire Strike"])(
        "%s uses actual fatal HP rather than the amplified spell's overkill",
        (spell) => {
            const h = fixture({
                spell,
                ring: "mage",
                expose: true,
                caster: { amountAlive: 200 },
                target: { maxHp: 600 },
            });
            const fatalHp = h.target.getCumulativeHp();
            const blast = lastFuseDamage(fatalHp, h.caster.getStackPower(), h.caster.getBuffPower("Last Fuse"));
            const castSpell = h.caster.getSpells().find((entry) => entry.getName() === spell.split(":")[1]);
            expect(castSpell).toBeDefined();
            expect(
                projectSpellDamageAgainstUnit({ spell: castSpell!, caster: h.caster, target: h.target }).damage,
            ).toBeGreaterThan(fatalHp);
            const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
            expect(blast).toBe(Math.max(h.caster.getStackPower() * 25, Math.round((fatalHp * 25) / 100)));
            expect(cast.features.expectedDamage).toBe(fatalHp + blast);
            const result = h.fire(cast);
            expect(result.friendlyLoss).toBe(0);
            expect(result.enemyLoss).toBe(fatalHp + blast);
            expect(result.blasts[0]?.hits).toEqual([
                expect.objectContaining({ unitId: h.neighbor.getId(), amount: blast }),
            ]);
        },
    );

    test("a neighboring Water Shield absorbs the blast and preserves the execution", () => {
        const h = fixture({ neighbor: { abilities: ["Water Shield"] } });
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        const priced = h.target.getCumulativeHp();
        expect(cast.features).toMatchObject({ expectedDamage: priced, expectedKill: 1 });
        expect(h.neighbor.hasBuffActive("Water Shield")).toBe(true);
        expect(h.fire(cast)).toMatchObject({ friendlyLoss: 0, enemyLoss: priced });
        expect(h.neighbor.hasBuffActive("Water Shield")).toBe(false);
        expect(h.neighbor.getCumulativeHp()).toBe(500);
    });

    test("an absorbed lethal spell does not trigger Last Fuse", () => {
        const h = fixture({ ring: "archmage", target: { abilities: ["Water Shield"] } });
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        expect(cast.features).toMatchObject({ expectedDamage: 0, expectedKill: 0 });
        expect(h.fire(cast)).toMatchObject({ blasts: [], friendlyLoss: 0, netDamage: 0 });
    });

    test("a blast that would destroy another enemy is left to search", () => {
        const h = fixture({ neighbor: { maxHp: 20 } });
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        const priced = h.target.getCumulativeHp();
        expect(cast.features).toMatchObject({ expectedDamage: priced, expectedKill: 1 });
        const result = h.fire(cast);
        expect(result.friendlyLoss).toBe(0);
        expect(result.enemyLoss).toBeGreaterThan(priced);
        expect(h.neighbor && (h.neighbor.isDead() || !h.unitsHolder.getAllUnits().has(h.neighbor.getId()))).toBe(true);
    });

    test("native resurrection is neither a Last Fuse detonation nor a secure spell kill", () => {
        const h = fixture({ target: { abilities: ["Resurrection"], spells: ["System:Resurrection"] } });
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        expect(cast.features).toMatchObject({ expectedDamage: 10, expectedKill: 0 });
        expect(h.fire(cast).blasts).toHaveLength(0);
        expect(h.target.isDead()).toBe(false);
    });

    test.each(["mage", "archmage"] as const)("%s ring and enemy Arcane Aegis use the engine's damage", (ring) => {
        const h = fixture({ ring, fuse: false, aegis: true, target: { maxHp: 1000 } });
        h.unitsHolder.refreshStackPowerForAllUnits();
        const cast = h.catalog().find((c) => c.kind === "spell" && c.targetId === h.target.getId())!;
        expect(h.target.getMagicResist()).toBe(18);
        expect(h.fire(cast).netDamage).toBe(cast.features.expectedDamage);
    });

    test.each(["Life:Meteorite", "Nature:Meteor Shower"])(
        "%s with Archmage's Ring avoids a larger shielded cluster",
        (spell) => {
            const h = fixture({
                spell,
                ring: "archmage",
                fuse: false,
                target: { maxHp: 1000, abilities: ["Water Shield"] },
            });
            const shielded = createTestUnit({
                name: "Second shield",
                team: RIGHT,
                maxHp: 1000,
                abilities: ["Water Shield"],
            });
            placeUnit(h.grid, h.unitsHolder, shielded, { x: 9, y: 9 });
            shielded.trySeedWaterShield();
            const cast = selectV08DamageSpellCandidate(h.caster, h.catalog())!;
            expect(cast).toBeDefined();
            const safeHp = h.safe.getCumulativeHp();
            h.fire(cast);
            expect(h.safe.getCumulativeHp()).toBe(safeHp - cast.features.expectedDamage);
            expect(h.target.getCumulativeHp()).toBe(1000);
            expect(shielded.getCumulativeHp()).toBe(1000);
        },
    );
});
