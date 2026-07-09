/*
 * -----------------------------------------------------------------------------
 * Per-unit win rate + pair/triplet SYNERGY sweep, for NON-RANGED rosters (set ROSTER_RANGED_MAX=0 so no
 * RANGE units are fielded — melee / melee-magic / magic only). Equal AI on both sides, so the only
 * variable is the roster composition.
 *
 * For every decisive game we look at units/pairs/triplets that appear on EXACTLY ONE side (mirrored
 * appearances cancel) and tally that side's win rate. A pair/triplet "synergy" is then scored two ways:
 *   - win%   : raw win rate of the side fielding the combo
 *   - lift   : win% minus the average solo win% of its members — i.e. how much MORE the units win together
 *              than their individual strength predicts. Positive lift = genuine synergy, not just two
 *              strong units stacked.
 *
 *   ROSTER_RANGED_MAX=0 SIM_NO_ACTIONS=1 bun src/simulation/measure_melee_synergy.ts [version=v0.4] [games=1000000] [concurrency=14] [seed=1]
 * -----------------------------------------------------------------------------
 */
import { createRequire } from "node:module";

import { runTournamentConcurrent } from "./concurrent_tournament";
import { AI_VERSIONS } from "../ai";

const require = createRequire(import.meta.url);
const CREATURES = require("../configuration/creatures.json") as Record<
    string,
    Record<string, { level?: number; attack_type?: string }>
>;
const levelOf: Record<string, number> = {};
const attackTypeOf: Record<string, string> = {};
for (const faction of Object.keys(CREATURES)) {
    const fc = CREATURES[faction];
    if (!fc || typeof fc !== "object") {
        continue;
    }
    for (const name of Object.keys(fc)) {
        if (fc[name] && typeof fc[name].level === "number") {
            levelOf[name] = fc[name].level as number;
            attackTypeOf[name] = fc[name].attack_type ?? "MELEE";
        }
    }
}

interface Tally {
    games: number;
    wins: number;
}

/** All k-combinations of a sorted name list, joined as a stable "A|B" key. */
function combos(names: string[], k: number): string[] {
    const out: string[] = [];
    const n = names.length;
    const idx = Array.from({ length: k }, (_, i) => i);
    if (n < k) {
        return out;
    }
    for (;;) {
        out.push(idx.map((i) => names[i]).join("|"));
        let p = k - 1;
        while (p >= 0 && idx[p] === n - k + p) {
            p -= 1;
        }
        if (p < 0) {
            break;
        }
        idx[p] += 1;
        for (let j = p + 1; j < k; j += 1) {
            idx[j] = idx[j - 1] + 1;
        }
    }
    return out;
}

async function main(): Promise<void> {
    const version = process.argv[2] ?? "v0.4";
    if (!AI_VERSIONS.includes(version)) {
        console.error(`unknown version "${version}". known: ${AI_VERSIONS.join(", ")}`);
        process.exit(1);
    }
    const games = Number(process.argv[3] ?? 1_000_000);
    const concurrency = Number(process.argv[4] ?? 14);
    const baseSeed = Number(process.argv[5] ?? 1);

    const unit: Record<string, Tally> = {};
    const pair: Record<string, Tally> = {};
    const triple: Record<string, Tally> = {};
    let decisive = 0;
    let draws = 0;
    const startedAt = Date.now();

    // Tally combos that sit on exactly one side. `mine`/`theirs` are that side's / the other side's sorted
    // deduped name lists; a combo counts for `mine` only if it is NOT fully present on `theirs` (cancels).
    const tallyCombos = (
        store: Record<string, Tally>,
        mine: string[],
        theirsSet: Set<string>,
        k: number,
        won: boolean,
    ): void => {
        for (const key of combos(mine, k)) {
            if (key.split("|").every((n) => theirsSet.has(n))) {
                continue; // both sides have the full combo — not discriminating
            }
            const t = (store[key] ??= { games: 0, wins: 0 });
            t.games += 1;
            if (won) {
                t.wins += 1;
            }
        }
    };

    await runTournamentConcurrent(
        { versionA: version, versionB: version, games, baseSeed, randomizePicks: true },
        concurrency,
        (record) => {
            const res = record.result;
            if (res.winner === "draw") {
                draws += 1;
                return;
            }
            decisive += 1;
            const green = [...new Set((res.roster ?? []).map((s) => s.creatureName))].sort();
            const red = [...new Set((res.redRoster ?? res.roster ?? []).map((s) => s.creatureName))].sort();
            const greenSet = new Set(green);
            const redSet = new Set(red);

            // Units (exactly-one-side).
            for (const name of new Set([...green, ...red])) {
                if (greenSet.has(name) === redSet.has(name)) {
                    continue;
                }
                const won = res.winner === (greenSet.has(name) ? "green" : "red");
                const t = (unit[name] ??= { games: 0, wins: 0 });
                t.games += 1;
                if (won) {
                    t.wins += 1;
                }
            }
            // Pairs + triplets from each side.
            tallyCombos(pair, green, redSet, 2, res.winner === "green");
            tallyCombos(pair, red, greenSet, 2, res.winner === "red");
            tallyCombos(triple, green, redSet, 3, res.winner === "green");
            tallyCombos(triple, red, greenSet, 3, res.winner === "red");

            if (decisive % 100_000 === 0) {
                console.log(`  ${decisive} decisive games...`);
            }
        },
    );

    const wr = (t: Tally) => t.wins / t.games;
    const unitWr: Record<string, number> = {};
    for (const [n, t] of Object.entries(unit)) {
        unitWr[n] = wr(t);
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(
        `\n=== ${version}: ${games} games (${decisive} decisive, ${draws} draws) in ${seconds}s — NON-RANGED rosters ===`,
    );

    // Optional: dump the full aggregated tallies so other metrics can be computed without re-running.
    if (process.env.SYNERGY_DUMP) {
        require("node:fs").writeFileSync(
            process.env.SYNERGY_DUMP,
            JSON.stringify({ version, games, decisive, draws, unit, pair, triple, levelOf }),
        );
        console.log(`(dumped full tallies -> ${process.env.SYNERGY_DUMP})`);
    }

    console.log(`\n--- PER-UNIT win rate (side fielding it, exactly-one-side games) ---`);
    console.log("rank unit".padEnd(22), "Lvl".padStart(4), "games".padStart(10), "win%".padStart(8));
    Object.entries(unit)
        .map(([name, t]) => ({ name, level: levelOf[name] ?? 0, games: t.games, w: wr(t) }))
        .sort((a, b) => b.w - a.w)
        .forEach((r, i) => {
            console.log(
                String(i + 1).padStart(3),
                r.name.padEnd(18),
                String(r.level).padStart(4),
                String(r.games).padStart(10),
                (100 * r.w).toFixed(2).padStart(7) + "%",
            );
        });

    const reportCombo = (store: Record<string, Tally>, k: number, minGames: number, label: string): void => {
        const rows = Object.entries(store)
            .filter(([, t]) => t.games >= minGames)
            .map(([key, t]) => {
                const members = key.split("|");
                const solos = members.map((n) => unitWr[n] ?? 0.5);
                const avg = solos.reduce((s, v) => s + v, 0) / solos.length;
                const max = Math.max(...solos);
                // liftMax = win% above the STRONGEST member's solo win% — the true "these amplify each other"
                // signal (a monster + a weakling scores high vs the average but ~0 vs its max, so it's excluded).
                return { key, games: t.games, w: wr(t), lift: wr(t) - avg, liftMax: wr(t) - max };
            });
        console.log(`\n--- TOP ${label} by WIN% (min ${minGames} games) ---`);
        [...rows]
            .sort((a, b) => b.w - a.w)
            .slice(0, 20)
            .forEach((r, i) =>
                console.log(
                    String(i + 1).padStart(3),
                    r.key.replace(/\|/g, " + ").padEnd(48),
                    String(r.games).padStart(9),
                    (100 * r.w).toFixed(2).padStart(7) + "%",
                ),
            );
        console.log(
            `\n--- TOP ${label} by TRUE SYNERGY (win% over the STRONGER member's solo, min ${minGames} games) ---`,
        );
        [...rows]
            .sort((a, b) => b.liftMax - a.liftMax)
            .slice(0, 20)
            .forEach((r, i) =>
                console.log(
                    String(i + 1).padStart(3),
                    r.key.replace(/\|/g, " + ").padEnd(48),
                    String(r.games).padStart(9),
                    (100 * r.w).toFixed(1).padStart(6) + "%",
                    ("+" + (100 * r.liftMax).toFixed(1) + "pp").padStart(9),
                ),
            );
    };

    reportCombo(pair, 2, 2000, "PAIRS");
    reportCombo(triple, 3, 600, "TRIPLETS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
