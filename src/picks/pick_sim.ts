/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { ArtifactTier } from "../artifacts/artifact_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getPerkRevealMode, PERKS, Perk } from "../perks/perk_properties";
import { CreatureLevelList, CreatureLevelMap, CreaturePoolByLevel } from "../units/unit_properties";

export type PickTeam = typeof PBTypes.TeamVals.LOWER | typeof PBTypes.TeamVals.UPPER;
export type PickBundle = readonly [level1Creature: number, level2Creature: number, tier1Artifact: number];
export type PickRandomInt = (maxExclusive: number) => number;

/**
 * How many creatures the draft removes at each level before anyone picks, level 1 first.
 *
 * L1 and L2 ban 6 rather than 5 because those tiers carry 16 creatures each — the widest pools in the
 * game — and every creature left unbanned is one more slot a player can safely settle into. Taking a
 * sixth keeps 10 available against the 4 the two teams actually fill, which is still far more than the
 * draft needs while making the two heavy-traffic tiers meaningfully more contested.
 *
 * MIRRORED by the ranked server (config.game.banCreaturesLevelN) — generateNewPick asserts the two
 * agree and refuses to build a pick if they drift, so these move together or not at all.
 */
export const LIVE_AUTO_BANS_BY_LEVEL = [6, 6, 3, 5] as const;
export const LIVE_TIER1_ARTIFACT_COUNT = 12;
export const LIVE_TIER2_ARTIFACT_COUNT = 12;
export const LIVE_TIER2_OFFER_SIZE = 3;
export const SERVER_PERSISTED_CREATURE_ORDER = "server-level-sort-after-each-accepted-pick" as const;

export interface ILivePickPhase {
    readonly phase: PBTypes.PickPhaseVals;
    readonly actors: readonly PickTeam[];
    readonly creatureLevel: 0 | 1 | 2 | 3 | 4;
}

/** Exact order persisted by the ranked server (PickPhaseOrder). The first step is split into TWO
 * independent simultaneous phases: PERK (doctrine only) then INITIAL_PICK (the starting bundle). AUGMENTS
 * markers hand the completed draft to placement. */
export const LIVE_PICK_PHASES: readonly ILivePickPhase[] = [
    {
        phase: PBTypes.PickPhaseVals.PERK,
        actors: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
        creatureLevel: 0,
    },
    {
        phase: PBTypes.PickPhaseVals.INITIAL_PICK,
        actors: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
        creatureLevel: 0,
    },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.LOWER], creatureLevel: 1 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.UPPER], creatureLevel: 1 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.UPPER], creatureLevel: 2 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.LOWER], creatureLevel: 2 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.LOWER], creatureLevel: 3 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.UPPER], creatureLevel: 3 },
    {
        phase: PBTypes.PickPhaseVals.ARTIFACT_2,
        actors: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
        creatureLevel: 0,
    },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.UPPER], creatureLevel: 4 },
    { phase: PBTypes.PickPhaseVals.PICK, actors: [PBTypes.TeamVals.LOWER], creatureLevel: 4 },
    {
        phase: PBTypes.PickPhaseVals.AUGMENTS,
        actors: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
        creatureLevel: 0,
    },
    {
        phase: PBTypes.PickPhaseVals.AUGMENTS_SCOUT,
        actors: [PBTypes.TeamVals.LOWER, PBTypes.TeamVals.UPPER],
        creatureLevel: 0,
    },
] as const;

export interface IPickTeamState {
    perk: Perk;
    /**
     * The one creature this team asked to have banned during the PERK phase. Optional — a team may skip it.
     * Kept per team and NOT exposed through the opponent-facing views (see getVisibleCreatureChoices), so a
     * proposal cannot leak draft intent before it resolves.
     */
    proposedBan?: number;
    bundles: [PickBundle, PickBundle];
    selectedBundleIndex?: 0 | 1;
    tier2Offers: [number, number, number];
    tier1Artifact?: number;
    tier2Artifact?: number;
    creatures: number[];
    remainingByLevel: [number, number, number, number];
    /** Slots in the opponent's six-creature array visible to this team. */
    revealedOpponentSlots: number[];
}

interface IPickTranscriptBase {
    index: number;
    team: PickTeam;
    phaseBefore: number;
    phaseAfter: number;
}

export type PickTranscriptEntry =
    | (IPickTranscriptBase & { type: "perk_selected"; perk: Perk; revealedOpponentSlots: number[] })
    | (IPickTranscriptBase & {
          type: "bundle_selected";
          bundleIndex: 0 | 1;
          creatures: [number, number];
          tier1Artifact: number;
      })
    | (IPickTranscriptBase & { type: "creature_picked"; creatureId: number; creatureLevel: number })
    | (IPickTranscriptBase & {
          type: "creature_collision";
          creatureId: number;
          revealedOpponentSlots: number[];
      })
    | (IPickTranscriptBase & { type: "ban_proposed"; creatureId: number })
    | (IPickTranscriptBase & { type: "tier2_selected"; artifactId: number });

export interface IPickSimState {
    phaseSequence: number;
    creaturesBanned: number[];
    /**
     * The creature the players' optional pre-game bans actually removed, decided when the PERK phase closes
     * (see resolveProposedBans). Undefined when neither team proposed one, or when the roll is still pending.
     * It is already inside `creaturesBanned`; this field records WHICH ban was the players' so the client can
     * show the outcome and the server can persist it.
     */
    extraBan?: number;
    lower: IPickTeamState;
    upper: IPickTeamState;
    transcript: PickTranscriptEntry[];
}

export type PickAction =
    | { type: "select_perk"; team: PickTeam; perk: Perk }
    | { type: "propose_ban"; team: PickTeam; creatureId: number }
    | { type: "select_bundle"; team: PickTeam; bundleIndex: number }
    | { type: "pick_creature"; team: PickTeam; creatureId: number }
    | { type: "select_tier2"; team: PickTeam; artifactId: number };

export type PickRejectionReason =
    | "pick_complete"
    | "wrong_phase"
    | "not_actor"
    | "invalid_perk"
    | "perk_already_selected"
    | "ban_already_proposed"
    | "creature_not_bannable"
    | "invalid_bundle"
    | "bundle_already_selected"
    | "unknown_creature"
    | "wrong_creature_level"
    | "creature_banned"
    | "creature_already_picked"
    | "creature_already_taken"
    | "creature_level_exhausted"
    | "invalid_artifact"
    | "artifact_not_offered"
    | "artifact_already_selected";

export type PickTransition =
    | { status: "accepted"; state: IPickSimState; event: PickTranscriptEntry }
    | {
          status: "collision";
          state: IPickSimState;
          reason: "creature_collision";
          event: Extract<PickTranscriptEntry, { type: "creature_collision" }>;
      }
    | { status: "rejected"; state: IPickSimState; reason: PickRejectionReason };

export interface IPickTeamView {
    phaseSequence: number;
    phase: PBTypes.PickPhaseVals;
    actors: PickTeam[];
    requiredCreatureLevel: number;
    complete: boolean;
    creaturesBanned: number[];
    creaturesPicked: number[];
    knownOpponentCreatures: number[];
    perk: Perk;
    bundles: PickBundle[];
    tier2Offers: number[];
    artifacts: [tier: number, artifactId: number][];
}

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
// The AUGMENTS phase (seq 11) is the ranked handoff: the server transitions PICK -> PLAY when it reaches an
// AUGMENTS/AUGMENTS_SCOUT phase, so the sim is "complete" from AUGMENTS onward. (AUGMENTS_SCOUT at seq 12
// only fires for scout augments, which the sim does not model; it stops at the AUGMENTS handoff.)
const COMPLETE_PHASE_SEQUENCE = 11;

const draw = (rng: PickRandomInt, maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`Cannot draw from a pool of size ${maxExclusive}`);
    }
    const value = rng(maxExclusive);
    if (!Number.isInteger(value) || value < 0 || value >= maxExclusive) {
        throw new RangeError(`Injected pick RNG returned ${value}; expected an integer in [0, ${maxExclusive})`);
    }
    return value;
};

const pickDistinct = (pool: readonly number[], count: number, rng: PickRandomInt): number[] => {
    const remaining = [...pool];
    const picked: number[] = [];
    for (let i = 0; i < count && remaining.length; i += 1) {
        picked.push(remaining.splice(draw(rng, remaining.length), 1)[0]);
    }
    return picked;
};

const artifactOffers = (rng: PickRandomInt): [number, number, number] =>
    pickDistinct(
        Array.from({ length: LIVE_TIER2_ARTIFACT_COUNT }, (_, index) => index + 1),
        LIVE_TIER2_OFFER_SIZE,
        rng,
    ) as [number, number, number];

const emptyTeam = (bundles: [PickBundle, PickBundle], tier2Offers: [number, number, number]): IPickTeamState => ({
    perk: Perk.NO_PERK,
    bundles,
    tier2Offers,
    creatures: [],
    remainingByLevel: [...CreaturePoolByLevel],
    revealedOpponentSlots: [],
});

/** Create a fresh live-faithful ranked pick using only the supplied upper-exclusive RNG. */
export function createPickSimState(rng: PickRandomInt): IPickSimState {
    const level1 = pickDistinct(CreatureLevelList[1], 4, rng);
    const level2 = pickDistinct(CreatureLevelList[2], 4, rng);
    if (level1.length !== 4 || level2.length !== 4) {
        throw new Error("The live pick requires at least four level-1 and four level-2 creatures");
    }

    const makeBundle = (index: number): PickBundle => [
        level1[index],
        level2[index],
        draw(rng, LIVE_TIER1_ARTIFACT_COUNT) + 1,
    ];
    const lowerBundles: [PickBundle, PickBundle] = [makeBundle(0), makeBundle(1)];
    const upperBundles: [PickBundle, PickBundle] = [makeBundle(2), makeBundle(3)];

    // The server generates both teams' T2 offers before auto-bans.
    const lowerTier2Offers = artifactOffers(rng);
    const upperTier2Offers = artifactOffers(rng);
    const offeredBundleCreatures = [...lowerBundles, ...upperBundles].flatMap(([level1Id, level2Id]) => [
        level1Id,
        level2Id,
    ]);
    const creaturesBanned: number[] = [];
    for (let level = 1; level <= 4; level += 1) {
        const available = CreatureLevelList[level].filter(
            (creatureId) => !offeredBundleCreatures.includes(creatureId) && !creaturesBanned.includes(creatureId),
        );
        const count = LIVE_AUTO_BANS_BY_LEVEL[level - 1];
        for (let i = 0; i < count && available.length; i += 1) {
            creaturesBanned.push(available.splice(draw(rng, available.length), 1)[0]);
        }
    }

    return {
        phaseSequence: 0,
        creaturesBanned,
        lower: emptyTeam(lowerBundles, lowerTier2Offers),
        upper: emptyTeam(upperBundles, upperTier2Offers),
        transcript: [],
    };
}

export const isPickSimComplete = (state: IPickSimState): boolean => state.phaseSequence >= COMPLETE_PHASE_SEQUENCE;

export const getCurrentPickPhase = (state: IPickSimState): ILivePickPhase =>
    LIVE_PICK_PHASES[Math.min(state.phaseSequence, LIVE_PICK_PHASES.length - 1)];

const teamState = (state: IPickSimState, team: PickTeam): IPickTeamState =>
    team === LOWER ? state.lower : state.upper;

const opponentState = (state: IPickSimState, team: PickTeam): IPickTeamState =>
    team === LOWER ? state.upper : state.lower;

const cloneState = (state: IPickSimState): IPickSimState => structuredClone(state);

const phaseAccepts = (state: IPickSimState, team: PickTeam, phase: PBTypes.PickPhaseVals): boolean => {
    if (isPickSimComplete(state)) {
        return false;
    }
    const current = getCurrentPickPhase(state);
    return current.phase === phase && current.actors.includes(team);
};

const perkPhaseComplete = (state: IPickSimState): boolean =>
    state.lower.perk !== Perk.NO_PERK && state.upper.perk !== Perk.NO_PERK;

const bundlePhaseComplete = (state: IPickSimState): boolean =>
    state.lower.selectedBundleIndex !== undefined && state.upper.selectedBundleIndex !== undefined;

const tier2PhaseComplete = (state: IPickSimState): boolean =>
    state.lower.tier2Artifact !== undefined && state.upper.tier2Artifact !== undefined;

const advanceIfReady = (state: IPickSimState, rng: PickRandomInt): void => {
    if (state.phaseSequence === 0 && perkPhaseComplete(state)) {
        // The optional pre-game bans settle exactly here, as the perk step closes: late enough that both
        // proposals are in, early enough that the result shapes the whole draft that follows.
        resolveProposedBans(state, rng);
        state.phaseSequence += 1;
    } else if (state.phaseSequence === 1 && bundlePhaseComplete(state)) {
        state.phaseSequence += 1;
    } else if (state.phaseSequence === 8 && tier2PhaseComplete(state)) {
        state.phaseSequence += 1;
    }
};

const eventBase = (state: IPickSimState, team: PickTeam): IPickTranscriptBase => ({
    index: state.transcript.length,
    team,
    phaseBefore: state.phaseSequence,
    phaseAfter: state.phaseSequence,
});

const accepted = (state: IPickSimState, event: PickTranscriptEntry): PickTransition => {
    event.phaseAfter = state.phaseSequence;
    state.transcript.push(structuredClone(event));
    return { status: "accepted", state, event: structuredClone(event) };
};

const rejected = (state: IPickSimState, reason: PickRejectionReason): PickTransition => ({
    status: "rejected",
    state,
    reason,
});

/**
 * Creatures a team may propose for the optional pre-game ban: everything in the draft catalog that is not
 * already auto-banned and not sitting in EITHER team's starting bundle offer.
 *
 * Bundle creatures are excluded because those offers are generated before the perk phase and are already on
 * screen — banning one would either be a wasted ban or force an offer to be re-rolled underneath a player who
 * has already read it. Same list for both teams, so it gives nothing away.
 */
export function getBannableCreatures(state: IPickSimState): number[] {
    const offered = new Set(
        [...state.lower.bundles, ...state.upper.bundles].flatMap(([level1Id, level2Id]) => [level1Id, level2Id]),
    );
    const banned = new Set(state.creaturesBanned);
    const bannable: number[] = [];
    for (let level = 1; level <= 4; level += 1) {
        for (const creatureId of CreatureLevelList[level]) {
            if (!offered.has(creatureId) && !banned.has(creatureId)) {
                bannable.push(creatureId);
            }
        }
    }

    return bannable;
}

/**
 * Close out the players' optional bans when the PERK phase ends.
 *
 * - nobody proposed one            -> nothing is banned
 * - both proposed the SAME unit    -> it is banned outright, no roll (they agree)
 * - two different proposals        -> exactly one of the two, chosen 50/50
 * - only one team proposed         -> that one is banned (there is no competing ban to roll against)
 *
 * The ban REPLACES an auto-ban of the same level rather than adding to the pile, so each level still loses
 * exactly LIVE_AUTO_BANS_BY_LEVEL[level - 1] creatures — the players only get to steer one of them. If that
 * level happens to have no auto-ban left to release, the ban still lands and the level is simply one short.
 */
const resolveProposedBans = (state: IPickSimState, rng: PickRandomInt): void => {
    const lowerBan = state.lower.proposedBan;
    const upperBan = state.upper.proposedBan;
    let chosen: number | undefined;
    if (lowerBan !== undefined && upperBan !== undefined) {
        chosen = lowerBan === upperBan ? lowerBan : [lowerBan, upperBan][draw(rng, 2)];
    } else {
        chosen = lowerBan ?? upperBan;
    }
    if (chosen === undefined || state.creaturesBanned.includes(chosen)) {
        return;
    }

    const level = CreatureLevelMap[chosen];
    // Release one auto-ban of the same level so the level's total stays put. Released from the END of that
    // level's block, which is the most recently drawn one — the earlier draws are the ones other state may
    // already have been derived from.
    if (level !== undefined) {
        for (let index = state.creaturesBanned.length - 1; index >= 0; index -= 1) {
            if (CreatureLevelMap[state.creaturesBanned[index]] === level) {
                state.creaturesBanned.splice(index, 1);
                break;
            }
        }
    }
    state.creaturesBanned.push(chosen);
    state.extraBan = chosen;
};

const applyProposedBan = (
    state: IPickSimState,
    action: Extract<PickAction, { type: "propose_ban" }>,
): PickTransition => {
    if (!phaseAccepts(state, action.team, PBTypes.PickPhaseVals.PERK)) {
        return rejected(state, isPickSimComplete(state) ? "pick_complete" : "wrong_phase");
    }
    const own = teamState(state, action.team);
    if (own.proposedBan !== undefined) {
        return rejected(state, "ban_already_proposed");
    }
    if (!getBannableCreatures(state).includes(action.creatureId)) {
        return rejected(state, "creature_not_bannable");
    }

    const next = cloneState(state);
    teamState(next, action.team).proposedBan = action.creatureId;
    const event: Extract<PickTranscriptEntry, { type: "ban_proposed" }> = {
        ...eventBase(next, action.team),
        type: "ban_proposed",
        creatureId: action.creatureId,
    };
    // Deliberately does NOT advance the phase: the ban is optional, so the perk choice alone gates the step.
    return accepted(next, event);
};

const applyPerk = (
    state: IPickSimState,
    action: Extract<PickAction, { type: "select_perk" }>,
    rng: PickRandomInt,
): PickTransition => {
    if (!phaseAccepts(state, action.team, PBTypes.PickPhaseVals.PERK)) {
        return rejected(state, isPickSimComplete(state) ? "pick_complete" : "wrong_phase");
    }
    const own = teamState(state, action.team);
    if (own.perk !== Perk.NO_PERK) {
        return rejected(state, "perk_already_selected");
    }
    if (action.perk === Perk.NO_PERK || !(action.perk in PERKS)) {
        return rejected(state, "invalid_perk");
    }

    const next = cloneState(state);
    const nextOwn = teamState(next, action.team);
    nextOwn.perk = action.perk;
    // The fixed six-slot creature layout by level is [L1@0, L1@1, L2@2, L2@3, L3@4, L4@5]
    // (CreaturePoolByLevel = [2, 2, 1, 1]). The "random3" doctrine reveals ONE slot per tier block rather than
    // drawing three uniformly: one of the two L1 slots, one of the two L2 slots, and either the L3 or L4 slot.
    // This mirrors the ranked server's legacy seeding in arango_hoc.ts (pickPhaseLogic slotsSeen seeding).
    const totalSlots = CreaturePoolByLevel.reduce((total, count) => total + count, 0);
    const revealMode = getPerkRevealMode(action.perk);
    if (revealMode === "all") {
        nextOwn.revealedOpponentSlots = Array.from({ length: totalSlots }, (_, index) => index);
    } else if (revealMode === "random3") {
        const slots = [draw(rng, 2), 2 + draw(rng, 2), draw(rng, 2) ? 4 : 5];
        slots.sort((a, b) => a - b);
        nextOwn.revealedOpponentSlots = slots;
    }
    const event: Extract<PickTranscriptEntry, { type: "perk_selected" }> = {
        ...eventBase(next, action.team),
        type: "perk_selected",
        perk: action.perk,
        revealedOpponentSlots: [...nextOwn.revealedOpponentSlots],
    };
    advanceIfReady(next, rng);
    return accepted(next, event);
};

const applyBundle = (
    state: IPickSimState,
    action: Extract<PickAction, { type: "select_bundle" }>,
    rng: PickRandomInt,
): PickTransition => {
    if (!phaseAccepts(state, action.team, PBTypes.PickPhaseVals.INITIAL_PICK)) {
        return rejected(state, isPickSimComplete(state) ? "pick_complete" : "wrong_phase");
    }
    const own = teamState(state, action.team);
    if (own.selectedBundleIndex !== undefined) {
        return rejected(state, "bundle_already_selected");
    }
    if (action.bundleIndex !== 0 && action.bundleIndex !== 1) {
        return rejected(state, "invalid_bundle");
    }

    const next = cloneState(state);
    const nextOwn = teamState(next, action.team);
    const bundleIndex = action.bundleIndex as 0 | 1;
    const [level1Creature, level2Creature, tier1Artifact] = nextOwn.bundles[bundleIndex];
    nextOwn.selectedBundleIndex = bundleIndex;
    nextOwn.creatures.push(level1Creature, level2Creature);
    nextOwn.remainingByLevel[0] -= 1;
    nextOwn.remainingByLevel[1] -= 1;
    nextOwn.tier1Artifact = tier1Artifact;
    const event: Extract<PickTranscriptEntry, { type: "bundle_selected" }> = {
        ...eventBase(next, action.team),
        type: "bundle_selected",
        bundleIndex,
        creatures: [level1Creature, level2Creature],
        tier1Artifact,
    };
    advanceIfReady(next, rng);
    return accepted(next, event);
};

const opponentSlotsForCreature = (state: IPickSimState, team: PickTeam, creatureId: number): number[] => {
    const slots: number[] = [];
    opponentState(state, team).creatures.forEach((picked, index) => {
        if (picked === creatureId) {
            slots.push(index);
        }
    });
    return slots;
};

const applyCreature = (
    state: IPickSimState,
    action: Extract<PickAction, { type: "pick_creature" }>,
): PickTransition => {
    if (!phaseAccepts(state, action.team, PBTypes.PickPhaseVals.PICK)) {
        if (isPickSimComplete(state)) {
            return rejected(state, "pick_complete");
        }
        return rejected(
            state,
            getCurrentPickPhase(state).phase === PBTypes.PickPhaseVals.PICK ? "not_actor" : "wrong_phase",
        );
    }
    const current = getCurrentPickPhase(state);
    const creatureLevel = CreatureLevelList.findIndex((ids) => ids.includes(action.creatureId));
    if (creatureLevel < 1) {
        return rejected(state, "unknown_creature");
    }
    if (creatureLevel !== current.creatureLevel) {
        return rejected(state, "wrong_creature_level");
    }
    if (state.creaturesBanned.includes(action.creatureId)) {
        return rejected(state, "creature_banned");
    }
    const own = teamState(state, action.team);
    if (own.remainingByLevel[creatureLevel - 1] < 1) {
        return rejected(state, "creature_level_exhausted");
    }
    if (own.creatures.includes(action.creatureId)) {
        return rejected(state, "creature_already_picked");
    }

    const opponentSlots = opponentSlotsForCreature(state, action.team, action.creatureId);
    if (opponentSlots.length) {
        if (opponentSlots.some((slot) => own.revealedOpponentSlots.includes(slot))) {
            return rejected(state, "creature_already_taken");
        }
        const next = cloneState(state);
        const nextOwn = teamState(next, action.team);
        const revealedOpponentSlots = opponentSlots.filter((slot) => !nextOwn.revealedOpponentSlots.includes(slot));
        nextOwn.revealedOpponentSlots.push(...revealedOpponentSlots);
        const event: Extract<PickTranscriptEntry, { type: "creature_collision" }> = {
            ...eventBase(next, action.team),
            type: "creature_collision",
            creatureId: action.creatureId,
            revealedOpponentSlots,
        };
        next.transcript.push(structuredClone(event));
        return {
            status: "collision",
            state: next,
            reason: "creature_collision",
            event: structuredClone(event),
        };
    }

    const next = cloneState(state);
    const nextOwn = teamState(next, action.team);
    nextOwn.creatures.push(action.creatureId);
    nextOwn.remainingByLevel[creatureLevel - 1] -= 1;
    const event: Extract<PickTranscriptEntry, { type: "creature_picked" }> = {
        ...eventBase(next, action.team),
        type: "creature_picked",
        creatureId: action.creatureId,
        creatureLevel,
    };
    next.phaseSequence += 1;
    return accepted(next, event);
};

const applyTier2 = (
    state: IPickSimState,
    action: Extract<PickAction, { type: "select_tier2" }>,
    rng: PickRandomInt,
): PickTransition => {
    if (!phaseAccepts(state, action.team, PBTypes.PickPhaseVals.ARTIFACT_2)) {
        return rejected(state, isPickSimComplete(state) ? "pick_complete" : "wrong_phase");
    }
    if (!Number.isInteger(action.artifactId) || action.artifactId < 1 || action.artifactId > 12) {
        return rejected(state, "invalid_artifact");
    }
    const own = teamState(state, action.team);
    if (own.tier2Artifact !== undefined) {
        return rejected(state, "artifact_already_selected");
    }
    if (!own.tier2Offers.includes(action.artifactId)) {
        return rejected(state, "artifact_not_offered");
    }

    const next = cloneState(state);
    teamState(next, action.team).tier2Artifact = action.artifactId;
    const event: Extract<PickTranscriptEntry, { type: "tier2_selected" }> = {
        ...eventBase(next, action.team),
        type: "tier2_selected",
        artifactId: action.artifactId,
    };
    advanceIfReady(next, rng);
    return accepted(next, event);
};

/** Pure reducer: ordinary rejections preserve the input state; accepted actions and collisions return a clone. */
export function transitionPickSim(state: IPickSimState, action: PickAction, rng: PickRandomInt): PickTransition {
    if (action.team !== LOWER && action.team !== UPPER) {
        return rejected(state, "not_actor");
    }
    switch (action.type) {
        case "select_perk":
            return applyPerk(state, action, rng);
        case "propose_ban":
            return applyProposedBan(state, action);
        case "select_bundle":
            return applyBundle(state, action, rng);
        case "pick_creature":
            return applyCreature(state, action);
        case "select_tier2":
            return applyTier2(state, action, rng);
    }
}

const sortServerPersistedCreatures = (creatureIds: readonly number[]): number[] =>
    creatureIds
        .map((creatureId, index) => ({ creatureId, index }))
        .sort(
            (left, right) =>
                (CreatureLevelMap[left.creatureId] ?? 99) - (CreatureLevelMap[right.creatureId] ?? 99) ||
                left.index - right.index,
        )
        .map(({ creatureId }) => creatureId);

/**
 * Model the ranked server's accepted creature write and subsequent document reload. The pure reducer retains
 * arrival order; Arango persists both creature arrays in stable level order after each accepted bundle/creature.
 */
export function transitionServerPersistedPickSim(
    state: IPickSimState,
    action: PickAction,
    rng: PickRandomInt,
): PickTransition {
    const transition = transitionPickSim(state, action, rng);
    if (transition.status === "accepted" && (action.type === "select_bundle" || action.type === "pick_creature")) {
        transition.state.lower.creatures = sortServerPersistedCreatures(transition.state.lower.creatures);
        transition.state.upper.creatures = sortServerPersistedCreatures(transition.state.upper.creatures);
    }
    return transition;
}

export function getKnownOpponentCreatures(state: IPickSimState, team: PickTeam): number[] {
    const known: number[] = [];
    const opponent = opponentState(state, team);
    for (const slot of teamState(state, team).revealedOpponentSlots) {
        const creatureId = opponent.creatures[slot];
        if (creatureId !== undefined && !known.includes(creatureId)) {
            known.push(creatureId);
        }
    }
    return known;
}

const creatureChoices = (state: IPickSimState, team: PickTeam, omniscient: boolean): number[] => {
    const current = getCurrentPickPhase(state);
    if (isPickSimComplete(state) || current.phase !== PBTypes.PickPhaseVals.PICK || !current.actors.includes(team)) {
        return [];
    }
    const unavailable = new Set([
        ...state.creaturesBanned,
        ...teamState(state, team).creatures,
        ...(omniscient ? opponentState(state, team).creatures : getKnownOpponentCreatures(state, team)),
    ]);
    return CreatureLevelList[current.creatureLevel].filter((creatureId) => !unavailable.has(creatureId));
};

/** Choices visible to a player. Hidden opponent picks remain and may produce collision transitions. */
export const getVisibleCreatureChoices = (state: IPickSimState, team: PickTeam): number[] =>
    creatureChoices(state, team, false);

/** Truly legal choices from the shared exclusive pool, useful for omniscient simulation policies. */
export const getOmniscientCreatureChoices = (state: IPickSimState, team: PickTeam): number[] =>
    creatureChoices(state, team, true);

/** Protocol-shaped private view: only this team's offers/artifacts and legitimately known opponent picks. */
export function getPickTeamView(state: IPickSimState, team: PickTeam): IPickTeamView {
    const current = getCurrentPickPhase(state);
    const own = teamState(state, team);
    const artifacts: [number, number][] = [];
    if (own.tier1Artifact !== undefined) {
        artifacts.push([ArtifactTier.TIER_1, own.tier1Artifact]);
    }
    if (own.tier2Artifact !== undefined) {
        artifacts.push([ArtifactTier.TIER_2, own.tier2Artifact]);
    }
    return {
        phaseSequence: state.phaseSequence,
        phase: current.phase,
        actors: [...current.actors],
        requiredCreatureLevel: current.creatureLevel,
        complete: isPickSimComplete(state),
        creaturesBanned: [...state.creaturesBanned],
        creaturesPicked: [...own.creatures],
        knownOpponentCreatures: getKnownOpponentCreatures(state, team),
        perk: own.perk,
        bundles: state.phaseSequence === 1 ? own.bundles.map((bundle) => [...bundle] as PickBundle) : [],
        tier2Offers: state.phaseSequence === 8 ? [...own.tier2Offers] : [],
        artifacts,
    };
}
