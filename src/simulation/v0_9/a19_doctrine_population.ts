/** Registered doctrine populations for offline learning. Legacy campaigns keep their exact schedule. */
import type { RankedDraftDoctrinePolicy } from "../ranked_draft_eval";
import { Doctrine, getUpgradePoints } from "../../doctrines/doctrine_properties";
import { GREEN_TEAM, type IMatchConfig } from "../battle_engine";

export type V09A19DoctrinePopulation = "balanced-doctrines-v1";
export const V09_A19_DOCTRINES = ["see-all", "three-reveals", "see-none"] as const;

export function v09DoctrineBoardCount(count: number, population?: V09A19DoctrinePopulation): number {
    if (population !== undefined && population !== "balanced-doctrines-v1")
        throw new Error("Unknown registered doctrine population");
    return population ? Math.ceil(count / 27) * 27 : count;
}

/** Audit the accepted setup passed to the engine, rather than reconstructing it from draft ids. */
export function assertV09DoctrineSetup(config: IMatchConfig, board: number, nullControl = false): void {
    const policies = v09DoctrineBoard(board, "balanced-doctrines-v1", nullControl);
    const ids = { "see-all": Doctrine.SEE_ALL, "three-reveals": Doctrine.THREE_REVEALS, "see-none": Doctrine.SEE_NONE };
    const candidateGreen = config.searchEnvOverrideTeams?.[0] === GREEN_TEAM;
    for (const [candidate, doctrine, augments] of [
        [candidateGreen, config.greenDoctrine, config.greenAugments],
        [!candidateGreen, config.redDoctrine, config.redAugments],
    ] as const) {
        const policy = candidate ? policies.candidateDoctrinePolicy : policies.opponentDoctrinePolicy;
        if (
            policy === "ranked-variety" ||
            doctrine !== ids[policy] ||
            augments?.reduce((sum, augment) => sum + augment.value, 0) !== getUpgradePoints(doctrine)
        )
            throw new Error("Doctrine training must use the scheduled doctrine and spend its real point budget");
    }
}

/** Every 27 boards cover three maps × three own doctrines × three opponent doctrines equally.
 * A/A keeps both doctrines identical so its four seat permutations remain an exact null control.
 */
export function v09DoctrineBoard(
    board: number,
    population?: V09A19DoctrinePopulation,
    nullControl = false,
): { candidateDoctrinePolicy: RankedDraftDoctrinePolicy; opponentDoctrinePolicy: RankedDraftDoctrinePolicy } {
    v09DoctrineBoardCount(1, population);
    if (!Number.isSafeInteger(board) || board < 0) throw new Error("Invalid doctrine board index");
    const own = population ? V09_A19_DOCTRINES[Math.floor(board / 3) % 3] : "see-none";
    return {
        candidateDoctrinePolicy: own,
        opponentDoctrinePolicy: population && !nullControl ? V09_A19_DOCTRINES[Math.floor(board / 9) % 3] : own,
    };
}
