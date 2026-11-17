import { enumeratePremiumAugmentPlans, premiumAugmentPlanId } from "../ai/setup/premium_augment_plans";
import { metaFormationProposals, type IMetaFormationInput } from "./ai_meta_formation_learning";
import { PREMIUM_LEARNING_DECISION_SCHEMA, type IPremiumLearningDecision } from "./premium_learning_decisions";

export const PREMIUM_TRAINING_EXAMPLE_SCHEMA = "premium-training-example-v1";
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected learning object");
    return value as ObjectValue;
}

function fields(value: unknown, keys: string[]): ObjectValue {
    const input = object(value);
    if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
        throw new Error("Unrecognized or missing learning observation fields");
    return input;
}

function integer(value: unknown): number {
    if (!Number.isSafeInteger(value)) throw new Error("Invalid learning integer");
    return value as number;
}

function numbers(value: unknown): number[] {
    if (!Array.isArray(value)) throw new Error("Expected learning array");
    return value.map(integer);
}

function variants(value: unknown): ObjectValue {
    const input = fields(value, ["Life", "Nature", "Chaos", "Might"]);
    return Object.fromEntries(Object.entries(input).map(([key, n]) => [key, integer(n)]));
}

function cell(value: unknown) {
    const input = fields(value, ["x", "y"]);
    return { x: integer(input.x), y: integer(input.y) };
}

const draftFields = [
    "phaseSequence",
    "phase",
    "actors",
    "requiredCreatureLevel",
    "complete",
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
const setupFields = [
    "phase",
    "cohort",
    "map",
    "ownCreatureIds",
    "ownRoster",
    "knownOpponentCreatureIds",
    "opponentRosterVisibility",
    "doctrine",
    "budget",
    "artifactT1",
    "artifactT2",
    "synergyVariants",
];
const plansByBudget = new Map<number, Map<string, ObjectValue>>();

/** Only this object is a model input. It excludes outcomes, behavior scores and opaque audit IDs. */
export function premiumLearningInput(
    row: Pick<IPremiumLearningDecision, "kind" | "observation" | "action" | "distribution" | "candidateActions">,
) {
    const keys = row.distribution.candidates.map(({ key }) => key);
    let observation: ObjectValue;
    let actions: ObjectValue[];
    let stage: string = row.kind;
    if (row.kind === "draft") {
        const input = fields(row.observation, draftFields);
        const action = object(row.action);
        stage = `draft:${action.type}`;
        const team = integer(action.team);
        if (![1, 2].includes(team) || input.complete !== false) throw new Error("Invalid draft decision actor");
        observation = {
            ownTeam: team,
            phaseSequence: integer(input.phaseSequence),
            phase: integer(input.phase),
            actors: numbers(input.actors),
            requiredCreatureLevel: integer(input.requiredCreatureLevel),
            creaturesBanned: numbers(input.creaturesBanned),
            creaturesPicked: numbers(input.creaturesPicked),
            knownOpponentCreatures: numbers(input.knownOpponentCreatures),
            doctrine: integer(input.doctrine),
            bundles: (input.bundles as unknown[]).map(numbers),
            tier2Offers: numbers(input.tier2Offers),
            artifacts: (input.artifacts as unknown[]).map(numbers),
            availableCreatureIds: numbers(input.availableCreatureIds),
            revealedOpponentSlots: numbers(input.revealedOpponentSlots),
            revealedMap: input.revealedMap === null ? null : integer(input.revealedMap),
            synergyVariants: variants(input.synergyVariants),
        };
        actions = keys.map((key) => {
            const id = Number(key);
            if (!Number.isSafeInteger(id) || String(id) !== key) throw new Error("Invalid draft action key");
            switch (action.type) {
                case "select_doctrine":
                    if (![1, 2, 3].includes(id)) throw new Error("Invalid doctrine offer");
                    return { doctrine: id };
                case "select_bundle": {
                    const bundles = observation.bundles as number[][];
                    if (!bundles[id]) throw new Error("Unknown bundle offer");
                    return { bundleIndex: id, bundle: [...bundles[id]] };
                }
                case "select_tier2":
                    if (!(observation.tier2Offers as number[]).includes(id)) throw new Error("Unknown artifact offer");
                    return { artifactId: id };
                case "pick_creature":
                    if (!(observation.availableCreatureIds as number[]).includes(id))
                        throw new Error("Unknown creature offer");
                    return { creatureId: id };
                default:
                    throw new Error("Unknown draft learning stage");
            }
        });
    } else {
        const input = fields(
            row.observation,
            row.kind === "formation" ? [...setupFields, "augments", "geometry"] : setupFields,
        );
        if (input.opponentRosterVisibility !== "complete") throw new Error("Unsupported setup visibility");
        if (input.phase !== (row.kind === "formation" ? "formation-after-spending" : "public-setup-before-spending"))
            throw new Error("Wrong setup learning phase");
        observation = {
            phase: input.phase,
            map: integer(input.map),
            ownCreatureIds: numbers(input.ownCreatureIds),
            ownRoster: (input.ownRoster as unknown[]).map((value) => {
                const unit = fields(value, ["faction", "creatureName", "level", "size", "amount"]);
                if (typeof unit.faction !== "string" || typeof unit.creatureName !== "string")
                    throw new Error("Invalid roster identity");
                return {
                    faction: unit.faction,
                    creatureName: unit.creatureName,
                    level: integer(unit.level),
                    size: integer(unit.size),
                    amount: integer(unit.amount),
                };
            }),
            knownOpponentCreatureIds: numbers(input.knownOpponentCreatureIds),
            doctrine: integer(input.doctrine),
            budget: integer(input.budget),
            artifactT1: integer(input.artifactT1),
            artifactT2: integer(input.artifactT2),
            synergyVariants: variants(input.synergyVariants),
        };
        if (row.kind === "augment") {
            const budget = Number(observation.budget);
            if (!plansByBudget.has(budget))
                plansByBudget.set(
                    budget,
                    new Map(
                        enumeratePremiumAugmentPlans(budget).map((plan) => [
                            premiumAugmentPlanId(plan),
                            { ...plan, empower: plan.empower ?? 0 },
                        ]),
                    ),
                );
            actions = keys.map((key) => {
                const plan = plansByBudget.get(budget)!.get(key);
                if (!plan) throw new Error("Unknown or unfunded augment action");
                return { ...plan };
            });
        } else if (row.kind === "formation") {
            const geometry = input.geometry as IMetaFormationInput;
            const proposals = metaFormationProposals(geometry);
            if (
                JSON.stringify(proposals) !== JSON.stringify(row.candidateActions) ||
                JSON.stringify(proposals.map(({ key }) => key)) !== JSON.stringify(keys)
            )
                throw new Error("Formation candidates differ from legal pre-decision geometry");
            const indices = new Map(geometry.units.map((unit, index) => [unit.unitId, index]));
            observation.augments = (input.augments as unknown[]).map((value) => {
                const augment = fields(value, ["kind", "value"]);
                if (typeof augment.kind !== "string") throw new Error("Invalid augment kind");
                return { kind: augment.kind, value: integer(augment.value) };
            });
            observation.geometry = {
                team: integer(geometry.team),
                gridType: integer(geometry.gridType),
                legalCells: geometry.legalCells.map(cell),
                units: geometry.units.map((unit, index) => ({
                    slot: index,
                    creatureName: unit.creatureName,
                    amount: unit.amount,
                    width: unit.width,
                    height: unit.height,
                    cell: cell(unit.cell),
                })),
            };
            actions = proposals.map((proposal) => ({
                positions: proposal.positions.map((position) => ({
                    slot: indices.get(position.unitId)!,
                    cell: cell(position.cell),
                })),
            }));
        } else throw new Error("Unknown learning stage");
    }
    return { stage, observation, candidates: keys.map((key, i) => ({ key, action: actions[i] })) };
}

/** Projection only: no fitted weights, inverse-propensity weighting or outcome-selected actions. */
export function premiumTrainingExample(row: IPremiumLearningDecision) {
    if (
        row.schema !== PREMIUM_LEARNING_DECISION_SCHEMA ||
        row.executionContract !== "headless-meta-ranked-sides-not-server-qualified" ||
        row.evidenceKind !== "logged-policy-outcome-not-paired-alternative"
    )
        throw new Error("Unsupported learning contract");
    const input = premiumLearningInput(row);
    const distribution = row.distribution.candidates;
    const selected = distribution.find(({ key }) => key === row.selectedKey);
    if (
        !distribution.length ||
        new Set(distribution.map(({ key }) => key)).size !== distribution.length ||
        !selected ||
        distribution.some(({ probability }) => !Number.isFinite(probability) || probability <= 0 || probability > 1) ||
        Math.abs(distribution.reduce((sum, { probability }) => sum + probability, 0) - 1) > 1e-10 ||
        Math.abs(selected.probability - row.distribution.behaviorProbability) > 1e-10
    )
        throw new Error("Invalid full marginal learning probabilities");
    if (
        !["accepted", "collision"].includes(row.status) ||
        (row.status === "collision" && input.stage !== "draft:pick_creature") ||
        !Number.isFinite(row.observedScore) ||
        row.observedScore < 0 ||
        row.observedScore > 1 ||
        row.labelScope !== (row.kind === "formation" ? "single-fight-army" : "seat-paired-army")
    )
        throw new Error("Invalid logged outcome or label scope");
    const action = object(row.action);
    if (row.kind === "draft") {
        const field = {
            select_doctrine: "doctrine",
            select_bundle: "bundleIndex",
            select_tier2: "artifactId",
            pick_creature: "creatureId",
        }[String(action.type)];
        if (!field || String(action[field]) !== row.selectedKey)
            throw new Error("Selected draft action differs from logged key");
        fields(action, ["type", "team", field]);
    } else if (row.kind === "augment") {
        const plan = input.candidates.find(({ key }) => key === row.selectedKey)!.action;
        fields(action, [
            "placement",
            "armor",
            "might",
            "sniper",
            "movement",
            ...(Object.hasOwn(action, "empower") ? ["empower"] : []),
        ]);
        if (Object.entries(plan).some(([key, value]) => value !== (action[key] ?? 0)))
            throw new Error("Selected augment action differs from logged key");
    } else if (
        JSON.stringify(row.action) !==
        JSON.stringify((row.candidateActions as { key: string }[]).find(({ key }) => key === row.selectedKey))
    ) {
        throw new Error("Selected formation differs from logged key");
    }
    return {
        schema: PREMIUM_TRAINING_EXAMPLE_SCHEMA,
        input,
        logged: {
            selectedKey: row.selectedKey,
            status: row.status,
            probabilities: distribution.map(({ key, probability }) => ({ key, probability })),
        },
        target: { observedScore: row.observedScore, labelScope: row.labelScope },
        audit: {
            familyId: row.familyId,
            side: row.side,
            decisionIndex: row.index,
            physicalTeam: row.physicalTeam,
            executionContract: row.executionContract,
            evidenceKind: row.evidenceKind,
        },
    };
}
