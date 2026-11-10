/** Public draft mechanics. A hidden map is deliberately absent, rather than inferred from a seed. */
import { PBTypes } from "../../generated/protobuf/v1/types";
import { ToFactionType } from "../../factions/faction_type";
import type { IDraftScoutingContext } from "../../picks/draft_visibility";
import { SynergyKeysToPower } from "../../synergies/synergy_properties";
import { creatureInfo } from "./creature_score";
import { draftCreatureContinuation } from "./draft_continuations";
import type { RankedDraftSynergyVariants } from "./draft_synergy_variants";

export const DRAFT_BATTLEFIELD_FACTIONS = ["Life", "Chaos", "Might", "Nature"] as const;

export interface IDraftBattlefieldContext {
    readonly ownCreatureIds: readonly number[];
    readonly knownOpponentCreatureIds: readonly number[];
    readonly scouting: Readonly<IDraftScoutingContext>;
    /** These four variants are public before the first bundle, independently of doctrine. */
    readonly synergyVariants: RankedDraftSynergyVariants;
}

export interface IDraftSynergyEffects {
    readonly factionCounts: readonly number[];
    readonly levels: readonly number[];
    readonly movement: number;
    readonly boardUnits: number;
    readonly auraRange: number;
    readonly flyArmor: number;
    readonly abilityPower: number;
    readonly supply: number;
    readonly morale: number;
    readonly luck: number;
    readonly breakChance: number;
}

export function validDraftBattlefieldContext(context: IDraftBattlefieldContext): boolean {
    const validRoster = (ids: readonly number[]) =>
        ids.length <= 6 &&
        new Set(ids).size === ids.length &&
        ids.every((id) => Number.isSafeInteger(id) && creatureInfo(id));
    return (
        validRoster(context.ownCreatureIds) &&
        validRoster(context.knownOpponentCreatureIds) &&
        DRAFT_BATTLEFIELD_FACTIONS.every((faction) => [1, 2].includes(context.synergyVariants[faction])) &&
        (context.scouting.map === undefined ||
            [
                PBTypes.GridVals.NORMAL,
                PBTypes.GridVals.WATER_CENTER,
                PBTypes.GridVals.LAVA_CENTER,
                PBTypes.GridVals.BLOCK_CENTER,
            ].includes(context.scouting.map))
    );
}

/** Distinct creature thresholds; duplicate split stacks never create another faction member. */
export function draftSynergyEffects(
    creatureIds: readonly number[],
    variants: RankedDraftSynergyVariants,
): IDraftSynergyEffects {
    const units = [...new Set(creatureIds)].flatMap((id) => creatureInfo(id) ?? []);
    const factionCounts = DRAFT_BATTLEFIELD_FACTIONS.map(
        (faction) => units.filter((unit) => unit.faction === ToFactionType[faction]).length,
    );
    const levels = factionCounts.map((count) => Math.min(3, Math.floor(count / 2)));
    const power = (faction: (typeof DRAFT_BATTLEFIELD_FACTIONS)[number], variant: number, component = 0): number => {
        const level = levels[DRAFT_BATTLEFIELD_FACTIONS.indexOf(faction)];
        return variants[faction] === variant && level > 0
            ? (SynergyKeysToPower[`${faction}:${variant}:${level}`]?.[component] ?? 0)
            : 0;
    };
    return {
        factionCounts,
        levels,
        movement: power("Chaos", 1),
        boardUnits: power("Nature", 1),
        auraRange: power("Might", 1),
        flyArmor: power("Nature", 2),
        abilityPower: power("Might", 2),
        supply: power("Life", 1),
        morale: power("Life", 2),
        luck: power("Life", 2, 1),
        breakChance: power("Chaos", 2),
    };
}

/** Reachable is potential under visible bans and picks, never a promise about concealed opponents. */
export function draftBattlefieldSummary(context: IDraftBattlefieldContext) {
    const own = draftSynergyEffects(context.ownCreatureIds, context.synergyVariants);
    const publicEnemyMinimum = draftSynergyEffects(context.knownOpponentCreatureIds, context.synergyVariants);
    const paths = DRAFT_BATTLEFIELD_FACTIONS.map((faction) =>
        draftCreatureContinuation(
            context.ownCreatureIds,
            context.knownOpponentCreatureIds,
            context.scouting,
            (unit) => unit.faction === ToFactionType[faction],
        ),
    );
    return {
        map: context.scouting.map,
        own,
        publicEnemyMinimum,
        maximumReachableLevels: paths.map((path) => Math.min(3, Math.floor(path.maximumCount / 2))),
        uncertainContinuations: paths.map((path) => path.uncertain),
    };
}
