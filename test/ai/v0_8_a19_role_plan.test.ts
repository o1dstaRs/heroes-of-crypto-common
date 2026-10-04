import { describe, expect, it } from "bun:test";
import { roleSearchPlan, v08A19RoleSearchOverrides } from "../../src/ai/versions/v0_8_a19_role_plan";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
const mage = ["Dryad", "Troll", "Fairy", "Medusa", "Monk", "Magic Dragon"];
describe("A19 optional own-army role search plan", () => {
    it("widens blocked physical healer movement while retaining other maps and ranged or magic profiles", () => {
        const healer = ["Squire", "Wyvern", "Orc", "Elf", "Cyclops", "Angel"];
        const blocked = roleSearchPlan(healer, PBTypes.GridVals.BLOCK_CENTER);
        expect(blocked.moves).toBe(4);
        expect(blocked.shortlist).toBe(24);
        expect(blocked.rollouts).toBe(32);
        expect(blocked.horizon).toBe(64);
        expect(blocked.material).toBe("sample-relative");
        for (const map of [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER]) {
            const native = roleSearchPlan(healer, map);
            expect(native.moves).toBe(1);
            expect(native.shortlist).toBe(12);
        }
        const physical = roleSearchPlan([...healer.slice(0, -1), "Frenzied Boar"], PBTypes.GridVals.BLOCK_CENTER);
        expect(physical.moves).toBe(1);
        expect(physical.shortlist).toBe(12);
        const fourRanged = roleSearchPlan(
            ["Arbalester", "Beholder", "Orc", "Elf", "Cyclops", "Angel"],
            PBTypes.GridVals.BLOCK_CENTER,
        );
        expect(fourRanged.moves).toBe(1);
        expect(fourRanged.shortlist).toBe(12);
    });
    it("counts unique creature roles rather than split stacks and distinguishes magic attacks from physical range", () => {
        const first = roleSearchPlan(mage);
        expect(first.ranged).toBe(3);
        expect(first.magic).toBe(1);
        expect(roleSearchPlan([...mage, "Dryad", "Troll"])).toEqual(first);
    });
    it("gives a blocked spell battery the independently measured depth while preserving the normal-map plan", () => {
        expect(roleSearchPlan(mage, PBTypes.GridVals.BLOCK_CENTER).rollouts).toBe(128);
        expect(roleSearchPlan(mage, PBTypes.GridVals.BLOCK_CENTER).horizon).toBe(128);
        expect(roleSearchPlan(mage).rollouts).toBe(32);
    });
    it("restricts buffered artillery depth to an own amplifiable buff and rallying support", () => {
        const buff = ["Wandering Mage", "Beholder", "Peasant", "Hyena", "Zena", "Tsar Cannon"];
        expect(roleSearchPlan(buff, PBTypes.GridVals.BLOCK_CENTER).rollouts).toBe(128);
        const plain = ["Wandering Mage", "Beholder", "Peasant", "Hyena", "Cyclops", "Tsar Cannon"];
        expect(roleSearchPlan(plain, PBTypes.GridVals.BLOCK_CENTER).rollouts).toBe(32);
    });
    it("expands ground hybrid movement without applying that change to a Dense Flesh carry", () => {
        const ground = ["Leprechaun", "Medusa", "Wandering Mage", "Elf", "Monk", "Frenzied Boar"];
        expect(roleSearchPlan(ground, PBTypes.GridVals.BLOCK_CENTER).moves).toBe(8);
        expect(roleSearchPlan([...ground.slice(0, -1), "Abomination"], PBTypes.GridVals.BLOCK_CENTER).moves).toBe(4);
    });
    it("builds detached per-driver overrides and leaves the ambient environment intact", () => {
        const before = { ...process.env };
        const plan = roleSearchPlan(mage, PBTypes.GridVals.BLOCK_CENTER);
        const overrides = v08A19RoleSearchOverrides(plan);
        expect(overrides.SEARCH_ROLLOUTS).toBe("128");
        expect(overrides.SEARCH_A19_MATERIAL_ARBITRATION).toBe(plan.material);
        expect(Object.isFrozen(overrides)).toBe(true);
        expect(process.env).toEqual(before);
    });
});
