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

// Wall-clock probe for the a19 live budget (research): one seat runs the sealed profile + OVERRIDE_JSON with
// the audit on, in PRODUCTION deadline mode (no deterministic caps), so ms per searched turn and deadline
// fallbacks reflect the host it runs on. Run it ON the live host to size a deadline:
//   OVERRIDE_JSON='{"SEARCH_DECISION_DEADLINE_MS":"1000","SEARCH_CIRCUIT_BREAKER_MS":"1500"}' bun src/simulation/measure_search_wallclock.ts <games> <label>
import { readFileSync, rmSync } from "node:fs";
import { buildRoster } from "./army";
import { GREEN_TEAM, RED_TEAM, runMatch } from "./battle_engine";

const games = Number(process.argv[2] ?? 30);
const label = process.argv[3] ?? "timing";
const auditPath = `/tmp/ab_timing_${label}_${process.pid}.jsonl`;
const overrides = JSON.parse(process.env.OVERRIDE_JSON ?? "{}") as Record<string, string>;
process.env.V08_A19_SEARCH_ENV_OVERRIDES = JSON.stringify({
    ...overrides,
    SEARCH_AUDIT: auditPath,
    SEARCH_AUDIT_TURNS: "1",
});

let state = 0x1f2e3d4c;
const rng = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
};
const t0 = Date.now();
for (let i = 0; i < games; i += 1) {
    const overrideIsGreen = i % 2 === 0;
    runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster: buildRoster(rng),
        redRoster: buildRoster(rng),
        seed: 700000 + i,
        searchEnvOverrideTeams: [overrideIsGreen ? GREEN_TEAM : RED_TEAM],
    });
}
const rows = readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const turns = rows.filter((row) => row.t === "turn").map((row) => Number(row.ms));
const gamesRows = rows.filter((row) => row.t === "game");
turns.sort((a, b) => a - b);
const q = (p: number): number => turns[Math.min(turns.length - 1, Math.floor(p * turns.length))];
const searched = gamesRows.reduce((sum, row) => sum + Number(row.searched ?? 0), 0);
const fallbacks = gamesRows.reduce((sum, row) => sum + Number(row.deadlineFallbacks ?? 0), 0);
const circuit = gamesRows.reduce((sum, row) => sum + Number(row.circuitSkipped ?? 0), 0);
const deadline = gamesRows[0]?.decisionDeadlineMs;
console.log(
    `TIMING ${label} override=${JSON.stringify(overrides)} games=${games} searchedTurns=${searched} ` +
        `ms p50=${q(0.5).toFixed(0)} p90=${q(0.9).toFixed(0)} p99=${q(0.99).toFixed(0)} max=${turns[turns.length - 1]?.toFixed(0)} ` +
        `deadline=${deadline}ms deadlineFallbacks=${fallbacks} (${((100 * fallbacks) / Math.max(1, searched)).toFixed(2)}%) circuitSkipped=${circuit} wall=${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
rmSync(auditPath, { force: true });
