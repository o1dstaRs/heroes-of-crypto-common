import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { reserveChoiceDiversity } from "../../src/simulation/melee_barrel_choice_diversity_research";

const action = (type: string, spellName?: string, damage = 0) => ({
    actions: [{ type, ...(spellName ? { spellName } : {}) }],
    features: { expectedDamage: damage },
});

test("replaces redundant buff targets with the highest finite walk and legal wait, within the original cap", () => {
    const [incumbent, a, b, c, walk1, walk2, wait] = [
        action("obstacle_attack"),
        action("cast_spell", "Bless"),
        action("cast_spell", "Bless"),
        action("cast_spell", "Bless"),
        action("move_unit"),
        action("move_unit"),
        action("wait_turn"),
    ];
    const candidates = [incumbent, a, b, c, walk1, walk2, wait];
    const retained = [incumbent, a, b, c];
    const result = reserveChoiceDiversity(candidates, retained, [0, 0.9, 0.8, 0.7, 0.2, 0.3, 0.1]);
    expect(result).toEqual([incumbent, a, wait, walk2]);
    expect(retained).toEqual([incumbent, a, b, c]);
    expect(result.length).toBe(retained.length);
});

test("never evicts the native incumbent or a unique spell", () => {
    const candidates = [
        action("obstacle_attack"),
        action("cast_spell", "Bless"),
        action("cast_spell", "Shield"),
        action("move_unit"),
    ];
    const retained = candidates.slice(0, 3);
    expect(reserveChoiceDiversity(candidates, retained, [0.1, 0.2, 0.3, 0.4])).toBe(retained);
});

test("keeps the existing best movement and excludes illegal alternatives", () => {
    const candidates = [
        action("obstacle_attack"),
        action("cast_spell", "Bless"),
        action("cast_spell", "Bless"),
        action("move_unit"),
        action("wait_turn"),
    ];
    const retained = candidates.slice(0, 4);
    expect(reserveChoiceDiversity(candidates, retained, [0, 0.9, 0.8, 0.3, -Infinity])).toBe(retained);
});

test("preserves damaging target alternatives and protected Vine reservations", () => {
    for (const [name, damage] of [
        ["Vine Throw", 0],
        ["Resurrection", 0],
        ["Bolt", 15],
    ] as const) {
        const candidates = [
            action("obstacle_attack"),
            action("cast_spell", name, damage),
            action("cast_spell", name, damage),
            action("move_unit"),
        ];
        const retained = candidates.slice(0, 3);
        expect(reserveChoiceDiversity(candidates, retained, [0, 0.2, 0.1, 0.3])).toBe(retained);
    }
});

test("rejects malformed evidence and creates no new candidate", () => {
    const candidates = [
        action("obstacle_attack"),
        action("cast_spell", "Bless"),
        action("cast_spell", "Bless"),
        action("wait_turn"),
    ];
    const retained = candidates.slice(0, 3);
    expect(reserveChoiceDiversity(candidates, retained, [1])).toBe(retained);
    expect(
        reserveChoiceDiversity(candidates, retained, [0, 0.2, 0.1, 0.3]).every((candidate) =>
            candidates.includes(candidate),
        ),
    ).toBe(true);
});

test("the experiment stays outside default A19 and native strategy code", () => {
    for (const path of [
        "../../src/simulation/search_driver.ts",
        "../../src/ai/versions/v0_8_a19_profile.ts",
        "../../src/ai/versions/v0_8.ts",
    ]) {
        expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain(
            "melee_barrel_choice_diversity_research",
        );
    }
});
