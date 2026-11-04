import { describe, expect, test } from "bun:test";
import { creatureInfo } from "../../src/ai/setup/creature_score";
import { rankedDraftStrengthV4LiftPp } from "../../src/ai/setup/draft_strength_prior";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { CreatureLevelList } from "../../src/units/unit_properties";
import type { IRankedDraftResearchContext } from "../../src/simulation/ranked_draft_eval";
import {
    delayedDoctrineScouting,
    DOCTRINE_DRAFT_FEATURES,
    DOCTRINE_DRAFT_V2_FEATURES,
    DOCTRINE_DRAFT_V3_FEATURES,
    doctrineDraftFeatures,
    fitDoctrineDraftModel,
    predictDoctrineDraftGain,
} from "../../src/simulation/v0_9/doctrine_draft_model";
import {
    DOCTRINE_DRAFT_STAGES,
    DOCTRINE_DRAFT_V2_STAGES,
    DOCTRINE_DRAFT_V3_STAGES,
    doctrineDraftTrainingLevel,
    pairedDoctrineDraftStatistics,
    validateDoctrineDraftRegistration,
    type IDoctrineDraftRegistration,
} from "../../src/simulation/v0_9/doctrine_draft_training";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";

const flyer = CreatureLevelList[1].find((id) => creatureInfo(id)?.canFly)!;
const walker = CreatureLevelList[1].find((id) => creatureInfo(id)?.melee && !creatureInfo(id)?.canFly)!;
const context: IRankedDraftResearchContext = {
    ownCreatureIds: [],
    knownOpponentCreatureIds: [],
    artifactFitVersion: 6,
    scouting: {
        map: PBTypes.GridVals.WATER_CENTER,
        bannedCreatureIds: [CreatureLevelList[4][0]],
        knownBanLevels: [1, 2, 3, 4],
        remainingPickLevels: [1, 2, 3, 4],
    },
};

describe("outcome-trained doctrine draft research", () => {
    test("seven-point and post-reveal decisions retain the existing policy", () => {
        expect(
            doctrineDraftFeatures("see-none", context, { creatureIds: [walker] }, { creatureIds: [flyer] }, 1),
        ).toBeUndefined();
        expect(
            doctrineDraftFeatures("see-all", context, { creatureIds: [walker] }, { creatureIds: [flyer] }, 3),
        ).toBeUndefined();
    });

    test("mask removes advance information while preserving model, doctrine and public features", () => {
        const full = doctrineDraftFeatures("see-all", context, { creatureIds: [walker] }, { creatureIds: [flyer] }, 1)!;
        const masked = doctrineDraftFeatures(
            "see-all",
            context,
            { creatureIds: [walker] },
            { creatureIds: [flyer] },
            1,
            true,
        )!;
        expect(full).toHaveLength(DOCTRINE_DRAFT_FEATURES.length);
        expect(masked.slice(0, 5)).toEqual(full.slice(0, 5));
        expect(full[5]).toBe(1);
        expect(masked.slice(5)).toEqual(new Array(DOCTRINE_DRAFT_FEATURES.length - 5).fill(0));
        const alreadyDelayed = { ...context, scouting: delayedDoctrineScouting(context.scouting, 1) };
        expect(
            doctrineDraftFeatures("see-all", alreadyDelayed, { creatureIds: [walker] }, { creatureIds: [flyer] }, 1),
        ).toEqual(masked);
    });

    test("delayed projection keeps already-public bans and the ordinary map reveal", () => {
        const scouting = { ...context.scouting, bannedCreatureIds: [CreatureLevelList[1][0], CreatureLevelList[4][0]] };
        expect(delayedDoctrineScouting(scouting, 1).bannedCreatureIds).toEqual([CreatureLevelList[1][0]]);
        expect(delayedDoctrineScouting(scouting, 1).knownBanLevels).toEqual([1]);
        expect(delayedDoctrineScouting(scouting, 3).map).toBe(context.scouting.map);
        expect(delayedDoctrineScouting(scouting, 1).remainingPickLevels).toEqual(scouting.remainingPickLevels);
    });

    test("advance bans change continuation features without exposing another state input", () => {
        const allFutureBans = [2, 3, 4].flatMap((level) => CreatureLevelList[level]);
        const evidence = {
            ...context,
            scouting: { ...context.scouting, map: undefined, bannedCreatureIds: allFutureBans },
        };
        const vectors = CreatureLevelList[1].map((id) =>
            doctrineDraftFeatures("three-reveals", evidence, { creatureIds: [walker] }, { creatureIds: [id] }, 1)!,
        );
        expect(vectors.some((vector) => vector.slice(11).some((value) => value !== 0))).toBe(true);
    });

    test("v2 uses level-4 bans at the level-3 pick while preserving the public map", () => {
        const c = PBTypes.CreatureVals;
        const evidence = {
            ...context,
            ownCreatureIds: [c.ORC, c.TROLL, c.WOLF, c.ELF],
            scouting: {
                ...context.scouting,
                remainingPickLevels: [3, 4],
                bannedCreatureIds: CreatureLevelList[4].filter(
                    (id) => creatureInfo(id)?.faction === creatureInfo(c.ORC)?.faction,
                ),
            },
        };
        const preferred = { creatureIds: [c.NIGHTMARE] };
        const alternative = { creatureIds: [c.MANTIS] };
        const full = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, false, "v2")!;
        const masked = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, true, "v2")!;
        expect(full).toHaveLength(DOCTRINE_DRAFT_V2_FEATURES.length);
        expect(full[11]).toBe(-1);
        expect(masked.slice(11, 14)).toEqual([0, 0, 0]);
        expect(masked.slice(0, 11)).toEqual(full.slice(0, 11));
        expect(full[5]).toBe(1);
        expect(full[14]).toBe(1);
        expect(masked[14]).toBe(1);
        expect(doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3)).toBeUndefined();
        expect(doctrineDraftFeatures("see-none", evidence, preferred, alternative, 3, false, "v2")).toBeUndefined();
        expect(
            doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 4, false, "v2"),
        ).toBeUndefined();
    });

    test("v2 fits late decisions without changing the v1 model contract", () => {
        const examples = Array.from({ length: 80 }, (_, board) => {
            const features = new Array<number>(DOCTRINE_DRAFT_V2_FEATURES.length).fill(0);
            features[1] = 1;
            features[11] = (board % 3) - 1;
            features[14] = 1;
            return { board, features, gain: -0.2 * features[11] - 0.05 };
        });
        const model = fitDoctrineDraftModel(examples, "v2");
        expect(model.schema).toBe("hoc.ai.v0_9.doctrine_draft.v2");
        expect(model.features).toEqual(DOCTRINE_DRAFT_V2_FEATURES);
        expect(model.finalLoss).toBeLessThan(model.initialLoss / 100);
        expect(predictDoctrineDraftGain(model, examples[0].features)).toBeCloseTo(0.15, 2);
        expect(() => fitDoctrineDraftModel(examples)).toThrow();
        expect(() =>
            predictDoctrineDraftGain({ ...model, schema: "hoc.ai.v0_9.doctrine_draft.v1" }, examples[0].features),
        ).toThrow();
    });

    test("registered populations cover every decision in every doctrine/map cell", () => {
        for (const version of ["v1", "v2", "v3"] as const) {
            const stages =
                version === "v3"
                    ? DOCTRINE_DRAFT_V3_STAGES
                    : version === "v2"
                      ? DOCTRINE_DRAFT_V2_STAGES
                      : DOCTRINE_DRAFT_STAGES;
            let index = 0;
            const body = {
                schema: `hoc.ai.v0_9.doctrine_draft_training.${version}`,
                banks: Object.fromEntries(
                    Object.entries(stages).map(([stage, count]) => [
                        stage,
                        Array.from({ length: count }, () => 3 * index++),
                    ]),
                ),
                deadlineAtMs: 1,
                productionPromotion: false,
            };
            const registration = { ...body, registrationSha256: fingerprintV09(body) } as IDoctrineDraftRegistration;
            expect(() => validateDoctrineDraftRegistration(registration)).not.toThrow();
            const counts = new Map<string, number>();
            for (let board = 0; board < stages.train; board++) {
                const cell = `${board % 27}:${doctrineDraftTrainingLevel(version, "train", board)}`;
                counts.set(cell, (counts.get(cell) ?? 0) + 1);
            }
            expect(counts.size).toBe(27 * (version === "v1" ? 3 : 4));
            expect([...counts.values()].every((count) => count === (version === "v3" ? 30 : 10))).toBe(true);
            if (version !== "v1") {
                expect(
                    Array.from({ length: 27 }, (_, board) => doctrineDraftTrainingLevel(version, "smoke", board)),
                ).toEqual(new Array(27).fill(3));
                const wrongBody = { ...body, schema: "hoc.ai.v0_9.doctrine_draft_training.v1" };
                expect(() =>
                    validateDoctrineDraftRegistration({
                        ...wrongBody,
                        registrationSha256: fingerprintV09(wrongBody),
                    } as IDoctrineDraftRegistration),
                ).toThrow("Incomplete registered bank");
            }
        }
    });

    test("v3 sees losing the fourth shooter when the old two-shooter feature is saturated", () => {
        const ranged = (id: number): boolean => Boolean(creatureInfo(id)?.ranged);
        const evidence = {
            ...context,
            ownCreatureIds: [
                ...CreatureLevelList[1].filter(ranged).slice(0, 2),
                CreatureLevelList[2].find(ranged)!,
                CreatureLevelList[2].find((id) => !ranged(id))!,
            ],
            scouting: {
                ...context.scouting,
                remainingPickLevels: [3, 4],
                bannedCreatureIds: CreatureLevelList[4].filter(ranged),
            },
        };
        const preferred = { creatureIds: [CreatureLevelList[3].find((id) => !ranged(id))!] };
        const alternative = { creatureIds: [CreatureLevelList[3].find(ranged)!] };
        const full = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, false, "v3")!;
        const masked = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, true, "v3")!;
        const old = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, false, "v2")!;
        const capacity = DOCTRINE_DRAFT_V3_FEATURES.indexOf("advance_bans_four_ranged_capacity_difference");
        expect(full).toHaveLength(73);
        expect(full.slice(0, 15)).toEqual(old);
        expect(full[13]).toBe(0);
        expect(full[capacity]).toBe(1);
        expect(masked[capacity]).toBe(0);
        expect(masked.slice(15, 71)).toEqual(full.slice(15, 71));
        expect(full[DOCTRINE_DRAFT_V3_FEATURES.indexOf(`unit_${preferred.creatureIds[0]}_difference`)]).toBe(-1);
        expect(full[DOCTRINE_DRAFT_V3_FEATURES.indexOf(`unit_${alternative.creatureIds[0]}_difference`)]).toBe(1);
        expect(DOCTRINE_DRAFT_V3_FEATURES).not.toContain("unit_0_difference");
        expect(doctrineDraftFeatures("see-none", evidence, preferred, alternative, 3, false, "v3")).toBeUndefined();
    });

    test("v3 distinguishes losing a strong faction partner while the faction remains reachable", () => {
        const c = PBTypes.CreatureVals;
        const chaos = CreatureLevelList[4]
            .filter((id) => creatureInfo(id)?.faction === creatureInfo(c.ORC)?.faction)
            .sort((a, b) => rankedDraftStrengthV4LiftPp(b) - rankedDraftStrengthV4LiftPp(a));
        const evidence = {
            ...context,
            ownCreatureIds: [c.ORC, c.TROLL, c.WOLF, c.ELF],
            scouting: { ...context.scouting, remainingPickLevels: [3, 4], bannedCreatureIds: [chaos[0]] },
        };
        const preferred = { creatureIds: [c.NIGHTMARE] },
            alternative = { creatureIds: [c.MANTIS] };
        const full = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, false, "v3")!;
        const masked = doctrineDraftFeatures("three-reveals", evidence, preferred, alternative, 3, true, "v3")!;
        const quality = DOCTRINE_DRAFT_V3_FEATURES.indexOf("advance_bans_faction_partner_strength_difference");
        expect(full[11]).toBe(0);
        expect(full[quality]).toBeGreaterThan(0);
        expect(full[quality]).toBeCloseTo(
            (rankedDraftStrengthV4LiftPp(chaos[0]) - rankedDraftStrengthV4LiftPp(chaos[1])) / 10,
            10,
        );
        expect(masked[quality]).toBe(0);
    });

    test("v3 learns the new information feature while preserving public unit identity in the mask", () => {
        const capacity = DOCTRINE_DRAFT_V3_FEATURES.indexOf("advance_bans_four_ranged_capacity_difference");
        const examples = Array.from({ length: 80 }, (_, board) => {
            const features = new Array<number>(DOCTRINE_DRAFT_V3_FEATURES.length).fill(0);
            features[1] = 1;
            features[capacity] = (board % 3) - 1;
            return { board, features, gain: 0.2 * features[capacity] - 0.05 };
        });
        const model = fitDoctrineDraftModel(examples, "v3");
        expect(model.schema).toBe("hoc.ai.v0_9.doctrine_draft.v3");
        expect(model.features).toEqual(DOCTRINE_DRAFT_V3_FEATURES);
        expect(model.finalLoss).toBeLessThan(model.initialLoss / 100);
        expect(predictDoctrineDraftGain(model, examples[2].features)).toBeCloseTo(0.15, 2);
        expect(() => fitDoctrineDraftModel(examples, "v2")).toThrow();
    });

    test("actual optimizer steps learn a held-out synthetic causal direction deterministically", () => {
        const examples = Array.from({ length: 80 }, (_, board) => {
            const features = new Array<number>(DOCTRINE_DRAFT_FEATURES.length).fill(0);
            features[0] = 1;
            features[5] = ((board % 9) - 4) / 4;
            return { board, features, gain: 0.3 * features[5] - 0.05 };
        });
        const model = fitDoctrineDraftModel(examples);
        expect(model.optimizerSteps).toBe(2000);
        expect(model.finalLoss).toBeLessThan(model.initialLoss / 100);
        expect(model).toEqual(fitDoctrineDraftModel(examples));
        const heldOut = [...examples[0].features];
        heldOut[5] = 0.37;
        expect(predictDoctrineDraftGain(model, heldOut)).toBeCloseTo(0.061, 2);
        expect(model.productionPromotion).toBe(false);
        expect(() => predictDoctrineDraftGain({ ...model, weights: [NaN] }, heldOut)).toThrow();
        expect(() => fitDoctrineDraftModel([{ board: 0, features: heldOut, gain: NaN }])).toThrow();
    });

    test("paired uncertainty resamples independent boards rather than the four correlated games", () => {
        const rows = Array.from({ length: 40 }, (_, board) => ({
            board,
            map: 1,
            candidateDoctrinePolicy: "see-all" as const,
            opponentDoctrinePolicy: "three-reveals" as const,
            delta: board % 2 ? 0.5 : -0.5,
        }));
        const stats = pairedDoctrineDraftStatistics(rows);
        expect(stats.gain).toBe(0);
        expect(stats.lower95).toBeLessThan(-0.1);
        expect(stats.upper95).toBeGreaterThan(0.1);
        const nullRows = rows.map((row) => ({ ...row, delta: 0 }));
        expect(pairedDoctrineDraftStatistics(nullRows)).toEqual({ boards: 40, gain: 0, lower95: 0, upper95: 0 });
        expect(() => pairedDoctrineDraftStatistics([...rows, rows[0]])).toThrow();
    });
});
