/** Synchronous offline experiment. Importing this module does not change the serving strategy. */
import type { IEnumeratedCandidate } from "../ai/candidates";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import type { Unit } from "../units/unit";
import { SearchDriver } from "./search_driver";

export const BATTLE_MAGE_SHORTLIST_RESEARCH_ID = "battle-mage-root-shortlist8-v1" as const;

interface IResearchMethods {
    effectiveShortlist(version: string, unit?: Unit): number | null;
    shortlistCandidates(
        unit: Unit,
        candidates: readonly IEnumeratedCandidate[],
        seedBase: number,
        deadlineAt: number | null,
        version: string,
        ...flags: boolean[]
    ): readonly IEnumeratedCandidate[];
}

export interface IBattleMageShortlistTrace {
    team: TeamType;
    unitId: string;
    candidateTeam: TeamType | null;
    expanded: boolean;
    elapsedMs: number;
    incumbent: GameAction[];
    chosen: GameAction[];
    catalogs: {
        seedBase: number;
        candidates: { kind: string; actions: GameAction[]; expectedDamage: number; expectedKill: number }[];
        finalistIndices: number[];
    }[];
}

let active = false;

/**
 * Only an ordinary six-choice v0.8 Battle Mage decision on the selected physical team expands to eight.
 * Preserve all rollout policies, neural weights, other units, degraded budgets and incumbent gates.
 * A null team observes the existing policy. Diagnostics do not enable the behavior-changing teacher seam.
 */
export function withBattleMageShortlistResearch<T>(
    candidateTeam: TeamType | null,
    run: () => T,
    observe?: (trace: IBattleMageShortlistTrace) => void,
): T {
    if (active) throw new Error("Battle Mage shortlist research cannot be nested");
    if (candidateTeam !== null && candidateTeam !== PBTypes.TeamVals.LEFT && candidateTeam !== PBTypes.TeamVals.RIGHT)
        throw new Error("Battle Mage shortlist research requires a physical team or null");
    const prototype = SearchDriver.prototype as unknown as IResearchMethods;
    const effective = prototype.effectiveShortlist;
    const shortlist = prototype.shortlistCandidates;
    const choose = SearchDriver.prototype.chooseDecision;
    let current: IBattleMageShortlistTrace | undefined;
    active = true;
    prototype.effectiveShortlist = function (version, unit) {
        const original = effective.call(this, version, unit);
        if (
            candidateTeam !== null &&
            version === "v0.8" &&
            unit?.getName() === "Battle Mage" &&
            unit.getTeam() === candidateTeam &&
            original === 6
        ) {
            if (current) current.expanded = true;
            return 8;
        }
        return original;
    };
    prototype.shortlistCandidates = function (unit, candidates, seedBase, deadlineAt, version, ...flags) {
        const result = shortlist.call(this, unit, candidates, seedBase, deadlineAt, version, ...flags);
        if (current && observe) {
            current.catalogs.push({
                seedBase,
                candidates: candidates.map((candidate) => ({
                    kind: candidate.kind,
                    actions: structuredClone(candidate.actions),
                    expectedDamage: candidate.features.expectedDamage,
                    expectedKill: candidate.features.expectedKill,
                })),
                finalistIndices: result.map((candidate) => candidates.indexOf(candidate)),
            });
        }
        return result;
    };
    SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context) {
        if (unit.getName() !== "Battle Mage" || version !== "v0.8")
            return choose.call(this, unit, version, incumbent, context);
        const previous = current;
        const trace: IBattleMageShortlistTrace = {
            team: unit.getTeam(),
            unitId: unit.getId(),
            candidateTeam,
            expanded: false,
            elapsedMs: 0,
            incumbent: structuredClone(incumbent),
            chosen: [],
            catalogs: [],
        };
        current = trace;
        const started = performance.now();
        try {
            const result = choose.call(this, unit, version, incumbent, context);
            trace.elapsedMs = performance.now() - started;
            trace.chosen = structuredClone(result);
            observe?.(trace);
            return result;
        } finally {
            current = previous;
        }
    };
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Battle Mage shortlist research requires a synchronous callback");
        return result;
    } finally {
        prototype.effectiveShortlist = effective;
        prototype.shortlistCandidates = shortlist;
        SearchDriver.prototype.chooseDecision = choose;
        active = false;
    }
}
