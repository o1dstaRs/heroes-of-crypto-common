import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { selectV08A19ScoredCandidateIndex } from "../../src/ai/versions/v0_8_a19_scored_arbitration";
import {
    appendBacklineApproachAlternative,
    backlineApproachScoreEvidence,
} from "../../src/simulation/backline_approach_preservation_research";

test("preserves the complete ordinary shortlist, order and protected extra choices", () => {
    const ordinary = ["incumbent", "first", "second", "third", "fourth", "fifth", "Vine", "barrel"];
    const expanded = appendBacklineApproachAlternative(ordinary, "approach");
    expect(expanded.slice(0, ordinary.length)).toEqual(ordinary);
    expect(expanded.length).toBe(ordinary.length + 1);
    expect(ordinary).not.toContain("approach");
    expect(appendBacklineApproachAlternative(ordinary, undefined)).toBe(ordinary);
    expect(appendBacklineApproachAlternative(ordinary, "first")).toBe(ordinary);
});

test("rejects equal wins, equal losses and tiny value changes instead of disturbing ordinary choices", () => {
    for (const means of [
        [1, 1, 1],
        [0, 0, 0],
        [0.6, 0.7, 0.705],
        [0.5, 1, 0.9],
    ]) {
        const original = [...means];
        expect(backlineApproachScoreEvidence(means, 2).eligible).toBe(false);
        expect(means).toEqual(original);
    }
    expect(backlineApproachScoreEvidence([0.1, 0.4, 0.8], 2).eligible).toBe(true);
    expect(backlineApproachScoreEvidence([0, 0, 0.5], 2).eligible).toBe(true);
});

test("invalid and missing comparisons fail closed", () => {
    for (const [means, index] of [
        [[1, NaN], 1],
        [[1, -Infinity], 1],
        [[1, Infinity], 1],
        [[-Infinity, 0.8], 1],
        [[0.8], 0],
        [[0.4], -1],
        [[0.4], 2],
    ] as [number[], number][])
        expect(backlineApproachScoreEvidence(means, index).eligible).toBe(false);
});

test("a rejected extra cannot be reselected by native scored arbitration", () => {
    const candidate = (id: string) => ({
        actions: [{ type: "move_unit" as const, unitId: id, path: [{ x: 1, y: 1 }] }],
    });
    const candidates = [candidate("current"), candidate("ordinary"), candidate("extra")];
    const means = [0.5, 0.8, 0.805];
    expect(backlineApproachScoreEvidence(means, 2).eligible).toBe(false);
    means[2] = -Infinity;
    expect(selectV08A19ScoredCandidateIndex(candidates, means, 1, candidates[0].actions)).toBe(1);
});

test("the follow-up remains unreachable from serving entry points", () => {
    const root = resolve(import.meta.dir, "../..");
    const forbidden = resolve(root, "src/simulation/backline_approach_preservation_research.ts");
    const pending = [resolve(root, "src/index.ts"), resolve(root, "src/simulation/battle_engine.ts")];
    const seen = new Set<string>(),
        scanner = new Bun.Transpiler({ loader: "ts" });
    while (pending.length) {
        const file = pending.pop()!;
        if (seen.has(file)) continue;
        seen.add(file);
        expect(file).not.toBe(forbidden);
        if (extname(file) === ".json") continue;
        for (const dep of scanner.scanImports(readFileSync(file, "utf8"))) {
            if (!dep.path.startsWith(".")) continue;
            const base = resolve(dirname(file), dep.path);
            const target = [
                base,
                `${base}.ts`,
                `${base}.tsx`,
                `${base}.js`,
                `${base}.json`,
                resolve(base, "index.ts"),
            ].find((p) => existsSync(p) && statSync(p).isFile());
            expect(target).toBeDefined();
            pending.push(target!);
        }
    }
    expect(seen.size).toBeGreaterThan(100);
});
