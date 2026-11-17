import { PBTypes } from "../../generated/protobuf/v1/types";
import { LIVE_PICK_PHASES, type IPickTeamView } from "../../picks/pick_sim";
import { CreatureLevelList, CreatureLevelMap } from "../../units/unit_properties";
import { createDraftMatchupValue, type IDraftMatchupModel } from "./draft_matchup_value";

export interface IHistoricalFinalPickView extends IPickTeamView {
    availableCreatureIds: readonly number[];
    revealedMap: number | null;
}

const lastPick = LIVE_PICK_PHASES.reduce(
    (last, phase, index) => (phase.phase === PBTypes.PickPhaseVals.PICK ? index : last),
    -1,
);
export const HISTORICAL_FINAL_PICK_MARGIN = 0.03;

/**
 * Explicit opt-in research candidate, not a default import. Compare complete armies only at the last
 * pick, after the existing V3/contextual drafter has chosen its incumbent. No battle labels, hidden
 * roster imputation, RNG, mutations, artifact changes or additional earlier-pick overrides.
 */
export function createHistoricalFinalPickAdvisor(model: IDraftMatchupModel) {
    const predict = createDraftMatchupValue(model);
    return (view: IHistoricalFinalPickView, ownTeam: number, incumbent: number) => {
        try {
            if (
                view.complete !== false ||
                view.phase !== PBTypes.PickPhaseVals.PICK ||
                view.phaseSequence !== lastPick ||
                view.requiredCreatureLevel !== 4 ||
                view.actors.length !== 1 ||
                view.actors[0] !== ownTeam ||
                view.revealedMap === null ||
                view.creaturesPicked.length !== 5 ||
                view.knownOpponentCreatures.length !== 6 ||
                new Set([...view.creaturesPicked, ...view.knownOpponentCreatures]).size !== 11 ||
                !view.availableCreatureIds.includes(incumbent)
            )
                return null;
            const levels = (roster: readonly number[]) =>
                [1, 2, 3, 4].map((level) => roster.filter((id) => CreatureLevelMap[id] === level).length).join(",");
            if (levels(view.creaturesPicked) !== "2,2,1,0" || levels(view.knownOpponentCreatures) !== "2,2,1,1")
                return null;
            const excluded = new Set([
                ...view.creaturesBanned,
                ...view.creaturesPicked,
                ...view.knownOpponentCreatures,
            ]);
            const choices = CreatureLevelList[4].filter((id) => !excluded.has(id)).sort((a, b) => a - b);
            if (
                choices.length !== view.availableCreatureIds.length ||
                new Set(view.availableCreatureIds).size !== choices.length ||
                choices.some((id) => !view.availableCreatureIds.includes(id))
            )
                return null;
            const scored = choices.map((creatureId) => ({
                creatureId,
                value: predict({
                    ownCreatureIds: [...view.creaturesPicked, creatureId],
                    opponentCreatureIds: view.knownOpponentCreatures,
                    ownDoctrine: view.doctrine,
                    map: view.revealedMap!,
                }),
            }));
            if (scored.some((row) => row.value === null)) return null;
            const incumbentValue = scored.find((row) => row.creatureId === incumbent)!.value!;
            let selectedCreatureId = incumbent;
            let selectedValue = incumbentValue;
            for (const row of scored)
                if (row.value! > selectedValue) {
                    selectedCreatureId = row.creatureId;
                    selectedValue = row.value!;
                }
            if (selectedValue - incumbentValue < HISTORICAL_FINAL_PICK_MARGIN) {
                selectedCreatureId = incumbent;
                selectedValue = incumbentValue;
            }
            return {
                incumbent,
                selectedCreatureId,
                incumbentValue,
                selectedValue,
                predictedGain: selectedValue - incumbentValue,
                changed: selectedCreatureId !== incumbent,
                choices: scored,
            };
        } catch {
            return null;
        }
    };
}
