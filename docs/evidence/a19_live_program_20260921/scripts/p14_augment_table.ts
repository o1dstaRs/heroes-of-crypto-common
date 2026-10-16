// P14 stage 2 (PREREGISTRATION_AUGMENTS_EMPOWER.md): from paired forced-augment arms (one seed, arm BASE = the current
// Sniper 3 / Armor 3 / Might 1), pick per cohort (armies with / without a magic-damage caster) the arm with the best
// draw-aware score, and predict that rule's effect off-policy with even/odd-board cross-fitting.
// usage: bun p14_augment_table.ts --common <root> --dir <dir holding aug_arm_<ARM>.jsonl for BASE, E1, E2, E3, E4>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (key: string): string => {
    const index = argv.indexOf(`--${key}`);
    if (index < 0 || !argv[index + 1]) throw new Error(`--${key} is required`);
    return argv[index + 1];
};
const { creatureInfo } = await import(`${arg("common")}/src/ai/setup/creature_score`);
const dir = arg("dir");
const ARMS = ["BASE", "E1", "E2", "E3", "E4"] as const;
type Cohort = "magic" | "plain";

interface IGame {
    board: number;
    cohort: Cohort;
    score: number;
    plan: string;
}
const arms = new Map<string, IGame[]>();
for (const arm of ARMS) {
    const games: IGame[] = [];
    for (const line of readFileSync(`${dir}/aug_arm_${arm}.jsonl`, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const record = JSON.parse(line);
        const army = record.armies.candidate;
        const magic = [...new Set<number>(army.creatureIds)].some((id) => creatureInfo(id)?.rangedSpellDamage);
        games[record.game] = {
            board: record.offerBoard,
            cohort: magic ? "magic" : "plain",
            score: record.candidateResult === "win" ? 1 : record.candidateResult === "draw" ? 0.5 : 0,
            plan: JSON.stringify(army.augments),
        };
    }
    arms.set(arm, games);
}
const reference = arms.get("BASE")!;
for (const [arm, games] of arms) {
    if (
        games.length !== reference.length ||
        games.some((game, index) => !game || game.board !== reference[index].board)
    ) {
        throw new Error(`arm ${arm} is not paired with BASE`);
    }
}
const cohorts: Cohort[] = ["magic", "plain"];
const scoreOf = (arm: string, cohort: Cohort, keep: (game: IGame) => boolean): number => {
    const games = arms.get(arm)!.filter((game) => game.cohort === cohort && keep(game));
    return games.reduce((sum, game) => sum + game.score, 0) / Math.max(1, games.length);
};
const rule = (keep: (game: IGame) => boolean): Record<Cohort, string> =>
    Object.fromEntries(
        cohorts.map((cohort) => [
            cohort,
            [...ARMS].sort(
                (a, b) => scoreOf(b, cohort, keep) - scoreOf(a, cohort, keep) || ARMS.indexOf(a) - ARMS.indexOf(b),
            )[0],
        ]),
    ) as Record<Cohort, string>;
const effect = (chosen: Record<Cohort, string>, keep: (index: number) => boolean): { games: number; pp: number } => {
    let total = 0;
    let games = 0;
    for (let index = 0; index < reference.length; index += 1) {
        if (!keep(index)) continue;
        games += 1;
        const arm = chosen[reference[index].cohort];
        total += arms.get(arm)![index].score - reference[index].score;
    }
    return { games, pp: (100 * total) / games };
};

for (const cohort of cohorts) {
    const count = reference.filter((game) => game.cohort === cohort).length;
    console.log(
        `${cohort} cohort (${count} games): ` +
            ARMS.map((arm) => `${arm} ${(100 * scoreOf(arm, cohort, () => true)).toFixed(2)}`).join("  "),
    );
}
console.log(`plans: ${ARMS.map((arm) => `${arm} ${arms.get(arm)![0].plan}`).join(" | ")}`);
const full = rule(() => true);
const even = rule((game) => game.board % 2 === 0);
const odd = rule((game) => game.board % 2 === 1);
const onOdd = effect(even, (index) => reference[index].board % 2 === 1);
const onEven = effect(odd, (index) => reference[index].board % 2 === 0);
const crossFitted = (onOdd.pp * onOdd.games + onEven.pp * onEven.games) / (onOdd.games + onEven.games);
console.log(`rule (full data): magic -> ${full.magic}, plain -> ${full.plain}`);
console.log(
    `predicted effect, cross-fitted: ${crossFitted.toFixed(2)}pp (fit even -> odd ${onOdd.pp.toFixed(2)}pp [rule ${even.magic}/${even.plain}]; fit odd -> even ${onEven.pp.toFixed(2)}pp [rule ${odd.magic}/${odd.plain}])`,
);
console.log(`in-sample (optimistic): ${effect(full, () => true).pp.toFixed(2)}pp`);
const decision =
    full.magic === "BASE" && full.plain === "BASE"
        ? "STOP: the current plan is best in both cohorts"
        : crossFitted < 1.0
          ? "STOP: no confirmable gain"
          : crossFitted < 2.5
            ? "CONFIRM with 16000 games"
            : "CONFIRM with 8000 games";
console.log(`stage-3 decision: ${decision}`);
