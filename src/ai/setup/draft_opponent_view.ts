import { PBTypes } from "../../generated/protobuf/v1/types";
import { getVisibleDraftMap } from "../../picks/draft_visibility";
import { LIVE_PICK_PHASES, type IPickTeamView } from "../../picks/pick_sim";
import { createFeasibleDraftOpponentMemory } from "./draft_opponent_occupancy";
import type { IDraftMemoryInput, IDraftOpponentMemory } from "./draft_opponent_memory";

const phaseOrder = LIVE_PICK_PHASES.map((phase) => phase.phase);
const phaseLevels = LIVE_PICK_PHASES.map((phase) => phase.creatureLevel);

export interface IDraftMemoryPublicView extends IPickTeamView {
    availableCreatureIds: readonly number[];
    revealedMap: number | null;
    synergyVariants: IDraftMemoryInput["synergyVariants"];
}

/**
 * Explicit research observer for authoritative, viewer-projected picks. Compile the pinned artifact
 * once, then pass only the acting player's view. This returns beliefs, never changes picks, doctrine
 * or either existing override budget. The snapshot itself is never opened during a live decision.
 */
export function createHistoricalDraftObserver(model: IDraftOpponentMemory) {
    const predict = createFeasibleDraftOpponentMemory(model);
    return (view: IDraftMemoryPublicView, ownTeam: number) => {
        try {
            if (
                view.complete !== false ||
                view.phase !== PBTypes.PickPhaseVals.PICK ||
                !view.actors.some((team) => team === ownTeam)
            )
                return null;
            const input: IDraftMemoryInput = {
                doctrine: view.doctrine,
                phaseSequence: view.phaseSequence,
                level: view.requiredCreatureLevel,
                ownTeam,
                ownCreatureIds: [...view.creaturesPicked],
                knownOpponentCreatureIds: [...view.knownOpponentCreatures],
                availableCreatureIds: [...view.availableCreatureIds],
                tier1ArtifactId: view.artifacts.find(([tier]) => tier === 1)?.[1] ?? null,
                // Spymaster sees the map early; all doctrines see it from the first level-3 phase.
                map:
                    getVisibleDraftMap(
                        view.revealedMap ?? undefined,
                        phaseOrder,
                        phaseLevels,
                        view.phaseSequence,
                        view.doctrine,
                    ) ?? null,
                synergyVariants: {
                    Life: view.synergyVariants.Life,
                    Nature: view.synergyVariants.Nature,
                    Chaos: view.synergyVariants.Chaos,
                    Might: view.synergyVariants.Might,
                },
            };
            return predict(input, view.creaturesBanned);
        } catch {
            // A missing or unsupported public view must not interfere with the incumbent drafter.
            return null;
        }
    };
}
