import { describe, expect, test } from "bun:test";

import { FireWalls } from "../../src/spells/fire_walls";
import { SmokeClouds } from "../../src/spells/smoke_clouds";
import { Vines } from "../../src/spells/vines";

describe("transient terrain store revisions", () => {
    test("advance only when smoke, vines, or fire state changes", () => {
        const smoke = new SmokeClouds();
        const vines = new Vines();
        const fire = new FireWalls();
        const stores = [smoke, vines, fire];

        for (const store of stores) {
            expect(store.getRevision()).toBe(0);
            store.clear();
            expect(store.getRevision()).toBe(0);
        }

        smoke.add({ x: 1, y: 2 }, 2);
        vines.add({ x: 1, y: 2 }, 2);
        fire.add({ x: 1, y: 2 }, 2);
        for (const store of stores) {
            expect(store.getRevision()).toBe(1);
            store.minusAllLaps();
            expect(store.getRevision()).toBe(2);
            store.clear();
            expect(store.getRevision()).toBe(3);
        }
    });
});
