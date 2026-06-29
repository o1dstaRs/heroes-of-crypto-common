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

import { AI_VERSIONS } from "../ai";
import { buildRoster, makeRng } from "./army";
import { runMatch } from "./battle_engine";

/**
 * CLI: run a SINGLE AI-vs-AI battle and print a human-readable fight log (roster, result, the failures,
 * and a per-lap blow-by-blow). Good for eyeballing that a fight is legit.
 *
 *   bun src/simulation/run_match.ts [versionA] [versionB] [seed] [maxLaps]
 *
 * Examples:
 *   bun src/simulation/run_match.ts                 # v0.1 vs v0.2, seed 42
 *   bun src/simulation/run_match.ts v0.1 v0.2 7     # specific seed (same seed -> same roster)
 *   bun src/simulation/run_match.ts v0.1 v0.1 123   # self-play
 *
 * GREEN plays the LOWER team, RED plays UPPER. Both sides get the SAME 6-unit army (2xL1, 2xL2, 1xL3,
 * 1xL4), so the only difference is the AI. NOTE: the fight uses global RNG, so the same seed gives the
 * same ROSTER but not necessarily the same outcome run-to-run.
 */
function main(): void {
    const [, , versionA = "v0.1", versionB = "v0.2", seedArg, lapsArg] = process.argv;
    if (versionA === "--help" || versionB === "--help") {
        console.log("usage: run_match [versionA] [versionB] [seed] [maxLaps]");
        console.log(`known versions: ${AI_VERSIONS.join(", ")}`);
        return;
    }
    const seed = seedArg ? Number(seedArg) : 42;
    const maxLaps = lapsArg ? Number(lapsArg) : 60;

    const roster = buildRoster(makeRng(seed));
    const result = runMatch({ greenVersion: versionA, redVersion: versionB, roster, seed, maxLaps });

    const rule = "-".repeat(74);
    console.log(rule);
    console.log(`MATCH  seed=${seed}  GREEN=${versionA}  RED=${versionB}`);
    console.log("ROSTER (identical for both sides):");
    for (const r of roster) {
        console.log(`   L${r.level}  ${r.creatureName.padEnd(16)} x${r.amount}`);
    }
    console.log(rule);
    console.log(
        `WINNER: ${result.winner.toUpperCase()}   endReason=${result.endReason}   laps=${result.laps}   actions=${result.totalActions}`,
    );
    console.log(
        `GREEN(${versionA}): units=${result.outcome.green.unitsAlive} creatures=${result.outcome.green.creaturesAlive} hp=${result.outcome.green.hpRemaining}`,
    );
    console.log(
        `RED  (${versionB}): units=${result.outcome.red.unitsAlive} creatures=${result.outcome.red.creaturesAlive} hp=${result.outcome.red.hpRemaining}`,
    );

    const byType: Record<string, number> = {};
    let damageTotal = 0;
    let stacksKilled = 0;
    const failures = result.actions.filter((a) => !a.completed);
    for (const a of result.actions) {
        byType[a.actionType] = (byType[a.actionType] ?? 0) + 1;
        damageTotal += a.damage ?? 0;
        stacksKilled += a.unitIdsDied?.length ?? 0;
    }
    console.log(rule);
    console.log(`action types: ${JSON.stringify(byType)}`);
    console.log(`failures(rejected)=${failures.length}  totalDamage=${damageTotal}  stacksKilled=${stacksKilled}`);
    for (const f of failures) {
        console.log(
            `   FAIL lap${f.lap} ${f.side} ${f.creatureName} ${f.actionType}${f.targetCreature ? ` -> ${f.targetCreature}` : ""}`,
        );
    }

    console.log(rule);
    let lap = 0;
    for (const a of result.actions) {
        if (a.lap !== lap) {
            lap = a.lap;
            console.log(`-- lap ${lap} --`);
        }
        const target = a.targetCreature ? ` -> ${a.targetCreature}` : "";
        const dmg = a.damage ? ` dmg=${a.damage}` : "";
        const kill = a.unitIdsDied?.length ? " [KILL]" : "";
        const rejected = a.completed ? "" : " (REJECTED)";
        console.log(
            `  ${a.side.padEnd(5)} ${a.creatureName.padEnd(15)} ${a.actionType}${target}${dmg}${kill}${rejected}`,
        );
    }
    console.log(rule);
}

// Bun/Node entry-point guard.
if ((import.meta as unknown as { main?: boolean }).main) {
    main();
}

export { main };
