import { afterEach, describe, expect, test } from "bun:test";

import { hasDoubleShotAbility } from "../../src/abilities/ability_helper";
import type { IDecisionContext } from "../../src/ai/ai_strategy";
import { enumerateCandidates, evaluateRangeCandidateDamage } from "../../src/ai/candidates";
import { selectV08DirectCombatCandidate, selectV08SplashRangedCandidate } from "../../src/ai/versions/v0_8";
import { Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { getEffectConfig, getSpellConfig } from "../../src/configuration/config_provider";
import { Effect } from "../../src/effects/effect";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import type { TeamType } from "../../src/generated/protobuf/v1/types_gen";
import { PathHelper } from "../../src/grid/path_helper";
import { Spell } from "../../src/spells/spell";
import { setDeterministicRandomSource } from "../../src/utils/lib";
import { createCombatTestContext, createTestUnit, createVisibleDamage, placeUnit } from "../helpers/combat";

const LEFT = PBTypes.TeamVals.LEFT;
const RIGHT = PBTypes.TeamVals.RIGHT;
type ShotKind = "ordinary" | "area" | "through";

class NeedsRoll extends Error {}

function scenario(
    kind: ShotKind,
    shots: number,
    dense: "primary" | "secondary" | "none",
    double: boolean,
    echo: boolean,
    options: {
        rolls?: readonly number[];
        team?: TeamType;
        direction?: { x: number; y: number };
        rectangle?: boolean;
        endless?: boolean;
        primaryHp?: number;
        shield?: "primary" | "secondary" | "both";
        fire?: boolean;
        damage?: number;
    } = {},
) {
    const { rolls, team = LEFT, direction = { x: 1, y: 0 } } = options;
    const enemyTeam = team === LEFT ? RIGHT : LEFT;
    setDeterministicRandomSource(undefined);
    const combat = createCombatTestContext();
    const abilities = kind === "area" ? ["Area Throw"] : kind === "through" ? ["Through Shot"] : [];
    if (double) abilities.push(kind === "area" ? "Double Throw" : "Crafted Double Shot");
    if (options.endless) abilities.push("Endless Quiver");
    if (options.fire) abilities.push("Fire Element");
    const shooter = createTestUnit({
        name: "Shooter",
        team,
        attackType: PBTypes.AttackVals.RANGE,
        damageMin: options.damage ?? 40,
        damageMax: options.damage ?? 40,
        attack: 10,
        stackPower: 5,
        rangeShots: shots,
        abilities,
    });
    const primary = createTestUnit({
        name: "Primary",
        team: enemyTeam,
        maxHp: options.primaryHp ?? 100_000,
        armor: 10,
        footprintWidth: options.rectangle ? 1 : undefined,
        footprintHeight: options.rectangle ? 2 : undefined,
        abilities: [
            ...(dense === "primary" ? ["Dense Flesh"] : []),
            ...(options.shield === "primary" || options.shield === "both" ? ["Water Shield"] : []),
        ],
    });
    const secondary = createTestUnit({
        name: "Secondary",
        team: enemyTeam,
        maxHp: 100_000,
        armor: 10,
        abilities: [
            ...(dense === "secondary" ? ["Dense Flesh"] : []),
            ...(options.shield === "secondary" || options.shield === "both" ? ["Water Shield"] : []),
        ],
    });
    const primaryCell = { x: 8 + direction.x * 4, y: 8 + direction.y * 4 };
    placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 8, y: 8 });
    placeUnit(combat.grid, combat.unitsHolder, primary, primaryCell);
    placeUnit(
        combat.grid,
        combat.unitsHolder,
        secondary,
        kind === "area"
            ? { x: primaryCell.x - direction.y, y: primaryCell.y + direction.x }
            : { x: primaryCell.x + direction.x * 2, y: primaryCell.y + direction.y * 2 },
    );
    const fight = FightStateManager.getInstance().getFightProperties();
    if (echo) {
        fight.setArtifactPerTeam(team, 2, Tier2Artifact.QUIVER_OF_ECHOES);
        combat.unitsHolder.applyArtifacts(fight);
    }
    if (options.endless) combat.unitsHolder.refreshStackPowerForAllUnits();
    primary.trySeedWaterShield();
    secondary.trySeedWaterShield();
    if (rolls) {
        shooter.applyEffect(new Effect({ ...getEffectConfig("Boar Saliva"), power: 50 }));
        expect(shooter.calculateMissChance(primary, 0)).toBe(50);
        if (echo) {
            shooter.deleteBuff("Quiver of Echoes");
            shooter.applyBuff(
                new Spell({
                    spellProperties: { ...getSpellConfig("System", "Quiver of Echoes"), power: 50 },
                    amount: 1,
                }),
            );
        }
    }
    shooter.refreshPossibleAttackTypes(true);
    const evaluation = combat.attackHandler.evaluateRangeAttack(
        combat.unitsHolder.getAllUnits(),
        shooter,
        shooter.getPosition(),
        primary.getPosition(),
        kind === "through",
        false,
        kind === "area",
    );
    const context: IDecisionContext = {
        grid: combat.grid,
        matrix: combat.grid.getMatrix(),
        unitsHolder: combat.unitsHolder,
        pathHelper: new PathHelper(combat.grid.getSettings()),
        attackHandler: combat.attackHandler,
        fightProperties: fight,
    };
    const before = JSON.stringify([
        shooter.getUnitProperties(),
        primary.getUnitProperties(),
        secondary.getUnitProperties(),
    ]);
    setDeterministicRandomSource(() => {
        throw new Error("Estimation must not consume combat randomness");
    });
    const estimate = evaluateRangeCandidateDamage(
        shooter,
        context,
        evaluation,
        primary.getId(),
        hasDoubleShotAbility(shooter) ? 2 : 1,
        kind === "area",
    );
    expect(
        JSON.stringify([shooter.getUnitProperties(), primary.getUnitProperties(), secondary.getUnitProperties()]),
    ).toBe(before);
    const hpBefore = primary.getCumulativeHp() + secondary.getCumulativeHp();
    let rawDraw = 0;
    setDeterministicRandomSource(() => {
        if (!rolls) return 0;
        const roll = rolls[Math.floor(rawDraw / 2)];
        if (roll === undefined) throw new NeedsRoll();
        return rawDraw++ % 2 === 0 ? 0 : roll / 0x100000000;
    });
    const damage = createVisibleDamage(primary);
    const result = combat.attackHandler.handleRangeAttack(
        combat.unitsHolder,
        evaluation.rangeAttackDivisors,
        1,
        damage,
        shooter,
        evaluation.affectedUnits,
        undefined,
        primary.getPosition(),
        kind === "area",
    );
    expect(result.completed).toBe(true);
    return {
        estimate: estimate.value,
        actual: hpBefore - primary.getCumulativeHp() - secondary.getCumulativeHp(),
        chance: shooter.getBonusRangedAttackChance() / 100,
        shotsRemaining: shooter.getRangeShots(),
    };
}

afterEach(() => setDeterministicRandomSource(undefined));

describe("artifact ranged estimates follow the resolver's ammunition rules", () => {
    for (const kind of ["ordinary", "area", "through"] as const) {
        for (const double of [false, true]) {
            for (const shield of ["primary", "secondary", "both"] as const) {
                test.each([1, 2, 3])(`${kind} shield=${shield}, double=${double}, %i arrows`, (shots) => {
                    const base = scenario(kind, shots, "primary", double, false, { shield });
                    const echo = scenario(kind, shots, "primary", double, true, { shield });
                    expect(base.estimate).toBeCloseTo(base.actual, 8);
                    expect(echo.estimate).toBeCloseTo(base.actual * (1 - echo.chance) + echo.actual * echo.chance, 8);
                });
            }
        }
    }

    for (const double of [false, true]) {
        test.each([1, 2, 3])(
            "shielded Echo keeps miss-dependent ammunition, double=" + double + ", %i arrows",
            (shots) => {
                let estimate = 0;
                const resolve = (rolls: number[]): number => {
                    expect(rolls.length).toBeLessThan(10);
                    try {
                        const result = scenario("ordinary", shots, "primary", double, true, {
                            rolls,
                            shield: "primary",
                        });
                        estimate = result.estimate;
                        return result.actual;
                    } catch (error) {
                        if (!(error instanceof NeedsRoll)) throw error;
                        return 0.5 * resolve([...rolls, 0]) + 0.5 * resolve([...rolls, 99]);
                    }
                };
                expect(resolve([])).toBeCloseTo(estimate, 8);
            },
        );
    }

    for (const kind of ["ordinary", "area", "through"] as const) {
        test.each([{ endless: true }, { fire: true }, { damage: 0 }])(`${kind} shielded Echo handles %j`, (options) => {
            const base = scenario(kind, 3, "primary", true, false, { ...options, shield: "both" });
            const echo = scenario(kind, 3, "primary", true, true, { ...options, shield: "both" });
            expect(base.estimate).toBeCloseTo(base.actual, 8);
            expect(echo.estimate).toBeCloseTo(base.actual * (1 - echo.chance) + echo.actual * echo.chance, 8);
        });
    }

    test("Echo targets exposed damage instead of pricing the shield-breaking arrow as damage", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Echo archer",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            damageMin: 40,
            damageMax: 40,
            rangeShots: 6,
        });
        const shielded = createTestUnit({
            team: RIGHT,
            name: "Shielded",
            maxHp: 1000,
            armor: 5.5,
            abilities: ["Water Shield"],
        });
        const exposed = createTestUnit({ team: RIGHT, name: "Exposed", maxHp: 1000, armor: 10 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, shielded, { x: 8, y: 3 });
        placeUnit(combat.grid, combat.unitsHolder, exposed, { x: 8, y: 8 });
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
        combat.unitsHolder.applyArtifacts(fight);
        shielded.trySeedWaterShield();
        shooter.refreshPossibleAttackTypes(true);
        const candidates = enumerateCandidates(
            shooter,
            {
                ...combat,
                matrix: combat.grid.getMatrix(),
                fightProperties: fight,
                pathHelper: new PathHelper(combat.grid.getSettings()),
            },
            [{ type: "defend_turn", unitId: shooter.getId() }],
        ).candidates;
        expect(selectV08DirectCombatCandidate(candidates)?.targetId).toBe(exposed.getId());
    });

    for (const kind of ["ordinary", "area", "through"] as const) {
        for (const double of [false, true]) {
            for (const dense of ["none", "primary", "secondary"] as const) {
                test.each([1, 2, 3, 4, 5, 6])(`${kind}, double=${double}, Dense Flesh=${dense}, %i arrows`, (shots) => {
                    const base = scenario(kind, shots, dense, double, false);
                    const quiver = scenario(kind, shots, dense, double, true);
                    expect(base.estimate).toBeCloseTo(base.actual, 8);
                    expect(quiver.estimate).toBeCloseTo(
                        base.actual * (1 - quiver.chance) + quiver.actual * quiver.chance,
                        8,
                    );
                });
            }
        }
    }

    for (const double of [false, true]) {
        for (const dense of ["none", "primary"] as const) {
            test.each([1, 2, 3])(
                `ordinary misses preserve arrows, double=${double}, Dense Flesh=${dense}, %i arrows`,
                (shots) => {
                    let estimate = 0;
                    const resolve = (rolls: number[]): number => {
                        expect(rolls.length).toBeLessThan(10);
                        try {
                            const result = scenario("ordinary", shots, dense, double, true, { rolls });
                            estimate = result.estimate;
                            return result.actual;
                        } catch (error) {
                            if (!(error instanceof NeedsRoll)) throw error;
                            return 0.5 * resolve([...rolls, 0]) + 0.5 * resolve([...rolls, 99]);
                        }
                    };
                    // Every engine roll in this fixed-damage fixture is 50/50: enumerate its actual branches.
                    const actualExpectedDamage = resolve([]);
                    expect(estimate).toBeCloseTo(actualExpectedDamage, 8);
                },
            );
        }
    }

    for (const kind of ["ordinary", "area", "through"] as const) {
        for (const team of [LEFT, RIGHT] as const) {
            test.each([
                { x: 1, y: 0 },
                { x: -1, y: 0 },
                { x: 0, y: 1 },
                { x: 0, y: -1 },
            ])(`${kind}, team=${team}, direction=%j`, (direction) => {
                const options = { team, direction };
                const base = scenario(kind, 3, "secondary", true, false, options);
                const quiver = scenario(kind, 3, "secondary", true, true, options);
                expect(quiver.estimate).toBeCloseTo(
                    base.actual * (1 - quiver.chance) + quiver.actual * quiver.chance,
                    8,
                );
            });
        }
        test.each([{ rectangle: true }, { endless: true }, { primaryHp: 1 }])(`${kind}, %j`, (options) => {
            const base = scenario(kind, 3, "secondary", true, false, options);
            const quiver = scenario(kind, 3, "secondary", true, true, options);
            expect(quiver.estimate).toBeCloseTo(base.actual * (1 - quiver.chance) + quiver.actual * quiver.chance, 8);
        });
    }

    test("selects the stronger splash instead of discounting Echo against a Dense Flesh bystander", () => {
        const combat = createCombatTestContext();
        const shooter = createTestUnit({
            name: "Shooter",
            team: LEFT,
            attackType: PBTypes.AttackVals.RANGE,
            attack: 10,
            damageMin: 40,
            damageMax: 40,
            rangeShots: 2,
            abilities: ["Area Throw"],
            stackPower: 5,
        });
        const primary = createTestUnit({ name: "Primary", team: RIGHT, maxHp: 100_000, armor: 10 });
        const bystander = createTestUnit({
            name: "Dense bystander",
            team: RIGHT,
            maxHp: 100_000,
            armor: 10,
            abilities: ["Dense Flesh"],
        });
        const isolated = createTestUnit({ name: "Isolated", team: RIGHT, maxHp: 100_000, armor: 5.5 });
        placeUnit(combat.grid, combat.unitsHolder, shooter, { x: 2, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, primary, { x: 7, y: 5 });
        placeUnit(combat.grid, combat.unitsHolder, bystander, { x: 7, y: 6 });
        placeUnit(combat.grid, combat.unitsHolder, isolated, { x: 7, y: 10 });
        const fight = FightStateManager.getInstance().getFightProperties();
        fight.setArtifactPerTeam(LEFT, 2, Tier2Artifact.QUIVER_OF_ECHOES);
        combat.unitsHolder.applyArtifacts(fight);
        shooter.refreshPossibleAttackTypes(true);
        const candidates = enumerateCandidates(
            shooter,
            {
                grid: combat.grid,
                matrix: combat.grid.getMatrix(),
                unitsHolder: combat.unitsHolder,
                pathHelper: new PathHelper(combat.grid.getSettings()),
                attackHandler: combat.attackHandler,
                fightProperties: fight,
            },
            [{ type: "end_turn", unitId: shooter.getId(), reason: "manual" }],
        ).candidates.filter((c) => c.kind === "shot");
        const clusterShot = candidates.find((c) => c.targetId === primary.getId())!;
        const isolatedShot = candidates.find((c) => c.targetId === isolated.getId())!;
        expect(clusterShot).toBeDefined();
        expect(isolatedShot).toBeDefined();
        expect(clusterShot.features.expectedDamage).toBeGreaterThan(isolatedShot.features.expectedDamage);
        expect(selectV08SplashRangedCandidate(candidates)?.targetId).toBe(primary.getId());
    });
});
