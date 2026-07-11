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

/**
 * DRAFT SHIP-PATH: turn a config/env value into the deployable draft genome the ranked server consumes.
 *
 * This is the consumption seam for whatever the league training produces — a champion ships by flipping
 * config (HOC_DRAFT_WEIGHTS on the server), never by editing policy code. Node-only (reads files); the
 * browser bundle must not import this module, so it is deliberately NOT re-exported from the package index.
 */

/** Server env var carrying the draft genome spec (see parseDraftGenome for the accepted forms). */
export const DRAFT_GENOME_ENV = "HOC_DRAFT_WEIGHTS";

/**
 * Embed an 11-weight intrinsic draft vector into the full league anchor genome. Composition-blind: the four
 * extra intrinsic features and every counter-draft interaction stay at the anchor's zeros, and the artifact,
 * augment, placement and perk heads keep the measured-table anchor values — so the resulting genome drafts by
 * exactly scoreCreatureWeighted(id, intrinsic) while every non-draft head behaves like the shipped heuristic.
 */
export function embedIntrinsicDraftWeights(intrinsic: readonly number[]): number[] {
    if (intrinsic.length !== DRAFT_FEATURE_DIM) {
        throw new RangeError(`Intrinsic draft vector has ${intrinsic.length} weights; expected ${DRAFT_FEATURE_DIM}`);
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
        if (weights.length === DRAFT_FEATURE_DIM) {
            return createLeagueGenome(id, embedIntrinsicDraftWeights(weights));
        }
        if (weights.length === LEAGUE_GENOME_DIM) {
            return createLeagueGenome(id, weights);
        }
        throw new RangeError(
            `Draft weights array has ${weights.length} entries; expected ${DRAFT_FEATURE_DIM} (intrinsic) or ${LEAGUE_GENOME_DIM} (league genome)`,
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
 * - inline JSON array of 11 intrinsic draft weights (embedded composition-blind into the anchor genome);
 * - inline JSON array of 95 league-genome weights, or an object with { id?, weights } of either length;
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
