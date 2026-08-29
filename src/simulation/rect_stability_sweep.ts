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

/*
 * Stability sweep: every shipped AI version against RECTANGULAR bodies, on every map, in both board
 * orientations, over many seeds.
 *
 * test/integration/footprint_end_to_end.test.ts is the acceptance gate, and it is deliberately small — one
 * seed, one roster, and only the versions and shapes it names. That makes it a fast CI check, not a search.
 * This is the search: it drives the same runMatch harness across the whole (version x roster x map x
 * orientation x seed) grid and reports every match the engine refused an action in, stalled, or threw on.
 *
 *   bun src/simulation/rect_stability_sweep.ts --versions v0.1,v0.8 --seeds 20 --json out.json
 *
 * A rejection is the signal that matters: a footprint bug rarely crashes, it makes the AI reason about a
 * body of the wrong shape and propose a command the engine declines — which is what a player sees as a bot
 * that stalls, skips its turn, or moves without attacking.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { IArmyUnitSpec } from "./army";
import { runMatch, type IMatchResult } from "./battle_engine";

const FOOTPRINT_OVERRIDE_ENV = "HOC_FOOTPRINT_OVERRIDES";

const arg = (name: string, fallback: string): string => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const ALL_VERSIONS = ["v0.1", "v0.2", "v0.3", "v0.4", "v0.5", "v0.6s", "v0.6", "v0.7s", "v0.7", "v0.8s", "v0.8", "v0.9"];

const WHITE_TIGER: IArmyUnitSpec = { faction: "Nature", creatureName: "White Tiger", level: 2, size: 1, amount: 12 };
const HYENA: IArmyUnitSpec = { faction: "Might", creatureName: "Hyena", level: 2, size: 1, amount: 12 };
const PEASANT: IArmyUnitSpec = { faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 30 };
const ARBALESTER: IArmyUnitSpec = { faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 12 };
const ARACHNA_QUEEN: IArmyUnitSpec = { faction: "Nature", creatureName: "Arachna Queen", level: 4, size: 2, amount: 2 };

/** Rosters chosen so an axis confusion cannot hide: each fields BOTH orientations next to squares. */
const ROSTERS: { name: string; roster: IArmyUnitSpec[] }[] = [
    { name: "mixed", roster: [WHITE_TIGER, HYENA, PEASANT, ARBALESTER, ARACHNA_QUEEN] },
    { name: "rect-only", roster: [WHITE_TIGER, HYENA] },
    { name: "rect+big", roster: [WHITE_TIGER, HYENA, ARACHNA_QUEEN] },
    { name: "rect+shooter", roster: [WHITE_TIGER, HYENA, ARBALESTER] },
];

/** Both orientations of each shape, plus the three-deep bodies the acceptance test only spot-checks. */
const SHAPES = ["White Tiger=2x1,Hyena=1x2", "White Tiger=1x2,Hyena=2x1", "White Tiger=3x1,Hyena=1x3"];

const MAPS = [1, 2, 3, 4]; // NORMAL, WATER_CENTER, LAVA_CENTER, BLOCK_CENTER

interface IFailure {
    kind: "rejection" | "stuck" | "throw" | "no_actions";
    version: string;
    opponent: string;
    roster: string;
    shapes: string;
    gridType: number;
    sideOriented: boolean;
    seed: number;
    detail: string;
}

const versions = arg("versions", ALL_VERSIONS.join(",")).split(",").filter(Boolean);
const opponents = arg("opponents", "").split(",").filter(Boolean);
const seedCount = Number(arg("seeds", "6"));
const seedBase = Number(arg("seed-base", "8800000"));
const maxLaps = Number(arg("max-laps", "24"));
const jsonOut = arg("json", "");

const describeRejections = (result: IMatchResult): string =>
    (result.rejectedDetails ?? [])
        .map((d) => `${d.version}:${d.creature ?? "?"}:${d.type}:${d.reason ?? "?"}${d.cause ? `(${d.cause})` : ""}`)
        .join(", ");

const failures: IFailure[] = [];
let matches = 0;
let rejectedMatches = 0;
const started = Date.now();

for (const version of versions) {
    // Self-play by default; an explicit --opponents list also drives the asymmetric pairings, where one
    // side reasons about a shape the other does not.
    for (const opponent of opponents.length ? opponents : [version]) {
        for (const { name: rosterName, roster } of ROSTERS) {
            for (const shapes of SHAPES) {
                for (const gridType of MAPS) {
                    for (const sideOriented of [false, true]) {
                        for (let s = 0; s < seedCount; s++) {
                            const seed = seedBase + s * 1_009 + gridType * 17;
                            const base = {
                                version, opponent, roster: rosterName, shapes, gridType, sideOriented, seed,
                            };
                            process.env[FOOTPRINT_OVERRIDE_ENV] = shapes;
                            matches++;
                            try {
                                const result = runMatch({
                                    roster,
                                    greenVersion: version,
                                    redVersion: opponent,
                                    seed,
                                    maxLaps,
                                    gridType,
                                    sideOrientedPlacement: sideOriented,
                                });
                                const rejected = (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0);
                                if (rejected > 0) {
                                    rejectedMatches++;
                                    failures.push({ ...base, kind: "rejection", detail: describeRejections(result) });
                                } else if (result.totalActions === 0) {
                                    failures.push({ ...base, kind: "no_actions", detail: "match produced no actions" });
                                } else if (result.endReason === "stuck") {
                                    failures.push({ ...base, kind: "stuck", detail: `stuck after ${result.laps} laps` });
                                }
                            } catch (error) {
                                failures.push({
                                    ...base,
                                    kind: "throw",
                                    detail: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 400),
                                });
                            } finally {
                                delete process.env[FOOTPRINT_OVERRIDE_ENV];
                            }
                        }
                    }
                }
            }
        }
    }
}

const byKind = failures.reduce<Record<string, number>>((acc, f) => {
    acc[f.kind] = (acc[f.kind] ?? 0) + 1;
    return acc;
}, {});
const byVersion = failures.reduce<Record<string, number>>((acc, f) => {
    acc[f.version] = (acc[f.version] ?? 0) + 1;
    return acc;
}, {});

const summary = {
    versions, matches, failures: failures.length, rejectedMatches, byKind, byVersion,
    elapsedSeconds: Number(((Date.now() - started) / 1000).toFixed(1)),
};
console.log(JSON.stringify(summary));
for (const failure of failures.slice(0, 40)) console.log("FAIL " + JSON.stringify(failure));
if (jsonOut) {
    mkdirSync(dirname(jsonOut), { recursive: true });
    writeFileSync(jsonOut, JSON.stringify({ summary, failures }, null, 2));
}
