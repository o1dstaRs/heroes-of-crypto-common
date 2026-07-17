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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    createLeagueGenome,
    createMeleeLeagueGenome,
    LEAGUE_ANCHOR_GENOME,
    LEAGUE_GENOME_DIM,
    LEAGUE_GENOME_LAYOUT,
    LEAGUE_SCHEMA_VERSION,
    scoreLeagueCreature,
    type ILeagueGenome,
} from "../../simulation/league_genome";
import { DRAFT_FEATURE_DIM } from "./creature_score";
import leagueRound1CandidateGenome from "./draft_genomes/league_round1_br_57de5a2d_candidate.json";
import leagueRound3ProjectedGenome from "./draft_genomes/league_round3_br_52752642_projected.json";
import v07NonfightDraftGenome from "./draft_genomes/v07_nonfight_draft_48d23ac4461_projected.json";

/**
 * DRAFT SHIP-PATH: turn a config/env value into the deployable draft genome the ranked server consumes.
 *
 * This is the consumption seam for whatever the league training produces — a champion ships by flipping
 * config (HOC_DRAFT_WEIGHTS on the server), never by editing policy code. Node-only (reads files); the
 * browser bundle must not import this module, so it is deliberately NOT re-exported from the package index.
 */

/** Server env var carrying the draft genome spec (see parseDraftGenome for the accepted forms). */
export const DRAFT_GENOME_ENV = "HOC_DRAFT_WEIGHTS";

/** Fresh v0.7-accepted, projected League round-1 candidate. Preferred stable opt-in name. */
export const LEAGUE_ROUND1_DRAFT_SPEC = "league-r1-br-57de5a2d";

/** Pre-acceptance research name retained so frozen jobs keep resolving to the same immutable weights. */
export const LEAGUE_ROUND1_DRAFT_CANDIDATE_SPEC = "league-r1-br-57de5a2d-candidate";

/** Fresh v0.7-accepted, projected League round-3 candidate. Explicit opt-in; not the fallback default. */
export const LEAGUE_ROUND3_DRAFT_SPEC = "league-r3-br-52752642";

/** Fresh overnight non-fight candidate. Explicit opt-in; not the fallback default. */
export const V07_NONFIGHT_DRAFT_SPEC = "v07-nonfight-draft-48d23ac4461";

/**
 * Embed either the legacy 11-weight creature score or the full 15-weight intrinsic draft head into the league
 * anchor. With the legacy shape, the four extra intrinsic features stay at the anchor's zeros. Counter-draft
 * interactions and every setup head always keep the measured-table anchor values.
 */
export function embedIntrinsicDraftWeights(intrinsic: readonly number[]): number[] {
    const fullIntrinsicDimension = LEAGUE_GENOME_LAYOUT.draftIntrinsic.length;
    if (intrinsic.length !== DRAFT_FEATURE_DIM && intrinsic.length !== fullIntrinsicDimension) {
        throw new RangeError(
            `Intrinsic draft vector has ${intrinsic.length} weights; expected ${DRAFT_FEATURE_DIM} (legacy) or ${fullIntrinsicDimension} (full intrinsic)`,
        );
    }
    if (!intrinsic.every((weight) => typeof weight === "number" && Number.isFinite(weight))) {
        throw new TypeError("Intrinsic draft weights must all be finite numbers");
    }
    const weights = [...LEAGUE_ANCHOR_GENOME];
    weights.splice(LEAGUE_GENOME_LAYOUT.draftIntrinsic.offset, intrinsic.length, ...intrinsic);
    return weights;
}

const genomeFromParsedJson = (parsed: unknown, id: string): ILeagueGenome => {
    if (Array.isArray(parsed)) {
        const weights = parsed as number[];
        if (weights.length === DRAFT_FEATURE_DIM || weights.length === LEAGUE_GENOME_LAYOUT.draftIntrinsic.length) {
            return createLeagueGenome(id, embedIntrinsicDraftWeights(weights));
        }
        if (weights.length === LEAGUE_GENOME_DIM) {
            return createLeagueGenome(id, weights);
        }
        throw new RangeError(
            `Draft weights array has ${weights.length} entries; expected ${DRAFT_FEATURE_DIM} (legacy intrinsic), ${LEAGUE_GENOME_LAYOUT.draftIntrinsic.length} (full intrinsic), or ${LEAGUE_GENOME_DIM} (league genome)`,
        );
    }
    if (parsed && typeof parsed === "object") {
        const value = parsed as {
            id?: unknown;
            omniscientDraft?: unknown;
            schemaVersion?: unknown;
            weights?: unknown;
        };
        if (value.schemaVersion !== undefined && value.schemaVersion !== LEAGUE_SCHEMA_VERSION) {
            throw new Error(`Unsupported draft genome schema ${String(value.schemaVersion)}`);
        }
        if (value.omniscientDraft) {
            throw new TypeError("A deployable draft genome cannot use omniscientDraft");
        }
        if (value.id !== undefined && (typeof value.id !== "string" || !value.id.trim())) {
            throw new TypeError("Draft genome id must be a non-empty string when provided");
        }
        if (Array.isArray(value.weights)) {
            return genomeFromParsedJson(value.weights, typeof value.id === "string" ? value.id : id);
        }
    }
    throw new TypeError("Draft genome JSON must be a weights array or an object with a weights array");
};

/**
 * Parse a draft genome spec (env HOC_DRAFT_WEIGHTS / server config.ai.draftWeights). Accepted forms:
 * - "anchor" | "heuristic": the untrained setup-v0 heuristic reproduced as a genome (A/B reference);
 * - "default" | "melee" | "melee_coevo": the baked DEFAULT_DRAFT_W melee co-evolution champion;
 * - "league-r1-br-57de5a2d": fresh-v0.7-accepted projected League round-1 candidate;
 * - "league-r1-br-57de5a2d-candidate": compatibility alias for the same immutable round-1 weights;
 * - "league-r3-br-52752642": the fresh-v0.7-accepted projected League round-3 candidate;
 * - "v07-nonfight-draft-48d23ac4461": the fresh overnight non-fight candidate;
 * - inline JSON array of 11 legacy or 15 full intrinsic weights (embedded into the anchor genome);
 * - inline JSON array of 95 league-genome weights, or an object with { id?, weights } of any accepted length;
 * - anything else: path to a JSON file containing one of the above (a league champion artifact).
 */
export function parseDraftGenome(
    spec: string,
    id: string = "draft-config",
    cwd: string = process.cwd(),
): ILeagueGenome {
    const trimmed = spec.trim();
    if (!trimmed) {
        throw new TypeError("Draft genome spec must not be empty");
    }
    if (trimmed === "anchor" || trimmed === "heuristic") {
        return createLeagueGenome("anchor", LEAGUE_ANCHOR_GENOME);
    }
    if (trimmed === "default" || trimmed === "melee" || trimmed === "melee_coevo") {
        return createMeleeLeagueGenome();
    }
    if (trimmed === LEAGUE_ROUND1_DRAFT_SPEC || trimmed === LEAGUE_ROUND1_DRAFT_CANDIDATE_SPEC) {
        return genomeFromParsedJson(leagueRound1CandidateGenome, LEAGUE_ROUND1_DRAFT_SPEC);
    }
    if (trimmed === LEAGUE_ROUND3_DRAFT_SPEC) {
        return genomeFromParsedJson(leagueRound3ProjectedGenome, LEAGUE_ROUND3_DRAFT_SPEC);
    }
    if (trimmed === V07_NONFIGHT_DRAFT_SPEC) {
        return genomeFromParsedJson(v07NonfightDraftGenome, V07_NONFIGHT_DRAFT_SPEC);
    }
    const raw =
        trimmed.startsWith("[") || trimmed.startsWith("{") ? trimmed : readFileSync(resolve(cwd, trimmed), "utf8");
    return genomeFromParsedJson(JSON.parse(raw) as unknown, id);
}

/**
 * Freeze a league artifact to the surface the ranked server consumes for draft decisions. Only the intrinsic
 * creature head survives; counter-draft, perk, artifact, augment and placement heads are reset to setup-v0.
 * This projection is also applied by the acceptance harness, preventing an unused head from earning a pass.
 */
export function projectDraftGenomeForShipping(genome: ILeagueGenome): ILeagueGenome {
    const validated = createLeagueGenome(genome.id, genome.weights, !!genome.omniscientDraft);
    if (validated.omniscientDraft) {
        throw new TypeError("A deployable draft genome cannot use omniscientDraft");
    }
    const weights = [...LEAGUE_ANCHOR_GENOME];
    const { offset, length } = LEAGUE_GENOME_LAYOUT.draftIntrinsic;
    weights.splice(offset, length, ...validated.weights.slice(offset, offset + length));
    return createLeagueGenome(validated.id, weights);
}

/**
 * Composition-independent draft value of a creature under a genome. The ranked server uses this same intrinsic
 * score for bundle creature terms and legal-creature argmax; live auto-bans remain random.
 */
export function draftGenomeCreatureScore(genome: ILeagueGenome, creatureId: number): number {
    return scoreLeagueCreature(creatureId, [], [], genome.weights);
}
