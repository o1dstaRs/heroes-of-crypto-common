import type { IDraftMatchupInput } from "../ai/setup/draft_matchup_value";
import type { AiMetaCohort } from "./ai_meta_cohorts_core";

/** Both sides stay together. Scores are labels, never fields of the policy input. */
export interface IPremiumMatchupFamily {
    familyId: string;
    snapshotId: string;
    cohort: AiMetaCohort;
    partition: "train";
    armies: {
        side: "a" | "b";
        input: IDraftMatchupInput;
        target: { seatPairedScore: number };
    }[];
}
