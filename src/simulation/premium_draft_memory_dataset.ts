import type { IAiMetaDraftDecision } from "./ai_meta_evidence";
import { premiumLearningInput } from "./premium_learning_dataset";

export const PREMIUM_DRAFT_MEMORY_SCHEMA = "premium-public-draft-opponent-target-v1";

/** Deliberately contains no army score, final formation or combat result. */
export interface IPremiumDraftHistoryRow {
    familyId: string;
    side: "a" | "b";
    partition: "train";
    snapshotId: string;
    decision: IAiMetaDraftDecision;
}

export type PremiumDraftPublicInput = ReturnType<typeof premiumLearningInput>;

const setEqual = (a: readonly number[], b: readonly number[]) =>
    a.length === b.length && new Set(a).size === a.length && a.every((id) => b.includes(id));
const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);

/** Reconstruct one COMPLETE training family. Hidden/future identities are targets, never input. */
export function premiumDraftOpponentExamples(history: readonly IPremiumDraftHistoryRow[]) {
    if (!history.length) throw new Error("Empty draft family");
    const first = history[0];
    const rows = [...history].sort((a, b) => a.decision.index - b.decision.index);
    const rosters: Record<"a" | "b", number[]> = { a: [], b: [] };
    const teams = new Map<string, number>();
    const timeline = rows.map((row, index) => {
        const { decision, side } = row;
        if (
            row.partition !== "train" ||
            row.familyId !== first.familyId ||
            row.snapshotId !== first.snapshotId ||
            !["a", "b"].includes(side) ||
            decision.index !== index ||
            !["accepted", "collision"].includes(decision.status) ||
            !decision.choice
        )
            throw new Error("Incomplete, mixed or unsupported training draft family");
        const team = decision.action.team;
        if (teams.has(side) && teams.get(side) !== team) throw new Error("Changed draft side identity");
        teams.set(side, team);
        const input = premiumLearningInput({
            kind: "draft",
            observation: { ...decision.observation },
            action: decision.action,
            distribution: decision.choice,
        });
        const other = side === "a" ? "b" : "a";
        const own = input.observation.creaturesPicked as number[];
        const visible = input.observation.knownOpponentCreatures as number[];
        if (!setEqual(own, rosters[side]) || visible.some((id) => !rosters[other].includes(id)))
            throw new Error("Draft observation differs from pre-action roster");
        const action = decision.action;
        const key = String(
            "creatureId" in action
                ? action.creatureId
                : "bundleIndex" in action
                  ? action.bundleIndex
                  : "doctrine" in action
                    ? action.doctrine
                    : "artifactId" in action
                      ? action.artifactId
                      : NaN,
        );
        const distribution = decision.choice.candidates;
        const selected = input.candidates.find((candidate) => candidate.key === key);
        const selectedProbability = distribution.find((candidate) => candidate.key === key)?.probability;
        if (
            !selected ||
            new Set(distribution.map((candidate) => candidate.key)).size !== distribution.length ||
            distribution.some(
                ({ probability }) => !Number.isFinite(probability) || probability < 0 || probability > 1,
            ) ||
            Math.abs(distribution.reduce((sum, candidate) => sum + candidate.probability, 0) - 1) > 1e-10 ||
            !(selectedProbability! > 0) ||
            selectedProbability !== decision.behaviorProbability ||
            selectedProbability !== decision.choice.behaviorProbability
        )
            throw new Error("Invalid logged draft distribution");
        const before = [...rosters[other]];
        if (action.type === "select_bundle") {
            if (decision.status !== "accepted") throw new Error("Invalid bundle collision");
            rosters[side].push(...(selected.action.bundle as number[]).slice(0, 2));
        } else if (action.type === "pick_creature") {
            if (before.includes(action.creatureId) !== (decision.status === "collision"))
                throw new Error("Collision differs from pre-action occupancy");
            if (decision.status === "accepted") rosters[side].push(action.creatureId);
        } else if (decision.status !== "accepted") throw new Error("Invalid non-pick collision");
        return { row, input, before, key };
    });
    if (
        teams.size !== 2 ||
        new Set(teams.values()).size !== 2 ||
        rosters.a.length !== 6 ||
        rosters.b.length !== 6 ||
        new Set([...rosters.a, ...rosters.b]).size !== 12
    )
        throw new Error("Incomplete or overlapping final draft rosters");
    return timeline.flatMap(({ row, input, before, key }, position) => {
        if (row.decision.action.type !== "pick_creature") return [];
        const other = row.side === "a" ? "b" : "a";
        const visible = input.observation.knownOpponentCreatures as number[];
        const hidden = before.filter((id) => !visible.includes(id));
        const offered = input.candidates.map((candidate) => Number(candidate.action.creatureId));
        if (offered.some((id) => visible.includes(id)) || (input.observation.doctrine === 2 && hidden.length > 0))
            throw new Error("Draft visibility/offer contract disagrees with history");
        return [
            {
                schema: PREMIUM_DRAFT_MEMORY_SCHEMA,
                input,
                logged: {
                    selectedKey: key,
                    status: row.decision.status,
                    probabilities: row.decision.choice!.candidates.map(({ key: candidateKey, probability }) => ({
                        key: candidateKey,
                        probability,
                    })),
                },
                target: {
                    opponentAlreadyPicked: sorted(before),
                    hiddenAlreadyPicked: sorted(hidden),
                    currentlyOccupiedOfferedCreatures: sorted(offered.filter((id) => before.includes(id))),
                    opponentFinalRoster: sorted(rosters[other]),
                    subsequentAcceptedOpponentPicks: timeline.slice(position + 1).flatMap(({ row: future }) =>
                        future.side === other &&
                        future.decision.action.type === "pick_creature" &&
                        future.decision.status === "accepted"
                            ? [
                                  {
                                      creatureId: future.decision.action.creatureId,
                                      phaseSequence: future.decision.observation.phaseSequence,
                                  },
                              ]
                            : [],
                    ),
                    observedOwnAttemptCollided: row.decision.status === "collision",
                },
                audit: {
                    familyId: first.familyId,
                    side: row.side,
                    index: row.decision.index,
                    partition: "train" as const,
                    snapshotId: first.snapshotId,
                },
            },
        ];
    });
}

export type PremiumDraftOpponentExample = ReturnType<typeof premiumDraftOpponentExamples>[number];
