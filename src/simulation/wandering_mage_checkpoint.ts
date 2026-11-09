/** Saved research candidates. Importing this module does not activate a live AI policy. */
import { planTacticalStackSplits, type ITacticalSplitUnit } from "../ai/tactical_split_placement";
import { PBTypes } from "../generated/protobuf/v1/types";
import checkpoint from "./checkpoints/wandering_mage_20261108/checkpoint.json";
import { SearchDriver } from "./search_driver";
import { fingerprintV09 } from "./v0_9/protocol";
import { planWanderingMageResearchSplits, protectWanderingMageResearchPlacement } from "./wandering_mage_research";

export const LOCKED_WANDERING_MAGE_ID = "wandering-mage-candidates-20261108";
export const LOCKED_WANDERING_MAGE_SHA256 = "f98041c7966c1e915f49b0e205484fbb4580ede93576efae9fee9f0bfd5eea0e";
export const LOCKED_WANDERING_MAGE_STRATEGIES = [
    "wandering-mage-one-buff-search8-20261108",
    "wandering-mage-rear-lateral-20261108",
] as const;
export type LockedWanderingMageStrategy = (typeof LOCKED_WANDERING_MAGE_STRATEGIES)[number];

/** User preservation keeps the original failed gates and all outcomes, including losses. */
export function lockedWanderingMageCheckpoint() {
    const { sha256, ...body } = checkpoint;
    if (
        sha256 !== LOCKED_WANDERING_MAGE_SHA256 ||
        fingerprintV09(body) !== sha256 ||
        body.id !== LOCKED_WANDERING_MAGE_ID ||
        body.productionActivation !== false ||
        body.originalProgressionGatesPassed !== false ||
        body.subsequentExperimentsMayOverwrite !== false
    )
        throw new Error("Locked Wandering Mage checkpoint changed");
    return structuredClone(checkpoint);
}

let searchScopeActive = false;

/**
 * Reproduce the measured pre-neural root expansion in an isolated synchronous research worker.
 * Patch the prototype, as the original experiment did: wrapping a driver's outer neural correction
 * instead changes when shortlist restoration happens. Never use this scope in a concurrent server.
 */
function withMageSearch<T>(team: number, run: () => T): T {
    if (searchScopeActive) throw new Error("Wandering Mage research search cannot be nested");
    if (team !== PBTypes.TeamVals.LEFT && team !== PBTypes.TeamVals.RIGHT)
        throw new Error("Wandering Mage research requires a physical team");
    const previous = SearchDriver.prototype.chooseDecision;
    searchScopeActive = true;
    SearchDriver.prototype.chooseDecision = function (unit, version, incumbent, context) {
        if (unit.getTeam() !== team || unit.getName() !== "Wandering Mage")
            return previous.call(this, unit, version, incumbent, context);
        const state = this as unknown as { shortlist: number | null; researchShortlist: number | null };
        if (version !== "v0.8" || state.shortlist !== 6 || state.researchShortlist !== null)
            throw new Error("Saved Mage search requires unchanged A19 shortlist 6 without another override");
        state.shortlist = 8;
        try {
            return previous.call(this, unit, version, incumbent, context);
        } finally {
            state.shortlist = 6;
        }
    };
    try {
        const result = run();
        if (result && typeof (result as { then?: unknown }).then === "function")
            throw new Error("Wandering Mage research search requires a synchronous callback");
        return result;
    } finally {
        SearchDriver.prototype.chooseDecision = previous;
        searchScopeActive = false;
    }
}

/**
 * Explicit opt-in only. Use native server splitting, then its final formation, then native barrels.
 * The caller supplies already funded capacity and legal cells; these candidates never buy upgrades.
 * Retain the recorded A19/H64/R2 profile. Applying them on newer source requires new qualification.
 */
export function createLockedWanderingMageResearchStrategy(id: LockedWanderingMageStrategy) {
    lockedWanderingMageCheckpoint();
    if (!LOCKED_WANDERING_MAGE_STRATEGIES.includes(id)) throw new Error(`Unknown Wandering Mage strategy: ${id}`);
    const splitAndSearch = id === LOCKED_WANDERING_MAGE_STRATEGIES[0];
    return {
        id,
        planSplits: (units: readonly ITacticalSplitUnit[], maximumStacks: number) =>
            splitAndSearch
                ? planWanderingMageResearchSplits(units, maximumStacks, "one-buff")
                : planTacticalStackSplits(units, maximumStacks),
        place: (...[incumbent, units, context]: Parameters<typeof protectWanderingMageResearchPlacement>) =>
            protectWanderingMageResearchPlacement(incumbent, units, {
                ...context,
                retainLateralPosition: !splitAndSearch,
            }),
        withSearch: <T>(team: number, run: () => T): T => (splitAndSearch ? withMageSearch(team, run) : run()),
    };
}
