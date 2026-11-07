/** Research-only extension: price the opportunity left for the next picker. No selector or weights. */
import { creatureInfo } from "../../ai/setup/creature_score";
import { draftCreatureCoherenceAffinity } from "../../ai/setup/draft_coherence";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { LIVE_PICK_PHASES, type PickTeam } from "../../picks/pick_sim";
import { SynergyKeysToPower } from "../../synergies/synergy_properties";
import { CreatureLevelList } from "../../units/unit_properties";
import {
    DOCTRINE_MATCHUP_ADVANTAGE_FEATURES,
    doctrineMatchupAdvantageFeatures,
    type IDoctrineMatchupChoice,
    type IDoctrineMatchupObservation,
} from "./doctrine_matchup_advantage";

const creatureIds = [...new Set([1, 2, 3, 4].flatMap((level) => CreatureLevelList[level]))].sort((a, b) => a - b);
export const DOCTRINE_MATCHUP_OPPORTUNITY_SCHEMA = "hoc.ai.v0_9.doctrine_matchup_advantage.v2";
export const DOCTRINE_MATCHUP_DENIAL_FEATURES: readonly string[] = Object.freeze([
    ...creatureIds.map((id) => `pending_opponent_denied_unit_${id}`),
    "pending_opponent_visible_build_fit",
    "pending_opponent_visible_ranged_network",
    "pending_opponent_visible_chaos_movement",
    "pending_opponent_visible_faction_activation",
]);
export const DOCTRINE_MATCHUP_OPPORTUNITY_FEATURES: readonly string[] = Object.freeze([
    ...DOCTRINE_MATCHUP_ADVANTAGE_FEATURES,
    ...DOCTRINE_MATCHUP_DENIAL_FEATURES,
]);

/** Public draft phase and draft seat, never physical battle side or a private pick state. */
export interface IDoctrineDraftPublicTurn {
    readonly phaseSequence: number;
    readonly actingTeam: PickTeam;
}

/** A collision leaves the public phase unchanged, so it must not consume an opponent opportunity. */
export function pendingOpponentDraftLevels(turn: IDoctrineDraftPublicTurn): number[] {
    if (!Number.isSafeInteger(turn.phaseSequence) || turn.phaseSequence < 0)
        throw new Error("Invalid public draft phase");
    const phase = LIVE_PICK_PHASES[turn.phaseSequence];
    if (
        !phase ||
        ![PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT].includes(turn.actingTeam) ||
        phase.phase !== PBTypes.PickPhaseVals.PICK ||
        phase.actors.length !== 1 ||
        phase.actors[0] !== turn.actingTeam
    )
        throw new Error("Public draft turn must identify the current creature picker");
    const opponent = turn.actingTeam === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    return LIVE_PICK_PHASES.slice(turn.phaseSequence + 1)
        .filter((entry) => entry.phase === PBTypes.PickPhaseVals.PICK && entry.actors.includes(opponent))
        .map((entry) => entry.creatureLevel);
}

function deniedOpportunity(
    observation: IDoctrineMatchupObservation,
    choice: IDoctrineMatchupChoice,
    pendingLevels: readonly number[],
): number[] {
    const context = observation.context;
    const enemy = [...new Set(context.knownOpponentCreatureIds)].map((id) => {
        const info = creatureInfo(id);
        if (!info) throw new Error(`Unknown revealed creature ${id}`);
        return info;
    });
    // The unit could still be in a hidden starting bundle. This feature is an opportunity,
    // not a probability, a guaranteed accepted pick, or a prediction of the opponent's choice.
    const denied = choice.creatureIds.filter((id) => {
        const info = creatureInfo(id);
        return (
            info &&
            pendingLevels.includes(info.level) &&
            !context.knownOpponentCreatureIds.includes(id) &&
            !context.ownCreatureIds.includes(id) &&
            !context.scouting.bannedCreatureIds.includes(id)
        );
    });
    const chaosCount = enemy.filter((unit) => unit.faction === PBTypes.FactionVals.CHAOS).length;
    const movementAt = (count: number) => {
        const tier = Math.min(3, Math.floor(count / 2));
        return observation.synergyVariants.Chaos === 1 ? (SynergyKeysToPower[`Chaos:1:${tier}`]?.[0] ?? 0) : 0;
    };
    const enemyMelee = enemy.filter((unit) => unit.melee).length;
    const enemyRanged = enemy.filter((unit) => unit.ranged).length;
    let fit = 0,
        rangedNetwork = 0,
        movement = 0,
        factionActivation = 0;
    for (const id of denied) {
        const unit = creatureInfo(id)!;
        // Enemy artifacts, offers and hidden identities are deliberately absent. This is fit
        // against the known part of the enemy roster; unknown allies are not imputed as absent.
        fit += draftCreatureCoherenceAffinity(id, { ownCreatureIds: context.knownOpponentCreatureIds });
        rangedNetwork += (Number(unit.ranged) * enemyRanged) / 6;
        const count = enemy.filter((ally) => ally.faction === unit.faction).length;
        factionActivation += Math.min(3, Math.floor((count + 1) / 2)) - Math.min(3, Math.floor(count / 2));
        if (unit.faction === PBTypes.FactionVals.CHAOS)
            movement +=
                ((movementAt(chaosCount + 1) - movementAt(chaosCount)) * (enemyMelee + Number(unit.melee))) / 18;
    }
    return [
        ...creatureIds.map((id) => Number(denied.includes(id))),
        fit,
        rangedNetwork,
        movement,
        factionActivation / 3,
    ];
}

/**
 * Versioned addition to the 119-feature encoder; the v1 schema/data are immutable.
 * Taking a unit denies it to an opponent with a future slot at that level. Passing it
 * does not guarantee a response. Coefficients must be learned and freshly evaluated.
 * This extension covers sequential creature picks; opening bundles retain v1 features.
 */
export function doctrineMatchupOpportunityFeatures(
    observation: IDoctrineMatchupObservation,
    incumbent: IDoctrineMatchupChoice,
    candidate: IDoctrineMatchupChoice,
    turn: IDoctrineDraftPublicTurn,
): number[] {
    const base = doctrineMatchupAdvantageFeatures(observation, incumbent, candidate);
    if (observation.level === 0) {
        const phase = LIVE_PICK_PHASES[turn.phaseSequence];
        if (
            !Number.isSafeInteger(turn.phaseSequence) ||
            phase?.phase !== PBTypes.PickPhaseVals.INITIAL_PICK ||
            !phase.actors.includes(turn.actingTeam)
        )
            throw new Error("Public turn does not match the bundle decision");
        return [...base, ...new Array<number>(DOCTRINE_MATCHUP_DENIAL_FEATURES.length).fill(0)];
    }
    const pending = pendingOpponentDraftLevels(turn);
    if (LIVE_PICK_PHASES[turn.phaseSequence].creatureLevel !== observation.level)
        throw new Error("Public turn does not match the creature decision level");
    const before = deniedOpportunity(observation, incumbent, pending);
    const after = deniedOpportunity(observation, candidate, pending);
    const result = [...base, ...after.map((value, i) => value - before[i])];
    if (!result.every(Number.isFinite)) throw new Error("Invalid draft opportunity features");
    return result;
}
