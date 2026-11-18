import type { IAiMetaPairRecord, IAiMetaRunOptions } from "./ai_meta_cohorts_core";
import type { runMatch } from "./battle_engine";

export interface IAiMetaRuntimeAdapter {
    preparePair(options: IAiMetaRunOptions, pair: number): Omit<IAiMetaPairRecord, "games">;
    configureFight(
        prepared: Omit<IAiMetaPairRecord, "games">,
        aIsGreen: boolean,
        config: Parameters<typeof runMatch>[0],
    ): Parameters<typeof runMatch>[0];
}
