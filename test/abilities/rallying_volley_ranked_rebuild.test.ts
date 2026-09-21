/*
 * -----------------------------------------------------------------------------
 * Rallying Volley on a RANKED CLIENT. The client rebuilds every unit from the server's snapshot, whose
 * range_shots is the REMAINING count with the Limited Supply cap and Zena's top-up already applied, and
 * stamps it range_shots_authoritative. The engine must then keep that number verbatim:
 *
 *  - re-running the Limited Supply cap compounds it, because the rebuilt unit's maxRangeShots is only the
 *    remaining count rather than the full quiver — a stack-power-1 Arbalester the server had at 4 (2 capped
 *    + Zena's 2) showed 2, its base cap, which is what "Zena gives no extra shots" looked like;
 *  - re-running the aura top-up double-grants — a 20-quiver Elf the server had at 22 showed 24.
 *
 * Locally simulated units (no flag) keep deriving both themselves; rallying_volley_aura.test.ts covers them.
 * -----------------------------------------------------------------------------
 */

import { describe, expect, it } from "bun:test";

import { AbilityFactory } from "../../src/abilities/ability_factory";
import { getAbilityConfig, getCreatureConfig } from "../../src/configuration/config_provider";
import { MAX_UNIT_STACK_POWER } from "../../src/constants";
import { EffectFactory } from "../../src/effects/effect_factory";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { Unit } from "../../src/units/unit";
import { createCombatTestContext, placeUnit } from "../helpers/combat";

const AURA_SHOTS = getAbilityConfig("Rallying Volley Aura").power;

interface IArcherBuild {
    faction: string;
    name: string;
    texture: string;
    amount: number;
    /** The snapshot's remaining count a ranked client rebuilds the archer from; omitted = built from config. */
    authoritativeShots?: number;
}

/** A huge Zena stack beside the archer, so the archer sits at the bottom stack-power band and is in range. */
const buildArmy = (archer: IArcherBuild) => {
    const ctx = createCombatTestContext();
    const effectFactory = new EffectFactory();
    const abilityFactory = new AbilityFactory(effectFactory);
    const build = (faction: string, name: string, texture: string, amount: number, shots?: number) => {
        const config = getCreatureConfig(PBTypes.TeamVals.LEFT, faction, name, texture, amount, 0);
        if (shots !== undefined) {
            config.range_shots = shots;
            config.range_shots_authoritative = true;
        }
        return Unit.createUnit(
            config,
            ctx.grid.getSettings(),
            PBTypes.TeamVals.LEFT,
            PBTypes.UnitVals.CREATURE,
            abilityFactory,
            effectFactory,
            false,
        );
    };
    const zena = build("Might", "Zena", "zena_512", 60);
    const unit = build(archer.faction, archer.name, archer.texture, archer.amount, archer.authoritativeShots);
    ctx.unitsHolder.addUnit(zena);
    ctx.unitsHolder.addUnit(unit);
    placeUnit(ctx.grid, ctx.unitsHolder, zena, { x: 3, y: 3 });
    placeUnit(ctx.grid, ctx.unitsHolder, unit, { x: 4, y: 3 });
    // The sandbox refresh order, twice, exactly as Sandbox.refreshUnits() runs it on the client.
    for (let pass = 0; pass < 2; pass += 1) {
        ctx.unitsHolder.refreshAuraEffectsForAllUnits();
        ctx.unitsHolder.refreshStackPowerForAllUnits();
    }
    return unit;
};

const ARBALESTER: IArcherBuild = { faction: "Life", name: "Arbalester", texture: "arbalester_512", amount: 12 };
const ELF: IArcherBuild = { faction: "Nature", name: "Elf", texture: "elf_512", amount: 12 };

describe("Rallying Volley Aura on a ranked client rebuilt from the snapshot", () => {
    it("keeps a Limited Supply archer at the server's count instead of capping it a second time", () => {
        // The server: full quiver, capped by stack power, plus Zena's shots on top.
        const server = buildArmy(ARBALESTER);
        const ownQuiver = getCreatureConfig(
            PBTypes.TeamVals.LEFT,
            "Life",
            "Arbalester",
            "arbalester_512",
            12,
            0,
        ).range_shots;
        expect(server.hasAbilityActive("Limited Supply")).toBe(true);
        expect(server.getStackPower()).toBeLessThan(MAX_UNIT_STACK_POWER);
        const cap = Math.floor((ownQuiver * server.getStackPower()) / MAX_UNIT_STACK_POWER);
        expect(server.getRangeShots()).toBe(cap + AURA_SHOTS);

        // The client: the same archer rebuilt from that remaining count. Before the flag was honoured this
        // came out as floor(count × coeff) + 2 — the base cap again, with Zena's shots invisible.
        const client = buildArmy({ ...ARBALESTER, authoritativeShots: server.getRangeShots() });
        expect(client.getStackPower()).toBe(server.getStackPower());
        expect(client.getRangeShots()).toBe(server.getRangeShots());
        expect(client.getAppliedAuraEffect("Rallying Volley Aura")?.getPower()).toBe(AURA_SHOTS);
    });

    it("does not top a plain archer up a second time", () => {
        const server = buildArmy(ELF);
        const ownQuiver = getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", "Elf", "elf_512", 12, 0).range_shots;
        expect(server.getRangeShots()).toBe(ownQuiver + AURA_SHOTS);

        const client = buildArmy({ ...ELF, authoritativeShots: server.getRangeShots() });
        expect(client.getRangeShots()).toBe(server.getRangeShots());
        // The aura itself still lands (it is what the HUD lists); only the quiver is left to the server.
        expect(client.getAppliedAuraEffect("Rallying Volley Aura")?.getPower()).toBe(AURA_SHOTS);
        expect(client.getUnitProperties().rallying_volley_granted).toBe(0);
    });

    it("still tops up and caps a locally simulated archer (no flag)", () => {
        const local = buildArmy({ ...ARBALESTER, amount: 12 });
        expect(local.getUnitProperties().rallying_volley_granted).toBe(AURA_SHOTS);
        const spentTwo = buildArmy(ELF);
        spentTwo.decreaseNumberOfShots();
        expect(spentTwo.getRangeShots()).toBe(
            getCreatureConfig(PBTypes.TeamVals.LEFT, "Nature", "Elf", "elf_512", 12, 0).range_shots + AURA_SHOTS - 1,
        );
    });
});
