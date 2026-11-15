import { expect, test } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { Tier1Artifact, Tier2Artifact } from "../../src/artifacts/artifact_properties";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { DEFAULT_SYNERGY_VARIANTS } from "../../src/synergies/synergy_properties";
import {
    armyPlanFeatures,
    armyPlanChoiceIndex,
    predictArmyPlan,
    validateArmyPlanModel,
    ARMY_PLAN_FEATURE_NAMES,
    ARMY_PLAN_MARGIN,
    ARMY_PLAN_SCHEMA,
    type IArmyPlanContext,
    type IArmyPlanModel,
} from "../../src/simulation/ranked_army_plan_research";

const own = [...new Set([1, 2, 3].flatMap((level) => CreatureLevelList[level]))].slice(0, 5);
const magic = CreatureLevelList[4].find((id) => creatureInfo(id)?.dealsMagicDamage)!;
const physical = CreatureLevelList[4].find((id) => !creatureInfo(id)?.dealsMagicDamage)!;
const context: IArmyPlanContext = {
    ownCreatureIds: own,
    knownOpponentCreatureIds: [],
    ownDoctrine: 3,
    tier1ArtifactId: Tier1Artifact.MAGES_RING,
    map: 1,
    synergyVariants: { ...DEFAULT_SYNERGY_VARIANTS },
};
const feature = (xs: number[], key: string) => xs[ARMY_PLAN_FEATURE_NAMES.indexOf(key)];

test("the final-pick representation couples the actual Tier-2 ring to a magic-damage choice", () => {
    const features = (artifactId: number) =>
        armyPlanFeatures(context, { artifactId, creatureId: physical }, { artifactId, creatureId: magic });
    const ring = features(Tier2Artifact.ARCHMAGES_RING),
        plate = features(Tier2Artifact.TITAN_PLATE);
    expect(ring).toHaveLength(ARMY_PLAN_FEATURE_NAMES.length);
    expect(ring.every(Number.isFinite)).toBe(true);
    expect(feature(ring, `difference:tier2:${Tier2Artifact.ARCHMAGES_RING}:magicDamage`)).toBeGreaterThan(0);
    expect(feature(plate, `difference:tier2:${Tier2Artifact.ARCHMAGES_RING}:magicDamage`)).toBe(0);
    expect(feature(ring, "difference:magicAmplification")).toBeGreaterThan(
        feature(plate, "difference:magicAmplification"),
    );
});

test("only legal projected information affects features; hidden data and source seed are inaccessible", () => {
    const before = { artifactId: Tier2Artifact.TITAN_PLATE },
        after = { artifactId: Tier2Artifact.ARCHMAGES_RING };
    const a = armyPlanFeatures(context, before, after);
    const withHidden = {
        ...context,
        hiddenOpponentCreatureIds: [magic],
        opponentDoctrine: 2,
        actualOpponentPositions: [{ x: 1, y: 1 }],
        seed: 12345,
    };
    expect(armyPlanFeatures(withHidden, before, after)).toEqual(a);
    expect(feature(a, "knownEnemyShare")).toBe(0);
    const revealed = armyPlanFeatures({ ...context, knownOpponentCreatureIds: [magic] }, before, after);
    expect(feature(revealed, "knownEnemyShare")).toBeCloseTo(1 / 6, 14);
    expect(revealed).not.toEqual(a);
    expect(context.knownOpponentCreatureIds).toEqual([]);
});

test("phase and artifact commitments cannot be crossed or filled from future picks", () => {
    const artifact = { artifactId: Tier2Artifact.TITAN_PLATE };
    expect(() => armyPlanFeatures(context, artifact, { ...artifact, creatureId: magic })).toThrow();
    expect(() =>
        armyPlanFeatures(
            context,
            { ...artifact, creatureId: physical },
            { artifactId: Tier2Artifact.ARCHMAGES_RING, creatureId: magic },
        ),
    ).toThrow();
    expect(() =>
        armyPlanFeatures({ ...context, ownCreatureIds: [...own, magic] }, artifact, {
            artifactId: Tier2Artifact.ARCHMAGES_RING,
        }),
    ).toThrow();
    expect(() =>
        armyPlanFeatures(
            { ...context, knownOpponentCreatureIds: [magic] },
            { ...artifact, creatureId: physical },
            { ...artifact, creatureId: magic },
        ),
    ).toThrow();
    expect(() => armyPlanFeatures({ ...context, ownDoctrine: 0 }, artifact, artifact)).toThrow();
});

test("doctrine budgets and public map are represented distinctly without inventing a concealed map", () => {
    const before = { artifactId: Tier2Artifact.ARCHMAGES_RING, creatureId: physical },
        after = { ...before, creatureId: magic };
    const none = armyPlanFeatures({ ...context, map: undefined }, before, after);
    expect(
        ARMY_PLAN_FEATURE_NAMES.filter((name) => name.startsWith("difference:map:")).every(
            (name) => feature(none, name) === 0,
        ),
    ).toBe(true);
    expect(armyPlanFeatures(context, before, after)).not.toEqual(none);
    for (const doctrine of [1, 2, 3]) {
        const values = armyPlanFeatures({ ...context, ownDoctrine: doctrine }, before, after);
        expect([1, 2, 3].map((id) => feature(values, `doctrine:${id}`))).toEqual(
            [1, 2, 3].map((id) => Number(id === doctrine)),
        );
    }
});

test("strict inference margin retains the incumbent on ties, NaNs and subthreshold gains", () => {
    expect(armyPlanChoiceIndex([0, 0.03, NaN])).toBe(0);
    expect(armyPlanChoiceIndex([0, 0.05, 0.05])).toBe(1);
    expect(armyPlanChoiceIndex([0, 0.04, 0.06])).toBe(2);
    const model: IArmyPlanModel = {
        schema: ARMY_PLAN_SCHEMA,
        featureNames: ARMY_PLAN_FEATURE_NAMES,
        artifactWeights: ARMY_PLAN_FEATURE_NAMES.map((_, index) => (index === 0 ? 0.02 : 0)),
        creatureWeights: ARMY_PLAN_FEATURE_NAMES.map((_, index) => (index === 0 ? 0.04 : 0)),
        margin: ARMY_PLAN_MARGIN,
        lambda: 10,
        productionPromotion: false,
    };
    validateArmyPlanModel(model);
    const x = armyPlanFeatures(
        context,
        { artifactId: Tier2Artifact.TITAN_PLATE },
        { artifactId: Tier2Artifact.ARCHMAGES_RING },
    );
    expect(predictArmyPlan(model, "artifact", x)).toBe(0.02);
    expect(predictArmyPlan(model, "creature", x)).toBe(0.04);
    expect(() => validateArmyPlanModel({ ...model, featureNames: [] })).toThrow();
});
