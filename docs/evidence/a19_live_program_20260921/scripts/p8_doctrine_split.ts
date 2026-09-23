// P8 (PREREGISTRATION_DOCTRINE_V08.md), informational: split a doctrine panel's head-to-head by the doctrine each seat
// actually took. `ranked-variety` is recomputed per game from the record's pick seed and seat, exactly as the harness
// resolved it, so no extra games are needed.
// usage: bun p8_doctrine_split.ts --common <root> --records <panel.jsonl> --candidate <policy> --opponent <policy>
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (key: string): string => {
    const index = argv.indexOf(`--${key}`);
    if (index < 0 || !argv[index + 1]) throw new Error(`--${key} is required`);
    return argv[index + 1];
};
const root = arg("common");
const { resolveRankedDraftDoctrine } = await import(`${root}/src/simulation/ranked_draft_eval`);
const { PBTypes } = await import(`${root}/src/generated/protobuf/v1/types`);
const { Doctrine } = await import(`${root}/src/doctrines/doctrine_properties`);
const candidatePolicy = arg("candidate");
const opponentPolicy = arg("opponent");
const doctrineName = (doctrine: number): string => Doctrine[doctrine] ?? String(doctrine);

const cells = new Map<string, { games: number; score: number; wins: number; losses: number }>();
for (const line of readFileSync(arg("records"), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    // pickSeat names the candidate's pick seat: lower = LEFT, upper = RIGHT (playRankedDraftGame).
    const candidateTeam = record.pickSeat === "candidate-lower" ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const opponentTeam = candidateTeam === PBTypes.TeamVals.LEFT ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT;
    const key = `${doctrineName(resolveRankedDraftDoctrine(candidatePolicy, record.pickSeed, candidateTeam))} vs ${doctrineName(
        resolveRankedDraftDoctrine(opponentPolicy, record.pickSeed, opponentTeam),
    )}`;
    const cell = cells.get(key) ?? { games: 0, score: 0, wins: 0, losses: 0 };
    cell.games += 1;
    cell.score += record.candidateResult === "win" ? 1 : record.candidateResult === "draw" ? 0.5 : 0;
    if (record.candidateResult === "win") cell.wins += 1;
    if (record.candidateResult === "loss") cell.losses += 1;
    cells.set(key, cell);
}
for (const [key, cell] of [...cells.entries()].sort()) {
    const decisive = cell.wins + cell.losses;
    const rate = cell.wins / decisive;
    const half = 196 * Math.sqrt((rate * (1 - rate)) / decisive);
    console.log(
        `${key.padEnd(32)} games ${String(cell.games).padStart(5)}  draw-aware ${((100 * cell.score) / cell.games).toFixed(2)}%  decisive ${(100 * rate).toFixed(2)}% ± ${half.toFixed(2)} (games not clustered)`,
    );
}
