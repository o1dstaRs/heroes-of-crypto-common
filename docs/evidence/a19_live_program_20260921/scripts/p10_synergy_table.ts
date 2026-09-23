// P10 stage 2 (PREREGISTRATION_SYNERGY.md): for each one-faction synergy flip arm, the candidate's draw-aware score over
// the games where the flip changed its synergies, with a 95% interval clustered by offer board, and the flip decision.
// usage: bun p10_synergy_table.ts --dir <dir holding syn_arm_<FACTION>.jsonl for LIFE, CHAOS, MIGHT, NATURE>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const index = argv.indexOf("--dir");
if (index < 0 || !argv[index + 1]) throw new Error("--dir is required");
const dir = argv[index + 1];

const flips: string[] = [];
for (const faction of ["LIFE", "CHAOS", "MIGHT", "NATURE"]) {
    const clusters = new Map<number, { games: number; score: number }>();
    let total = 0;
    for (const line of readFileSync(`${dir}/syn_arm_${faction}.jsonl`, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        total += 1;
        const army = record.armies.candidate;
        if (JSON.stringify(army.synergies) === JSON.stringify(army.policySynergies)) continue;
        const cluster = clusters.get(record.offerBoard) ?? { games: 0, score: 0 };
        cluster.games += 1;
        cluster.score += record.candidateResult === "win" ? 1 : record.candidateResult === "draw" ? 0.5 : 0;
        clusters.set(record.offerBoard, cluster);
    }
    const values = [...clusters.values()];
    const games = values.reduce((sum, cluster) => sum + cluster.games, 0);
    const score = values.reduce((sum, cluster) => sum + cluster.score, 0) / games;
    // Cluster-robust variance of a ratio mean: sum over boards of (s_c - p n_c)^2 / N^2, small-sample corrected.
    const count = values.length;
    const variance =
        (values.reduce((sum, cluster) => sum + (cluster.score - score * cluster.games) ** 2, 0) / games ** 2) *
        (count / Math.max(1, count - 1));
    const half = 1.96 * Math.sqrt(variance);
    const flip = score > 0.5 && score - half > 0.5;
    if (flip) flips.push(faction);
    console.log(
        `${faction.padEnd(7)} flip applied in ${games}/${total} games; draw-aware ${(100 * score).toFixed(2)}% ` +
            `[${(100 * (score - half)).toFixed(2)}, ${(100 * (score + half)).toFixed(2)}] over ${count} boards -> ` +
            (flip ? "FLIP" : "keep"),
    );
}
console.log(flips.length ? `stage-3 candidate: flip ${flips.join(", ")}` : "STOP: the synergy table holds");
