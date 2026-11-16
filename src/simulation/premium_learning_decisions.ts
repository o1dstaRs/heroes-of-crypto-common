import { getUpgradePoints } from "../doctrines/doctrine_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";
import type { IAiMetaChoiceEvidence } from "./ai_meta_evidence";
import { PREMIUM_META_POLICY_LEARNING_STUDY } from "./ai_meta_study";

export const PREMIUM_LEARNING_DECISION_SCHEMA = "premium-learning-decision-v1";

export interface IPremiumLearningDecision {
    schema: typeof PREMIUM_LEARNING_DECISION_SCHEMA;
    familyId: string;
    side: "a" | "b";
    kind: "draft" | "augment" | "formation";
    index: number;
    physicalTeam: number;
    observation: Record<string, unknown>;
    selectedKey: string;
    action: unknown;
    candidateActions?: unknown[];
    status: "accepted" | "collision";
    distribution: IAiMetaChoiceEvidence;
    observedScore: number;
    labelScope: "seat-paired-army" | "single-fight-army";
    executionContract: "headless-meta-ranked-sides-not-server-qualified";
    evidenceKind: "logged-policy-outcome-not-paired-alternative";
}

/** Deterministic normalization. Labels and actions never enter the pre-decision observation. */
export function premiumLearningDecisions(record: IAiMetaPairRecord): IPremiumLearningDecision[] {
    if (record.evidence?.studyProfile !== PREMIUM_META_POLICY_LEARNING_STUDY) return [];
    const evidence = record.evidence;
    const rows: IPremiumLearningDecision[] = [];
    const score = (side: "a" | "b", index?: number) => {
        const games = index === undefined ? record.games : [record.games[index]];
        return (
            games.reduce((sum, game) => sum + (game.winner === "draw" ? 0.5 : Number(game.winner === side)), 0) /
            games.length
        );
    };
    const base = (side: "a" | "b") => ({
        schema: PREMIUM_LEARNING_DECISION_SCHEMA as typeof PREMIUM_LEARNING_DECISION_SCHEMA,
        familyId: evidence.scenarioId,
        side,
        physicalTeam: 0,
        observedScore: score(side),
        labelScope: "seat-paired-army" as const,
        executionContract: "headless-meta-ranked-sides-not-server-qualified" as const,
        evidenceKind: "logged-policy-outcome-not-paired-alternative" as const,
    });
    for (const decision of evidence.rankedDraft?.decisions ?? []) {
        if (!decision.choice) throw new Error("Learning draft requires a complete distribution");
        const action = decision.action;
        const side = action.team === PBTypes.TeamVals.LEFT ? "a" : "b";
        const selectedKey = String(
            action.type === "select_bundle"
                ? action.bundleIndex
                : action.type === "select_tier2"
                  ? action.artifactId
                  : action.type === "select_doctrine"
                    ? action.doctrine
                    : action.creatureId,
        );
        rows.push({
            ...base(side),
            kind: "draft",
            index: decision.index,
            observation: { ...structuredClone(decision.observation) },
            selectedKey,
            action: structuredClone(action),
            status: decision.status,
            distribution: structuredClone(decision.choice),
        });
    }
    for (const side of ["a", "b"] as const) {
        const army = side === "a" ? record.armyA : record.armyB;
        const observation = {
            phase: "public-setup-before-spending",
            cohort: record.cohort,
            map: record.map,
            ownCreatureIds: [...army.creatureIds],
            ownRoster: structuredClone(army.roster),
            knownOpponentCreatureIds: [...evidence.setupObservations![side].knownOpponentCreatureIds],
            opponentRosterVisibility: evidence.setupObservations![side].opponentRosterVisibility,
            doctrine: army.doctrine,
            budget: getUpgradePoints(army.doctrine),
            artifactT1: army.artifactT1.id,
            artifactT2: army.artifactT2.id,
            synergyVariants: structuredClone(evidence.synergyVariants),
        };
        if (!army.augment.evidence) throw new Error("Learning setup requires sampling probabilities");
        rows.push({
            ...base(side),
            kind: "augment",
            index: 0,
            observation,
            selectedKey: army.augment.planId,
            action: structuredClone(army.augment.plan),
            status: "accepted",
            distribution: structuredClone(army.augment.evidence),
        });
        for (const [index, fight] of evidence.fights!.entries()) {
            const decision = fight.formationChoices![side];
            rows.push({
                ...base(side),
                kind: "formation",
                index,
                physicalTeam: decision.observation.team,
                labelScope: "single-fight-army",
                observedScore: score(side, index),
                observation: {
                    ...observation,
                    phase: "formation-after-spending",
                    augments: structuredClone(army.augment.augments),
                    geometry: structuredClone(decision.observation),
                },
                selectedKey: decision.selectedKey,
                action: structuredClone(decision.proposals.find(({ key }) => key === decision.selectedKey)!),
                candidateActions: structuredClone(decision.proposals),
                status: "accepted",
                distribution: structuredClone(decision.choice),
            });
        }
    }
    return rows;
}
