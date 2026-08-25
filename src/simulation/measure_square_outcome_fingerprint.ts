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

/**
 * The square-only outcome fingerprint: one number that answers "did anything a SHIPPED unit does move?".
 *
 * Every creature that ships today is 1x1 or 2x2. A change to shared geometry, pathing, targeting or the AI
 * is usually meant to be INVISIBLE to those shapes — it exists to make some other shape work, or to replace
 * a special case with a general rule. That intent is easy to assert and hard to believe, and a reviewer
 * cannot tell by reading whether a rewritten expansion still emits the same cells in the same ORDER (which
 * decides, for instance, which of two equidistant mountains a large unit mines).
 *
 * So do not assert it — hash it. Play the same matches before and after the change and hash everything an
 * observer could see: who won, why it ended, how many laps and actions it took, how many actions the engine
 * refused, and the exact cell every stack was placed on. Two trees that agree on this hash cannot differ in
 * any shipped behaviour these rosters and boards reach.
 *
 *     git worktree add /tmp/base <sha-before-the-change>
 *     (cd /tmp/base && bun src/simulation/measure_square_outcome_fingerprint.ts)
 *     bun src/simulation/measure_square_outcome_fingerprint.ts
 *     # the two sha256 lines must be identical
 *
 * A19/A13 search MUST stay off, and this script forces it: those drivers stop on a `performance.now()`
 * deadline, so they are not reproducible across processes even with byte-identical code. Everything else is
 * seeded.
 *
 * FP_DUMP=1 prints the per-match rows, which is how you find WHICH match diverged once a hash differs.
 *
 * Do NOT pin the number in a test. It is a DIFFERENTIAL tool: the hash is supposed to move whenever
 * gameplay is deliberately changed — a balance edit, a new ability, a retrained AI — and a committed
 * expectation would then just be a chore to update, which is how a guard stops being read. Its value is
 * comparing two trees you are holding at the same moment.
 */
process.env.V08_A19_SEARCH = "0";
process.env.V08_A13_SEARCH = "0";
// The point of this harness is the shapes that SHIP. A stray override in the environment would silently
// fingerprint something else and compare clean against a tree that had the same stray override.
delete process.env.HOC_FOOTPRINT_OVERRIDES;

import { createHash } from "crypto";

import { runMatch } from "./battle_engine";
import type { IArmyUnitSpec } from "./army";
import { PBTypes } from "../generated/protobuf/v1/types";

const u = (faction: string, creatureName: string, level: number, size: number, amount: number): IArmyUnitSpec => ({
    faction,
    creatureName,
    level,
    size,
    amount,
});

/** Mixed on purpose: small melee, a shooter, a caster, a summoner and genuine 2x2 bodies. */
const ROSTERS: Record<string, IArmyUnitSpec[]> = {
    mixed: [
        u("Nature", "White Tiger", 2, 1, 12),
        u("Might", "Hyena", 2, 1, 12),
        u("Life", "Peasant", 1, 1, 30),
        u("Life", "Arbalester", 1, 1, 12),
        u("Nature", "Arachna Queen", 4, 2, 2),
    ],
    large: [
        u("Nature", "Arachna Queen", 4, 2, 2),
        u("Might", "Behemoth", 4, 2, 2),
        u("Life", "Angel", 4, 2, 2),
        u("Life", "Squire", 1, 1, 20),
    ],
    melee: [
        u("Chaos", "Orc", 1, 1, 24),
        u("Life", "Pikeman", 2, 1, 20),
        u("Life", "Crusader", 3, 1, 6),
        u("Might", "Hyena", 2, 1, 12),
    ],
    caster: [
        u("Life", "Battle Mage", 2, 1, 8),
        u("Life", "Healer", 2, 1, 12),
        u("Chaos", "Nightmare", 3, 1, 5),
        u("Nature", "Satyr", 2, 1, 10),
    ],
};

// All four boards: the obstacle maps are where geometry goes wrong, because a body has to path around the
// centre block and can straddle a lava or water edge.
const GRIDS = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
];
const VERSIONS = ["v0.1", "v0.2", "v0.3", "v0.4", "v0.5", "v0.6", "v0.7", "v0.8"] as const;

const rows: string[] = [];
let index = 0;
for (const version of VERSIONS) {
    for (const [rosterName, roster] of Object.entries(ROSTERS)) {
        for (const gridType of GRIDS) {
            const seed = 5_500_011 + index * 7919;
            index++;
            const result = runMatch({
                roster,
                greenVersion: version,
                redVersion: version,
                seed,
                maxLaps: 40,
                gridType,
            });
            const placements = [...result.placements.green, ...result.placements.red]
                .map((placement) => `${placement.creatureName}@${placement.cell?.x},${placement.cell?.y}`)
                .join("|");
            rows.push(
                [
                    version,
                    rosterName,
                    gridType,
                    seed,
                    result.winner,
                    result.endReason,
                    result.laps,
                    result.totalActions,
                    result.rejectedGreen ?? 0,
                    result.rejectedRed ?? 0,
                    placements,
                ].join(";"),
            );
        }
    }
}

const body = rows.join("\n");
console.log(`matches=${rows.length}`);
console.log(`sha256=${createHash("sha256").update(body).digest("hex")}`);
if (process.env.FP_DUMP) {
    console.log(body);
}
