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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import {
    parseV09Corpus,
    parseV09DecisionRow,
    parseV09GameRow,
    v09RowChainNext,
    V09_FEATURE_FINGERPRINTS,
    V09_IL_GAME_TYPE,
    V09_IL_SCHEMA,
    V09_IL_VERSION,
    type IV09DecisionRow,
    type IV09GameRow,
} from "./protocol";

export type IV09DecisionInput = Omit<IV09DecisionRow, "t" | "v" | "schema" | "featureFingerprints" | "runFingerprint">;

export type IV09GameInput = Omit<
    IV09GameRow,
    "t" | "v" | "schema" | "featureFingerprints" | "runFingerprint" | "decisions" | "rowChainSha256"
>;

export interface IV09RecorderIdentity {
    runFingerprint: string;
    sourceCommit: string;
    rulesFingerprint: string;
    anchorFingerprint: string;
}

function atomicText(path: string, value: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(temporary, value, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
}

function sameIdentity(
    row: Pick<IV09DecisionRow, "sourceCommit" | "rulesFingerprint" | "anchorFingerprint">,
    identity: IV09RecorderIdentity,
): boolean {
    return (
        row.sourceCommit === identity.sourceCommit &&
        row.rulesFingerprint === identity.rulesFingerprint &&
        row.anchorFingerprint === identity.anchorFingerprint
    );
}

/**
 * One recorder owns one game. Finalization writes an atomic, self-validating JSONL checkpoint; interrupted
 * games leave no accepted shard and can be safely replayed from their reserved seed.
 */
export class V09GameRecorder {
    private readonly identity: IV09RecorderIdentity;
    private readonly game: IV09GameInput;
    private readonly rows: IV09DecisionRow[] = [];
    private closed = false;
    public constructor(identity: IV09RecorderIdentity, game: IV09GameInput) {
        this.identity = identity;
        this.game = game;
    }
    public record(input: IV09DecisionInput): IV09DecisionRow {
        if (this.closed) throw new Error("v0.9 game recorder is already finalized");
        if (
            input.gameId !== this.game.gameId ||
            input.seed !== this.game.seed ||
            input.phase !== this.game.phase ||
            input.split !== this.game.split ||
            input.cohort !== this.game.cohort ||
            input.map !== this.game.map
        ) {
            throw new Error("v0.9 decision provenance does not match its game");
        }
        if (!sameIdentity(input, this.identity)) {
            throw new Error("v0.9 decision source identity does not match its recorder");
        }
        if (input.decision !== this.rows.length) {
            throw new Error(`v0.9 decision index ${input.decision} is not contiguous at ${this.rows.length}`);
        }
        const row = parseV09DecisionRow({
            ...input,
            t: "v09_il_decision",
            v: V09_IL_VERSION,
            schema: V09_IL_SCHEMA,
            runFingerprint: this.identity.runFingerprint,
            featureFingerprints: V09_FEATURE_FINGERPRINTS,
        });
        this.rows.push(row);
        return row;
    }
    public finalize(path: string, outcome?: Pick<IV09GameInput, "winner" | "endReason">): IV09GameRow {
        if (this.closed) throw new Error("v0.9 game recorder is already finalized");
        if (!sameIdentity(this.game, this.identity)) {
            throw new Error("v0.9 game source identity does not match its recorder");
        }
        const serializedRows = this.rows.map((row) => JSON.stringify(row));
        let chain = "0".repeat(64);
        for (const row of serializedRows) chain = v09RowChainNext(chain, row);
        const footer = parseV09GameRow({
            ...this.game,
            ...outcome,
            t: V09_IL_GAME_TYPE,
            v: V09_IL_VERSION,
            schema: V09_IL_SCHEMA,
            runFingerprint: this.identity.runFingerprint,
            featureFingerprints: V09_FEATURE_FINGERPRINTS,
            decisions: this.rows.length,
            rowChainSha256: chain,
        });
        const contents = [...serializedRows, JSON.stringify(footer)].join("\n") + "\n";
        if (existsSync(path)) {
            const current = readFileSync(path, "utf8");
            if (current !== contents) {
                throw new Error(`refusing to overwrite incompatible v0.9 shard ${path}`);
            }
        } else {
            atomicText(path, contents);
        }
        this.closed = true;
        return footer;
    }
}

export function validateV09GameShard(path: string): IV09GameRow {
    const parsed = parseV09Corpus(readFileSync(path, "utf8").split(/\r?\n/));
    if (parsed.games.length !== 1) throw new Error(`${path} must contain exactly one complete v0.9 game`);
    return parsed.games[0]!;
}
