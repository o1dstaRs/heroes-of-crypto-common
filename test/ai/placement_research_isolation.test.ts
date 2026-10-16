import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { expect, test } from "bun:test";

import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { resolveSetupPolicy } from "../../src/ai/setup/setup_ship";
import { createPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";

const root = resolve(import.meta.dir, "../..");
const unqualified = ["v0_8_screen_hold.ts", "v0_8_stable_screen_placement.ts"].map((name) =>
    resolve(root, "src/ai/versions", name),
);

// Follow executable imports/re-exports, not comments or type-only references. A helper silently called
// from an existing placement layer must fail even when the public strategy wrapper chain stays the same.
test("unqualified screen experiments stay outside the game API and default battle engine", () => {
    const pending = [resolve(root, "src/index.ts"), resolve(root, "src/simulation/battle_engine.ts")];
    const visited = new Set<string>();
    const scanner = new Bun.Transpiler({ loader: "ts" });
    while (pending.length) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        expect(unqualified, `Unqualified Placement research became reachable: ${file}`).not.toContain(file);
        if (extname(file) === ".json") continue;
        for (const dependency of scanner.scanImports(readFileSync(file, "utf8"))) {
            if (!dependency.path.startsWith(".")) continue;
            const base = resolve(dirname(file), dependency.path);
            const target = [
                base,
                `${base}.ts`,
                `${base}.tsx`,
                `${base}.js`,
                `${base}.json`,
                resolve(base, "index.ts"),
                resolve(base, "index.js"),
            ].find((path) => existsSync(path) && statSync(path).isFile());
            expect(target, `Unresolved source dependency ${dependency.path} in ${file}`).toBeDefined();
            pending.push(target!);
        }
    }
    expect(visited.size).toBeGreaterThan(100);
});

test("the shipped setup policy does not buy the unqualified flyer Placement plans", () => {
    const policy = resolveSetupPolicy("artifact-fit-v4:conditional-v1:sniper+t2a19");
    const rosters = [
        ["Orc", "Dryad", "Troll", "Elf", "Monk", "Arachna Queen"],
        ["Wandering Mage", "Battle Mage", "Magic Dragon", "Satyr", "Nightmare", "Peasant"],
    ].map((names) => names.map((name) => creatureIdForName(name)!));
    for (const roster of rosters) {
        expect(roster.every((id) => id !== undefined)).toBe(true);
        for (const flyer of ["Black Dragon", "Thunderbird", "Griffin"]) {
            const context = createPlacementSetupDecisionContext({
                publicOpponentCreatureIds: [creatureIdForName(flyer)!],
            });
            for (const budget of [5, 6, 7]) {
                const plan = policy.pickAugments(budget, roster, context);
                expect(plan.reduce((sum, item) => sum + item.value, 0)).toBe(budget);
                expect(plan.some((item) => item.kind === "Placement" && item.value > 0)).toBe(false);
            }
        }
    }
});
