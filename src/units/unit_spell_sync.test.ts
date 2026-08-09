import { describe, expect, test } from "bun:test";

import {
    AbilityFactory,
    EffectFactory,
    GridConstants,
    GridSettings,
    HoCConfig,
    TeamVals,
    Unit,
    UnitVals,
} from "../index";

/**
 * syncAuthoritativeSpellEntries is how the ranked client mirrors the server's spellbook after a
 * cast: the client never runs the cast engine, so BOTH the Spell objects (book cards, AI
 * castability) and the raw unitProperties.spells entry list (the sidebar's scroll count) must be
 * forced to the snapshot's exact entries. Leaving the raw list stale is the "still 3/3 after
 * casting Lightning in ranked" bug — the count froze at the base value forever.
 */

const gridSettings = new GridSettings(
    GridConstants.GRID_SIZE,
    GridConstants.MAX_Y,
    GridConstants.MIN_Y,
    GridConstants.MAX_X,
    GridConstants.MIN_X,
    GridConstants.MOVEMENT_DELTA,
    GridConstants.UNIT_SIZE_DELTA,
);

const createMagicDragon = (): Unit => {
    const effectFactory = new EffectFactory();
    return Unit.createUnit(
        HoCConfig.getCreatureConfig(TeamVals.LOWER, "Nature", "Magic Dragon", "magic_dragon_512", 1),
        gridSettings,
        TeamVals.LOWER,
        UnitVals.CREATURE,
        new AbilityFactory(effectFactory),
        effectFactory,
        false,
    );
};

const amountByName = (unit: Unit): Record<string, number> =>
    Object.fromEntries(unit.getSpells().map((spell) => [spell.getName(), spell.getAmount()]));

describe("Unit.syncAuthoritativeSpellEntries", () => {
    test("a spent cast shrinks BOTH the Spell amounts and the raw properties entry list", () => {
        const dragon = createMagicDragon();
        const baseEntries = [...dragon.getUnitProperties().spells];
        expect(baseEntries.filter((entry) => entry.endsWith(":Lightning Strike"))).toHaveLength(4);

        // The server's snapshot after one Lightning Strike cast: the same book minus one entry.
        const afterCast = [...baseEntries];
        afterCast.splice(afterCast.indexOf("Nature:Lightning Strike"), 1);
        dragon.syncAuthoritativeSpellEntries(afterCast);

        expect(dragon.getUnitProperties().spells).toEqual(afterCast);
        // The sidebar reads this length as the scroll count — it must drop with the cast.
        expect(dragon.getUnitProperties().spells).toHaveLength(baseEntries.length - 1);
        expect(amountByName(dragon)["Lightning Strike"]).toBe(3);
    });

    test("an authoritative EMPTY book zeroes every spell and the scroll count", () => {
        const dragon = createMagicDragon();
        dragon.syncAuthoritativeSpellEntries([]);
        expect(dragon.getUnitProperties().spells).toHaveLength(0);
        expect(Object.values(amountByName(dragon)).every((amount) => amount === 0)).toBe(true);
    });

    test("the sync is idempotent and re-raises after a Spellbook transfer grants entries back", () => {
        const dragon = createMagicDragon();
        const entries = [...dragon.getUnitProperties().spells];
        dragon.syncAuthoritativeSpellEntries(entries);
        dragon.syncAuthoritativeSpellEntries(entries);
        expect(dragon.getUnitProperties().spells).toEqual(entries);
        expect(amountByName(dragon)["Lightning Strike"]).toBe(4);

        // Server says a transfer refilled a charge that was down to 2: amounts follow the entries.
        const reduced = entries
            .filter((entry) => entry !== "Nature:Lightning Strike")
            .concat(["Nature:Lightning Strike", "Nature:Lightning Strike"]);
        dragon.syncAuthoritativeSpellEntries(reduced);
        expect(amountByName(dragon)["Lightning Strike"]).toBe(2);
    });
});
