import { afterEach, expect, test } from "bun:test";
import type { IEnumeratedCandidate } from "../../src/ai/candidates";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import {
    reserveMageContactSpell,
    withMageContactShortlistResearch,
} from "../../src/simulation/battle_mage_contact_shortlist_research";
import { SearchDriver } from "../../src/simulation/search_driver";
import type { Unit } from "../../src/units/unit";

const green = PBTypes.TeamVals.LEFT,
    red = PBTypes.TeamVals.RIGHT;
const unit = (id: string, team: number, x: number, y: number, cells = [{ x, y }]) =>
    ({
        getId: () => id,
        getName: () => "Battle Mage",
        getTeam: () => team,
        getCells: () => cells,
        getAmountAlive: () => 10,
        getCumulativeHp: () => 200,
        getAttackDamageMin: () => 10,
        getAttackDamageMax: () => 20,
    }) as Unit;
const spell = (name: string, id: string, kill: 0 | 1 = 0) =>
    ({
        kind: "spell",
        actions: [{ type: "cast_spell", casterId: "actor", spellName: name, targetId: id }],
        features: { expectedDamage: 100, expectedKill: kill },
    }) as IEnumeratedCandidate;
const setup = () => {
    const actor = unit("actor", green, 1, 1),
        contact = unit("contact", red, 3, 2, [
            { x: 2, y: 1 },
            { x: 3, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 2 },
        ]);
    const units = new Map([
        ["actor", actor],
        ["contact", contact],
        ["far", unit("far", red, 12, 12)],
    ]);
    const candidates = [
        spell("Meteorite", "incumbent"),
        spell("Fire Strike", "lethal", 1),
        spell("Meteorite", "cluster"),
        spell("Fire Strike", "other"),
        spell("Meteorite", "kill", 1),
        spell("Meteorite", "weak"),
        spell("Fire Strike", "contact"),
        spell("Fire Strike", "far"),
    ];
    return { actor, units, candidates, original: candidates.slice(0, 6) };
};
test("uses the whole footprint while preserving the incumbent, lethal spells and six-slot budget", () => {
    const { actor, units, candidates, original } = setup();
    const records: unknown[] = [];
    const result = reserveMageContactSpell(actor, units, candidates, original, (r) => records.push(r));
    expect(result).toEqual([...original.slice(0, 5), candidates[6]]);
    expect(original).toEqual(candidates.slice(0, 6));
    expect(records).toEqual([{ removedIndex: 5, addedIndex: 6, adjacentAllies: 1, pressureProxy: 75 }]);
});
test("retains all-lethal shortlists, degraded caps, absent targets and no-contact positions", () => {
    const { actor, units, candidates, original } = setup();
    expect(reserveMageContactSpell(actor, units, candidates, original.slice(0, 2))).toEqual(original.slice(0, 2));
    units.delete("contact");
    expect(reserveMageContactSpell(actor, units, candidates, original)).toBe(original);
    units.set("contact", unit("contact", red, 8, 8));
    expect(reserveMageContactSpell(actor, units, candidates, original)).toBe(original);
    units.set("contact", unit("contact", red, 2, 2));
    original.forEach((c) => (c.features.expectedKill = 1));
    expect(reserveMageContactSpell(actor, units, candidates, original)).toBe(original);
});

type Shortlist = (
    this: unknown,
    unit: Unit,
    candidates: readonly IEnumeratedCandidate[],
    seed: number,
    deadline: number | null,
    version: string,
) => readonly IEnumeratedCandidate[];
const prototype = SearchDriver.prototype as unknown as { shortlistCandidates: Shortlist };
const originalMethod = prototype.shortlistCandidates;
afterEach(() => {
    prototype.shortlistCandidates = originalMethod;
});
test("scopes only the selected v0.8 Mage and restores after a failed synchronous run", () => {
    const { actor, units, candidates, original } = setup();
    const driver = { deps: { unitsHolder: { getAllUnits: () => units } } };
    prototype.shortlistCandidates = () => original;
    const fake = prototype.shortlistCandidates;
    withMageContactShortlistResearch(green, () => {
        expect(prototype.shortlistCandidates.call(driver, actor, candidates, 1, null, "v0.8")[5]).toBe(candidates[6]);
        expect(prototype.shortlistCandidates.call(driver, unit("enemy", red, 1, 1), candidates, 1, null, "v0.8")).toBe(
            original,
        );
        expect(prototype.shortlistCandidates.call(driver, actor, candidates, 1, null, "v0.9")).toBe(original);
        expect(
            prototype.shortlistCandidates.call(
                driver,
                { ...actor, getName: () => "Wandering Mage" } as Unit,
                candidates,
                1,
                null,
                "v0.8",
            ),
        ).toBe(original);
    });
    expect(prototype.shortlistCandidates).toBe(fake);
    expect(() =>
        withMageContactShortlistResearch(green, () => {
            throw Error("probe");
        }),
    ).toThrow("probe");
    expect(() => withMageContactShortlistResearch(null, () => Promise.resolve())).toThrow("synchronous");
    expect(() => withMageContactShortlistResearch(null, () => withMageContactShortlistResearch(null, () => 1))).toThrow(
        "nested",
    );
    expect(prototype.shortlistCandidates).toBe(fake);
});
