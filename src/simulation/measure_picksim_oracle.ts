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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

import { creatureInfo, scoreCreature, scoreCreatureWeighted, DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import { TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getUpgradePoints, Perk } from "../perks/perk_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getOmniscientCreatureChoices,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type IPickTeamState,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { FROZEN_FIGHT_VERSION } from "./archetype_payoff";
import { creaturesByLevel, makeRng, resolveStackAmount, DEFAULT_AMOUNT_BY_LEVEL, type IArmyUnitSpec } from "./army";
import {
    runMatch,
    type IMatchConfig,
    type IMatchResult,
    type ISetupAugment,
    type ISetupSynergy,
    type Side,
} from "./battle_engine";
import { creatureIdForName } from "./draft";
import { LIVETWIN_PRESET } from "./livetwin";

/**
 * B1 pick_sim oracle re-check of the question left open by the Wave-2 KILL.
 *
 * The Wave-2 archetype matrix (measure_archetypes.ts) killed B1 under a shared-offer PROXY draft. This
 * harness replays the question under the REAL pick structure (picks/pick_sim.ts): auto-bans 5/5/3/3,
 * two-bundle choice [L1,L2,T1], snake pick order, the shared exclusive creature pool with hidden-pick
 * collision reveals, and the 3-of-12 Tier-2 artifact pick. A deliberately advantaged ORACLE picker sees every
 * opponent pick immediately and removes already-taken creatures through the omniscient legal-choice API. That
 * is strictly more information than live collision reveals provide. It best-responds using the Wave-2
 * payoff-matrix priors + greedy roster-fit scoring and plays against the CURRENT policy: the live untrained
 * heuristic (SETUP_POLICY_V0 / scoreCreature) and the DEFAULT_DRAFT_W melee champion. Resulting armies fight
 * under LIVETWIN with the frozen v0.6 vector on both sides.
 *
 * REGISTERED GATE (same +3pp bar as the Wave-2 B1 kill test): oracle decisive win rate vs the melee champion
 * baseline gains < +3pp over the 50% mirror -> B1 is DEAD by the registered oracle criterion. >= +3pp -> B1
 * REOPENS with pick_sim as the training environment. Runs below the registered sample floor are INCONCLUSIVE
 * regardless of their point estimate.
 *
 * Also reported: how often collisions / collision reveals actually occur (the roadmap froze the vision-gated
 * perk head pending this number), and an informed-vs-blind ablation. That difference is an upper-bound proxy
 * for information value, not an isolated live counter-pick effect: it includes the informed oracle's
 * omniscient collision avoidance. Its uncertainty conservatively treats each same-seed two-game re-draft pair
 * as one cluster.
 */

export type Role = "melee" | "ranged" | "flyer";
export const ROLES: readonly Role[] = ["melee", "ranged", "flyer"];

export type RolePayoff = Record<Role, Record<Role, number>>;

/**
 * Wave-2 payoff-matrix priors: pooled unordered decisive win rates from the B1 archetype kill test
 * (archetype_matrix/matrix.json, 4,000 paired side-swap games per pair, seed 1, LIVETWIN, frozen v0.6).
 * Rows/cols are the three creature ROLES, mapped from the matrix archetypes melee_coevo /
 * ranged_max_sniper3 / flyer_max. Pass --matrix to recompute from the summary JSON instead.
 */
export const WAVE2_ROLE_PAYOFF: RolePayoff = {
    melee: { melee: 0.5, ranged: 0.5024, flyer: 0.6928 },
    ranged: { melee: 0.4976, ranged: 0.5, flyer: 0.5416 },
    flyer: { melee: 0.3072, ranged: 0.4584, flyer: 0.5 },
};

const MATRIX_ARCHETYPE_ROLE: Record<string, Role> = {
    melee_coevo: "melee",
    ranged_max_sniper3: "ranged",
    flyer_max: "flyer",
};

/** Rebuild the role payoff from a measure_archetypes summary JSON (its pooledPairs section). */
export function rolePayoffFromMatrix(matrix: unknown): RolePayoff {
    const pairs = (matrix as { pooledPairs?: { a?: string; b?: string; winRateA?: number }[] }).pooledPairs;
    if (!Array.isArray(pairs)) {
        throw new Error("Matrix JSON has no pooledPairs array (expected a measure_archetypes summary)");
    }
    const payoff: RolePayoff = {
        melee: { melee: 0.5, ranged: 0.5, flyer: 0.5 },
        ranged: { melee: 0.5, ranged: 0.5, flyer: 0.5 },
        flyer: { melee: 0.5, ranged: 0.5, flyer: 0.5 },
    };
    let found = 0;
    for (const pair of pairs) {
        const roleA = MATRIX_ARCHETYPE_ROLE[pair.a ?? ""];
        const roleB = MATRIX_ARCHETYPE_ROLE[pair.b ?? ""];
        if (!roleA || !roleB || roleA === roleB || typeof pair.winRateA !== "number") {
            continue;
        }
        payoff[roleA][roleB] = pair.winRateA;
        payoff[roleB][roleA] = 1 - pair.winRateA;
        found += 1;
    }
    if (found < 3) {
        throw new Error(`Matrix JSON covered only ${found} of the 3 role pairs`);
    }
    return payoff;
}

/** Fight role of a creature: ranged dominates (it drives the matchup), then flyer, else melee. */
export function classifyRole(creatureId: number): Role {
    const info = creatureInfo(creatureId);
    if (!info) {
        return "melee";
    }
    if (info.ranged) {
        return "ranged";
    }
    if (info.canFly) {
        return "flyer";
    }
    return "melee";
}

/** Normalized role distribution of a set of picked stacks; uniform when nothing is known yet. */
export function roleMix(creatureIds: readonly number[]): Record<Role, number> {
    if (!creatureIds.length) {
        return { melee: 1 / 3, ranged: 1 / 3, flyer: 1 / 3 };
    }
    const mix: Record<Role, number> = { melee: 0, ranged: 0, flyer: 0 };
    for (const id of creatureIds) {
        mix[classifyRole(id)] += 1 / creatureIds.length;
    }
    return mix;
}

/** Expected decisive win rate of fielding `role` against the opponent role mix, under the priors. */
export function counterScore(payoff: RolePayoff, role: Role, mix: Record<Role, number>): number {
    return ROLES.reduce((sum, opponentRole) => sum + mix[opponentRole] * payoff[role][opponentRole], 0);
}

// ---------------------------------------------------------------------------------------------------------
// Pick policies
// ---------------------------------------------------------------------------------------------------------

export const PICK_POLICY_NAMES = ["policy_v0", "champion", "oracle", "oracle_blind"] as const;
export type PickPolicyName = (typeof PICK_POLICY_NAMES)[number];

/** Weight of the greedy roster-fit term (min-max normalized within the choice set) in win-rate units. */
export const ORACLE_FIT_WEIGHT = 0.02;
/** Weight of the bundle's T1 artifact table delta ((winrate-50)/100) in win-rate units. */
export const ORACLE_T1_WEIGHT = 0.5;

/** Only the informed oracle consumes opponent information; everything else is playable live today. */
export const isInformedPolicy = (policy: PickPolicyName): boolean => policy === "oracle";

const championScore = (id: number): number => scoreCreatureWeighted(id, DEFAULT_DRAFT_W);

const baselineScorer = (policy: PickPolicyName): ((id: number) => number) =>
    policy === "policy_v0" ? scoreCreature : championScore;

const argmaxId = (candidates: readonly number[], score: (id: number) => number): number => {
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const id of candidates) {
        const s = score(id);
        if (s > bestScore || (s === bestScore && id < best)) {
            bestScore = s;
            best = id;
        }
    }
    return best;
};

/** Min-max normalized roster-fit (champion weights) over a choice set; constant sets normalize to 0. */
const fitNormalizer = (candidates: readonly number[]): ((id: number) => number) => {
    let min = Infinity;
    let max = -Infinity;
    for (const id of candidates) {
        const s = championScore(id);
        if (s < min) min = s;
        if (s > max) max = s;
    }
    const span = max - min;
    return span > 0 ? (id) => (championScore(id) - min) / span : () => 0;
};

/** Oracle creature scoring: payoff-prior best response + a small greedy roster-fit tiebreak. */
export function oracleCreatureChoice(
    candidates: readonly number[],
    payoff: RolePayoff,
    mix: Record<Role, number>,
): number {
    const fit = fitNormalizer(candidates);
    return argmaxId(candidates, (id) => counterScore(payoff, classifyRole(id), mix) + ORACLE_FIT_WEIGHT * fit(id));
}

/** Oracle bundle scoring over [L1, L2, T1] bundles: mean creature counter-score + fit + T1 table delta. */
export function oracleBundleChoice(
    bundles: readonly (readonly [number, number, number])[],
    payoff: RolePayoff,
    mix: Record<Role, number>,
): number {
    const fit = fitNormalizer(bundles.flatMap(([l1, l2]) => [l1, l2]));
    let bestIndex = 0;
    let bestScore = -Infinity;
    bundles.forEach(([l1, l2, t1], index) => {
        const counter = (counterScore(payoff, classifyRole(l1), mix) + counterScore(payoff, classifyRole(l2), mix)) / 2;
        const fitness = (fit(l1) + fit(l2)) / 2;
        const t1Delta = ((TIER1_ARTIFACT_WINRATE[t1] ?? 50) - 50) / 100;
        const score = counter + ORACLE_FIT_WEIGHT * fitness + ORACLE_T1_WEIGHT * t1Delta;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return bestIndex;
}

const championBundleChoice = (bundles: readonly (readonly [number, number, number])[]): number => {
    let bestIndex = 0;
    let bestScore = -Infinity;
    bundles.forEach(([l1, l2, t1], index) => {
        const score = championScore(l1) + championScore(l2) + (TIER1_ARTIFACT_WINRATE[t1] ?? 50);
        if (score > bestScore) {
            bestScore = score;
            bestIndex = index;
        }
    });
    return bestIndex;
};

// ---------------------------------------------------------------------------------------------------------
// Pick-phase driver
// ---------------------------------------------------------------------------------------------------------

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;
const UNIFORM_MIX: Record<Role, number> = { melee: 1 / 3, ranged: 1 / 3, flyer: 1 / 3 };

export type OracleDecisionKind = "bundle" | "L1" | "L2" | "L3" | "L4";

export interface ITeamPickStats {
    /** Hidden-pick collisions this team hit (each reveals one opponent slot to it — the real phase's info flow). */
    collisions: number;
    collisionsByLevel: [number, number, number, number];
    /** Informed-oracle decisions taken / how many differed from the blind (uniform-prior) choice. */
    oracleDecisions: number;
    oracleOverrides: number;
    overridesByDecision: Partial<Record<OracleDecisionKind, number>>;
}

export interface IPickPhaseOutcome {
    state: IPickSimState;
    lower: ITeamPickStats;
    upper: ITeamPickStats;
}

const emptyTeamPickStats = (): ITeamPickStats => ({
    collisions: 0,
    collisionsByLevel: [0, 0, 0, 0],
    oracleDecisions: 0,
    oracleOverrides: 0,
    overridesByDecision: {},
});

/**
 * Drive one complete pick through pick_sim. Snake order and phase gating come from the sim itself; in the two
 * simultaneous phases (perk+bundle, T2) the non-oracle side commits first, which hands the full-information
 * oracle its maximal (most favorable) information edge. The oracle also chooses from omniscient legal choices,
 * avoiding collisions before live reveal machinery would permit that knowledge. Baselines pick greedily from
 * their VISIBLE choices and re-pick on collision — outcome-identical to the live daemon's omniscient-pool
 * argmax (pick_decider.ts) while exercising the collision/reveal machinery this measurement reports on.
 */
export function runPickPhase(
    seed: number,
    lowerPolicy: PickPolicyName,
    upperPolicy: PickPolicyName,
    payoff: RolePayoff = WAVE2_ROLE_PAYOFF,
): IPickPhaseOutcome {
    const rng = makeRng(seed >>> 0);
    const rngInt: PickRandomInt = (maxExclusive) => Math.floor(rng() * maxExclusive);
    let state = createPickSimState(rngInt);
    const stats: Record<PickTeam, ITeamPickStats> = {
        [LOWER]: emptyTeamPickStats(),
        [UPPER]: emptyTeamPickStats(),
    } as Record<PickTeam, ITeamPickStats>;
    const policies: Record<PickTeam, PickPolicyName> = {
        [LOWER]: lowerPolicy,
        [UPPER]: upperPolicy,
    } as Record<PickTeam, PickPolicyName>;
    const combinedOrder: PickTeam[] =
        isInformedPolicy(lowerPolicy) && !isInformedPolicy(upperPolicy) ? [UPPER, LOWER] : [LOWER, UPPER];

    const teamState = (team: PickTeam): IPickTeamState => (team === LOWER ? state.lower : state.upper);
    const opponentCreatures = (team: PickTeam): readonly number[] =>
        team === LOWER ? state.upper.creatures : state.lower.creatures;

    const accept = (action: Parameters<typeof transitionPickSim>[1]): void => {
        const transition = transitionPickSim(state, action, rngInt);
        if (transition.status !== "accepted") {
            throw new Error(`Pick harness produced a non-accepted ${action.type} (${transition.reason})`);
        }
        state = transition.state;
    };

    const trackOracleOverride = (
        team: PickTeam,
        kind: OracleDecisionKind,
        informedChoice: number,
        blindChoice: number,
    ): void => {
        const teamStats = stats[team];
        teamStats.oracleDecisions += 1;
        if (informedChoice !== blindChoice) {
            teamStats.oracleOverrides += 1;
            teamStats.overridesByDecision[kind] = (teamStats.overridesByDecision[kind] ?? 0) + 1;
        }
    };

    const chooseBundle = (team: PickTeam): number => {
        const policy = policies[team];
        const bundles = teamState(team).bundles;
        if (policy === "policy_v0") {
            return SETUP_POLICY_V0.pickBundle(bundles);
        }
        if (policy === "champion") {
            return championBundleChoice(bundles);
        }
        const mix = policy === "oracle" ? roleMix(opponentCreatures(team)) : UNIFORM_MIX;
        const choice = oracleBundleChoice(bundles, payoff, mix);
        if (policy === "oracle") {
            trackOracleOverride(team, "bundle", choice, oracleBundleChoice(bundles, payoff, UNIFORM_MIX));
        }
        return choice;
    };

    const chooseCreature = (team: PickTeam, level: number): number => {
        const policy = policies[team];
        if (policy === "oracle") {
            const candidates = getOmniscientCreatureChoices(state, team);
            if (!candidates.length) {
                throw new Error(`No legal level-${level} creature for the oracle`);
            }
            const mix = roleMix(opponentCreatures(team));
            const choice = oracleCreatureChoice(candidates, payoff, mix);
            trackOracleOverride(
                team,
                `L${level}` as OracleDecisionKind,
                choice,
                oracleCreatureChoice(candidates, payoff, UNIFORM_MIX),
            );
            return choice;
        }
        const candidates = getVisibleCreatureChoices(state, team);
        if (!candidates.length) {
            throw new Error(`No visible level-${level} creature for ${policy}`);
        }
        if (policy === "oracle_blind") {
            return oracleCreatureChoice(candidates, payoff, UNIFORM_MIX);
        }
        return argmaxId(candidates, baselineScorer(policy));
    };

    let guard = 0;
    while (!isPickSimComplete(state)) {
        if ((guard += 1) > 300) {
            throw new Error("Pick phase failed to complete within 300 driver iterations");
        }
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.PERK) {
            for (const team of combinedOrder) {
                if (teamState(team).perk === Perk.NO_PERK) {
                    // Every policy takes the live max-budget doctrine; the oracle's information is free, so
                    // paying upgrade points for in-draft vision would only weaken its army.
                    accept({ type: "select_perk", team, perk: SETUP_POLICY_V0.pickPerk() });
                }
            }
        } else if (phase.phase === PBTypes.PickPhaseVals.INITIAL_PICK) {
            for (const team of combinedOrder) {
                if (teamState(team).selectedBundleIndex === undefined) {
                    accept({ type: "select_bundle", team, bundleIndex: chooseBundle(team) });
                }
            }
        } else if (phase.phase === PBTypes.PickPhaseVals.PICK) {
            const team = phase.actors[0];
            const creatureId = chooseCreature(team, phase.creatureLevel);
            const transition = transitionPickSim(state, { type: "pick_creature", team, creatureId }, rngInt);
            if (transition.status === "collision") {
                stats[team].collisions += 1;
                stats[team].collisionsByLevel[phase.creatureLevel - 1] += 1;
                state = transition.state;
                continue;
            }
            if (transition.status !== "accepted") {
                throw new Error(`Creature pick rejected (${transition.reason})`);
            }
            state = transition.state;
        } else if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            for (const team of combinedOrder) {
                if (teamState(team).tier2Artifact === undefined) {
                    // T2 is held symmetric across all policies (the live table pick) so the gate isolates
                    // creature/bundle counter-picking; there are no per-matchup artifact priors to respond with.
                    const artifactId = SETUP_POLICY_V0.pickArtifactT2(teamState(team).tier2Offers);
                    accept({ type: "select_tier2", team, artifactId });
                }
            }
        } else {
            throw new Error(`Pick driver reached unexpected phase ${phase.phase}`);
        }
    }
    return { state, lower: stats[LOWER], upper: stats[UPPER] };
}

// ---------------------------------------------------------------------------------------------------------
// Draft -> army -> fight
// ---------------------------------------------------------------------------------------------------------

interface ICatalogRef {
    faction: string;
    creatureName: string;
    level: number;
    size: number;
}

let catalogByIdCache: Map<number, ICatalogRef> | undefined;

const catalogById = (): Map<number, ICatalogRef> => {
    if (!catalogByIdCache) {
        catalogByIdCache = new Map();
        for (let level = 1; level <= 4; level += 1) {
            for (const entry of creaturesByLevel(level)) {
                catalogByIdCache.set(creatureIdForName(entry.creatureName), {
                    faction: entry.faction,
                    creatureName: entry.creatureName,
                    level: entry.level,
                    size: entry.size,
                });
            }
        }
    }
    return catalogByIdCache;
};

export interface IPickedArmy {
    roster: IArmyUnitSpec[];
    perk: number;
    augments: ISetupAugment[];
    synergies: ISetupSynergy[];
    tier1Artifact: number;
    tier2Artifact: number;
    /** Stack counts per role, aligned to ROLES. */
    roleStacks: [number, number, number];
}

/** Materialize a completed pick_sim team into the exact army the live pipeline would field. */
export function buildArmyFromPick(team: IPickTeamState): IPickedArmy {
    if (team.creatures.length !== 6 || team.tier1Artifact === undefined || team.tier2Artifact === undefined) {
        throw new Error("Cannot build an army from an incomplete pick");
    }
    const refs = team.creatures.map((id, index) => {
        const ref = catalogById().get(id);
        if (!ref) {
            throw new Error(`Picked creature id ${id} has no catalog entry`);
        }
        return { id, index, ref };
    });
    refs.sort((a, b) => a.ref.level - b.ref.level || a.index - b.index);
    const roleStacks: [number, number, number] = [0, 0, 0];
    const roster = refs.map(({ id, ref }) => {
        roleStacks[ROLES.indexOf(classifyRole(id))] += 1;
        return {
            faction: ref.faction,
            creatureName: ref.creatureName,
            level: ref.level,
            size: ref.size,
            amount: resolveStackAmount(
                ref.creatureName,
                ref.level,
                DEFAULT_AMOUNT_BY_LEVEL,
                LIVETWIN_PRESET.amountMode,
            ),
        };
    });
    return {
        roster,
        perk: team.perk,
        augments: SETUP_POLICY_V0.pickAugments(getUpgradePoints(team.perk)),
        synergies: SETUP_POLICY_V0.pickSynergies(team.creatures),
        tier1Artifact: team.tier1Artifact,
        tier2Artifact: team.tier2Artifact,
        roleStacks,
    };
}

export interface IPickSimCell {
    id: string;
    policyA: PickPolicyName;
    policyB: PickPolicyName;
    control: boolean;
}

/** The registered cell list: mirror control, both baseline cells, the headline oracle cell, the blind ablation. */
export function defaultCells(): IPickSimCell[] {
    return [
        { id: "champion__mirror", policyA: "champion", policyB: "champion", control: true },
        { id: "policy_v0__vs__champion", policyA: "policy_v0", policyB: "champion", control: false },
        { id: "oracle__vs__champion", policyA: "oracle", policyB: "champion", control: false },
        { id: "oracle__vs__policy_v0", policyA: "oracle", policyB: "policy_v0", control: false },
        { id: "oracle_blind__vs__champion", policyA: "oracle_blind", policyB: "champion", control: false },
    ];
}

export interface IPickSimGameOptions {
    gamesPerCell: number;
    baseSeed: number;
    maxLaps?: number;
}

export interface IPickMatchOutcome {
    winner: Side | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
}

export interface IPickSimGameDependencies {
    payoff?: RolePayoff;
    matchRunner?: (config: IMatchConfig) => IPickMatchOutcome;
}

export interface IPickSimGameRecord {
    cellId: string;
    game: number;
    seed: number;
    aIsLower: boolean;
    winnerSide: Side | "draw";
    winnerSlot: "a" | "b" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    decidedByArmageddon: boolean;
    /** Per-slot pick instrumentation. */
    collisionsA: number;
    collisionsB: number;
    collisionsByLevel: [number, number, number, number];
    oracleDecisions: number;
    oracleOverrides: number;
    overridesByDecision: Partial<Record<OracleDecisionKind, number>>;
    roleStacksA: [number, number, number];
    roleStacksB: [number, number, number];
    armyA: string;
    armyB: string;
}

const armySignature = (army: IPickedArmy): string =>
    `${army.roster.map((unit) => `L${unit.level}:${unit.creatureName}x${unit.amount}`).join("|")}` +
    `|T1:${army.tier1Artifact}|T2:${army.tier2Artifact}`;

const mergeOverrides = (
    ...sources: Partial<Record<OracleDecisionKind, number>>[]
): Partial<Record<OracleDecisionKind, number>> => {
    const merged: Partial<Record<OracleDecisionKind, number>> = {};
    for (const source of sources) {
        for (const [kind, count] of Object.entries(source)) {
            merged[kind as OracleDecisionKind] = (merged[kind as OracleDecisionKind] ?? 0) + (count ?? 0);
        }
    }
    return merged;
};

/**
 * Play one independently addressable game: full pick phase + LIVETWIN fight. Games 2k/2k+1 share the offer
 * board RNG and combat seed, with slot A assigned to opposite LOWER/UPPER pick seats. Both policies re-draft in
 * the second game, so this is not a fixed-army battle side swap and pick-seat luck need not cancel exactly.
 * The shared seed makes the two games a statistical cluster, which the reported conservative uncertainty
 * accounts for.
 */
export function playPickSimGame(
    cell: IPickSimCell,
    options: IPickSimGameOptions,
    game: number,
    dependencies: IPickSimGameDependencies = {},
): IPickSimGameRecord {
    if (!Number.isSafeInteger(game) || game < 0 || game >= options.gamesPerCell) {
        throw new Error(`game must be in [0, ${options.gamesPerCell}); got ${game}`);
    }
    const pairIndex = Math.floor(game / 2);
    const seed = ((options.baseSeed >>> 0) + pairIndex * 0x9e3779b1) >>> 0;
    const aIsLower = game % 2 === 0;
    const lowerPolicy = aIsLower ? cell.policyA : cell.policyB;
    const upperPolicy = aIsLower ? cell.policyB : cell.policyA;
    const payoff = dependencies.payoff ?? WAVE2_ROLE_PAYOFF;
    const outcome = runPickPhase(seed, lowerPolicy, upperPolicy, payoff);
    const lowerArmy = buildArmyFromPick(outcome.state.lower);
    const upperArmy = buildArmyFromPick(outcome.state.upper);
    // LOWER is the green team (battle_engine GREEN_TEAM = TeamVals.LOWER), matching the live seat mapping.
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IPickMatchOutcome => {
            // Prime the lazy singleton outside runMatch's seeded scope (see archetype_payoff.ts).
            FightStateManager.getInstance();
            const result = runMatch(config);
            return {
                winner: result.winner,
                laps: result.laps,
                endReason: result.endReason,
                decidedByArmageddon: result.attrition.decidedByArmageddon,
            };
        });
    const result = matchRunner({
        greenVersion: FROZEN_FIGHT_VERSION,
        redVersion: FROZEN_FIGHT_VERSION,
        roster: lowerArmy.roster,
        redRoster: upperArmy.roster,
        seed,
        gridType: PBTypes.GridVals.NORMAL,
        ...(options.maxLaps === undefined ? {} : { maxLaps: options.maxLaps }),
        greenPerk: lowerArmy.perk,
        redPerk: upperArmy.perk,
        greenAugments: lowerArmy.augments,
        redAugments: upperArmy.augments,
        greenArtifactT1: lowerArmy.tier1Artifact,
        redArtifactT1: upperArmy.tier1Artifact,
        greenArtifactT2: lowerArmy.tier2Artifact,
        redArtifactT2: upperArmy.tier2Artifact,
        greenSynergies: lowerArmy.synergies,
        redSynergies: upperArmy.synergies,
    });
    const aStats = aIsLower ? outcome.lower : outcome.upper;
    const bStats = aIsLower ? outcome.upper : outcome.lower;
    const aArmy = aIsLower ? lowerArmy : upperArmy;
    const bArmy = aIsLower ? upperArmy : lowerArmy;
    const winnerSlot = result.winner === "draw" ? "draw" : (result.winner === "green") === aIsLower ? "a" : "b";
    const collisionsByLevel = outcome.lower.collisionsByLevel.map(
        (count, index) => count + outcome.upper.collisionsByLevel[index],
    ) as [number, number, number, number];
    return {
        cellId: cell.id,
        game,
        seed,
        aIsLower,
        winnerSide: result.winner,
        winnerSlot,
        laps: result.laps,
        endReason: result.endReason,
        decidedByArmageddon: result.decidedByArmageddon,
        collisionsA: aStats.collisions,
        collisionsB: bStats.collisions,
        collisionsByLevel,
        oracleDecisions: aStats.oracleDecisions + bStats.oracleDecisions,
        oracleOverrides: aStats.oracleOverrides + bStats.oracleOverrides,
        overridesByDecision: mergeOverrides(aStats.overridesByDecision, bStats.overridesByDecision),
        roleStacksA: aArmy.roleStacks,
        roleStacksB: bArmy.roleStacks,
        armyA: armySignature(aArmy),
        armyB: armySignature(bArmy),
    };
}

// ---------------------------------------------------------------------------------------------------------
// Aggregation, gate, summary
// ---------------------------------------------------------------------------------------------------------

export interface IRateEstimate {
    wins: number;
    decisive: number;
    rate: number;
    /** Binomial standard error, in percentage points. */
    sePp: number;
}

export function rateWithSe(wins: number, decisive: number): IRateEstimate {
    const rate = decisive > 0 ? wins / decisive : 0.5;
    const sePp = decisive > 0 ? 100 * Math.sqrt((rate * (1 - rate)) / decisive) : Number.POSITIVE_INFINITY;
    return { wins, decisive, rate, sePp };
}

export interface ICellAggregate {
    key: string;
    cell: IPickSimCell;
    baseSeed: number;
    games: number;
    winsA: number;
    winsB: number;
    draws: number;
    greenWins: number;
    redWins: number;
    laps: number;
    armageddonDecided: number;
    endReasons: Record<string, number>;
    collisionsA: number;
    collisionsB: number;
    gamesWithCollision: number;
    collisionsByLevel: [number, number, number, number];
    oracleDecisions: number;
    oracleOverrides: number;
    overridesByDecision: Partial<Record<OracleDecisionKind, number>>;
    roleStacksA: [number, number, number];
    roleStacksB: [number, number, number];
    armiesA: Map<string, number>;
    armiesB: Map<string, number>;
}

export function emptyAggregate(key: string, cell: IPickSimCell, baseSeed: number): ICellAggregate {
    return {
        key,
        cell,
        baseSeed,
        games: 0,
        winsA: 0,
        winsB: 0,
        draws: 0,
        greenWins: 0,
        redWins: 0,
        laps: 0,
        armageddonDecided: 0,
        endReasons: {},
        collisionsA: 0,
        collisionsB: 0,
        gamesWithCollision: 0,
        collisionsByLevel: [0, 0, 0, 0],
        oracleDecisions: 0,
        oracleOverrides: 0,
        overridesByDecision: {},
        roleStacksA: [0, 0, 0],
        roleStacksB: [0, 0, 0],
        armiesA: new Map(),
        armiesB: new Map(),
    };
}

export function aggregateRecord(aggregate: ICellAggregate, record: IPickSimGameRecord): void {
    aggregate.games += 1;
    if (record.winnerSlot === "a") aggregate.winsA += 1;
    else if (record.winnerSlot === "b") aggregate.winsB += 1;
    else aggregate.draws += 1;
    if (record.winnerSide === "green") aggregate.greenWins += 1;
    else if (record.winnerSide === "red") aggregate.redWins += 1;
    aggregate.laps += record.laps;
    aggregate.armageddonDecided += Number(record.decidedByArmageddon);
    aggregate.endReasons[record.endReason] = (aggregate.endReasons[record.endReason] ?? 0) + 1;
    aggregate.collisionsA += record.collisionsA;
    aggregate.collisionsB += record.collisionsB;
    aggregate.gamesWithCollision += Number(record.collisionsA + record.collisionsB > 0);
    record.collisionsByLevel.forEach((count, index) => {
        aggregate.collisionsByLevel[index] += count;
    });
    aggregate.oracleDecisions += record.oracleDecisions;
    aggregate.oracleOverrides += record.oracleOverrides;
    aggregate.overridesByDecision = mergeOverrides(aggregate.overridesByDecision, record.overridesByDecision);
    record.roleStacksA.forEach((count, index) => {
        aggregate.roleStacksA[index] += count;
    });
    record.roleStacksB.forEach((count, index) => {
        aggregate.roleStacksB[index] += count;
    });
    aggregate.armiesA.set(record.armyA, (aggregate.armiesA.get(record.armyA) ?? 0) + 1);
    aggregate.armiesB.set(record.armyB, (aggregate.armiesB.get(record.armyB) ?? 0) + 1);
}

export const PICKSIM_GATE = {
    /** Same bar as the Wave-2 B1 kill gate: the oracle must gain this much over the 50% mirror to reopen B1. */
    oracleGainThresholdPp: 3,
    /** Minimum total games behind the headline estimate. */
    minGames: 8000,
    headlineCell: "oracle__vs__champion",
} as const;

/** Same-seed pairs contain two re-drafted games; the conservative variance bound treats them as one cluster. */
export const PICKSIM_PAIR_CLUSTER_SIZE = 2;
const NORMAL_95_Z = 1.959963984540054;

export interface IPickSimGateVerdict {
    thresholds: typeof PICKSIM_GATE;
    oracleWinRate: number;
    oracleDecisive: number;
    oracleGames: number;
    oracleGainPp: number;
    adequatelyPowered: boolean;
    verdict: "REOPEN" | "DEAD" | "INCONCLUSIVE";
    reason: string;
}

export function evaluatePickSimGate(input: {
    oracleWinRate: number;
    oracleDecisive: number;
    oracleGames: number;
}): IPickSimGateVerdict {
    const oracleGainPp = (input.oracleWinRate - 0.5) * 100;
    const adequatelyPowered = input.oracleGames >= PICKSIM_GATE.minGames;
    const reopen = oracleGainPp >= PICKSIM_GATE.oracleGainThresholdPp;
    return {
        thresholds: PICKSIM_GATE,
        oracleWinRate: input.oracleWinRate,
        oracleDecisive: input.oracleDecisive,
        oracleGames: input.oracleGames,
        oracleGainPp,
        adequatelyPowered,
        verdict: adequatelyPowered ? (reopen ? "REOPEN" : "DEAD") : "INCONCLUSIVE",
        reason: !adequatelyPowered
            ? `Only ${input.oracleGames} games were run (< ${PICKSIM_GATE.minGames} registered minimum); ` +
              `the ${oracleGainPp >= 0 ? "+" : ""}${oracleGainPp.toFixed(2)}pp point estimate cannot decide ` +
              `the B1 gate.`
            : reopen
              ? `The advantaged oracle gains +${oracleGainPp.toFixed(2)}pp (>= +3pp) over the melee champion ` +
                `under pick_sim — B1 draft optimization reopens, without attributing the gain to information.`
              : `The advantaged oracle gains only ${oracleGainPp >= 0 ? "+" : ""}${oracleGainPp.toFixed(2)}pp ` +
                `(< +3pp) vs the melee champion under pick_sim — B1 is dead by the registered oracle criterion ` +
                `against the frozen fight AI.`,
    };
}

export interface IInformationUpperBoundEstimate {
    interpretation: "upper_bound_proxy_including_omniscient_collision_avoidance";
    uncertaintyMethod: "independent_cells_max_design_effect_two_game_seed_clusters";
    /** Informed minus blind point estimate; includes omniscient collision avoidance. */
    valuePp: number;
    /** Standard error if games were independent, retained only for diagnostic comparison. */
    independentGameSePp: number;
    /** Maximum-design-effect standard error for same-seed clusters of two games. */
    conservativeClusterSePp: number;
    /** One-sided interpretation uses the upper endpoint of a two-sided normal 95% interval. */
    upper95Pp: number;
    thresholdPp: number;
    adequatelyPowered: boolean;
    thresholdVerdict: "EXCLUDED_AT_95" | "NOT_EXCLUDED_AT_95" | "INCONCLUSIVE";
}

/**
 * Conservative uncertainty for the informed-minus-blind upper-bound proxy. The cells use independent seed
 * streams, while each cell's games arrive in same-seed pairs. Multiplying the independent-game variance by
 * the maximum cluster size (2) is a safe design-effect bound for arbitrary within-pair correlation.
 */
export function estimateInformationUpperBound(input: {
    informedWinRate: number;
    blindWinRate: number;
    informedSePp: number;
    blindSePp: number;
    informedGames: number;
    blindGames: number;
    thresholdPp?: number;
}): IInformationUpperBoundEstimate {
    const valuePp = (input.informedWinRate - input.blindWinRate) * 100;
    const independentGameSePp = Math.hypot(input.informedSePp, input.blindSePp);
    const conservativeClusterSePp = Math.sqrt(PICKSIM_PAIR_CLUSTER_SIZE) * independentGameSePp;
    const upper95Pp = valuePp + NORMAL_95_Z * conservativeClusterSePp;
    const thresholdPp = input.thresholdPp ?? PICKSIM_GATE.oracleGainThresholdPp;
    const adequatelyPowered = input.informedGames >= PICKSIM_GATE.minGames && input.blindGames >= PICKSIM_GATE.minGames;
    return {
        interpretation: "upper_bound_proxy_including_omniscient_collision_avoidance",
        uncertaintyMethod: "independent_cells_max_design_effect_two_game_seed_clusters",
        valuePp,
        independentGameSePp,
        conservativeClusterSePp,
        upper95Pp,
        thresholdPp,
        adequatelyPowered,
        thresholdVerdict: !adequatelyPowered
            ? "INCONCLUSIVE"
            : upper95Pp < thresholdPp
              ? "EXCLUDED_AT_95"
              : "NOT_EXCLUDED_AT_95",
    };
}

// ---------------------------------------------------------------------------------------------------------
// Job runner (worker pool; this file spawns itself as the worker)
// ---------------------------------------------------------------------------------------------------------

export interface IPickSimJob {
    key: string;
    cell: IPickSimCell;
    baseSeed: number;
    gamesPerCell: number;
    game: number;
}

/** Avalanche-mixed per-cell base seed so every cell's paired seed stream is independent. */
export function cellBaseSeed(baseSeed: number, cellIndex: number): number {
    let h = (baseSeed >>> 0) ^ 0x9c1e5f3b;
    h = Math.imul(h ^ (cellIndex + 0x7f4a), 0x85ebca6b) >>> 0;
    h ^= h >>> 15;
    h = Math.imul(h, 0x27d4eb2f) >>> 0;
    return (h ^ (h >>> 13)) >>> 0;
}

type WorkerReply =
    { type: "ready" } | { type: "result"; key: string; record: IPickSimGameRecord } | { type: "error"; error: string };

async function runJobsConcurrent(
    jobs: readonly IPickSimJob[],
    aggregates: Map<string, ICellAggregate>,
    payoff: RolePayoff,
    concurrency: number,
    onRecord?: (completed: number, total: number) => void,
): Promise<void> {
    const total = jobs.length;
    const poolSize = Math.max(1, Math.min(Math.floor(concurrency) || 1, total));
    if (poolSize <= 1) {
        let completed = 0;
        for (const job of jobs) {
            const record = playPickSimGame(
                job.cell,
                { gamesPerCell: job.gamesPerCell, baseSeed: job.baseSeed },
                job.game,
                {
                    payoff,
                },
            );
            aggregateRecord(aggregates.get(job.key)!, record);
            completed += 1;
            onRecord?.(completed, total);
        }
        return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const workers: Worker[] = [];
        const inFlight = new Map<number, IPickSimJob>();
        let dispatched = 0;
        let completed = 0;
        let settled = false;
        const cleanup = (): void => {
            for (const worker of workers) void worker.terminate();
        };
        const fail = (error: unknown): void => {
            if (settled) return;
            settled = true;
            cleanup();
            rejectPromise(error instanceof Error ? error : new Error(String(error)));
        };
        const dispatchNext = (worker: Worker, workerId: number): void => {
            if (dispatched >= total) {
                worker.postMessage({ type: "stop" });
                return;
            }
            const job = jobs[dispatched];
            dispatched += 1;
            inFlight.set(workerId, job);
            worker.postMessage({ type: "game", job });
        };
        for (let workerId = 0; workerId < poolSize; workerId += 1) {
            let worker: Worker;
            try {
                worker = new Worker(new URL(import.meta.url), { workerData: { picksimOracle: true, payoff } });
            } catch (error) {
                fail(error);
                return;
            }
            workers.push(worker);
            worker.on("message", (message: WorkerReply) => {
                if (settled) return;
                if (message.type === "error") {
                    fail(new Error(message.error));
                    return;
                }
                if (message.type === "ready") {
                    dispatchNext(worker, workerId);
                    return;
                }
                const job = inFlight.get(workerId);
                if (!job || job.key !== message.key) {
                    fail(new Error(`Worker ${workerId} returned a record for an unexpected job key ${message.key}`));
                    return;
                }
                aggregateRecord(aggregates.get(message.key)!, message.record);
                completed += 1;
                onRecord?.(completed, total);
                if (completed >= total) {
                    settled = true;
                    cleanup();
                    resolvePromise();
                    return;
                }
                dispatchNext(worker, workerId);
            });
            worker.on("error", fail);
        }
    });
}

if (!isMainThread && parentPort && (workerData as { picksimOracle?: boolean } | undefined)?.picksimOracle) {
    const port = parentPort;
    const payoff = (workerData as { payoff: RolePayoff }).payoff;
    port.on("message", (message: { type: "game"; job: IPickSimJob } | { type: "stop" }) => {
        if (message.type === "stop") {
            port.close();
            return;
        }
        try {
            const { job } = message;
            const record = playPickSimGame(
                job.cell,
                { gamesPerCell: job.gamesPerCell, baseSeed: job.baseSeed },
                job.game,
                {
                    payoff,
                },
            );
            port.postMessage({ type: "result", key: job.key, record });
        } catch (error) {
            port.postMessage({
                type: "error",
                error: error instanceof Error ? (error.stack ?? error.message) : String(error),
            });
        }
    });
    port.postMessage({ type: "ready" });
}

// ---------------------------------------------------------------------------------------------------------
// Summary + CLI
// ---------------------------------------------------------------------------------------------------------

interface ICellSummary {
    id: string;
    policyA: PickPolicyName;
    policyB: PickPolicyName;
    control: boolean;
    games: number;
    decisive: number;
    draws: number;
    winRateA: number;
    sePp: number;
    slotAWinRate: number;
    greenSeatWinRate: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    collisions: {
        perGameA: number;
        perGameB: number;
        perGame: number;
        gamesWithCollisionRate: number;
        byLevelPerGame: [number, number, number, number];
    };
    oracle: {
        decisions: number;
        overrides: number;
        overrideRate: number;
        byDecision: Partial<Record<OracleDecisionKind, number>>;
    };
    roleStacksPerGameA: [number, number, number];
    roleStacksPerGameB: [number, number, number];
    topArmiesA: { army: string; share: number }[];
    topArmiesB: { army: string; share: number }[];
    distinctArmiesA: number;
    distinctArmiesB: number;
}

function summarizeCell(aggregate: ICellAggregate): ICellSummary {
    const decisive = aggregate.winsA + aggregate.winsB;
    const estimate = rateWithSe(aggregate.winsA, decisive);
    const seatDecisive = aggregate.greenWins + aggregate.redWins;
    const games = Math.max(1, aggregate.games);
    const topArmies = (armies: Map<string, number>): { army: string; share: number }[] =>
        [...armies.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([army, count]) => ({ army, share: count / games }));
    return {
        id: aggregate.cell.id,
        policyA: aggregate.cell.policyA,
        policyB: aggregate.cell.policyB,
        control: aggregate.cell.control,
        games: aggregate.games,
        decisive,
        draws: aggregate.draws,
        winRateA: estimate.rate,
        sePp: estimate.sePp,
        slotAWinRate: decisive ? aggregate.winsA / decisive : 0.5,
        greenSeatWinRate: seatDecisive ? aggregate.greenWins / seatDecisive : 0.5,
        avgLaps: aggregate.laps / games,
        endReasons: aggregate.endReasons,
        collisions: {
            perGameA: aggregate.collisionsA / games,
            perGameB: aggregate.collisionsB / games,
            perGame: (aggregate.collisionsA + aggregate.collisionsB) / games,
            gamesWithCollisionRate: aggregate.gamesWithCollision / games,
            byLevelPerGame: aggregate.collisionsByLevel.map((count) => count / games) as [
                number,
                number,
                number,
                number,
            ],
        },
        oracle: {
            decisions: aggregate.oracleDecisions,
            overrides: aggregate.oracleOverrides,
            overrideRate: aggregate.oracleDecisions ? aggregate.oracleOverrides / aggregate.oracleDecisions : 0,
            byDecision: aggregate.overridesByDecision,
        },
        roleStacksPerGameA: aggregate.roleStacksA.map((count) => count / games) as [number, number, number],
        roleStacksPerGameB: aggregate.roleStacksB.map((count) => count / games) as [number, number, number],
        topArmiesA: topArmies(aggregate.armiesA),
        topArmiesB: topArmies(aggregate.armiesB),
        distinctArmiesA: aggregate.armiesA.size,
        distinctArmiesB: aggregate.armiesB.size,
    };
}

export interface IMeasurePickSimOptions {
    gamesPerCell: number;
    baseSeed: number;
    concurrency: number;
    payoff?: RolePayoff;
    onProgress?: (completed: number, total: number) => void;
}

export interface IMeasurePickSimSummary {
    schemaVersion: 2;
    kind: "b1_picksim_oracle_recheck";
    fightVersion: typeof FROZEN_FIGHT_VERSION;
    startedAt: string;
    wallSeconds: number;
    gamesPerSecond: number;
    config: {
        liveTwinEnv: string;
        amountMode: typeof LIVETWIN_PRESET.amountMode;
        perk: number;
        grid: "NORMAL";
        pairing: {
            clusterSize: typeof PICKSIM_PAIR_CLUSTER_SIZE;
            sharedOfferAndCombatSeed: true;
            policiesRedraftedInOppositePickSeats: true;
            fixedArmyBattleSideSwap: false;
        };
        artifactsApplied: true;
        synergiesApplied: true;
        tier2PolicySymmetric: true;
        oracleFitWeight: number;
        oracleT1Weight: number;
        gamesPerCell: number;
        baseSeed: number;
        concurrency: number;
        totalGames: number;
    };
    payoffPriors: RolePayoff;
    cells: ICellSummary[];
    headline: {
        cell: string;
        oracleGainPp: number;
        blindGainPp: number;
        /** Upper-bound proxy: informed oracle minus blind oracle, including omniscient collision avoidance. */
        informationValueUpperBound: IInformationUpperBoundEstimate;
    };
    gate: IPickSimGateVerdict;
}

export async function runMeasurePickSim(options: IMeasurePickSimOptions): Promise<IMeasurePickSimSummary> {
    if (!Number.isSafeInteger(options.gamesPerCell) || options.gamesPerCell < 2 || options.gamesPerCell % 2 !== 0) {
        throw new Error(`gamesPerCell must be a positive even integer >= 2; got ${options.gamesPerCell}`);
    }
    if (!Number.isSafeInteger(options.baseSeed)) {
        throw new Error(`baseSeed must be a safe integer; got ${options.baseSeed}`);
    }
    const payoff = options.payoff ?? WAVE2_ROLE_PAYOFF;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const aggregates = new Map<string, ICellAggregate>();
    const jobs: IPickSimJob[] = [];
    defaultCells().forEach((cell, cellIndex) => {
        const seed = cellBaseSeed(options.baseSeed, cellIndex);
        aggregates.set(cell.id, emptyAggregate(cell.id, cell, seed));
        for (let game = 0; game < options.gamesPerCell; game += 1) {
            jobs.push({ key: cell.id, cell, baseSeed: seed, gamesPerCell: options.gamesPerCell, game });
        }
    });
    await runJobsConcurrent(jobs, aggregates, payoff, options.concurrency, options.onProgress);
    const wallSeconds = (Date.now() - startMs) / 1000;

    const cells = defaultCells().map((cell) => summarizeCell(aggregates.get(cell.id)!));
    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    const oracleCell = byId.get(PICKSIM_GATE.headlineCell)!;
    const blindCell = byId.get("oracle_blind__vs__champion")!;
    const oracleGainPp = (oracleCell.winRateA - 0.5) * 100;
    const blindGainPp = (blindCell.winRateA - 0.5) * 100;
    const informationValueUpperBound = estimateInformationUpperBound({
        informedWinRate: oracleCell.winRateA,
        blindWinRate: blindCell.winRateA,
        informedSePp: oracleCell.sePp,
        blindSePp: blindCell.sePp,
        informedGames: oracleCell.games,
        blindGames: blindCell.games,
    });
    return {
        schemaVersion: 2,
        kind: "b1_picksim_oracle_recheck",
        fightVersion: FROZEN_FIGHT_VERSION,
        startedAt,
        wallSeconds,
        gamesPerSecond: wallSeconds > 0 ? jobs.length / wallSeconds : 0,
        config: {
            liveTwinEnv: process.env.LIVETWIN ?? "",
            amountMode: LIVETWIN_PRESET.amountMode,
            perk: SETUP_POLICY_V0.pickPerk(),
            grid: "NORMAL",
            pairing: {
                clusterSize: PICKSIM_PAIR_CLUSTER_SIZE,
                sharedOfferAndCombatSeed: true,
                policiesRedraftedInOppositePickSeats: true,
                fixedArmyBattleSideSwap: false,
            },
            artifactsApplied: true,
            synergiesApplied: true,
            tier2PolicySymmetric: true,
            oracleFitWeight: ORACLE_FIT_WEIGHT,
            oracleT1Weight: ORACLE_T1_WEIGHT,
            gamesPerCell: options.gamesPerCell,
            baseSeed: options.baseSeed,
            concurrency: options.concurrency,
            totalGames: jobs.length,
        },
        payoffPriors: payoff,
        cells,
        headline: {
            cell: PICKSIM_GATE.headlineCell,
            oracleGainPp,
            blindGainPp,
            informationValueUpperBound,
        },
        gate: evaluatePickSimGate({
            oracleWinRate: oracleCell.winRateA,
            oracleDecisive: oracleCell.decisive,
            oracleGames: oracleCell.games,
        }),
    };
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    }
    return parsed;
}

function printUsage(): void {
    console.log(
        "usage: LIVETWIN=1 bun src/simulation/measure_picksim_oracle.ts [--games 8000] [--seed 1] " +
            "[--concurrency 8] [--matrix archetype_matrix/matrix.json] [--output sim-out/picksim_oracle.summary.json]",
    );
    console.log("  --games        games per cell; must be even (default 8000)");
    console.log("  --seed         base seed; every cell derives an independent stream (default 1)");
    console.log("  --concurrency  worker threads (default 8)");
    console.log("  --matrix       measure_archetypes summary JSON to derive the payoff priors from");
    console.log("  --output       summary JSON path; use '-' for stdout");
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            games: { type: "string", default: "8000" },
            seed: { type: "string", default: "1" },
            concurrency: { type: "string", default: String(Math.min(8, Math.max(1, availableParallelism()))) },
            matrix: { type: "string" },
            output: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: false,
    });
    if (values.help) {
        printUsage();
        return;
    }
    // The registered re-check runs on the committed live-faithful preset — force it on for this process and
    // every worker it spawns (measure_archetypes.ts does the same).
    process.env.LIVETWIN = "1";
    const gamesPerCell = positiveInteger(values.games, "--games");
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed)) {
        throw new Error(`--seed must be a safe integer; got ${values.seed}`);
    }
    const concurrency = positiveInteger(values.concurrency, "--concurrency");
    const payoff = values.matrix
        ? rolePayoffFromMatrix(JSON.parse(readFileSync(resolve(values.matrix), "utf8")))
        : WAVE2_ROLE_PAYOFF;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const output = values.output ?? join(process.cwd(), "sim-out", `picksim_oracle_${stamp}.summary.json`);
    const total = defaultCells().length * gamesPerCell;
    console.error(
        `B1 pick_sim oracle re-check: ${defaultCells().length} cells x ${gamesPerCell} = ${total} games ` +
            `(seed ${baseSeed}, concurrency ${concurrency}, LIVETWIN=1, frozen ${FROZEN_FIGHT_VERSION} both sides, ` +
            `priors ${values.matrix ? values.matrix : "embedded Wave-2"})`,
    );
    const started = Date.now();
    let lastLogged = 0;
    const summary = await runMeasurePickSim({
        gamesPerCell,
        baseSeed,
        concurrency,
        payoff,
        onProgress: (completed, totalJobs) => {
            if (completed - lastLogged >= Math.max(500, Math.floor(totalJobs / 25)) || completed === totalJobs) {
                lastLogged = completed;
                const rate = (completed / (Date.now() - started)) * 1000;
                console.error(`  ${completed}/${totalJobs} games (${rate.toFixed(1)} games/s)`);
            }
        },
    });
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    if (output === "-") {
        process.stdout.write(json);
    } else {
        const outputPath = resolve(output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.error(`Summary: ${outputPath}`);
    }
    for (const cell of summary.cells) {
        console.error(
            `  ${cell.id}: A ${(cell.winRateA * 100).toFixed(2)}% +/- ${cell.sePp.toFixed(2)}pp ` +
                `(${cell.decisive} decisive / ${cell.games}), collisions/game ${cell.collisions.perGame.toFixed(2)}, ` +
                `oracle overrides ${(cell.oracle.overrideRate * 100).toFixed(1)}%`,
        );
    }
    const information = summary.headline.informationValueUpperBound;
    console.error(
        `Information-value upper-bound proxy (informed - blind; includes omniscient collision avoidance): ` +
            `${information.valuePp >= 0 ? "+" : ""}${information.valuePp.toFixed(2)}pp, conservative ` +
            `paired-cluster SE ${information.conservativeClusterSePp.toFixed(2)}pp, ` +
            `95% upper ${information.upper95Pp.toFixed(2)}pp; +${information.thresholdPp}pp ` +
            `${information.thresholdVerdict}`,
    );
    console.error(`GATE VERDICT: ${summary.gate.verdict} — ${summary.gate.reason}`);
}

if (isMainThread && (import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
