/*
 * Headless faction-distribution census of the DEPLOYED ranked AI draft policy.
 *
 * Faithful to the server: at each PICK phase it calls the exact common functions the server's
 * draft_policy.ts wraps — pickCoherentDraftBundle (bundle) + pickDraftGenomeCreature (creature) — under
 * the deployed spec RANKED_VERSATILE_DRAFT_SPEC ("ranked-versatile-a19-v3", the default when
 * HOC_DRAFT_WEIGHTS is unset). The reveal-aware own/opponent context is taken from common's pick_sim state
 * exactly as pick_decider.ts does (teamState.creatures / teamState.tier1Artifact / getKnownOpponentCreatures).
 * No arango, no Pick document, no fights — pick_sim resolution only.
 *
 * Approximations (creature-neutral): perk is fixed to THREE_REVEALS for both seats (the deployed default
 * reveal setting; it only changes opponent-slot visibility) and Tier-2 is taken as the first legal offer
 * (does not affect which creatures are drafted).
 *
 * Usage: bun src/simulation/measure_ranked_draft_faction_distribution.ts [--drafts 5000] [--seed 86004710]
 */
import { parseArgs } from "node:util";

import { pickCoherentDraftBundle } from "../ai/setup/draft_coherence";
import { creatureInfo } from "../ai/setup/creature_score";
import {
    draftGenomeCreatureScore,
    parseDraftGenome,
    pickDraftGenomeCreature,
    RANKED_VERSATILE_DRAFT_SPEC,
} from "../ai/setup/draft_ship";
import { TIER1_ARTIFACT_WINRATE } from "../ai/setup/setup_strategy";
import { PBTypes } from "../generated/protobuf/v1/types";
import { Perk } from "../perks/perk_properties";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getVisibleCreatureChoices,
    isPickSimComplete,
    transitionPickSim,
    type IPickSimState,
    type PickRandomInt,
    type PickTeam,
} from "../picks/pick_sim";
import { creaturesByLevel, makeRng } from "./army";

const LOWER = PBTypes.TeamVals.LOWER;
const UPPER = PBTypes.TeamVals.UPPER;

const randomInt = (seed: number): PickRandomInt => {
    const rng = makeRng(seed);
    return (maxExclusive) => Math.floor(rng() * maxExclusive);
};

const creatureEnum = PBTypes.CreatureVals as unknown as Record<string, number>;
const idForName = (name: string): number => creatureEnum[name.toUpperCase().replace(/ /g, "_")] ?? 0;

// creatureId -> readable faction name, sourced from the same catalog the game ships.
const factionById = new Map<number, string>();
for (let level = 1; level <= 4; level += 1) {
    for (const entry of creaturesByLevel(level)) {
        factionById.set(idForName(entry.creatureName), entry.faction);
    }
}
const factionOf = (id: number): string => factionById.get(id) ?? `faction#${creatureInfo(id)?.faction ?? "?"}`;

const teamState = (state: IPickSimState, team: PickTeam) => (team === LOWER ? state.lower : state.upper);

const PERK_BY_NAME: Record<string, Perk> = {
    three_reveals: Perk.THREE_REVEALS,
    see_all: Perk.SEE_ALL,
    see_none: Perk.SEE_NONE,
};

/** One mirrored ranked draft through the deployed policy on both seats. Returns both 6-creature rosters. */
function draftRanked(seed: number, genome: ReturnType<typeof parseDraftGenome>, perk: Perk): number[][] {
    const rng = randomInt(seed);
    let state = createPickSimState(rng);

    const scoreCreature = (creatureId: number): number => draftGenomeCreatureScore(genome, creatureId);
    const artifactWinrate = (artifactId: number): number => TIER1_ARTIFACT_WINRATE[artifactId] ?? 50;
    const pickBundle = (team: PickTeam): number =>
        pickCoherentDraftBundle(teamState(state, team).bundles, scoreCreature, artifactWinrate);

    const apply = (action: Parameters<typeof transitionPickSim>[1]): void => {
        const result = transitionPickSim(state, action, rng);
        if (result.status === "rejected") throw new Error(`ranked policy ${action.type} rejected: ${result.reason}`);
        state = result.state;
    };

    // PERK (both) — reveal setting (deployed AI picks uniformly among the three; pass --perk to bound it).
    apply({ type: "select_perk", team: LOWER, perk });
    apply({ type: "select_perk", team: UPPER, perk });
    // INITIAL_PICK / bundle (both) — server bundle policy.
    apply({ type: "select_bundle", team: LOWER, bundleIndex: pickBundle(LOWER) });
    apply({ type: "select_bundle", team: UPPER, bundleIndex: pickBundle(UPPER) });

    let guard = 0;
    while (!isPickSimComplete(state)) {
        if ((guard += 1) > 60) throw new Error("ranked pick exceeded collision guard");
        const phase = getCurrentPickPhase(state);
        if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
            apply({ type: "select_tier2", team: LOWER, artifactId: teamState(state, LOWER).tier2Offers[0] });
            apply({ type: "select_tier2", team: UPPER, artifactId: teamState(state, UPPER).tier2Offers[0] });
            continue;
        }
        if (phase.phase !== PBTypes.PickPhaseVals.PICK || phase.actors.length !== 1) {
            throw new Error(`unexpected phase ${phase.phase}`);
        }
        const team = phase.actors[0];
        const ts = teamState(state, team);
        const creatureId = pickDraftGenomeCreature(
            genome,
            getVisibleCreatureChoices(state, team),
            ts.creatures,
            getKnownOpponentCreatures(state, team),
            ts.tier1Artifact,
        );
        if (creatureId === undefined) throw new Error("ranked policy returned no creature");
        // A collision reveals the taken creature and does NOT advance the phase; the next loop re-picks
        // from the updated visible set (mirrors pick_decider's in-tick re-pick).
        apply({ type: "pick_creature", team, creatureId });
    }
    return [[...state.lower.creatures], [...state.upper.creatures]];
}

function main(): void {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            drafts: { type: "string", default: "5000" },
            seed: { type: "string", default: "86004710" },
            perk: { type: "string", default: "three_reveals" },
        },
        strict: true,
    });
    const drafts = Number(values.drafts);
    const baseSeed = Number(values.seed);
    const perk = PERK_BY_NAME[values.perk.toLowerCase()] ?? Perk.THREE_REVEALS;

    const genome = parseDraftGenome(RANKED_VERSATILE_DRAFT_SPEC);

    const rosters: number[][] = [];
    for (let i = 0; i < drafts; i += 1) {
        const seed = (baseSeed + i * 0x9e3779b1) >>> 0;
        rosters.push(...draftRanked(seed, genome, perk));
    }

    const factionCreatureCounts: Record<string, number> = {};
    const factionLeadRosters: Record<string, number> = {}; // plurality faction of each roster
    const distinctFactionHistogram: Record<number, number> = {};
    let monoRosters = 0;
    let totalCreatures = 0;

    for (const roster of rosters) {
        const perRoster: Record<string, number> = {};
        for (const id of roster) {
            const f = factionOf(id);
            factionCreatureCounts[f] = (factionCreatureCounts[f] ?? 0) + 1;
            perRoster[f] = (perRoster[f] ?? 0) + 1;
            totalCreatures += 1;
        }
        const distinct = Object.keys(perRoster).length;
        distinctFactionHistogram[distinct] = (distinctFactionHistogram[distinct] ?? 0) + 1;
        if (distinct === 1) monoRosters += 1;
        const lead = Object.entries(perRoster).sort(([, a], [, b]) => b - a)[0][0];
        factionLeadRosters[lead] = (factionLeadRosters[lead] ?? 0) + 1;
    }

    const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(2)}%`;
    const report = {
        spec: RANKED_VERSATILE_DRAFT_SPEC,
        drafts,
        rosters: rosters.length,
        totalCreatures,
        monoFactionRosters: monoRosters,
        monoFactionRate: pct(monoRosters, rosters.length),
        distinctFactionsPerRoster: Object.fromEntries(
            Object.entries(distinctFactionHistogram)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([k, v]) => [`${k}_faction`, `${v} (${pct(v, rosters.length)})`]),
        ),
        creaturesByFaction: Object.fromEntries(
            Object.entries(factionCreatureCounts)
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) => [k, `${v} (${pct(v, totalCreatures)})`]),
        ),
        rostersByLeadFaction: Object.fromEntries(
            Object.entries(factionLeadRosters)
                .sort(([, a], [, b]) => b - a)
                .map(([k, v]) => [k, `${v} (${pct(v, rosters.length)})`]),
        ),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
