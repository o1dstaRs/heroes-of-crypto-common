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

import { TIER1_ARTIFACT_LIST, TIER2_ARTIFACT_LIST } from "../artifacts/artifact_properties";
import { getUpgradePoints } from "../perks/perk_properties";
import { DRAFT_ANCHOR_W, loadDraftWeights } from "../ai/setup/creature_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { SetupPolicyWeighted } from "../ai/setup/setup_policy_weighted";
import {
    buildRoster,
    makeRng,
    DEFAULT_ROSTER_COMPOSITION,
    DEFAULT_AMOUNT_BY_LEVEL,
    type IRosterComposition,
} from "./army";
import { runMatch, type IMatchResult, type ISetupAugment, type ISetupSynergy, type Side } from "./battle_engine";
import { creatureIdForName, draftRoster } from "./draft";

export interface ITournamentOptions {
    versionA: string;
    versionB: string;
    /** Total games to play. Played as mirrored pairs (each roster is fought twice with sides swapped). */
    games: number;
    /** Base seed; game i uses a seed derived from it, so a whole run reproduces from one number. */
    baseSeed: number;
    maxLaps?: number;
    composition?: readonly IRosterComposition[];
    amountByLevel?: Readonly<Record<number, number>>;
    /**
     * Off by default → both teams field the SAME roster (mirror match; isolates AI skill from luck).
     * On → each team gets its OWN randomly-picked roster (same composition/stack sizes, likely different
     * creatures), so matchups vary. Side/roster bias is still cancelled: each pair of games keeps the
     * two rosters fixed to their sides and swaps which version drives which side.
     */
    randomizePicks?: boolean;
    /**
     * Board layouts to sample from (GridVals: 1 NORMAL, 2 WATER_CENTER, 3 LAVA_CENTER, 4 BLOCK_CENTER).
     * Empty/undefined → every game is NORMAL (the historical default; keeps old baselines comparable). When
     * set, each PAIR draws one layout deterministically from the list (both games in the pair share it, so
     * map luck cancels alongside side/roster luck), letting map-specific tactics be measured.
     */
    mapTypes?: readonly number[];
    /**
     * When true, every team fields ONE random Tier-1 artifact (measure_artifacts.ts). Each mirrored pair
     * draws two DISTINCT artifacts (A,B) and swaps which side holds which between the pair's two games, so
     * side bias cancels and each artifact's aggregated win rate isolates the artifact's own contribution.
     * Pair with versionA === versionB (e.g. v0.5 vs v0.5) so the AI is not a confound.
     */
    artifactsT1?: boolean;
    /** Same as artifactsT1 but A/B-tests the Tier-2 artifact pool instead (measure_artifacts --tier 2). */
    artifactsT2?: boolean;
    /** A/B-test army augments: each team fields ONE stat augment (Armor/Might/Sniper/Movement × level 1-3 =
     * 12 options), paired side-swap like the artifact test. measure_setup.ts aggregates per augment. */
    augmentsAb?: boolean;
    /** A/B-test the two synergies of ONE faction (FactionVals: 1 CHAOS, 2 MIGHT, 3 NATURE, 4 LIFE). Both
     * teams field a faction-stacked army (so the synergy is active at a real level); each side picks a
     * different one of the faction's two synergies, swapped across the pair. */
    synergyFaction?: number;
    /** Strip the heavy per-game actions[]/placements from each record inside the worker before it's posted
     * back (measurement / RL only need aggregate win rates). Removes the worker→main structured-clone
     * bottleneck so the pool scales to all cores. Leave off when the full game log is needed (LLM analysis). */
    lightweight?: boolean;
    /** CEM setup-training self-play: one side drafts its perk + augments via the WEIGHTED setup policy
     * (env V05_SETUP_WEIGHTS), the other via the FROZEN heuristic; sides swap across the pair to cancel bias.
     * Everything else is mirrored, so the win rate isolates the learned perk+augment spend. The aggregator
     * reads greenIsWeighted + result.winner to get the weighted policy's win rate (the CEM fitness). */
    cemSetup?: boolean;
    /** CEM draft-training self-play: each side DRAFTS its roster (from a shared offered subset per level) via
     * a draft policy — one WEIGHTED (env V05_DRAFT_WEIGHTS), one FROZEN (the anchor heuristic) — sides swapped
     * across the pair. Unlike every other mode the two rosters DIFFER (that's the point), so the win rate
     * isolates which draft policy picks the better army. Same aggregator (greenIsWeighted + winner). */
    cemDraft?: boolean;
}

// Constructed once per worker process. The weighted policy reads its vector from the process env at
// construction, which the CEM injects (propagated to worker threads); the frozen one is the shipped anchor.
const CEM_WEIGHTED = new SetupPolicyWeighted();
const CEM_FROZEN = SETUP_POLICY_V0;

// Draft-policy vectors (11-dim, DRAFT_FEATURE_NAMES). Weighted reads V05_DRAFT_WEIGHTS at load; frozen anchor
// reproduces the scoreCreature heuristic exactly. Only used on the cemDraft path.
const CEM_DRAFT_WEIGHTED_W: readonly number[] = loadDraftWeights();
// Frozen opponent draft: DRAFT_ANCHOR_W by default; V05_DRAFT_FROZEN_WEIGHTS overrides it (used to A/B a
// candidate against a NON-anchor opponent, e.g. the current champion — exposes anti-anchor hard-counters).
const CEM_DRAFT_FROZEN_W: readonly number[] = (() => {
    const raw = process.env.V05_DRAFT_FROZEN_WEIGHTS;
    if (raw) {
        try {
            const p = JSON.parse(raw);
            if (
                Array.isArray(p) &&
                p.length === DRAFT_ANCHOR_W.length &&
                p.every((n) => typeof n === "number" && Number.isFinite(n))
            ) {
                return p;
            }
        } catch {
            /* malformed -> anchor */
        }
    }
    return DRAFT_ANCHOR_W;
})();

/** FactionVals id → catalog faction name (lowercased match in creaturesByLevel). Only the four synergy
 * factions are relevant here. */
const FACTION_NAME: Record<number, string> = { 1: "chaos", 2: "might", 3: "nature", 4: "life" };

/** The stat-augment options A/B-tested by augmentsAb (Placement is excluded — it only reshapes the placement
 * zone, irrelevant once units are already placed in the sim). Armor/Might/Sniper have levels 1-3, Movement
 * only 1-2 (no LEVEL_3) → 11 options. Label = "Kind:Level". */
const AUGMENT_AB_POOL: { kind: "Armor" | "Might" | "Sniper" | "Movement"; value: number; label: string }[] = (
    [
        { kind: "Armor", levels: [1, 2, 3] },
        { kind: "Might", levels: [1, 2, 3] },
        { kind: "Sniper", levels: [1, 2, 3] },
        { kind: "Movement", levels: [1, 2] },
    ] as const
).flatMap(({ kind, levels }) => levels.map((value) => ({ kind, value, label: `${kind}:${value}` })));

export interface IGameRecord {
    game: number;
    /** Which version played which side this game (sides swap every other game). */
    greenVersion: string;
    redVersion: string;
    winnerVersion: string | "draw";
    /** Artifact each side fielded (enum id; 0/undefined = none) — present only in the matching
     * `artifactsT1`/`artifactsT2` run, so a caller can aggregate per-artifact win rates from the records. */
    greenArtifactT1?: number;
    redArtifactT1?: number;
    greenArtifactT2?: number;
    redArtifactT2?: number;
    /** Augment label ("Kind:Level") each side fielded — present only in an `augmentsAb` run. */
    greenAugment?: string;
    redAugment?: string;
    /** Synergy label ("faction:synergyId") each side fielded — present only in a `synergyFaction` run. */
    greenSynergy?: string;
    redSynergy?: string;
    /** In a `cemSetup` run: whether GREEN drafted via the weighted (trained) policy this game (else FROZEN).
     * The CEM fitness is the weighted policy's win rate = games where the weighted side won. */
    greenIsWeighted?: boolean;
    result: IMatchResult;
}

export interface IVersionStats {
    version: string;
    wins: number;
    winsAsGreen: number;
    winsAsRed: number;
}

export interface ITournamentSummary {
    versionA: string;
    versionB: string;
    games: number;
    baseSeed: number;
    a: IVersionStats;
    b: IVersionStats;
    draws: number;
    /** Share of decisive games won by A (draws excluded). 0.5 = no improvement. */
    winRateA: number;
    avgLaps: number;
    endReasons: Record<string, number>;
    better: string | "tie";
    /** Games whose result leaned on armageddon attrition rather than a clean combat kill. */
    armageddonDecided: number;
    /** Fraction of games NOT decided by armageddon — higher is better (AI wins cleanly). */
    cleanWinRate: number;
}

const emptyStats = (version: string): IVersionStats => ({ version, wins: 0, winsAsGreen: 0, winsAsRed: 0 });

/**
 * Play a single game by its index. Fully self-contained — the seed (and thus the mirrored roster) and
 * the side assignment are derived from the index alone, so games can be run in ANY order or in
 * parallel across workers and still produce the same roster per index. Each mirrored pair (games 2k,
 * 2k+1) shares a roster+seed and swaps sides, cancelling green/red bias.
 */
export function playGame(options: ITournamentOptions, game: number): IGameRecord {
    const composition = options.composition ?? DEFAULT_ROSTER_COMPOSITION;
    const amountByLevel = options.amountByLevel ?? DEFAULT_AMOUNT_BY_LEVEL;

    const pairIndex = Math.floor(game / 2);
    const seed = (options.baseSeed + pairIndex * 0x9e3779b1) >>> 0;
    // Green roster from `seed`. When randomizing, red gets its own roster from a decorrelated seed;
    // both games in the pair reuse the same two rosters (fixed to their sides) so swapping versions
    // cancels side AND roster luck. Mirrored (default) → red roster === green roster.
    // Synergy A/B fields a faction-stacked army (so the faction's synergy is actually active) — build both
    // rosters filtered to that faction; otherwise the normal (all-faction) pool.
    const factionFilter = options.synergyFaction ? FACTION_NAME[options.synergyFaction] : undefined;
    let roster = buildRoster(makeRng(seed), composition, amountByLevel, factionFilter);
    let redRoster =
        options.randomizePicks && !factionFilter
            ? buildRoster(makeRng((seed ^ 0x85ebca6b) >>> 0), composition, amountByLevel)
            : undefined;

    // The board layout is drawn once per PAIR (decorrelated from the roster seed) so both games in the pair
    // share it — keeping the comparison apples-to-apples while still varying maps across pairs.
    const gridType = options.mapTypes?.length
        ? options.mapTypes[Math.floor(makeRng((seed ^ 0xc2b2ae35) >>> 0)() * options.mapTypes.length)]
        : undefined;

    const aIsGreen = game % 2 === 0;
    const greenVersion = aIsGreen ? options.versionA : options.versionB;
    const redVersion = aIsGreen ? options.versionB : options.versionA;

    // Optional artifact A/B test (either tier). The pair draws two DISTINCT artifacts (A,B) from a
    // decorrelated pair seed; game 2k gives green A / red B, game 2k+1 swaps them. Swapping across the pair
    // (which shares roster + combat seed) makes the two games identical except the artifacts trade sides, so
    // side bias cancels exactly and each artifact's aggregated win rate reflects the artifact alone.
    const abArtifact = (ids: number[], salt: number): [number | undefined, number | undefined] => {
        const artRng = makeRng((seed ^ salt) >>> 0);
        const a = ids[Math.floor(artRng() * ids.length)];
        let b = ids[Math.floor(artRng() * ids.length)];
        while (ids.length > 1 && b === a) {
            b = ids[Math.floor(artRng() * ids.length)];
        }
        const swap = game % 2 === 1;
        return swap ? [b, a] : [a, b];
    };

    let greenArtifactT1: number | undefined;
    let redArtifactT1: number | undefined;
    if (options.artifactsT1) {
        [greenArtifactT1, redArtifactT1] = abArtifact(
            TIER1_ARTIFACT_LIST.map((a) => a.id),
            0x27d4eb2f,
        );
    }
    let greenArtifactT2: number | undefined;
    let redArtifactT2: number | undefined;
    if (options.artifactsT2) {
        [greenArtifactT2, redArtifactT2] = abArtifact(
            TIER2_ARTIFACT_LIST.map((a) => a.id),
            0x165667b1,
        );
    }

    // Augment A/B: draw two DISTINCT augments from the 12-option pool and swap sides across the pair, exactly
    // like the artifact test. Budget defaults to 8 (NO_PERK) so any single level-1..3 augment fits.
    let greenAugments: ISetupAugment[] | undefined;
    let redAugments: ISetupAugment[] | undefined;
    let greenAugment: string | undefined;
    let redAugment: string | undefined;
    if (options.augmentsAb) {
        const artRng = makeRng((seed ^ 0x9e3779b9) >>> 0);
        const ai = Math.floor(artRng() * AUGMENT_AB_POOL.length);
        let bi = Math.floor(artRng() * AUGMENT_AB_POOL.length);
        while (AUGMENT_AB_POOL.length > 1 && bi === ai) {
            bi = Math.floor(artRng() * AUGMENT_AB_POOL.length);
        }
        const [gi, ri] = game % 2 === 1 ? [bi, ai] : [ai, bi];
        greenAugment = AUGMENT_AB_POOL[gi].label;
        redAugment = AUGMENT_AB_POOL[ri].label;
        greenAugments = [{ kind: AUGMENT_AB_POOL[gi].kind, value: AUGMENT_AB_POOL[gi].value }];
        redAugments = [{ kind: AUGMENT_AB_POOL[ri].kind, value: AUGMENT_AB_POOL[ri].value }];
    }

    // Synergy A/B: both sides field the faction; each picks a different one of the faction's two synergies
    // (ids 1 and 2), swapped across the pair. Level is composition-derived inside runMatch.
    let greenSynergies: ISetupSynergy[] | undefined;
    let redSynergies: ISetupSynergy[] | undefined;
    let greenSynergy: string | undefined;
    let redSynergy: string | undefined;
    if (options.synergyFaction) {
        const f = options.synergyFaction;
        const [gs, rs] = game % 2 === 1 ? [2, 1] : [1, 2];
        greenSynergy = `${FACTION_NAME[f]}:${gs}`;
        redSynergy = `${FACTION_NAME[f]}:${rs}`;
        greenSynergies = [{ faction: f, synergy: gs }];
        redSynergies = [{ faction: f, synergy: rs }];
    }

    // CEM setup training: derive perk + augments for each side from a policy — weighted (trained) vs frozen
    // (heuristic anchor), swapped across the pair. Everything else is mirrored, so the outcome isolates the
    // learned perk+augment spend. The perk sets the augment budget (getUpgradePoints).
    let greenPerk: number | undefined;
    let redPerk: number | undefined;
    let greenIsWeighted: boolean | undefined;
    if (options.cemDraft) {
        // Each side drafts from the SAME offered subsets (shared `seed`); weighted vs frozen policy, swapped
        // per pair. The two rosters differ, isolating draft-policy quality under identical fight AI.
        greenIsWeighted = game % 2 === 0;
        const greenW = greenIsWeighted ? CEM_DRAFT_WEIGHTED_W : CEM_DRAFT_FROZEN_W;
        const redW = greenIsWeighted ? CEM_DRAFT_FROZEN_W : CEM_DRAFT_WEIGHTED_W;
        roster = draftRoster(greenW, seed, composition, amountByLevel);
        redRoster = draftRoster(redW, seed, composition, amountByLevel);
        // Optionally activate SYNERGIES in draft self-play (CEM_DRAFT_SYNERGIES=1): each side gets the heuristic
        // best synergy per fielded faction (2+ units) from its OWN drafted roster — a fuller, more realistic
        // game so we can check whether the melee>ranged draft edge survives when synergies are live.
        if (process.env.CEM_DRAFT_SYNERGIES === "1") {
            greenSynergies = SETUP_POLICY_V0.pickSynergies(roster.map((u) => creatureIdForName(u.creatureName)));
            redSynergies = SETUP_POLICY_V0.pickSynergies(redRoster.map((u) => creatureIdForName(u.creatureName)));
        }
    }
    if (options.cemSetup) {
        const setupFor = (policy: typeof CEM_FROZEN) => {
            const perk = policy.pickPerk();
            return { perk, augments: policy.pickAugments(getUpgradePoints(perk)) };
        };
        const weighted = setupFor(CEM_WEIGHTED);
        const frozen = setupFor(CEM_FROZEN);
        greenIsWeighted = game % 2 === 0; // swap which side is the weighted policy across the pair
        const g = greenIsWeighted ? weighted : frozen;
        const r = greenIsWeighted ? frozen : weighted;
        greenPerk = g.perk;
        greenAugments = g.augments;
        redPerk = r.perk;
        redAugments = r.augments;
    }

    const result = runMatch({
        greenVersion,
        redVersion,
        roster,
        redRoster,
        seed,
        gridType,
        maxLaps: options.maxLaps,
        greenArtifactT1,
        redArtifactT1,
        greenArtifactT2,
        redArtifactT2,
        greenPerk,
        redPerk,
        greenAugments,
        redAugments,
        greenSynergies,
        redSynergies,
    });

    const winnerSide: Side | "draw" = result.winner;
    const winnerVersion = winnerSide === "draw" ? "draw" : winnerSide === "green" ? greenVersion : redVersion;
    return {
        game,
        greenVersion,
        redVersion,
        winnerVersion,
        greenArtifactT1,
        redArtifactT1,
        greenArtifactT2,
        redArtifactT2,
        greenAugment,
        redAugment,
        greenSynergy,
        redSynergy,
        greenIsWeighted,
        result,
    };
}

/** Running totals over games. Accumulation is order-independent, so parallel results merge cleanly. */
export interface ITournamentTally {
    a: IVersionStats;
    b: IVersionStats;
    draws: number;
    totalLaps: number;
    endReasons: Record<string, number>;
    armageddonDecided: number;
    counted: number;
}

export function createTally(options: ITournamentOptions): ITournamentTally {
    return {
        a: emptyStats(options.versionA),
        b: emptyStats(options.versionB),
        draws: 0,
        totalLaps: 0,
        endReasons: {},
        armageddonDecided: 0,
        counted: 0,
    };
}

export function tallyGame(tally: ITournamentTally, record: IGameRecord, options: ITournamentOptions): void {
    if (record.winnerVersion === "draw") {
        tally.draws += 1;
    } else {
        const stats = record.winnerVersion === options.versionA ? tally.a : tally.b;
        stats.wins += 1;
        if (record.result.winner === "green") {
            stats.winsAsGreen += 1;
        } else {
            stats.winsAsRed += 1;
        }
    }
    tally.totalLaps += record.result.laps;
    tally.endReasons[record.result.endReason] = (tally.endReasons[record.result.endReason] ?? 0) + 1;
    if (record.result.attrition.decidedByArmageddon) {
        tally.armageddonDecided += 1;
    }
    tally.counted += 1;
}

export function finalizeTally(tally: ITournamentTally, options: ITournamentOptions): ITournamentSummary {
    const decisive = tally.a.wins + tally.b.wins;
    return {
        versionA: options.versionA,
        versionB: options.versionB,
        games: options.games,
        baseSeed: options.baseSeed,
        a: tally.a,
        b: tally.b,
        draws: tally.draws,
        winRateA: decisive > 0 ? tally.a.wins / decisive : 0.5,
        avgLaps: tally.counted ? tally.totalLaps / tally.counted : 0,
        endReasons: tally.endReasons,
        better:
            tally.a.wins === tally.b.wins ? "tie" : tally.a.wins > tally.b.wins ? options.versionA : options.versionB,
        armageddonDecided: tally.armageddonDecided,
        cleanWinRate: tally.counted ? 1 - tally.armageddonDecided / tally.counted : 1,
    };
}

/**
 * Play `games` AI-vs-AI battles between two versions and tally who wins (sequentially, in this thread).
 * For large runs use runTournamentConcurrent (worker pool). `onGame` receives the full per-game record
 * (placements + every action) so a caller can stream them to a JSONL log for later LLM analysis.
 */
export function runTournament(options: ITournamentOptions, onGame?: (record: IGameRecord) => void): ITournamentSummary {
    const tally = createTally(options);
    for (let game = 0; game < options.games; game += 1) {
        const record = playGame(options, game);
        tallyGame(tally, record, options);
        onGame?.(record);
    }
    return finalizeTally(tally, options);
}
