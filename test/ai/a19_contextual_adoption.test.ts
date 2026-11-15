import { expect, test } from "bun:test";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
import {
    createA19ContextualDraftPolicy,
    selectA19ContextualDraftChoice,
} from "../../src/ai/setup/a19_contextual_draft_policy";
import * as formation from "../../src/ai/setup/a19_ranged_formation";
import * as setup from "../../src/ai/setup/a19_ranged_setup";
import { parseDraftGenome } from "../../src/ai/setup/draft_ship";
import { createPlacementSetupDecisionContext } from "../../src/ai/setup/setup_strategy";
import { lockedContextualDraftResearchModels } from "../../src/simulation/contextual_draft_checkpoint";
import { contextualDraftFeatures, predictContextualDraft } from "../../src/simulation/contextual_draft_research";
import { lockedLearnedRangedSetupModel } from "../../src/simulation/learned_ranged_setup_checkpoint";
import * as oldSetup from "../../src/simulation/learned_ranged_setup_research";
import * as oldFormation from "../../src/simulation/ranged_counter_research";
import { CreatureLevelList } from "../../src/units/unit_properties";

const variants = { Life: 1, Chaos: 1, Might: 2, Nature: 2 };
const scouting = { bannedCreatureIds: [], knownBanLevels: [], remainingPickLevels: [1, 2, 3, 4] };
const own = [47, 31, 15, 6, 50, 29];
const enemy = [23, 49, 4, 53, 37, 9];

test("adopted full draft head preserves the exact frozen decision boundary and one-use input", () => {
    const model = lockedContextualDraftResearchModels().full;
    let switches = 0;
    for (const budget of [5, 6, 7])
        for (const map of [undefined, 1, 3, 4])
            for (const level of [1, 2, 3, 4]) {
                const pool = CreatureLevelList[level];
                const context = {
                    ownCreatureIds: [],
                    knownOpponentCreatureIds: [37],
                    budget,
                    scouting: { ...scouting, map },
                    artifactFitVersion: 6 as const,
                    synergyVariants: variants,
                };
                for (const a of pool)
                    for (const b of pool) {
                        if (a === b) continue;
                        const preferred = { id: a, creatureIds: [a] },
                            alternative = { id: b, creatureIds: [b] };
                        const features = contextualDraftFeatures(context, preferred, alternative, level)!;
                        const expected = predictContextualDraft(model, features) > model.margin;
                        const actual = selectA19ContextualDraftChoice({
                            context,
                            preferred,
                            alternative,
                            level,
                            overrideUsed: false,
                        });
                        expect(actual.consumeOverride).toBe(expected);
                        expect(actual.choice).toBe(expected ? b : a);
                        if (expected) switches++;
                        expect(
                            selectA19ContextualDraftChoice({
                                context,
                                preferred,
                                alternative,
                                level,
                                overrideUsed: true,
                            }),
                        ).toEqual({ choice: a, consumeOverride: false });
                    }
            }
    expect(switches).toBeGreaterThan(0);
    expect(model.productionPromotion).toBe(false);
    const policy = createA19ContextualDraftPolicy(parseDraftGenome("ranked-unit-strength-a19-side-v4-w16-r4"));
    expect(
        policy.creature(
            [50, 54],
            50,
            {
                ownCreatureIds: [],
                knownOpponentCreatureIds: [],
                budget: 7,
                scouting,
                artifactFitVersion: 6,
                synergyVariants: variants,
            },
            3,
            true,
        ),
    ).toEqual({ choice: 50, consumeOverride: false });
});

test("serving setup features and available-action choices reproduce the saved selector", () => {
    const model = lockedLearnedRangedSetupModel();
    for (const budget of [5, 6, 7])
        for (const map of [1, 3, 4])
            for (const life of [1, 2])
                for (const nature of [1, 2]) {
                    const context = {
                        ownCreatureIds: own,
                        publicOpponentCreatureIds: enemy,
                        budget,
                        map,
                        synergyVariants: { ...variants, Life: life, Nature: nature },
                    };
                    const features = setup.learnedRangedSetupFeatures(context)!;
                    expect(features).toEqual(oldSetup.learnedRangedSetupFeatures(context)!);
                    expect(setup.selectA19RangedSetup(context, { paidPlanAvailable: true })).toBe(
                        oldSetup.selectLearnedRangedSetup(model, context),
                    );
                    expect(setup.selectA19RangedSetup(context, { paidPlanAvailable: false })).not.toBe(
                        "placement1-sniper",
                    );
                    expect(
                        setup.selectA19RangedSetup(
                            { ...context, publicOpponentCreatureIds: [37] },
                            { paidPlanAvailable: true },
                        ),
                    ).toBe("control");
                }
    for (const budget of [5, 6, 7]) {
        const plan = setup.a19RangedSetupAugments(budget);
        expect(plan).toEqual(oldFormation.fundedRangedPlacement(budget, 1, "sniper"));
        expect(plan.reduce((sum, a) => sum + a.value, 0)).toBe(budget);
        const levels = { Placement: 1, Sniper: 3, Armor: budget - 4, Might: 0, Movement: 0, Empower: 0 };
        expect(setup.hasA19RangedSetupAugments(budget, levels)).toBe(true);
        expect(setup.hasA19RangedSetupAugments(budget, { ...levels, Movement: 1 })).toBe(false);
        expect(setup.hasA19RangedSetupAugments(budget, { ...levels, Placement: 0 })).toBe(false);
    }
});

test("free formation preserves frozen geometry, footprints, both seats and aura links", () => {
    for (const team of [1, 2] as const) {
        const legal = new Set<number>();
        for (let x = team === 1 ? 0 : 12; x < (team === 1 ? 4 : 16); x++)
            for (let y = 0; y < 16; y++) legal.add(x * 16 + y);
        const x = team === 1 ? 1 : 13;
        const bodies: formation.IRangedCounterBody[] = [
            { id: "wide", width: 2, height: 2, ranged: true, caster: false, value: 1.5, buffRanges: [] },
            { id: "aura", width: 1, height: 1, ranged: false, caster: true, value: 0.4, buffRanges: [2] },
            { id: "shot", width: 1, height: 1, ranged: true, caster: false, value: 1, buffRanges: [] },
        ];
        const original = new Map([
            ["wide", { x, y: 1 }],
            ["aura", { x, y: 2 }],
            ["shot", { x, y: 3 }],
        ]);
        for (const enemyIds of [[], [37], [54], enemy]) {
            const context = { legal, team, sideAxis: true, enemyIds };
            const proposed = formation.spreadRangedCounterFormation(bodies, original, context);
            expect(proposed).toEqual(oldFormation.spreadRangedCounterFormation(bodies, original, context));
            expect(formation.validRangedCounterFormation(bodies, proposed, legal)).toBe(true);
            expect(formation.rangedCounterFormationRisk(bodies, proposed, team, true, enemyIds)).toBeLessThanOrEqual(
                formation.rangedCounterFormationRisk(bodies, original, team, true, enemyIds),
            );
        }
        expect(original.get("wide")).toEqual({ x, y: 1 });
    }
});

test("public variants are frozen and the serving graph cannot load research workers or filesystem checkpoint loaders", () => {
    const context = createPlacementSetupDecisionContext({
        publicOpponentCreatureIds: [37],
        gridType: 1,
        gridSize: 16,
        synergyVariants: { ...variants, enemySelectedLevel: 3 },
    });
    expect(context.synergyVariants).toEqual(variants);
    expect(Object.isFrozen(context.synergyVariants)).toBe(true);
    const root = resolve(import.meta.dir, "../../src");
    const pending = ["a19_contextual_draft_policy", "a19_ranged_setup", "a19_ranged_formation"].map((name) =>
        resolve(root, "ai/setup", `${name}.ts`),
    );
    const visited = new Set<string>(),
        scanner = new Bun.Transpiler({ loader: "ts" });
    while (pending.length) {
        const file = pending.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);
        expect(file).not.toMatch(
            /(?:measure_ranged_counter_research|contextual_draft_battles|contextual_draft_checkpoint|ranged_counter_research)\.ts$/,
        );
        if (extname(file) === ".json") continue;
        for (const { path } of scanner.scanImports(readFileSync(file, "utf8"))) {
            if (!path.startsWith(".")) continue;
            const base = resolve(dirname(file), path);
            const target = [base, `${base}.ts`, `${base}.json`, resolve(base, "index.ts")].find(
                (p) => existsSync(p) && statSync(p).isFile(),
            );
            expect(target).toBeDefined();
            pending.push(target!);
        }
    }
});
