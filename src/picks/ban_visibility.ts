import { Doctrine } from "../doctrines/doctrine_properties";
import { CreatureLevelMap } from "../units/unit_properties";

/** Public viewers use NO_DOCTRINE so scouting cannot leak through an observer link. */
export function getVisibleDraftBanLevels(
    phaseLevels: readonly number[],
    phaseSequence: number,
    doctrine: number = Doctrine.NO_DOCTRINE,
): number[] {
    if (!Number.isSafeInteger(phaseSequence) || phaseSequence < 0 || phaseSequence >= phaseLevels.length) {
        return [];
    }
    const revealedLevels = new Set<number>();
    if (doctrine === Doctrine.THREE_REVEALS || doctrine === Doctrine.SEE_ALL) {
        for (const level of [1, 2, 3, 4]) revealedLevels.add(level);
    } else {
        // A zero-level artifact/handoff step must not hide bans from a level already opened.
        for (let index = 0; index <= phaseSequence; index++) {
            const level = phaseLevels[index];
            if (Number.isInteger(level) && level >= 1 && level <= 4) {
                revealedLevels.add(level);
            }
        }
    }
    return [...revealedLevels];
}

export function getVisibleDraftBans(
    banned: readonly number[],
    phaseLevels: readonly number[],
    phaseSequence: number,
    doctrine: number = Doctrine.NO_DOCTRINE,
): number[] {
    const revealedLevels = new Set(getVisibleDraftBanLevels(phaseLevels, phaseSequence, doctrine));
    return banned.filter((id) => revealedLevels.has(CreatureLevelMap[id]));
}
