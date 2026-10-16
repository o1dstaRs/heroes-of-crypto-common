// P9 stage 2 (PREREGISTRATION_T2_TABLE.md): derive the ranged Tier-2 table from the twelve paired forced-artifact
// arms, and predict the new rule's effect off-policy with cross-fitting.
// usage: bun p9_t2_table.ts --common <root> --dir <dir holding t2_arm_<id>.jsonl for every live Tier-2 id>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (key: string): string => {
    const index = argv.indexOf(`--${key}`);
    if (index < 0 || !argv[index + 1]) throw new Error(`--${key} is required`);
    return argv[index + 1];
};
const root = arg("common");
const dir = arg("dir");
const { ownComposition, T2_RANGED_TABLE_MIN_RANGED, TIER2_ARTIFACT_WINRATE_RANGED } = await import(
    `${root}/src/ai/setup/setup_conditional`
);
const { LIVE_TIER2_ARTIFACT_IDS } = await import(`${root}/src/picks/pick_sim`);
const { TIER2_ARTIFACTS } = await import(`${root}/src/artifacts/artifact_properties`);

interface IGame {
    board: number;
    grid: number;
    ranged: boolean;
    offers: number[];
    policy: number;
    score: number;
}
const scoreOf = (result: string): number => (result === "win" ? 1 : result === "draw" ? 0.5 : 0);

const arms = new Map<number, IGame[]>();
for (const artifact of LIVE_TIER2_ARTIFACT_IDS as number[]) {
    const games: IGame[] = [];
    for (const line of readFileSync(`${dir}/t2_arm_${artifact}.jsonl`, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        const army = record.armies.candidate;
        if (army.tier2Artifact !== artifact) throw new Error(`arm ${artifact} holds a game with ${army.tier2Artifact}`);
        games[record.game] = {
            board: record.offerBoard,
            grid: record.gridType,
            ranged: ownComposition(army.creatureIds).ranged >= T2_RANGED_TABLE_MIN_RANGED,
            offers: army.tier2Offers,
            policy: army.policyTier2Artifact,
            score: scoreOf(record.candidateResult),
        };
    }
    arms.set(artifact, games);
}
// Every arm must be the same panel: same games, boards, armies' cohorts, offers and policy picks.
const reference = arms.get((LIVE_TIER2_ARTIFACT_IDS as number[])[0])!;
for (const [artifact, games] of arms) {
    if (games.length !== reference.length || games.some((game, index) => !game)) {
        throw new Error(`arm ${artifact} has ${games.filter(Boolean).length} games, expected ${reference.length}`);
    }
    for (let index = 0; index < games.length; index += 1) {
        const a = games[index];
        const b = reference[index];
        if (
            a.board !== b.board ||
            a.ranged !== b.ranged ||
            a.policy !== b.policy ||
            a.offers.join() !== b.offers.join()
        ) {
            throw new Error(`arm ${artifact} game ${index} is not paired with the reference arm`);
        }
    }
}
const ids = [...arms.keys()];
const name = (artifact: number): string => TIER2_ARTIFACTS[artifact]?.name ?? String(artifact);

const tableFor = (keep: (game: IGame) => boolean): Map<number, number> => {
    const table = new Map<number, number>();
    for (const artifact of ids) {
        const games = arms.get(artifact)!.filter((game) => game.ranged && keep(game));
        table.set(artifact, games.reduce((sum, game) => sum + game.score, 0) / games.length);
    }
    return table;
};
// Highest measured score among the offers; ties go to the lower id so the rule is deterministic.
const pick = (offers: readonly number[], table: Map<number, number>): number =>
    [...offers].sort((a, b) => table.get(b)! - table.get(a)! || a - b)[0];

/** Mean paired difference, new rule's arm minus the policy's arm, over the games `keep` selects. */
const effect = (
    table: Map<number, number>,
    keep: (index: number) => boolean,
): { games: number; changed: number; pp: number } => {
    let total = 0;
    let games = 0;
    let changed = 0;
    for (let index = 0; index < reference.length; index += 1) {
        if (!keep(index)) continue;
        const game = reference[index];
        games += 1;
        const chosen = game.ranged ? pick(game.offers, table) : game.policy;
        if (chosen === game.policy) continue;
        changed += 1;
        total += arms.get(chosen)![index].score - arms.get(game.policy)![index].score;
    }
    return { games, changed, pp: (100 * total) / games };
};

const full = tableFor(() => true);
console.log(`games per arm ${reference.length}; ranged cohort ${reference.filter((game) => game.ranged).length}`);
console.log("ranged table (draw-aware score of the forced arm against the policy's artifact, 0.5 = even):");
for (const artifact of [...ids].sort((a, b) => full.get(b)! - full.get(a)!)) {
    const perMap = [1, 3, 4]
        .map((grid) => {
            const games = arms.get(artifact)!.filter((game) => game.ranged && game.grid === grid);
            return `${grid}:${((100 * games.reduce((sum, game) => sum + game.score, 0)) / games.length).toFixed(1)}`;
        })
        .join(" ");
    const old = TIER2_ARTIFACT_WINRATE_RANGED[artifact];
    console.log(
        `  ${String(artifact).padStart(2)} ${name(artifact).padEnd(24)} ${(100 * full.get(artifact)!).toFixed(2)}  maps ${perMap}  old table ${old ?? "none"}`,
    );
}
const even = tableFor((game) => game.board % 2 === 0);
const odd = tableFor((game) => game.board % 2 === 1);
const onOdd = effect(even, (index) => reference[index].board % 2 === 1);
const onEven = effect(odd, (index) => reference[index].board % 2 === 0);
const crossFitted = (onOdd.pp * onOdd.games + onEven.pp * onEven.games) / (onOdd.games + onEven.games);
const inSample = effect(full, () => true);
const policyShare = new Map<number, number>();
const newShare = new Map<number, number>();
for (const game of reference.filter((entry) => entry.ranged)) {
    policyShare.set(game.policy, (policyShare.get(game.policy) ?? 0) + 1);
    const chosen = pick(game.offers, full);
    newShare.set(chosen, (newShare.get(chosen) ?? 0) + 1);
}
const share = (counts: Map<number, number>): string =>
    [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(
            ([artifact, count]) =>
                `${name(artifact)} ${((100 * count) / reference.filter((g) => g.ranged).length).toFixed(1)}%`,
        )
        .join(", ");
console.log(`policy picks (ranged cohort): ${share(policyShare)}`);
console.log(`new rule picks (ranged cohort): ${share(newShare)}`);
console.log(
    `predicted effect, cross-fitted: ${crossFitted.toFixed(2)}pp (fit even -> odd ${onOdd.pp.toFixed(2)}pp on ${onOdd.changed}/${onOdd.games} changed games; fit odd -> even ${onEven.pp.toFixed(2)}pp on ${onEven.changed}/${onEven.games})`,
);
console.log(
    `in-sample (optimistic, for reference only): ${inSample.pp.toFixed(2)}pp on ${inSample.changed}/${inSample.games} changed games`,
);
const decision =
    crossFitted < 1.0
        ? "STOP: no confirmable gain"
        : crossFitted < 2.5
          ? "CONFIRM with 16000 games"
          : "CONFIRM with 8000 games";
console.log(`stage-3 decision: ${decision}`);
console.log(
    `TABLE_JSON ${JSON.stringify(Object.fromEntries(ids.map((artifact) => [artifact, Number((100 * full.get(artifact)!).toFixed(2))])))}`,
);
