/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { type IAiMetaPairRecord, type IAiMetaRunOptions } from "./ai_meta_cohorts_core";
import { type AiMetaStrategyProfileId } from "./ai_meta_strategy_profile";

export interface IAiMetaProcessTask {
    readonly options: IAiMetaRunOptions;
    readonly pair: number;
    readonly strategyProfileId: AiMetaStrategyProfileId;
}

export type AiMetaProcessRequest =
    { readonly type: "pair"; readonly taskId: number; readonly task: IAiMetaProcessTask } | { readonly type: "stop" };

export type AiMetaProcessResponse =
    | { readonly type: "ready" }
    | { readonly type: "result"; readonly taskId: number; readonly record: IAiMetaPairRecord }
    | { readonly type: "error"; readonly taskId: number; readonly error: string };
