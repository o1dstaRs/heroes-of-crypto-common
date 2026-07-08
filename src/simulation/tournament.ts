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
import { Perk, getUpgradePoints } from "../perks/perk_properties";
import { creatureInfo, DEFAULT_DRAFT_W, DRAFT_ANCHOR_W, loadDraftWeights } from "../ai/setup/creature_score";
import { loadSynergyWeights, pickSynergiesSituational } from "../ai/setup/synergy_score";
import { SETUP_POLICY_V0 } from "../ai/setup/setup_v0";
import { SetupPolicyWeighted } from "../ai/setup/setup_policy_weighted";
import {
    buildRoster,
    makeRng,
    DEFAULT_ROSTER_COMPOSITION,
    DEFAULT_AMOUNT_BY_LEVEL,
    type IArmyUnitSpec,
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
    /** CEM composition+opponent-aware AUGMENT training: each side fields its OWN random roster (so opponent
     * composition varies and matters), the WEIGHTED side picks augments via the army-aware policy (env
     * V05_AUGCA_WEIGHTS, sees own+enemy comp), the FROZEN side via the blind heuristic; sides swap across the
     * pair. Win rate isolates whether composition/opponent-aware augment choice beats the blind default. */
    cemAugCA?: boolean;
    /** CEM VISION-GATED setup training: each side fields its OWN random roster; the WEIGHTED side jointly picks
     * PERK (buying vision at a budget cost) + AUGMENTS (counter-picking only the VISIBLE fraction of the enemy
     * army) via the setupCA policy (env V05_SETUPCA_WEIGHTS); FROZEN side uses the blind heuristic. Tests whether
     * paying for opponent vision to counter-augment beats the max-budget/no-vision default. */
    cemSetupCA?: boolean;
    /** CEM SITUATIONAL-SYNERGY training: each side fields its OWN random roster; the WEIGHTED side picks synergies
     * via the situational picker (env V05_SYNERGY_WEIGHTS — scores each synergy by how much of the army benefits),
     * the FROZEN side via the fixed BEST_SYNERGY_BY_FACTION table; swap per pair. Win rate isolates whether
     * situational synergy choice (e.g. +Fly-Armor only with enough flyers) beats the fixed table. */
    cemSynergy?: boolean;
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

// Composition + OPPONENT-aware augment policy (trained via cemAugCA). Scores each augment kind by its base
// value + a weight vector over features of the OWN and ENEMY army composition — so a ranged army can learn to
// buy Sniper, and an army facing ranged can learn to buy Armor. 20 weights = 4 kinds x 5 features; w=0 (anchor)
// reproduces the value-only greedy ({Armor,Might}). Injected via env V05_AUGCA_WEIGHTS by the trainer.
const AUGCA_KINDS = ["Armor", "Might", "Sniper", "Movement"] as const;
const AUGCA_BASE: Record<(typeof AUGCA_KINDS)[number], number> = { Armor: 19, Might: 15, Sniper: 7, Movement: -5 };
const AUGCA_MAXLVL: Record<(typeof AUGCA_KINDS)[number], number> = { Armor: 3, Might: 3, Sniper: 3, Movement: 2 };
const AUGCA_NFEAT = 5;
const AUGCA_WEIGHTS: number[] = (() => {
    const raw = process.env.V05_AUGCA_WEIGHTS;
    if (raw) {
        try {
            const p = JSON.parse(raw);
            if (
                Array.isArray(p) &&
                p.length === AUGCA_KINDS.length * AUGCA_NFEAT &&
                p.every((n) => Number.isFinite(n))
            ) {
                return p;
            }
        } catch {
            /* malformed -> anchor */
        }
    }
    return new Array(AUGCA_KINDS.length * AUGCA_NFEAT).fill(0);
})();
const rangedFracOf = (r: readonly IArmyUnitSpec[]): number =>
    r.filter((u) => creatureInfo(creatureIdForName(u.creatureName))?.ranged).length / Math.max(1, r.length);
/** Features seen when choosing augments: [ownRanged, ownAvgLevel/4, enemyRanged, enemyMelee, bias]. With
 * AUGCA_NOVISION=1 the two ENEMY features are zeroed — modelling the live SEE_NONE reality (no enemy vision at
 * augment time), so a CEM run learns an OWN-COMPOSITION-only policy that is actually realizable in ranked
 * (the full 20-dim champion's enemy-counter-pick edge needs paid vision the setupCA verdict rejected). */
const augCAFeats = (own: readonly IArmyUnitSpec[], enemy: readonly IArmyUnitSpec[]): number[] => {
    const noVision = process.env.AUGCA_NOVISION === "1";
    const eR = noVision ? 0 : rangedFracOf(enemy);
    const eM = noVision ? 0 : 1 - rangedFracOf(enemy);
    return [rangedFracOf(own), own.reduce((s, u) => s + u.level, 0) / Math.max(1, own.length) / 4, eR, eM, 1];
};
const augCA = (
    own: readonly IArmyUnitSpec[],
    enemy: readonly IArmyUnitSpec[],
    budget: number,
    w: number[],
): ISetupAugment[] => {
    const f = augCAFeats(own, enemy);
    const scored = AUGCA_KINDS.map((kind, ki) => {
        let v = AUGCA_BASE[kind];
        for (let j = 0; j < AUGCA_NFEAT; j += 1) {
            v += w[ki * AUGCA_NFEAT + j] * f[j];
        }
        return { kind, v };
    })
        .filter((c) => c.v >= 10)
        .sort((a, b) => b.v - a.v);
    const out: ISetupAugment[] = [];
    let rem = Math.max(0, Math.floor(budget));
    for (const c of scored) {
        const lvl = Math.min(AUGCA_MAXLVL[c.kind], rem);
        if (lvl >= 1) {
            out.push({ kind: c.kind, value: lvl });
            rem -= lvl;
        }
    }
    return out;
};

// VISION-GATED composition+opponent-aware SETUP policy (cemSetupCA). The perk buys VISION at a budget cost
// (SEE_NONE 7pts/no vision, THREE_REVEALS 6pts/half vision, SEE_ALL 5pts/full vision); only the VISIBLE fraction
// of the ENEMY composition can be used to counter-pick augments. 23 weights = [0..2] vision-value (bias, ownRanged,
// ownAvgLvl) + [3..22] augment scorer (4 kinds x 5 feats). w=0 -> SEE_NONE + blind augments (shipped heuristic).
// Env V05_SETUPCA_WEIGHTS.
const SETUPCA_PERKS: { perk: Perk; budget: number; vision: number }[] = [
    { perk: Perk.SEE_NONE, budget: 7, vision: 0 },
    { perk: Perk.THREE_REVEALS, budget: 6, vision: 0.5 },
    { perk: Perk.SEE_ALL, budget: 5, vision: 1 },
];
const SETUPCA_DIM = 3 + AUGCA_KINDS.length * AUGCA_NFEAT; // 23
const SETUPCA_WEIGHTS: number[] = (() => {
    const raw = process.env.V05_SETUPCA_WEIGHTS;
    if (raw) {
        try {
            const p = JSON.parse(raw);
            if (Array.isArray(p) && p.length === SETUPCA_DIM && p.every((n) => Number.isFinite(n))) {
                return p;
            }
        } catch {
            /* malformed -> anchor */
        }
    }
    return new Array(SETUPCA_DIM).fill(0);
})();
const setupCA = (
    own: readonly IArmyUnitSpec[],
    enemy: readonly IArmyUnitSpec[],
    w: number[],
): { perk: Perk; augments: ISetupAugment[] } => {
    const ownR = rangedFracOf(own);
    const ownLvl = own.reduce((s, u) => s + u.level, 0) / Math.max(1, own.length) / 4;
    // Vision value depends on OWN army (known when choosing the perk). Perk maximises budget + vision*value.
    const visionValue = w[0] + w[1] * ownR + w[2] * ownLvl;
    let best = SETUPCA_PERKS[0];
    let bestS = -Infinity;
    for (const p of SETUPCA_PERKS) {
        const s = p.budget + p.vision * visionValue;
        if (s > bestS) {
            bestS = s;
            best = p;
        }
    }
    // Augments: enemy features are scaled by the chosen perk's VISION (0 = blind, 1 = full sight).
    const eR = rangedFracOf(enemy);
    const f = [ownR, ownLvl, best.vision * eR, best.vision * (1 - eR), 1];
    const aw = w.slice(3);
    const scored = AUGCA_KINDS.map((kind, ki) => {
        let v = AUGCA_BASE[kind];
        for (let j = 0; j < AUGCA_NFEAT; j += 1) {
            v += aw[ki * AUGCA_NFEAT + j] * f[j];
        }
        return { kind, v };
    })
        .filter((c) => c.v >= 10)
        .sort((a, b) => b.v - a.v);
    const augments: ISetupAugment[] = [];
    let rem = best.budget;
    for (const c of scored) {
        const lvl = Math.min(AUGCA_MAXLVL[c.kind], rem);
        if (lvl >= 1) {
            augments.push({ kind: c.kind, value: lvl });
            rem -= lvl;
        }
    }
    return { perk: best.perk, augments };
};

// Situational synergy weights (16-dim). Weighted reads V05_SYNERGY_WEIGHTS at load; anchor reproduces the fixed
// BEST_SYNERGY_BY_FACTION table. Only used on the cemSynergy path.
const SYNERGY_WEIGHTS: number[] = loadSynergyWeights();

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

    // FIGHT-ON-DEPLOYMENT-DISTRIBUTION mode (env FIGHT_MELEE_ROSTERS=1): both sides field the MELEE-drafted
    // armies our baked draft (DEFAULT_DRAFT_W) actually produces in live play, instead of random/mirrored rosters.
    // The fight champion was trained on random rosters; this lets a fight CEM (cem.mjs OPT=v0.6 vs BASE) retrain
    // it on the distribution we truly deploy. Decorrelated per-side offer seeds → two distinct melee armies (like
    // randomizePicks but drafted). Only active with the flag; default tournaments are untouched.
    const meleeFrac = Number(process.env.FIGHT_MELEE_ROSTERS);
    if (meleeFrac > 0 && !factionFilter) {
        // Fraction of games (deterministic per pair) that field melee-drafted armies; the rest keep the
        // random/mirrored rosters above. =1 → ALL melee, which overfits a melee-specialist that regresses ~4.6pp
        // on varied armies (measured); a MIX (e.g. 0.5) keeps the fight vector ROBUST across the opponent
        // compositions live play actually faces, so a CEM can only bake a gain that survives on BOTH.
        const useMelee = meleeFrac >= 1 || makeRng((seed ^ 0x1b873593) >>> 0)() < meleeFrac;
        if (useMelee) {
            roster = draftRoster(DEFAULT_DRAFT_W, seed, composition, amountByLevel);
            redRoster = draftRoster(DEFAULT_DRAFT_W, (seed ^ 0x85ebca6b) >>> 0, composition, amountByLevel);
        }
    }

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
        // UNIT-SPLITTING (CEM_DRAFT_SPLIT=1): model extra placement slots (Placement augment / Nature synergy) by
        // splitting a RANGED-heavy army's stacks into more, smaller stacks — more shooters landing shots before
        // melee contact. Small stacks (< 4) aren't split. Tests whether splitting is the lever that saves ranged.
        if (process.env.CEM_DRAFT_SPLIT === "1") {
            const rFrac = (r: typeof roster): number =>
                r.filter((u) => creatureInfo(creatureIdForName(u.creatureName))?.ranged).length / Math.max(1, r.length);
            const split = (r: typeof roster): typeof roster =>
                rFrac(r) < 0.4
                    ? r
                    : r.flatMap((u) =>
                          u.amount >= 4
                              ? [
                                    { ...u, amount: Math.ceil(u.amount / 2) },
                                    { ...u, amount: Math.floor(u.amount / 2) },
                                ]
                              : [u],
                      );
            roster = split(roster);
            redRoster = split(redRoster);
        }
        // SPLIT-MELEE A/B (CEM_DRAFT_SPLIT_MELEE=1): split ONLY the WEIGHTED side's stacks (any composition incl.
        // melee) regardless of rangedFrac — models the extra placement slots (Nature Increase-Board-Units /
        // placement augments) applied to our MELEE deployment. With weighted==frozen draft weights both sides field
        // the SAME army, so this isolates whether splitting a melee army into more/smaller stacks beats single-stack.
        if (process.env.CEM_DRAFT_SPLIT_MELEE === "1") {
            const splitAll = (r: typeof roster): typeof roster =>
                r.flatMap((u) =>
                    u.amount >= 4
                        ? [
                              { ...u, amount: Math.ceil(u.amount / 2) },
                              { ...u, amount: Math.floor(u.amount / 2) },
                          ]
                        : [u],
                );
            if (greenIsWeighted) roster = splitAll(roster);
            else redRoster = splitAll(redRoster);
        }
        // Optionally activate SYNERGIES in draft self-play (CEM_DRAFT_SYNERGIES=1): each side gets the heuristic
        // best synergy per fielded faction (2+ units) from its OWN drafted roster — a fuller, more realistic
        // game so we can check whether the melee>ranged draft edge survives when synergies are live.
        if (process.env.CEM_DRAFT_SYNERGIES === "1") {
            greenSynergies = SETUP_POLICY_V0.pickSynergies(roster.map((u) => creatureIdForName(u.creatureName)));
            redSynergies = SETUP_POLICY_V0.pickSynergies(redRoster.map((u) => creatureIdForName(u.creatureName)));
        }
        // Apply setup augments to BOTH sides. "1" = composition-BLIND shipped setup (buys Armor/Might + 1 Sniper
        // regardless of army). "2" = composition-AWARE: a ranged-heavy army leads with SNIPER-max, a melee army
        // with Armor/Might — the fair test of whether ranged competes when it gets its actual toolkit.
        if (process.env.CEM_DRAFT_AUGMENTS === "1") {
            const gp = CEM_WEIGHTED.pickPerk();
            greenPerk = gp;
            greenAugments = CEM_WEIGHTED.pickAugments(getUpgradePoints(gp));
            const rp = CEM_WEIGHTED.pickPerk();
            redPerk = rp;
            redAugments = CEM_WEIGHTED.pickAugments(getUpgradePoints(rp));
        } else if (process.env.CEM_DRAFT_AUGMENTS === "2") {
            const rangedFrac = (r: typeof roster): number =>
                r.filter((u) => creatureInfo(creatureIdForName(u.creatureName))?.ranged).length / Math.max(1, r.length);
            // budget 7 (SEE_NONE): ranged → Sniper3+Armor3+Might1; melee → Armor3+Might3+Sniper1.
            const augFor = (r: typeof roster): ISetupAugment[] =>
                rangedFrac(r) >= 0.4
                    ? [
                          { kind: "Sniper", value: 3 },
                          { kind: "Armor", value: 3 },
                          { kind: "Might", value: 1 },
                      ]
                    : [
                          { kind: "Armor", value: 3 },
                          { kind: "Might", value: 3 },
                          { kind: "Sniper", value: 1 },
                      ];
            greenPerk = Perk.SEE_NONE;
            greenAugments = augFor(roster);
            redPerk = Perk.SEE_NONE;
            redAugments = augFor(redRoster);
        }
    }
    if (options.cemAugCA) {
        // Both sides field their OWN random roster (opponent comp varies); weighted side picks augments via the
        // composition+opponent-aware policy, frozen side via the blind heuristic; swap which is weighted per pair.
        redRoster = buildRoster(makeRng((seed ^ 0x85ebca6b) >>> 0), composition, amountByLevel);
        greenIsWeighted = game % 2 === 0;
        const budget = getUpgradePoints(Perk.SEE_NONE);
        greenPerk = Perk.SEE_NONE;
        redPerk = Perk.SEE_NONE;
        greenAugments = greenIsWeighted
            ? augCA(roster, redRoster, budget, AUGCA_WEIGHTS)
            : CEM_FROZEN.pickAugments(budget);
        redAugments = greenIsWeighted
            ? CEM_FROZEN.pickAugments(budget)
            : augCA(redRoster, roster, budget, AUGCA_WEIGHTS);
    }
    if (options.cemSetupCA) {
        // Vision-gated joint perk+augment CA vs the blind heuristic; each side its own random roster, swap per pair.
        redRoster = buildRoster(makeRng((seed ^ 0x85ebca6b) >>> 0), composition, amountByLevel);
        greenIsWeighted = game % 2 === 0;
        const frozen = () => {
            const p = CEM_FROZEN.pickPerk();
            return { perk: p, augments: CEM_FROZEN.pickAugments(getUpgradePoints(p)) };
        };
        const g = greenIsWeighted ? setupCA(roster, redRoster, SETUPCA_WEIGHTS) : frozen();
        const r = greenIsWeighted ? frozen() : setupCA(redRoster, roster, SETUPCA_WEIGHTS);
        greenPerk = g.perk;
        greenAugments = g.augments;
        redPerk = r.perk;
        redAugments = r.augments;
    }
    if (options.cemSynergy) {
        // Field FACTION-CONCENTRATED armies (rotating faction per pair via the seed) so the synergy is reliably
        // active at a real level and the situational choice (which of the faction's two synergies) matters every
        // game — otherwise random mixed armies rarely field 2+ of a faction and the signal is diluted. Both sides
        // same faction; weighted picks situationally, frozen via the fixed table; swap per pair.
        const synFacNames = ["chaos", "might", "nature", "life"];
        const synFac = synFacNames[Math.floor(makeRng((seed ^ 0x51ed270b) >>> 0)() * synFacNames.length)];
        roster = buildRoster(makeRng(seed), composition, amountByLevel, synFac);
        redRoster = buildRoster(makeRng((seed ^ 0x85ebca6b) >>> 0), composition, amountByLevel, synFac);
        greenIsWeighted = game % 2 === 0;
        const gIds = roster.map((u) => creatureIdForName(u.creatureName));
        const rIds = redRoster.map((u) => creatureIdForName(u.creatureName));
        greenSynergies = greenIsWeighted
            ? pickSynergiesSituational(gIds, SYNERGY_WEIGHTS)
            : SETUP_POLICY_V0.pickSynergies(gIds);
        redSynergies = greenIsWeighted
            ? SETUP_POLICY_V0.pickSynergies(rIds)
            : pickSynergiesSituational(rIds, SYNERGY_WEIGHTS);
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
