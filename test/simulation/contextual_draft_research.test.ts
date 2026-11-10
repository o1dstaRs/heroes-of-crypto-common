import { expect, test } from "bun:test";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { getDraftScoutingContext } from "../../src/picks/draft_visibility";
import { LIVE_PICK_PHASES } from "../../src/picks/pick_sim";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { ToFactionType } from "../../src/factions/faction_type";
import { CreatureLevelList } from "../../src/units/unit_properties";
import { DEFAULT_SYNERGY_VARIANTS } from "../../src/synergies/synergy_properties";
import {
    contextualDraftFeatures,
    CONTEXTUAL_DRAFT_FEATURE_NAMES,
    CONTEXTUAL_DRAFT_BASE_FEATURES,
    predictContextualDraft,
    CONTEXTUAL_DRAFT_SCHEMA,
    CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
    type IContextualDraftContext,
    type IContextualDraftModel,
} from "../../src/simulation/contextual_draft_research";

const ids = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))];
const nature = ids.filter((id) => creatureInfo(id)?.faction === ToFactionType.Nature);
const other = ids.find((id) => creatureInfo(id)?.faction !== ToFactionType.Nature)!;
const caster = ids.find((id) => creatureInfo(id)?.nativeSpellbook && ![nature[0], nature[1], other].includes(id))!;
const context: IContextualDraftContext = {
    ownCreatureIds: [nature[0], caster],
    knownOpponentCreatureIds: [],
    budget: 7,
    artifactFitVersion: 6,
    synergyVariants: { ...DEFAULT_SYNERGY_VARIANTS, Nature: 1 },
    scouting: { bannedCreatureIds: [], knownBanLevels: [], remainingPickLevels: [1, 2, 3, 4] },
};
const before = { creatureIds: [other] },
    after = { creatureIds: [nature[1]] };
const index = (name: string) => CONTEXTUAL_DRAFT_FEATURE_NAMES.indexOf(name);

test("Nature board capacity learns an interaction with spellbooks in any allied faction", () => {
    const features = contextualDraftFeatures(context, before, after, 1)!;
    expect(features.length).toBe(CONTEXTUAL_DRAFT_FEATURE_NAMES.length);
    expect(features.every(Number.isFinite)).toBe(true);
    expect(features[index("ownBoardUnitsSpellbooks")]).toBeGreaterThan(0);
    const fly = contextualDraftFeatures(
        { ...context, synergyVariants: { ...context.synergyVariants, Nature: 2 } },
        before,
        after,
        1,
    )!;
    expect(fly[index("ownBoardUnitsSpellbooks")]).toBe(0);
    expect(fly.slice(0, CONTEXTUAL_DRAFT_BASE_FEATURES.length)).toEqual(
        features.slice(0, CONTEXTUAL_DRAFT_BASE_FEATURES.length),
    );
});

test("five-point early map and universal level-three reveal use the reducer projection", () => {
    const visibility = (gridType: number, doctrine: Doctrine, phaseSequence: number) =>
        getDraftScoutingContext({
            gridType,
            doctrine,
            phaseSequence,
            bannedCreatureIds: [],
            team: PBTypes.TeamVals.LEFT,
            phaseOrder: LIVE_PICK_PHASES.map((phase) => phase.phase),
            phaseLevels: LIVE_PICK_PHASES.map((phase) => phase.creatureLevel),
            phaseActors: LIVE_PICK_PHASES.map((phase) => phase.actors),
        });
    const features = (map: number, doctrine: Doctrine, phase: number) =>
        contextualDraftFeatures({ ...context, scouting: visibility(map, doctrine, phase) }, before, after, 1)!;
    for (const doctrine of [Doctrine.SEE_NONE, Doctrine.THREE_REVEALS])
        expect(features(1, doctrine, 2)).toEqual(features(4, doctrine, 2));
    expect(features(1, Doctrine.SEE_ALL, 2)).not.toEqual(features(4, Doctrine.SEE_ALL, 2));
    expect(features(1, Doctrine.SEE_NONE, 6)).not.toEqual(features(4, Doctrine.SEE_NONE, 6));
});

test("the separately fitted context ablation cannot read map or available variants", () => {
    const model: IContextualDraftModel = {
        schema: CONTEXTUAL_DRAFT_SCHEMA,
        featureSchema: CONTEXTUAL_DRAFT_FEATURE_SCHEMA,
        features: CONTEXTUAL_DRAFT_FEATURE_NAMES,
        weights: Array.from({ length: CONTEXTUAL_DRAFT_FEATURE_NAMES.length }, (_, i) => (i % 7) / 10),
        margin: 0.02,
        information: "without-map-synergies",
        productionPromotion: false,
    };
    const a = contextualDraftFeatures({ ...context, scouting: { ...context.scouting, map: 1 } }, before, after, 1)!;
    const b = contextualDraftFeatures(
        {
            ...context,
            scouting: { ...context.scouting, map: 4 },
            synergyVariants: { Life: 2, Chaos: 2, Might: 2, Nature: 2 },
        },
        before,
        after,
        1,
    )!;
    expect(predictContextualDraft(model, a)).toBe(predictContextualDraft(model, b));
    expect(predictContextualDraft({ ...model, information: "full" }, a)).not.toBe(
        predictContextualDraft({ ...model, information: "full" }, b),
    );
    expect(
        contextualDraftFeatures(
            { ...context, synergyVariants: { ...context.synergyVariants, Chaos: 0 } },
            before,
            after,
            1,
        ),
    ).toBeUndefined();
    expect(
        contextualDraftFeatures(
            { ...context, ownCreatureIds: [...context.ownCreatureIds, context.ownCreatureIds[0]] },
            before,
            after,
            1,
        ),
    ).toBeUndefined();
});
