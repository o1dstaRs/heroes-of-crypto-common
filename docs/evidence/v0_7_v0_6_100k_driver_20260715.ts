import { runTournamentConcurrent } from "./concurrent_tournament";

// v0.7 vs v0.6 head-to-head win rate over N games, split into COHORTS (independent seed batches) so we can
// see the win rate AND its stability (each cohort is a disjoint seed range). Mirror rosters (both sides the
// SAME randomized army per game) so only the AI differs. winnerVersion accounts for side alternation.
async function main() {
    const total = Number(process.argv[2]) || 100_000;
    const cohorts = Number(process.argv[3]) || 4;
    const conc = Number(process.argv[4]) || 16;
    const per = Math.floor(total / cohorts);
    const results: { cohort: number; games: number; winRate: number; wins: number; losses: number; draws: number }[] =
        [];
    let W = 0,
        L = 0,
        D = 0;
    for (let c = 0; c < cohorts; c += 1) {
        let wins = 0,
            losses = 0,
            draws = 0;
        const baseSeed = 100_000 + c * 1_000_000; // disjoint per-cohort seed ranges
        await runTournamentConcurrent(
            { versionA: "v0.7", versionB: "v0.6", games: per, baseSeed, lightweight: true },
            conc,
            (rec: any) => {
                const wv = rec.winnerVersion;
                if (wv === "draw") draws += 1;
                else if (wv === "v0.7") wins += 1;
                else losses += 1;
            },
        );
        const dec = wins + losses;
        const wr = dec ? wins / dec : 0.5;
        results.push({ cohort: c, games: per, winRate: +(wr * 100).toFixed(2), wins, losses, draws });
        W += wins;
        L += losses;
        D += draws;
        console.log(JSON.stringify(results[results.length - 1]));
    }
    const decAll = W + L;
    const wrAll = decAll ? W / decAll : 0.5;
    // 95% CI half-width on the aggregate decisive win rate.
    const ci = decAll ? 1.96 * Math.sqrt((wrAll * (1 - wrAll)) / decAll) : 0;
    console.log(
        JSON.stringify({
            AGGREGATE: true,
            games: total,
            v07_winRate_pct: +(wrAll * 100).toFixed(2),
            ci95_pp: +(ci * 100).toFixed(2),
            wins: W,
            losses: L,
            draws: D,
        }),
    );
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
