/*
 * -----------------------------------------------------------------------------
 * Per-side (green/lower vs red/upper) win-rate measurer. Both sides run the same AI version, so the only
 * variable is a per-team behavior toggled by env (e.g. V06_DISPERSE_TEAM=lower disperses only green). Use
 * MIRRORED rosters (no --random) + FORCE_CREATURES so the two sides are identical and the toggle is the
 * sole difference; a "none" control run measures any inherent side bias to subtract off.
 *
 *   FORCE_CREATURES="4:Black Dragon" V06_DISPERSE_TEAM=lower bun src/simulation/measure_team_winrate.ts v0.6 200000 14 1
 * -----------------------------------------------------------------------------
 */
import { runTournamentConcurrent } from "./concurrent_tournament";
import { AI_VERSIONS } from "../ai";

async function main(): Promise<void> {
    const version = process.argv[2] ?? "v0.6";
    if (!AI_VERSIONS.includes(version)) {
        console.error(`unknown version "${version}". known: ${AI_VERSIONS.join(", ")}`);
        process.exit(1);
    }
    const games = Number(process.argv[3] ?? 200000);
    const concurrency = Number(process.argv[4] ?? 14);
    const baseSeed = Number(process.argv[5] ?? 1);
    const randomize = process.env.TEAM_WR_RANDOM === "1"; // default: mirrored rosters

    let green = 0;
    let red = 0;
    let draws = 0;
    const startedAt = Date.now();
    await runTournamentConcurrent(
        { versionA: version, versionB: version, games, baseSeed, randomizePicks: randomize },
        concurrency,
        (rec) => {
            const w = rec.result.winner;
            if (w === "green") {
                green += 1;
            } else if (w === "red") {
                red += 1;
            } else {
                draws += 1;
            }
            if ((green + red + draws) % 100_000 === 0) {
                console.log(`  ${green + red + draws} games...`);
            }
        },
    );
    const dec = green + red;
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
        `\n=== ${version}: ${games} games (${dec} decisive, ${draws} draws, ${randomize ? "random" : "mirrored"}) in ${seconds}s ===`,
    );
    console.log(
        `GREEN/lower ${((100 * green) / dec).toFixed(2)}%   RED/upper ${((100 * red) / dec).toFixed(2)}%   (FORCE=${process.env.FORCE_CREATURES ?? "-"}, DISPERSE=${process.env.V06_DISPERSE_TEAM ?? "-"})`,
    );
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
