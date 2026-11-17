import { createHash } from "node:crypto";
import {
    createDraftOpponentMemory,
    draftMemoryKeys,
    validDraftMemoryInput,
    DRAFT_OPPONENT_MEMORY_RECIPE,
    DRAFT_OPPONENT_MEMORY_SCHEMA,
    type IDraftMemoryInput,
    type IDraftOpponentMemory,
} from "../ai/setup/draft_opponent_memory";
import type { PremiumDraftOpponentExample, PremiumDraftPublicInput } from "./premium_draft_memory_dataset";

/** Public projection only; the trainer must pass row.input, never row.target or the complete row. */
export function draftMemoryInput(input: PremiumDraftPublicInput): IDraftMemoryInput {
    if (input.stage !== "draft:pick_creature") throw new Error("Draft memory requires a creature-pick observation");
    const o = input.observation;
    const fields = [
        "ownTeam",
        "phaseSequence",
        "phase",
        "actors",
        "requiredCreatureLevel",
        "creaturesBanned",
        "creaturesPicked",
        "knownOpponentCreatures",
        "doctrine",
        "bundles",
        "tier2Offers",
        "artifacts",
        "availableCreatureIds",
        "revealedOpponentSlots",
        "revealedMap",
        "synergyVariants",
    ];
    if (Object.keys(o).length !== fields.length || fields.some((key) => !Object.hasOwn(o, key)))
        throw new Error("Unexpected draft memory observation field");
    const artifacts = o.artifacts as number[][];
    const result: IDraftMemoryInput = {
        doctrine: Number(o.doctrine),
        phaseSequence: Number(o.phaseSequence),
        level: Number(o.requiredCreatureLevel),
        ownTeam: Number(o.ownTeam),
        ownCreatureIds: [...(o.creaturesPicked as number[])],
        knownOpponentCreatureIds: [...(o.knownOpponentCreatures as number[])],
        availableCreatureIds: [...(o.availableCreatureIds as number[])],
        tier1ArtifactId: artifacts.find((artifact) => artifact[0] === 1)?.[1] ?? null,
        map: o.revealedMap === null ? null : Number(o.revealedMap),
        synergyVariants: { ...(o.synergyVariants as IDraftMemoryInput["synergyVariants"]) },
    };
    if (
        !validDraftMemoryInput(result) ||
        input.candidates.length !== result.availableCreatureIds.length ||
        new Set(input.candidates.map((candidate) => candidate.key)).size !== input.candidates.length ||
        input.candidates.some(
            (candidate) =>
                candidate.key !== String(candidate.action.creatureId) ||
                !result.availableCreatureIds.includes(Number(candidate.action.creatureId)),
        )
    )
        throw new Error("Invalid public draft-memory input/candidate set");
    return result;
}

export const draftMemoryFold = (familyId: string) =>
    createHash("sha256").update(`draft-memory-family-fold-v1:${familyId}`).digest().readUInt32BE(0) % 5;

function families(examples: readonly PremiumDraftOpponentExample[]) {
    const groups = new Map<string, PremiumDraftOpponentExample[]>();
    const decisions = new Set<string>();
    const snapshotIds = new Set<string>();
    for (const example of examples) {
        const key = `${example.audit.familyId}:${example.audit.index}`;
        if (example.audit.partition !== "train" || decisions.has(key))
            throw new Error("Held-out or duplicate memory row");
        decisions.add(key);
        snapshotIds.add(example.audit.snapshotId);
        const input = draftMemoryInput(example.input);
        const occupied = example.target.currentlyOccupiedOfferedCreatures;
        if (
            new Set(occupied).size !== occupied.length ||
            occupied.some((id) => !input.availableCreatureIds.includes(id)) ||
            (input.doctrine === 2 && occupied.length)
        )
            throw new Error("Invalid draft occupancy target");
        if (!groups.has(example.audit.familyId)) groups.set(example.audit.familyId, []);
        groups.get(example.audit.familyId)!.push(example);
    }
    if (!examples.length || snapshotIds.size !== 1) throw new Error("Memory sources must remain separate");
    return groups;
}

/** Closed-form smoothed frequency fit; no battle labels, gradient steps or policy selection. */
export function fitPremiumDraftMemory(
    examples: readonly PremiumDraftOpponentExample[],
    provenance: { sourceSha256: string; snapshotSha256: string },
): IDraftOpponentMemory {
    const groups = families(examples);
    const tables: Record<string, [number, number]> = {};
    for (const rows of groups.values()) {
        const local = new Map<string, [number, number]>();
        for (const example of rows) {
            const input = draftMemoryInput(example.input);
            if (input.doctrine === 2) continue;
            for (const id of input.availableCreatureIds) {
                const label = Number(example.target.currentlyOccupiedOfferedCreatures.includes(id));
                const keys = draftMemoryKeys(input, id);
                for (const key of ["global", keys.base, keys.candidate, ...keys.contexts]) {
                    const count = local.get(key) ?? [0, 0];
                    count[0] += label;
                    count[1]++;
                    local.set(key, count);
                }
            }
        }
        for (const [key, [positives, observations]] of local) {
            const count = tables[key] ?? [0, 0];
            count[0] += positives / observations;
            count[1]++;
            tables[key] = count;
        }
    }
    const global = tables.global;
    if (!global) throw new Error("No concealed-opponent training contexts");
    delete tables.global;
    for (const [key, count] of Object.entries(tables))
        if (key.startsWith("x:") && count[1] < DRAFT_OPPONENT_MEMORY_RECIPE.minimumContextFamilies) delete tables[key];
    const model: IDraftOpponentMemory = {
        schema: DRAFT_OPPONENT_MEMORY_SCHEMA,
        recipe: DRAFT_OPPONENT_MEMORY_RECIPE,
        target: "currently-occupied-offer-not-win-rate",
        snapshotId: examples[0].audit.snapshotId,
        ...provenance,
        trainingFamilies: groups.size,
        trainingContexts: examples.length,
        global,
        tables,
        qualification: "unqualified-research",
    };
    createDraftOpponentMemory(model);
    return model;
}

/** Five fixed whole-family folds within the ORIGINAL training partition. Not fresh strength evidence. */
export function validatePremiumDraftMemory(
    examples: readonly PremiumDraftOpponentExample[],
    provenance: { sourceSha256: string; snapshotSha256: string },
) {
    families(examples);
    const scores: {
        familyId: string;
        doctrine: number;
        labels: number;
        positives: number;
        priorBrier: number;
        memoryBrier: number;
        priorLogLoss: number;
        memoryLogLoss: number;
    }[] = [];
    const folds = [];
    for (let fold = 0; fold < 5; fold++) {
        const train = examples.filter((row) => draftMemoryFold(row.audit.familyId) !== fold);
        const validation = examples.filter((row) => draftMemoryFold(row.audit.familyId) === fold);
        if (!validation.length) throw new Error("Empty memory validation fold");
        const model = fitPremiumDraftMemory(train, provenance);
        const predict = createDraftOpponentMemory(model);
        const groups = new Map<string, (typeof scores)[number]>();
        for (const row of validation) {
            const input = draftMemoryInput(row.input);
            const key = `${row.audit.familyId}:${input.doctrine}`;
            const score = groups.get(key) ?? {
                familyId: row.audit.familyId,
                doctrine: input.doctrine,
                labels: 0,
                positives: 0,
                priorBrier: 0,
                memoryBrier: 0,
                priorLogLoss: 0,
                memoryLogLoss: 0,
            };
            for (const probability of predict(input)!) {
                const y = Number(row.target.currentlyOccupiedOfferedCreatures.includes(probability.creatureId));
                const loss = (p: number) =>
                    -y * Math.log(Math.max(1e-12, p)) - (1 - y) * Math.log(Math.max(1e-12, 1 - p));
                score.labels++;
                score.positives += y;
                score.priorBrier += (probability.priorProbability - y) ** 2;
                score.memoryBrier += (probability.occupiedProbability - y) ** 2;
                score.priorLogLoss += loss(probability.priorProbability);
                score.memoryLogLoss += loss(probability.occupiedProbability);
            }
            groups.set(key, score);
        }
        scores.push(...groups.values());
        folds.push({
            fold,
            trainingFamilies: model.trainingFamilies,
            validationFamilies: new Set(validation.map((row) => row.audit.familyId)).size,
            modelSha256: createHash("sha256").update(JSON.stringify(model)).digest("hex"),
        });
    }
    return { folds, scores, heldOutSnapshotRows: 0, policyWinRateMeasured: false, fits: 5, optimizerSteps: 0 };
}
