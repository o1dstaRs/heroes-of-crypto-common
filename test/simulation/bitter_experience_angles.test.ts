import { test, expect } from "bun:test";
import { createCombatTestContext, createTestUnit, placeUnit, testGridSettings } from "../helpers/combat";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { SceneLogMock } from "../../src/scene/scene_log_mock";
import { projectAttackDamageBand } from "../../src/damage/damage_projection";
import { getSpellConfig } from "../../src/configuration/config_provider";
import { Spell } from "../../src/spells/spell";
import { spellDamageAgainstUnit } from "../../src/spells/spell_cast_projection";
import { enumerateCandidates } from "../../src/ai/candidates";
import { PathHelper } from "../../src/grid/path_helper";
import { info, neutralizeBonus } from "../helpers/bitter_experience_ablation";
const L = PBTypes.TeamVals.LEFT,
    R = PBTypes.TeamVals.RIGHT;
for (const armor of [7, 14, 21])
    test(`bonus armor reduces ordinary melee and ranged damage at base ${armor}, not spell damage`, () => {
        createCombatTestContext();
        const u = createTestUnit({
            name: "Peasant",
            team: L,
            maxHp: 8,
            amountAlive: 40,
            armor,
            abilities: ["Bitter Experience"],
        });
        const foe = createTestUnit({
            team: R,
            attack: 14,
            amountAlive: 10,
            damageMin: 10,
            damageMax: 10,
            rangeShots: 10,
        });
        u.applyDamage(10, 0, new SceneLogMock());
        u.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        const withBonus = info(u),
            melee = () =>
                projectAttackDamageBand({
                    attacker: foe,
                    target: u,
                    attackType: PBTypes.AttackVals.MELEE,
                    synergyAbilityPowerIncrease: 0,
                }).min,
            range = () =>
                projectAttackDamageBand({
                    attacker: foe,
                    target: u,
                    attackType: PBTypes.AttackVals.RANGE,
                    synergyAbilityPowerIncrease: 0,
                }).min;
        const spells = [
            new Spell({ spellProperties: getSpellConfig("Chaos", "Fireball"), amount: 1 }),
            new Spell({ spellProperties: getSpellConfig("Nature", "Lightning Strike"), amount: 1 }),
        ];
        const before = { melee: melee(), range: range(), spells: spells.map((s) => spellDamageAgainstUnit(s, 100, u)) };
        neutralizeBonus(u, 0, "armor");
        u.adjustBaseStats(true, 1, 0, 0, 0, 0, 0);
        expect(info(u).hp).toBe(withBonus.hp);
        expect(info(u).stacks).toBe(withBonus.stacks);
        expect(melee()).toBeGreaterThan(before.melee);
        expect(range()).toBeGreaterThan(before.range);
        expect(spells.map((s) => spellDamageAgainstUnit(s, 100, u))).toEqual(before.spells);
    });
test("the movement bonus can unlock a real legal move-and-strike on the next decision", () => {
    const c = createCombatTestContext(),
        u = createTestUnit({
            name: "Peasant",
            team: L,
            maxHp: 8,
            amountAlive: 40,
            armor: 7,
            abilities: ["Bitter Experience"],
        }),
        foe = createTestUnit({ team: R, amountAlive: 10 });
    placeUnit(c.grid, c.unitsHolder, u, { x: 8, y: 4 });
    placeUnit(c.grid, c.unitsHolder, foe, { x: 8, y: 9 });
    const canReach = () =>
        enumerateCandidates(
            u,
            {
                grid: c.grid,
                matrix: c.grid.getMatrix(),
                unitsHolder: c.unitsHolder,
                pathHelper: new PathHelper(testGridSettings),
                attackHandler: c.attackHandler,
            },
            [{ type: "defend_turn", unitId: u.getId() }],
        ).candidates.some((x) => x.actions.some((a) => a.type === "melee_attack" && a.targetId === foe.getId()));
    expect(u.getSteps()).toBe(3);
    expect(canReach()).toBe(false);
    u.applyDamage(10, 0, new SceneLogMock());
    expect(u.getSteps()).toBe(4);
    expect(canReach()).toBe(true);
    const hp = u.getCumulativeHp();
    neutralizeBonus(u, 0, "steps");
    expect(u.getCumulativeHp()).toBe(hp);
    expect(canReach()).toBe(false);
});
test("minimum one-point physical hits can make another armor point locally worthless", () => {
    createCombatTestContext();
    const u = createTestUnit({
            name: "Peasant",
            team: L,
            maxHp: 8,
            amountAlive: 40,
            armor: 21,
            abilities: ["Bitter Experience"],
        }),
        foe = createTestUnit({ team: R, attack: 1, amountAlive: 1, damageMin: 1, damageMax: 1 });
    const hit = () =>
        projectAttackDamageBand({
            attacker: foe,
            target: u,
            attackType: PBTypes.AttackVals.MELEE,
            synergyAbilityPowerIncrease: 0,
        }).min;
    u.applyDamage(10, 0, new SceneLogMock());
    expect(hit()).toBe(1);
    neutralizeBonus(u, 0, "armor");
    expect(hit()).toBe(1);
});
