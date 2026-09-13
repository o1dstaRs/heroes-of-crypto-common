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

// a19 self-play with the IL v3 dataset on for BOTH seats (research): one row per searched decision — incumbent
// kind, whether the search overrode, the 41 wait features, candidate rollout means. Used for the 2026-09-13
// wait-veto distillation attempt (parked: AUC 0.69/0.72, no in-play case).
//   SIM_NO_ACTIONS=1 bun src/simulation/measure_search_il_dataset.ts <games> <seedOffset> <outPath>
import { createHash } from "node:crypto";
import { buildRoster } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";

const games = Number(process.argv[2] ?? 50);
const offset = Number(process.argv[3] ?? 0);
const outPath = process.argv[4] ?? `/tmp/il_a19wait_${offset}.jsonl`;
process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
    SEARCH_IL_DATASET: outPath,
    SEARCH_IL_RUN_FINGERPRINT: createHash("sha256").update("a19-wait-distil-2026-09-13").digest("hex"),
    SEARCH_IL_COHORT: "a19wait",
});
let state = (0x7a11ce ^ Math.imul(offset, 2654435761)) >>> 0 || 1;
const rng = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
};
const t0 = Date.now();
for (let i = 0; i < games; i += 1) {
    runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster: buildRoster(rng),
        redRoster: buildRoster(rng),
        seed: 800000 + offset + i,
        searchOfflineDeterministicWork: true,
        searchEnvOverrideTeams: [GREEN_TEAM, RED_TEAM],
    });
    if ((i + 1) % 10 === 0) console.log(`PROGRESS ${offset} ${i + 1}/${games}`);
}
console.log(
    `RESULT ilgen offset=${offset} games=${games} out=${outPath} secs=${((Date.now() - t0) / 1000).toFixed(0)}`,
);
