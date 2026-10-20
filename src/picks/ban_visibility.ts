import { Doctrine } from "../doctrines/doctrine_properties";
import { CreatureLevelMap } from "../units/unit_properties";

/** Public viewers use NO_DOCTRINE so scouting cannot leak through an observer link. */
export function getVisibleDraftBans(
    banned: readonly number[],
    phaseLevels: readonly number[],
    phaseSequence: number,
    doctrine: number = Doctrine.NO_DOCTRINE,
): number[] {
    if (!Number.isSafeInteger(phaseSequence) || phaseSequence < 0 || phaseSequence >= phaseLevels.length) {
        return [];
    }
    let revealedLevel = 0;
    if (doctrine === Doctrine.THREE_REVEALS || doctrine === Doctrine.SEE_ALL) {
        revealedLevel = 4;
    } else {
        // A zero-level artifact/handoff step must not hide bans from a level already opened.
        for (let index = 0; index <= phaseSequence; index++) {
            const level = phaseLevels[index];
            if (Number.isInteger(level) && level >= 1 && level <= 4) {
                revealedLevel = Math.max(revealedLevel, level);
            }
        }
    }
    return banned.filter((id) => {
        const level = CreatureLevelMap[id];
        return level >= 1 && level <= revealedLevel;
    });
}
