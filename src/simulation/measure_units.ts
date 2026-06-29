/*
 * -----------------------------------------------------------------------------
 * Per-unit win-rate sweep. Runs N v0.4-vs-v0.4 randomized-roster games (equal AI on both sides, so the
 * only variable is the roster) and tallies, for each creature, the win rate of the side fielding it in
 * games where it is on EXACTLY ONE side (so mirrored appearances cancel and the number reflects the
 * unit's own strength). Records carry no action log (SIM_NO_ACTIONS) so the run stays light.
 *
 *   SIM_NO_ACTIONS=1 bun src/simulation/measure_units.ts [games=1000000] [concurrency=12] [seed=1]
 * -----------------------------------------------------------------------------
 */
import { createRequire } from "node:module";

import { runTournamentConcurrent } from "./concurrent_tournament";

const require = createRequire(import.meta.url);
const CREATURES = require("../configuration/creatures.json") as Record<string, Record<string, { level?: number }>>;
const levelOf: Record<string, number> = {};
for (const faction of Object.keys(CREATURES)) {
    const fc = CREATURES[faction];
    if (!fc || typeof fc !== "object") {
        continue;
    }
    for (const name of Object.keys(fc)) {
        if (fc[name] && typeof fc[name].level === "number") {
            levelOf[name] = fc[name].level as number;
        }
    }
}

async function main(): Promise<void> {
    const games = Number(process.argv[2] ?? 1_000_000);
    const concurrency = Number(process.argv[3] ?? 12);
    const baseSeed = Number(process.argv[4] ?? 1);

    const tally: Record<string, { games: number; wins: number }> = {};
    let decisive = 0;
    let draws = 0;
    const startedAt = Date.now();

    await runTournamentConcurrent(
        { versionA: "v0.4", versionB: "v0.4", games, baseSeed, randomizePicks: true },
        concurrency,
        (record) => {
            const res = record.result;
            if (res.winner === "draw") {
                draws += 1;
                return;
            }
            decisive += 1;
            const green = new Set((res.roster ?? []).map((s) => s.creatureName));
            const red = new Set((res.redRoster ?? res.roster ?? []).map((s) => s.creatureName));
            for (const name of new Set([...green, ...red])) {
                const onGreen = green.has(name);
                const onRed = red.has(name);
                if (onGreen === onRed) {
                    continue; // on both sides (or neither) — cancels, not discriminating
                }
                const side = onGreen ? "green" : "red";
                const t = (tally[name] ??= { games: 0, wins: 0 });
                t.games += 1;
                if (res.winner === side) {
                    t.wins += 1;
                }
            }
            if (decisive % 100_000 === 0) {
                console.log(`  ${decisive} decisive games...`);
            }
        },
    );

    const rows = Object.entries(tally)
        .map(([name, t]) => ({ name, level: levelOf[name] ?? 0, games: t.games, wr: t.wins / t.games }))
        .sort((a, b) => b.wr - a.wr);

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`\n=== ${games} games (${decisive} decisive, ${draws} draws) in ${seconds}s ===`);
    console.log(`unit (exactly-one-side games) — win rate of the side fielding it\n`);
    console.log("rank unit".padEnd(22), "Lvl".padStart(4), "games".padStart(10), "win%".padStart(8));
    rows.forEach((r, i) => {
        console.log(
            String(i + 1).padStart(3),
            r.name.padEnd(18),
            String(r.level).padStart(4),
            String(r.games).padStart(10),
            (100 * r.wr).toFixed(2).padStart(7) + "%",
        );
    });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
