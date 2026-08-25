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
 * Rectangular-footprint clash: many full matches with a 2x1 and a 1x2 stack on the board, reporting the
 * ENGINE-REJECTION rate.
 *
 * A wrong footprint rarely crashes. It makes an AI reason about a body of the wrong shape and then propose a
 * move or a strike the engine refuses — which in ranked is a bot that stalls, skips its turn, or "moves but
 * does not attack". A healthy AI never emits a declined command, so the only acceptable answer here is zero,
 * and the number is worth re-measuring whenever the footprint code or an AI version moves.
 *
 * The shapes come from the engine's QA override rather than from creatures.json: which creature becomes
 * rectangular is a balance and art decision, and this has to be able to prove the engine handles one without
 * pre-empting it. White Tiger is the 2x1 (two cells WIDE); Hyena is deliberately the transposed 1x2, because
 * nearly every bug in this area is an axis confusion that a single orientation would hide.
 *
 *   bun src/simulation/measure_rectangular_footprint_clash.ts
 *   CLASH_MATCHES=250 CLASH_PAIRS=v0.8/v0.8,v0.8/v0.4 bun src/simulation/measure_rectangular_footprint_clash.ts
 *
 * Set HOC_FOOTPRINT_OVERRIDES="" to run the same cohorts all-square as a control.
 */
process.env.HOC_FOOTPRINT_OVERRIDES = process.env.HOC_FOOTPRINT_OVERRIDES ?? "White Tiger=2x1,Hyena=1x2";
process.env.V08_A19_SEARCH = "1";

import { runMatch } from "./battle_engine";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { IArmyUnitSpec } from "./army";

const u = (faction: string, creatureName: string, level: number, size: number, amount: number): IArmyUnitSpec => ({
    faction,
    creatureName,
    level,
    size,
    amount,
});

const WHITE_TIGER = u("Nature", "White Tiger", 2, 1, 12); // 2x1
const HYENA = u("Might", "Hyena", 2, 1, 12); // 1x2
const COHORTS: Record<string, IArmyUnitSpec[]> = {
    both_rectangles: [
        WHITE_TIGER,
        HYENA,
        u("Life", "Peasant", 1, 1, 30),
        u("Life", "Arbalester", 1, 1, 12),
        u("Nature", "Arachna Queen", 4, 2, 2),
    ],
    rect_vs_large: [
        WHITE_TIGER,
        HYENA,
        u("Nature", "Arachna Queen", 4, 2, 2),
        u("Might", "Behemoth", 4, 2, 2),
        u("Life", "Squire", 1, 1, 20),
    ],
    rect_melee_heavy: [
        WHITE_TIGER,
        HYENA,
        u("Chaos", "Orc", 1, 1, 24),
        u("Life", "Pikeman", 2, 1, 20),
        u("Life", "Crusader", 3, 1, 6),
    ],
    rect_ranged_heavy: [
        WHITE_TIGER,
        HYENA,
        u("Life", "Arbalester", 1, 1, 14),
        u("Nature", "Elf", 2, 1, 10),
        u("Might", "Nomad", 2, 1, 8),
    ],
    rect_caster: [
        WHITE_TIGER,
        HYENA,
        u("Life", "Battle Mage", 2, 1, 8),
        u("Life", "Healer", 2, 1, 12),
        u("Chaos", "Nightmare", 3, 1, 5),
    ],
    rect_flyers: [
        WHITE_TIGER,
        HYENA,
        u("Life", "Angel", 4, 2, 2),
        u("Nature", "Pegasus", 3, 1, 6),
        u("Might", "Harpy", 2, 1, 10),
    ],
    rect_only: [WHITE_TIGER, HYENA],
    rect_plus_summoner: [
        WHITE_TIGER,
        HYENA,
        u("Nature", "Satyr", 2, 1, 10),
        u("Nature", "Trent", 2, 1, 6),
        u("Chaos", "Wandering Mage", 1, 1, 14),
    ],
};

const matchesPerCohort = Number(process.env.CLASH_MATCHES ?? 40);
const baseSeed = Number(process.env.CLASH_SEED ?? 7_100_001);

let total = 0;
let rejected = 0;
const reasons = new Map<string, number>();
const endReasons = new Map<string, number>();
const gridTypes = new Map<number, number>();
const versionPairs: Array<[string, string]> = (process.env.CLASH_PAIRS ?? "v0.8/v0.8,v0.8/v0.7,v0.8/v0.4")
    .split(",")
    .map((pair) => pair.split("/") as [string, string]);
// runMatch defaults to NORMAL, so a clash that never sets gridType silently tests ONE board. The obstacle
// boards are exactly where a footprint can go wrong (a rectangle has to path around the centre block and
// can straddle a lava/water edge), so cycle all four.
const GRID_TYPES = [
    PBTypes.GridVals.NORMAL,
    PBTypes.GridVals.LAVA_CENTER,
    PBTypes.GridVals.WATER_CENTER,
    PBTypes.GridVals.BLOCK_CENTER,
];
const started = Date.now();

for (const [name, roster] of Object.entries(COHORTS)) {
    let cohortRejected = 0;
    for (let i = 0; i < matchesPerCohort; i++) {
        const seed = baseSeed + total * 977;
        const [greenVersion, redVersion] = versionPairs[i % versionPairs.length];
        const gridType = GRID_TYPES[total % GRID_TYPES.length];
        const result = runMatch({ roster, greenVersion, redVersion, seed, maxLaps: 60, gridType });
        gridTypes.set(result.gridType, (gridTypes.get(result.gridType) ?? 0) + 1);
        total++;
        const count = (result.rejectedGreen ?? 0) + (result.rejectedRed ?? 0);
        rejected += count;
        cohortRejected += count;
        endReasons.set(result.endReason, (endReasons.get(result.endReason) ?? 0) + 1);
        for (const d of result.rejectedDetails ?? []) {
            const key = `${d.creature ?? "?"}:${d.type}:${d.reason ?? "?"}`;
            reasons.set(key, (reasons.get(key) ?? 0) + 1);
            if (reasons.get(key) === 1) console.log("FIRST", key, "seed=" + seed, "cohort=" + name);
        }
    }
    console.log(`cohort ${name.padEnd(18)} matches=${matchesPerCohort} rejections=${cohortRejected}`);
}

console.log("---");
console.log(
    `matches=${total} rejections=${rejected} rate=${((rejected / total) * 100).toFixed(3)}% elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`,
);
console.log("end reasons:", JSON.stringify(Object.fromEntries(endReasons)));
console.log("grid types:", JSON.stringify(Object.fromEntries(gridTypes)));
console.log("version pairs:", JSON.stringify(versionPairs));
if (reasons.size) console.log("rejection kinds:", JSON.stringify(Object.fromEntries(reasons), null, 1));
