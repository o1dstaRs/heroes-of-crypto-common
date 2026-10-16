/*
 * a19 (v0.8 + SearchDriver) self-play reproducer: TIMING + a decision FINGERPRINT.
 *
 * Random rosters only — the owner retired the Gargantuan/Tsar Cannon cohort as a measurement target.
 *
 * Both seats search, offline deterministic work caps, so decisions are a pure function of the code —
 * host speed cannot move them. Any pure-performance change must leave every fingerprint identical.
 *
 *   bun <this> <games> [seedOffset]
 *
 * Run WITHOUT SIM_NO_ACTIONS: the action stream is most of what the fingerprint covers.
 */
import { buildRoster } from "./army";
import { runMatch } from "./battle_engine";

const games = Number(process.argv[2] ?? 10);
const offset = Number(process.argv[3] ?? 0);

let state = (0x2545f491 ^ Math.imul(offset, 2654435761)) >>> 0 || 1;
const rng = (): number => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
};

// FNV-1a over the decision stream. Deliberately includes the exact cells and targets: a change that
// alters ONE tie-break on ONE turn moves the hash.
let hash = 0x811c9dc5;
const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
};

const t0 = Date.now();
let actions = 0;
let laps = 0;
for (let i = 0; i < games; i += 1) {
    const seed = 900000 + offset + i;
    const roster = buildRoster(rng);
    const redRoster = buildRoster(rng);
    const result = runMatch({
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster,
        redRoster,
        seed,
        searchOfflineDeterministicWork: true,
    });
    mix(`${result.seed}|${result.winner}|${result.endReason}|${result.laps}|${result.totalActions}`);
    for (const side of ["green", "red"] as const) {
        const out = result.outcome[side];
        mix(`${side}:${out.version}:${out.unitsAlive}:${out.creaturesAlive}:${out.hpRemaining}`);
        for (const p of result.placements[side]) mix(`${p.creatureName}@${p.cell.x},${p.cell.y}x${p.amount}`);
    }
    for (const a of result.actions) {
        mix(
            `${a.index}${a.lap}${a.side}${a.creatureName}${a.actionType}${a.fromCell.x},${a.fromCell.y}` +
                `>${a.toCell?.x ?? "-"},${a.toCell?.y ?? "-"}|${a.targetCreature ?? "-"}|${a.completed ? 1 : 0}` +
                `|${a.damage ?? 0}|${a.impactDamage ?? 0}|${a.secondaryHits ?? 0}`,
        );
    }
    actions += result.totalActions;
    laps += result.laps;
}
const secs = (Date.now() - t0) / 1000;
console.log(
    `FINGERPRINT ${(hash >>> 0).toString(16).padStart(8, "0")} games=${games} ` +
        `actions=${actions} laps=${laps} secs=${secs.toFixed(2)} secsPerGame=${(secs / games).toFixed(3)}`,
);
