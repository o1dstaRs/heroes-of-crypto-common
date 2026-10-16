/*
 * -----------------------------------------------------------------------------
 * Rejection sweep: run N v0.4-vs-v0.4 randomized games and tally every STRATEGY action the engine
 * declined, broken down by type :: cause :: creature, plus any stuck/non-elimination games. Goal: drive
 * the AI's rejected-action count to 0. Records carry no action log (SIM_NO_ACTIONS), so the run is light.
 *
 *   SIM_NO_ACTIONS=1 bun src/simulation/measure_rejections.ts [games=100000] [concurrency=12] [seed=1]
 *
 * The entrant version and the roster shape are env-overridable so the same tally can be aimed at a
 * specific archetype rather than only the v0.4 default:
 *   REJECT_VERSION=v0.8                      both sides (v0.8 is the a19 profile)
 *   REJECT_COMPOSITION="1:1,3:1,4:4"         level:count pairs, replacing the 2/2/1/1 default
 *   FORCE_CREATURES="4:Gargantuan,4:Tsar Cannon"   pin named creatures into those slots (army.ts)
 * -----------------------------------------------------------------------------
 */
import type { IRosterComposition } from "./army";
import { runTournamentConcurrent } from "./concurrent_tournament";

/** `"1:1,3:1,4:4"` -> the roster composition, or undefined to keep the default 2xL1/2xL2/1xL3/1xL4. */
function compositionFromEnv(): readonly IRosterComposition[] | undefined {
    const raw = process.env.REJECT_COMPOSITION;
    if (!raw) {
        return undefined;
    }
    const composition: IRosterComposition[] = [];
    for (const part of raw.split(",")) {
        const [level, count] = part.split(":").map((value) => Number(value.trim()));
        if (Number.isFinite(level) && Number.isFinite(count) && count > 0) {
            composition.push({ level, count });
        }
    }
    return composition.length ? composition : undefined;
}

async function main(): Promise<void> {
    const games = Number(process.argv[2] ?? 100_000);
    const concurrency = Number(process.argv[3] ?? 12);
    const baseSeed = Number(process.argv[4] ?? 1);
    const version = process.env.REJECT_VERSION ?? "v0.4";
    const composition = compositionFromEnv();

    let counted = 0;
    let totalRejections = 0;
    let nonElimination = 0;
    const byKey: Record<string, number> = {};
    const byCause: Record<string, number> = {};
    const startedAt = Date.now();

    await runTournamentConcurrent(
        { versionA: version, versionB: version, games, baseSeed, randomizePicks: true, composition },
        concurrency,
        (record) => {
            const res = record.result;
            counted += 1;
            if (res.endReason !== "elimination") {
                nonElimination += 1;
            }
            totalRejections += (res.rejectedGreen ?? 0) + (res.rejectedRed ?? 0);
            for (const d of res.rejectedDetails ?? []) {
                const cause = `${d.type} :: ${d.cause ?? d.reason ?? "?"}`;
                byCause[cause] = (byCause[cause] ?? 0) + 1;
                const key = `${cause} :: ${d.creature ?? "?"}`;
                byKey[key] = (byKey[key] ?? 0) + 1;
            }
            if (counted % 25_000 === 0) {
                console.log(`  ${counted} games... rejections so far: ${totalRejections}`);
            }
        },
    );

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
        `\n=== ${counted} games in ${seconds}s  (${version} vs ${version}` +
            `${composition ? `, roster ${composition.map((c) => `${c.count}xL${c.level}`).join("+")}` : ""}` +
            `${process.env.FORCE_CREATURES ? `, forced ${process.env.FORCE_CREATURES}` : ""}) ===`,
    );
    console.log(
        `TOTAL rejected strategy actions: ${totalRejections}  (${(totalRejections / counted).toFixed(4)}/game)`,
    );
    console.log(`non-elimination (stuck/turn_cap) games: ${nonElimination}`);
    console.log(`\nrejections by type :: cause (aggregated):`);
    for (const [k, v] of Object.entries(byCause).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(v).padStart(6)}  ${k}`);
    }
    console.log(`\nrejections by type :: cause :: creature (top 15):`);
    Object.entries(byKey)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
    if (!totalRejections) {
        console.log("  (none — zero rejected actions)");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
