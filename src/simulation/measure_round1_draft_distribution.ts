/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { LEAGUE_ROUND1_DRAFT_SPEC, parseDraftGenome, projectDraftGenomeForShipping } from "../ai/setup/draft_ship";
import { creatureInfo, DEFAULT_DRAFT_W } from "../ai/setup/creature_score";
import CREATURES_JSON from "../configuration/creatures.json";
import { PBTypes } from "../generated/protobuf/v1/types";
import { DEFAULT_AMOUNT_BY_LEVEL, DEFAULT_ROSTER_COMPOSITION } from "./army";
import { DEFAULT_OFFER_K, draftRoster } from "./draft";
import { resolveLeaguePick } from "./league_eval";

/**
 * DISTRIBUTION-SHIFT CENSUS, PART 1 — what does the round-1 draft (server 8823670,
 * HOC_DRAFT_WEIGHTS=league-r1-br-57de5a2d, deployment pending) actually field, compared to the
 * ~97%-melee heuristic-drafted armies the W2-era misplay census was measured under?
 *
 * Two independently-generated distributions, same composition (2x L1 + 2x L2 + 1x L3 + 1x L4) and same
 * accounting, so the fractions are directly comparable:
 *   - "round1": the real live pick reducer (common/picks/pick_sim) driven by the round-1 genome on BOTH
 *     seats (mirrored), exactly the construction the draft-ship acceptance harness measures wins with
 *     (projectDraftGenomeForShipping resets every non-intrinsic head to the setup-v0 anchor, matching
 *     what the ranked server's draft_policy.ts actually consumes: only the composition-blind creature
 *     score + the live TIER1_ARTIFACT_WINRATE table for bundle choice).
 *   - "heuristic": misplay_audit.ts's own OLD roster construction — draftRoster(DEFAULT_DRAFT_W, ...)
 *     over DEFAULT_ROSTER_COMPOSITION, byte-identical seeding to playMisplayAuditGame (seed and
 *     seed^0x85ebca6b for the two sides) so this reproduces exactly what the W2 census fielded.
 *
 * No fight is simulated here — pick_sim resolution only, so this is fast even at large sample sizes.
 *
 * Usage: bun src/simulation/measure_round1_draft_distribution.ts [--drafts 2000] [--seed 86004710]
 *   [--output sim-out/round1_draft_distribution.json]
 */

interface ICompositionRow {
    creatures: number;
    ranged: number;
    flyer: number;
    caster: number;
    melee: number;
    attackType: Record<string, number>;
}

interface ILevelRow extends ICompositionRow {
    level: number;
    topCreatures: { name: string; count: number; share: number }[];
}

interface IDistributionReport {
    label: string;
    drafts: number;
    rosters: number;
    creatureSlots: number;
    overall: ICompositionRow & { topCreatures: { name: string; count: number; share: number }[] };
    byLevel: ILevelRow[];
}

// --- caster classification -------------------------------------------------
// creature_score.ts's ICreatureInfo does not expose the raw attack_type string (only derived `ranged`
// and `melee` booleans), so build a tiny local id -> attack_type index from the same source JSON, exactly
// mirroring creature_score.ts's own buildIndex (enum key = NAME_UPPER_SNAKE). Self-contained: this script
// does not modify creature_score.ts or any shared production module.
const CreatureJsonShape = CREATURES_JSON as unknown as Record<string, Record<string, { attack_type?: string }>>;
const buildAttackTypeIndex = (): Map<number, string> => {
    const idByEnumKey = PBTypes.CreatureVals as unknown as Record<string, number>;
    const index = new Map<number, string>();
    for (const [, creatures] of Object.entries(CreatureJsonShape)) {
        if (!creatures || typeof creatures !== "object") continue;
        for (const [name, cfg] of Object.entries(creatures)) {
            if (!cfg || typeof cfg !== "object") continue;
            const enumKey = name.toUpperCase().replace(/ /g, "_");
            const id = idByEnumKey[enumKey];
            if (typeof id !== "number" || id <= 0) continue;
            index.set(id, cfg.attack_type ?? "UNKNOWN");
        }
    }
    return index;
};
const attackTypeById = buildAttackTypeIndex();
const isCaster = (creatureId: number): boolean => {
    const attackType = attackTypeById.get(creatureId);
    return attackType === "MAGIC" || attackType === "MELEE_MAGIC";
};

// --- accumulation ------------------------------------------------------------
class Accumulator {
    public creatures = 0;
    public rangedCount = 0;
    public flyerCount = 0;
    public casterCount = 0;
    public meleeCount = 0;
    public attackType: Record<string, number> = {};
    public names: Record<string, number> = {};
    public add(creatureId: number): void {
        const info = creatureInfo(creatureId);
        if (!info) throw new Error(`Unknown creature id ${creatureId} in drafted roster`);
        this.creatures += 1;
        if (info.ranged) this.rangedCount += 1;
        if (info.canFly) this.flyerCount += 1;
        if (isCaster(creatureId)) this.casterCount += 1;
        if (info.melee) this.meleeCount += 1;
        const attackType = attackTypeById.get(creatureId) ?? "UNKNOWN";
        this.attackType[attackType] = (this.attackType[attackType] ?? 0) + 1;
        this.names[info.name] = (this.names[info.name] ?? 0) + 1;
    }
    public topCreatures(limit = 20): { name: string; count: number; share: number }[] {
        return Object.entries(this.names)
            .sort(([, a], [, b]) => b - a)
            .slice(0, limit)
            .map(([name, count]) => ({ name, count, share: this.creatures ? count / this.creatures : 0 }));
    }
    public row(): ICompositionRow {
        const n = this.creatures || 1;
        return {
            creatures: this.creatures,
            ranged: this.rangedCount / n,
            flyer: this.flyerCount / n,
            caster: this.casterCount / n,
            melee: this.meleeCount / n,
            attackType: Object.fromEntries(
                Object.entries(this.attackType)
                    .sort(([, a], [, b]) => b - a)
                    .map(([key, count]) => [key, count / n]),
            ),
        };
    }
}

function summarize(label: string, drafts: number, rosters: number[][]): IDistributionReport {
    const overall = new Accumulator();
    const byLevel = new Map<number, Accumulator>();
    for (const roster of rosters) {
        for (const creatureId of roster) {
            const info = creatureInfo(creatureId);
            if (!info) throw new Error(`Unknown creature id ${creatureId}`);
            overall.add(creatureId);
            const levelAcc = byLevel.get(info.level) ?? new Accumulator();
            levelAcc.add(creatureId);
            byLevel.set(info.level, levelAcc);
        }
    }
    return {
        label,
        drafts,
        rosters: rosters.length,
        creatureSlots: overall.creatures,
        overall: { ...overall.row(), topCreatures: overall.topCreatures(20) },
        byLevel: [...byLevel.entries()]
            .sort(([a], [b]) => a - b)
            .map(([level, acc]) => ({ level, ...acc.row(), topCreatures: acc.topCreatures(10) })),
    };
}

/** Mirrored round-1-vs-round-1 pick_sim drafts through the exact live reducer. */
function round1Rosters(drafts: number, baseSeed: number): number[][] {
    const genome = projectDraftGenomeForShipping(parseDraftGenome(LEAGUE_ROUND1_DRAFT_SPEC));
    const rosters: number[][] = [];
    for (let i = 0; i < drafts; i += 1) {
        const seed = (baseSeed + i * 0x9e3779b1) >>> 0;
        const pick = resolveLeaguePick(seed, genome, genome, true);
        rosters.push([...pick.state.lower.creatures]);
        rosters.push([...pick.state.upper.creatures]);
    }
    return rosters;
}

/** misplay_audit.ts's OLD heuristic roster construction, byte-identical seeding to playMisplayAuditGame. */
function heuristicRosters(drafts: number, baseSeed: number): number[][] {
    const creatureEnum = PBTypes.CreatureVals as unknown as Record<string, number>;
    const idForName = (name: string): number => creatureEnum[name.toUpperCase().replace(/ /g, "_")] ?? 0;
    const rosters: number[][] = [];
    for (let i = 0; i < drafts; i += 1) {
        const seed = (baseSeed + i * 0x9e3779b1) >>> 0;
        const green = draftRoster(
            DEFAULT_DRAFT_W,
            seed,
            DEFAULT_ROSTER_COMPOSITION,
            DEFAULT_AMOUNT_BY_LEVEL,
            DEFAULT_OFFER_K,
            "expBudget",
        );
        const red = draftRoster(
            DEFAULT_DRAFT_W,
            (seed ^ 0x85ebca6b) >>> 0,
            DEFAULT_ROSTER_COMPOSITION,
            DEFAULT_AMOUNT_BY_LEVEL,
            DEFAULT_OFFER_K,
            "expBudget",
        );
        rosters.push(green.map((u) => idForName(u.creatureName)));
        rosters.push(red.map((u) => idForName(u.creatureName)));
    }
    return rosters;
}

function positiveInteger(value: string, flag: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
        throw new Error(`${flag} must be a positive integer; got ${value}`);
    return parsed;
}

export async function main(): Promise<void> {
    const { values } = parseArgs({
        args: process.argv.slice(2),
        options: {
            drafts: { type: "string", default: "2000" },
            seed: { type: "string", default: "86004710" },
            output: { type: "string" },
        },
        strict: true,
        allowPositionals: false,
    });
    const drafts = positiveInteger(values.drafts, "--drafts");
    const baseSeed = Number(values.seed);
    if (!Number.isSafeInteger(baseSeed) || baseSeed < 0 || baseSeed > 0xffffffff) {
        throw new Error(`--seed must be an integer in [0, 2^32-1]; got ${values.seed}`);
    }

    console.error(`round1 pick_sim drafts: ${drafts} mirrored boards (seed ${baseSeed})...`);
    const round1 = summarize(
        "round1 (br-57de5a2dab8b27b5, pick_sim, mirrored)",
        drafts,
        round1Rosters(drafts, baseSeed),
    );
    console.error(
        `heuristic drafts: ${drafts} boards, byte-identical seeding to misplay_audit.ts (seed ${baseSeed})...`,
    );
    const heuristic = summarize(
        "heuristic (DEFAULT_DRAFT_W, draftRoster, W2-era construction)",
        drafts,
        heuristicRosters(drafts, baseSeed),
    );

    const report = {
        schemaVersion: 1,
        status: "distribution_census",
        baseSeed,
        drafts,
        composition: DEFAULT_ROSTER_COMPOSITION,
        round1,
        heuristic,
        limitations: [
            "round1 uses projectDraftGenomeForShipping, which is what the ranked server's draft_policy.ts actually consumes for creature-pick decisions (composition-blind score + live TIER1_ARTIFACT_WINRATE for bundle choice); non-draft heads (artifact tier2/augments/placement/perk) are the setup-v0 anchor here and are governed by separate live logic (CONDITIONAL_SETUP_V1/setup-v0) not exercised by this script.",
            "heuristic reproduces misplay_audit.ts's OLD non-pick_sim roster construction exactly (draftRoster over DEFAULT_ROSTER_COMPOSITION with DEFAULT_DRAFT_W) so the two distributions are comparable under identical accounting; it is not itself a pick_sim draft and never fields artifacts.",
            "'caster' and 'melee' overlap for MELEE_MAGIC creatures (Angel/Harpy/Valkyrie/Troll/Ogre Mage/Behemoth) by construction; the attackType breakdown is the mutually-exclusive view.",
            "This script drafts only; it runs no fights and says nothing about win rates or AI decision quality (see measure_round1_misplay_census.ts for that).",
        ],
    };

    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (values.output) {
        const outputPath = resolve(values.output);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.error(`Summary: ${outputPath}`);
    } else {
        process.stdout.write(json);
    }

    const fmt = (x: number): string => `${(x * 100).toFixed(1)}%`;
    console.error(
        `round1:    ranged ${fmt(round1.overall.ranged)} flyer ${fmt(round1.overall.flyer)} caster ${fmt(round1.overall.caster)} melee ${fmt(round1.overall.melee)}`,
    );
    console.error(
        `heuristic: ranged ${fmt(heuristic.overall.ranged)} flyer ${fmt(heuristic.overall.flyer)} caster ${fmt(heuristic.overall.caster)} melee ${fmt(heuristic.overall.melee)}`,
    );
}

if ((import.meta as unknown as { main?: boolean }).main) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
