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

// Seat-scoped a19 search A/B (research): v0.8 vs v0.8, ONE seat per game runs the sealed profile with the
// research env in OVERRIDE_JSON merged through the searchEnvOverrideTeams seam; the seat alternates.
// Deterministic operation caps so host speed cannot move a decision. Shard it with nohup for volume:
//   OVERRIDE_JSON='{"SEARCH_ROLLOUTS":"4"}' SIM_NO_ACTIONS=1 bun src/simulation/measure_search_env_ab.ts <games> <seedOffset> <label>
// Measured with it (2026-09-13): rollouts 4 +2.8pp, rollouts 3 +2.2pp, validation bank off/pooled null,
// deep budget (r4/s6/m10) +5.1pp — see a19 v7 in v0_8_a19_h18_f184_lower_human_placement_profile.ts.
import { buildRoster } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";

const games = Number(process.argv[2] ?? 100);
const offset = Number(process.argv[3] ?? 0);
const label = process.argv[4] ?? "arm";
if (!process.env.OVERRIDE_JSON) throw new Error("OVERRIDE_JSON is required");
process.env.V08_A19_SEARCH_ENV_OVERRIDES = process.env.OVERRIDE_JSON;

let state = (0x2545f491 ^ Math.imul(offset, 2654435761)) >>> 0 || 1;
const rng = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
};
let wins = 0;
let losses = 0;
let draws = 0;
let rejections = 0;
const t0 = Date.now();
for (let i = 0; i < games; i += 1) {
    const seed = 600000 + offset + i;
    const overrideIsGreen = i % 2 === 0;
    const roster = buildRoster(rng);
    const redRoster = buildRoster(rng);
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster,
        redRoster,
        seed,
        searchOfflineDeterministicWork: true,
        searchEnvOverrideTeams: [overrideIsGreen ? GREEN_TEAM : RED_TEAM],
    });
    rejections += (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0);
    const overrideSide = overrideIsGreen ? "green" : "red";
    if (result.winner === overrideSide) wins += 1;
    else if (result.winner === "draw") draws += 1;
    else losses += 1;
    if ((i + 1) % 25 === 0) console.log(`PROGRESS ${label} ${i + 1}/${games} w=${wins} l=${losses} d=${draws}`);
}
console.log(
    `RESULT ${label} override=${process.env.OVERRIDE_JSON} games=${games} overrideSeat wins=${wins} losses=${losses} draws=${draws} rejections=${rejections} secs=${((Date.now() - t0) / 1000).toFixed(0)}`,
);
