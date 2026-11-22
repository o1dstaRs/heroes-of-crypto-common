import { afterEach, describe, expect, test } from "bun:test";

import { a19WildRegenGiftEnabled, isWorthwhileWildRegenerationGift } from "../../src/ai/wild_regeneration_gift";
import type { Unit } from "../../src/units/unit";

const unit = (maxHp: number, options: { regenerates?: boolean; holyCross?: boolean } = {}): Unit =>
    ({
        getMaxHp: () => maxHp,
        hasAbilityActive: (name: string) => name === "Wild Regeneration" && !!options.regenerates,
        hasBuffActive: (name: string) => name === "Holy Cross" && !!options.holyCross,
    }) as unknown as Unit;

describe("a19-wild-regen-gift-v1", () => {
    const saved = { left: process.env.A19_WILD_REGEN_GIFT_LEFT, right: process.env.A19_WILD_REGEN_GIFT_RIGHT };
    afterEach(() => {
        for (const [name, value] of [
            ["A19_WILD_REGEN_GIFT_LEFT", saved.left],
            ["A19_WILD_REGEN_GIFT_RIGHT", saved.right],
        ] as const) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });

    test("the owner's case: a Troll gives it to the Griffin, not to a Fairy", () => {
        const troll = unit(40);
        expect(isWorthwhileWildRegenerationGift(troll, unit(72))).toBe(true);
        expect(isWorthwhileWildRegenerationGift(troll, unit(7))).toBe(false);
        expect(isWorthwhileWildRegenerationGift(troll, unit(40))).toBe(false);
    });

    test("an ally that already regenerates gains nothing", () => {
        expect(isWorthwhileWildRegenerationGift(unit(40), unit(72, { regenerates: true }))).toBe(false);
    });

    test("Holy Cross keeps the caster's card, so any ally without it gains", () => {
        expect(isWorthwhileWildRegenerationGift(unit(40, { holyCross: true }), unit(7))).toBe(true);
        expect(isWorthwhileWildRegenerationGift(unit(40, { holyCross: true }), unit(7, { regenerates: true }))).toBe(
            false,
        );
    });

    test("per-seat switch: on unless 0", () => {
        delete process.env.A19_WILD_REGEN_GIFT_LEFT;
        delete process.env.A19_WILD_REGEN_GIFT_RIGHT;
        expect(a19WildRegenGiftEnabled(1)).toBe(true);
        expect(a19WildRegenGiftEnabled(2)).toBe(true);
        process.env.A19_WILD_REGEN_GIFT_RIGHT = "0";
        expect(a19WildRegenGiftEnabled(1)).toBe(false);
        expect(a19WildRegenGiftEnabled(2)).toBe(true);
    });
});
