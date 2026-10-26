import type { IDecisionContext } from "../ai/ai_strategy";
import type { IEnumeratedCandidate } from "../ai/candidates";
import { creatureInfo } from "../ai/setup/creature_score";
import { v09CandidateSignature } from "../ai/versions/v0_9";
import type { GameAction } from "../engine/actions";
import type { Unit } from "../units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../utils/lib";
import { auditDigest, type A19AuditProfile } from "./a19_decision_audit";
import { hashSimulationParts, makeRng } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch, type IMatchConfig, type IMatchResult } from "./battle_engine";
import { snapshotBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";
import { continuationCandidates, continuationFeatures } from "./measure_search_continuation";
import { SearchDriver } from "./search_driver";
import { withScopedAIEnvironment } from "./v0_8_a13_search";

export interface IActualContinuationCandidate {
    signature: string;
    actions: GameAction[];
    kind: string;
    returnedR2Score: number | null;
    features?: number[];
}

export interface IActualContinuationPosition {
    ordinal: number;
    actorId: string;
    actor: string;
    team: number;
    lap: number;
    stateDigest: string;
    prefixDigest: string;
    baselineSignature: string;
    candidates: IActualContinuationCandidate[];
    state?: unknown;
}

export interface IActualContinuationIntervention {
    position: Pick<
        IActualContinuationPosition,
        "ordinal" | "actorId" | "stateDigest" | "prefixDigest" | "baselineSignature"
    >;
    actions: readonly GameAction[];
    combatSeed: number | null;
}

interface IObservedDriver {
    deps: ILookaheadDeps;
    horizon: number;
    rollouts: number;
    shortlist: number;
    complementaryR2: boolean;
    a19MaterialArbitration: string | undefined;
    certifiedSelectionBounds: boolean;
    certifiedTightBounds: boolean;
    chooseDecision(unit: Unit, version: string, incumbent: GameAction[], context?: IDecisionContext): GameAction[];
    scoreCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seed: number,
        mode: string,
        count?: number,
        deadline?: number | null,
        turns?: number,
        ...rest: unknown[]
    ): number[];
}

export function selectActualContinuationPosition(
    positions: readonly IActualContinuationPosition[],
    board: number,
    seed: number,
): IActualContinuationPosition | null {
    const eligible = positions.filter((position) => position.candidates.length > 1);
    const team = board % 2 === 0 ? GREEN_TEAM : RED_TEAM;
    const phase = Math.floor(board / 3) % 3;
    const inPhase = (lap: number) => (lap <= 2 ? 0 : lap <= 5 ? 1 : 2) === phase;
    const groups = [
        eligible.filter((position) => position.team === team && inPhase(position.lap)),
        eligible.filter((position) => position.team === team),
        eligible,
    ];
    const available = groups.find((group) => group.length);
    if (!available) return null;
    return [...available].sort(
        (left, right) =>
            hashSimulationParts("actual-a19-position-v1", seed, board, left.ordinal) -
                hashSimulationParts("actual-a19-position-v1", seed, board, right.ordinal) ||
            left.ordinal - right.ordinal,
    )[0];
}

/** Research sampler: compare midpoint scores with an outcome-blind control in the same team/phase. */
export function selectMidpointActualContinuationPair(
    positions: readonly IActualContinuationPosition[],
    board: number,
    seed: number,
): {
    control: IActualContinuationPosition | null;
    midpoint: IActualContinuationPosition | null;
    midpointAvailable: boolean;
    eligiblePositions: number;
    midpointPositions: number;
} {
    const eligible = positions.filter(
        (position) =>
            Number.isFinite(position.candidates[0]?.returnedR2Score) &&
            new Set(
                position.candidates
                    .filter((candidate) => Number.isFinite(candidate.returnedR2Score))
                    .map((candidate) => candidate.signature),
            ).size > 1,
    );
    const midpoints = eligible.filter((position) => position.candidates[0].returnedR2Score === 0.5);
    const midpoint = selectActualContinuationPosition(midpoints, board, seed);
    if (!midpoint) {
        const control = selectActualContinuationPosition(eligible, board, seed);
        return {
            control,
            midpoint: control,
            midpointAvailable: false,
            eligiblePositions: eligible.length,
            midpointPositions: 0,
        };
    }
    const phase = (lap: number) => (lap <= 2 ? 0 : lap <= 5 ? 1 : 2);
    const controls = eligible.filter(
        (position) => position.team === midpoint.team && phase(position.lap) === phase(midpoint.lap),
    );
    const control = [...controls].sort(
        (left, right) =>
            hashSimulationParts("actual-a19-midpoint-control-v1", seed, board, left.ordinal) -
                hashSimulationParts("actual-a19-midpoint-control-v1", seed, board, right.ordinal) ||
            left.ordinal - right.ordinal,
    )[0];
    return {
        control,
        midpoint,
        midpointAvailable: true,
        eligiblePositions: eligible.length,
        midpointPositions: midpoints.length,
    };
}

export function observeActualA19Match(
    config: IMatchConfig,
    profile: A19AuditProfile,
    options: {
        intervention?: IActualContinuationIntervention;
        featureOrdinal?: number;
        maxCandidates?: number;
        captureAllPositions?: boolean;
        captureState?: boolean;
        /** Offline research only. Undefined/baseline selections preserve the original action array. */
        policy?: {
            team: number;
            select(position: Readonly<IActualContinuationPosition>): string | undefined;
        };
    } = {},
): {
    result: IMatchResult;
    positions: IActualContinuationPosition[];
    traceDigest: string;
    searchedTurns: number;
    searchedTurnsAfterIntervention: number;
    interventionApplied: boolean;
} {
    if (config.greenVersion !== "v0.8" || config.redVersion !== "v0.8" || !config.searchOfflineDeterministicWork)
        throw new Error("Actual continuation requires two offline A19 seats");
    if (options.policy && options.intervention) throw new Error("Policy and root intervention are mutually exclusive");
    if (options.policy && options.policy.team !== GREEN_TEAM && options.policy.team !== RED_TEAM)
        throw new Error("Invalid continuation policy team");
    const maxCandidates = options.maxCandidates ?? 7;
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 2 || maxCandidates > 7)
        throw new Error("Invalid retained-candidate cap");
    if (
        options.intervention?.combatSeed !== undefined &&
        options.intervention.combatSeed !== null &&
        (!Number.isSafeInteger(options.intervention.combatSeed) ||
            options.intervention.combatSeed < 0 ||
            options.intervention.combatSeed > 0xffffffff)
    )
        throw new Error("Continuation combat seed must be uint32 or null");
    const catalogRandom = captureDeterministicRandomState();
    try {
        setDeterministicRandomSource(undefined);
        creatureInfo(1);
    } finally {
        restoreDeterministicRandomState(catalogRandom);
    }
    const prototype = SearchDriver.prototype as unknown as IObservedDriver;
    const choose = prototype.chooseDecision;
    const score = prototype.scoreCandidates;
    const profileOverrides = Object.fromEntries(
        Object.entries(profile.overrides).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const random = captureDeterministicRandomState();
    const positions: IActualContinuationPosition[] = [];
    const trace: unknown[] = [];
    let searchedTurns = 0;
    let searchedTurnsAfterIntervention = 0;
    let applied = false;
    let active:
        | { driver: IObservedDriver; candidates: Map<string, { candidate: IEnumeratedCandidate; score: number }> }
        | undefined;
    prototype.scoreCandidates = function (...args) {
        const values = score.apply(this, args);
        if (
            active?.driver === this &&
            args[3] === "turns" &&
            (args[4] ?? this.rollouts) === 2 &&
            (args[6] ?? this.horizon) === 64
        ) {
            args[1].forEach((candidate, index) => {
                if (Number.isFinite(values[index])) {
                    active!.candidates.set(v09CandidateSignature(candidate.actions), {
                        candidate,
                        score: values[index],
                    });
                }
            });
        }
        return values;
    };
    prototype.chooseDecision = function (...args) {
        const [unit, , , context] = args;
        const expected = profile.environment;
        if (
            this.horizon !== 64 ||
            this.rollouts !== 2 ||
            this.shortlist !== 6 ||
            !this.complementaryR2 ||
            this.a19MaterialArbitration !== expected.SEARCH_A19_MATERIAL_ARBITRATION ||
            this.certifiedSelectionBounds !== (expected.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS === "1") ||
            this.certifiedTightBounds !== (expected.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS === "1")
        )
            throw new Error("Continuation driver differs from captured R2 profile");
        const ordinal = searchedTurns++;
        if (applied) searchedTurnsAfterIntervention++;
        const policyTurn = options.policy?.team === unit.getTeam();
        const capture =
            options.captureAllPositions !== false || ordinal === options.intervention?.position.ordinal || policyTurn;
        const prior = active;
        const frame = { driver: this, candidates: new Map() } as NonNullable<typeof active>;
        active = capture ? frame : undefined;
        let chosen: GameAction[];
        try {
            chosen = choose.apply(this, args);
        } finally {
            active = prior;
        }
        const baselineSignature = v09CandidateSignature(chosen);
        let returned = chosen;
        if (capture) {
            if (!context) throw new Error("Actual A19 root lacks decision context");
            const state = () => ({
                ...snapshotBattle(this.deps.unitsHolder, this.deps.grid, this.deps.fightProperties),
                unitRefs: undefined,
                uuidSequence: captureDeterministicRandomState().uuidSequence,
            });
            const epoch = () => auditDigest(state());
            const stateDigest = epoch();
            const priorRandom = captureDeterministicRandomState();
            let candidates: IActualContinuationCandidate[];
            try {
                const baseline =
                    frame.candidates.get(baselineSignature)?.candidate ??
                    continuationCandidates(unit, context, chosen)[0];
                const retained = [...frame.candidates.entries()]
                    .filter(([signature]) => signature !== baselineSignature)
                    .sort(([left, a], [right, b]) => b.score - a.score || left.localeCompare(right))
                    .slice(0, maxCandidates - 1)
                    .map(([, entry]) => entry.candidate);
                const catalog = [baseline, ...retained];
                const features =
                    options.featureOrdinal === ordinal || policyTurn
                        ? continuationFeatures(unit, context, catalog)
                        : undefined;
                candidates = catalog.map((candidate, index) => ({
                    signature: v09CandidateSignature(candidate.actions),
                    actions: structuredClone(candidate.actions),
                    kind: candidate.kind,
                    returnedR2Score: frame.candidates.get(v09CandidateSignature(candidate.actions))?.score ?? null,
                    ...(features ? { features: features[index] } : {}),
                }));
            } finally {
                restoreDeterministicRandomState(priorRandom);
            }
            if (epoch() !== stateDigest) throw new Error("Candidate recording changed the live decision epoch");
            const position: IActualContinuationPosition = {
                ordinal,
                actorId: unit.getId(),
                actor: unit.getName(),
                team: unit.getTeam(),
                lap: this.deps.fightProperties.getCurrentLap(),
                stateDigest,
                prefixDigest: auditDigest(trace),
                baselineSignature,
                candidates,
                ...(options.captureState
                    ? {
                          state: JSON.parse(
                              JSON.stringify(state(), (_key, value) =>
                                  value instanceof Map || value instanceof Set ? [...value] : value,
                              ),
                          ),
                      }
                    : {}),
            };
            positions.push(position);
            if (policyTurn) {
                const policyRandom = captureDeterministicRandomState();
                let signature: string | undefined;
                try {
                    signature = options.policy!.select(position);
                } finally {
                    restoreDeterministicRandomState(policyRandom);
                }
                if (epoch() !== stateDigest) throw new Error("Continuation policy changed the live decision epoch");
                if (signature !== undefined && signature !== baselineSignature) {
                    const selected = candidates.find((candidate) => candidate.signature === signature);
                    if (!selected || v09CandidateSignature(selected.actions) !== signature)
                        throw new Error("Policy selection is outside the recorded retained catalog");
                    returned = structuredClone(selected.actions);
                }
            }
            const intervention = options.intervention;
            if (intervention?.position.ordinal === ordinal) {
                for (const key of ["actorId", "stateDigest", "prefixDigest", "baselineSignature"] as const) {
                    if (position[key] !== intervention.position[key])
                        throw new Error(`Continuation prefix drift: ${key}`);
                }
                const signature = v09CandidateSignature(intervention.actions);
                if (!candidates.some((candidate) => candidate.signature === signature))
                    throw new Error("Intervention is outside the recorded retained catalog");
                if (intervention.combatSeed !== null) setDeterministicRandomSource(makeRng(intervention.combatSeed));
                // The engine uses reference identity to preserve the native target-memory commit.
                // An unchanged baseline must retain that identity even with a new combat seed.
                returned =
                    signature === baselineSignature ? chosen : (structuredClone(intervention.actions) as GameAction[]);
                applied = true;
            }
        }
        trace.push([unit.getId(), unit.getTeam(), this.deps.fightProperties.getCurrentLap(), returned]);
        return returned;
    };
    try {
        const result = withScopedAIEnvironment({ V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, LIVETWIN: "1" }, () =>
            runMatch({ ...config, headlessEvents: true, researchA19BaseSearchEnvironment: profileOverrides }),
        );
        if (options.intervention && !applied) throw new Error("Continuation never reached its registered root");
        if ((result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0))
            throw new Error(`Actual continuation rejected actions: ${JSON.stringify(result.rejectedDetails)}`);
        return {
            result,
            positions,
            traceDigest: auditDigest(trace),
            searchedTurns,
            searchedTurnsAfterIntervention,
            interventionApplied: applied,
        };
    } finally {
        prototype.chooseDecision = choose;
        prototype.scoreCandidates = score;
        restoreDeterministicRandomState(random);
    }
}
