import { Doctrine } from "../doctrines/doctrine_properties";
import { PBTypes } from "../generated/protobuf/v1/types";
import { getVisibleDraftBanLevels, getVisibleDraftBans } from "./ban_visibility";

export interface IDraftScoutingContext {
    readonly map?: number;
    readonly bannedCreatureIds: readonly number[];
    readonly knownBanLevels: readonly number[];
    readonly remainingPickLevels: readonly number[];
}

export interface IDraftVisibilityInput {
    readonly gridType?: number;
    readonly bannedCreatureIds: readonly number[];
    readonly phaseOrder: readonly number[];
    readonly phaseLevels: readonly number[];
    readonly phaseActors: readonly (readonly number[])[];
    readonly phaseSequence: number;
    readonly doctrine: number;
    readonly team: number;
}

export function getVisibleDraftMap(
    gridType: number | undefined,
    phaseOrder: readonly number[],
    phaseLevels: readonly number[],
    sequence: number,
    doctrine: number = Doctrine.NO_DOCTRINE,
): number | undefined {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= phaseOrder.length) return undefined;
    const firstLevel3 = phaseLevels.findIndex((level) => level >= 3);
    const firstBundle = phaseOrder.indexOf(PBTypes.PickPhaseVals.INITIAL_PICK);
    const earlyReveal = doctrine === Doctrine.SEE_ALL && firstBundle >= 0 && sequence >= firstBundle;
    return earlyReveal || (firstLevel3 >= 0 && sequence >= firstLevel3) ? gridType : undefined;
}

export function getDraftScoutingContext(input: IDraftVisibilityInput): IDraftScoutingContext {
    const sequence = input.phaseSequence;
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= input.phaseOrder.length) {
        return { bannedCreatureIds: [], knownBanLevels: [], remainingPickLevels: [] };
    }
    const map = getVisibleDraftMap(input.gridType, input.phaseOrder, input.phaseLevels, sequence, input.doctrine);
    return {
        ...(map === undefined ? {} : { map }),
        bannedCreatureIds: getVisibleDraftBans(input.bannedCreatureIds, input.phaseLevels, sequence, input.doctrine),
        knownBanLevels: getVisibleDraftBanLevels(input.phaseLevels, sequence, input.doctrine),
        remainingPickLevels: input.phaseLevels.filter(
            (level, index) =>
                index >= sequence && level >= 1 && level <= 4 && input.phaseActors[index]?.includes(input.team),
        ),
    };
}
