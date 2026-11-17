/** Small, explicit draft-belief artifact. Not a pick-value model or a default policy. */
export const DRAFT_OPPONENT_MEMORY_SCHEMA = "draft-opponent-memory-v1";
export const DRAFT_OPPONENT_MEMORY_RECIPE = Object.freeze({
    id: "family-balanced-occupancy-v1",
    priorFamilies: 8,
    contextPriorFamilies: 16,
    minimumContextFamilies: 8,
    contextWeight: 0.5,
});

export interface IDraftMemoryInput {
    doctrine: number;
    phaseSequence: number;
    level: number;
    ownTeam: number;
    ownCreatureIds: readonly number[];
    knownOpponentCreatureIds: readonly number[];
    availableCreatureIds: readonly number[];
    tier1ArtifactId: number | null;
    map: number | null;
    synergyVariants: Readonly<Record<"Life" | "Nature" | "Chaos" | "Might", number>>;
}

/** One contribution per family/table key; first element sums within-family label means. */
export type DraftMemoryCount = readonly [positiveFamilyMass: number, families: number];
export interface IDraftOpponentMemory {
    schema: typeof DRAFT_OPPONENT_MEMORY_SCHEMA;
    recipe: typeof DRAFT_OPPONENT_MEMORY_RECIPE;
    target: "currently-occupied-offer-not-win-rate";
    snapshotId: string;
    sourceSha256: string;
    snapshotSha256: string;
    trainingFamilies: number;
    trainingContexts: number;
    global: DraftMemoryCount;
    tables: Record<string, DraftMemoryCount>;
    qualification: "unqualified-research";
}

const factions = ["Life", "Nature", "Chaos", "Might"] as const;
const integer = (n: unknown, min: number, max: number): n is number =>
    Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
const identities = (ids: readonly number[], maximum: number) =>
    Array.isArray(ids) &&
    ids.length <= maximum &&
    new Set(ids).size === ids.length &&
    ids.every((id) => integer(id, 1, 2048));

/** Whitelisted live fields only. Unknown inputs and incompatible artifacts fall back to the incumbent. */
export function validDraftMemoryInput(input: IDraftMemoryInput): boolean {
    if (!input || typeof input !== "object") return false;
    const keys = [
        "doctrine",
        "phaseSequence",
        "level",
        "ownTeam",
        "ownCreatureIds",
        "knownOpponentCreatureIds",
        "availableCreatureIds",
        "tier1ArtifactId",
        "map",
        "synergyVariants",
    ];
    return (
        Object.keys(input).length === keys.length &&
        keys.every((key) => Object.hasOwn(input, key)) &&
        integer(input.doctrine, 1, 3) &&
        integer(input.phaseSequence, 0, 64) &&
        integer(input.level, 1, 4) &&
        integer(input.ownTeam, 1, 2) &&
        identities(input.ownCreatureIds, 6) &&
        identities(input.knownOpponentCreatureIds, 6) &&
        identities(input.availableCreatureIds, 128) &&
        input.availableCreatureIds.length > 0 &&
        !input.ownCreatureIds.some((id) => input.knownOpponentCreatureIds.includes(id)) &&
        !input.availableCreatureIds.some(
            (id) => input.ownCreatureIds.includes(id) || input.knownOpponentCreatureIds.includes(id),
        ) &&
        (input.tier1ArtifactId === null || integer(input.tier1ArtifactId, 0, 2048)) &&
        (input.map === null || integer(input.map, 0, 64)) &&
        !!input.synergyVariants &&
        Object.keys(input.synergyVariants).length === 4 &&
        factions.every((faction) => integer(input.synergyVariants[faction], 0, 64))
    );
}

export function draftMemoryKeys(input: IDraftMemoryInput, creatureId: number) {
    const base = `b:${input.doctrine}:${input.phaseSequence}:${input.level}:${input.ownTeam}`;
    const candidate = `c:${base}:${creatureId}`;
    const tokens = [
        ...[...input.ownCreatureIds].sort((a, b) => a - b).map((id) => `own:${id}`),
        ...[...input.knownOpponentCreatureIds].sort((a, b) => a - b).map((id) => `enemy:${id}`),
        ...(input.tier1ArtifactId === null ? [] : [`artifact:${input.tier1ArtifactId}`]),
        ...(input.map === null ? [] : [`map:${input.map}`]),
        ...factions.map((faction) => `synergy:${faction}:${input.synergyVariants[faction]}`),
    ];
    return { base, candidate, contexts: tokens.map((token) => `x:${candidate}:${token}`) };
}

function validateModel(model: IDraftOpponentMemory) {
    if (
        !model ||
        model.schema !== DRAFT_OPPONENT_MEMORY_SCHEMA ||
        model.target !== "currently-occupied-offer-not-win-rate" ||
        model.qualification !== "unqualified-research" ||
        JSON.stringify(model.recipe) !== JSON.stringify(DRAFT_OPPONENT_MEMORY_RECIPE) ||
        !/^[a-f0-9]{64}$/.test(model.sourceSha256) ||
        !/^[a-f0-9]{64}$/.test(model.snapshotSha256) ||
        !model.snapshotId ||
        !integer(model.trainingFamilies, 1, 100_000_000) ||
        !integer(model.trainingContexts, 1, 1_000_000_000)
    )
        throw new Error("Incompatible draft memory artifact");
    for (const count of [model.global, ...Object.values(model.tables)])
        if (
            !Array.isArray(count) ||
            count.length !== 2 ||
            !Number.isFinite(count[0]) ||
            !integer(count[1], 1, model.trainingFamilies) ||
            count[0] < 0 ||
            count[0] > count[1] + 1e-10
        )
            throw new Error("Invalid draft memory family counts");
}

/** Compile once outside the turn. No SQLite, hidden labels, file I/O or mutable per-game state. */
export function createDraftOpponentMemory(model: IDraftOpponentMemory) {
    validateModel(model);
    const tables = new Map(Object.entries(model.tables).map(([key, count]) => [key, [...count] as [number, number]]));
    const global = (model.global[0] + 0.5) / (model.global[1] + 1);
    const smooth = (count: DraftMemoryCount | undefined, prior: number, mass: number) =>
        count ? (count[0] + prior * mass) / (count[1] + mass) : prior;
    return (input: IDraftMemoryInput) => {
        if (!validDraftMemoryInput(input)) return null;
        return input.availableCreatureIds.map((creatureId) => {
            // All previously picked enemies are visible with Spymaster; offers exclude them.
            if (input.doctrine === 2)
                return {
                    creatureId,
                    priorProbability: 0,
                    occupiedProbability: 0,
                    families: 0,
                    contextFamilies: 0,
                    exact: true,
                };
            const keys = draftMemoryKeys(input, creatureId);
            const candidate = tables.get(keys.candidate);
            const parent = smooth(tables.get(keys.base), global, DRAFT_OPPONENT_MEMORY_RECIPE.priorFamilies);
            const prior = smooth(candidate, parent, DRAFT_OPPONENT_MEMORY_RECIPE.priorFamilies);
            const contexts = keys.contexts
                .map((key) => tables.get(key))
                .filter(
                    (count): count is [number, number] =>
                        !!count && count[1] >= DRAFT_OPPONENT_MEMORY_RECIPE.minimumContextFamilies,
                );
            const adjustment = contexts.length
                ? contexts.reduce(
                      (sum, count) =>
                          sum + smooth(count, prior, DRAFT_OPPONENT_MEMORY_RECIPE.contextPriorFamilies) - prior,
                      0,
                  ) / contexts.length
                : 0;
            return {
                creatureId,
                priorProbability: prior,
                occupiedProbability: Math.max(
                    0,
                    Math.min(1, prior + DRAFT_OPPONENT_MEMORY_RECIPE.contextWeight * adjustment),
                ),
                families: candidate?.[1] ?? 0,
                contextFamilies: contexts.length ? Math.min(...contexts.map((count) => count[1])) : 0,
                exact: false,
            };
        });
    };
}
