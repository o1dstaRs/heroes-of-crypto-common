import { createHash } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import { hashSimulationParts } from "./army";
import type { IAiMetaPairRecord, IAiMetaRunOptions } from "./ai_meta_cohorts_core";
import { validateAiMetaEvidence } from "./ai_meta_evidence";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function writeAiMetaAtomic(path: string, bytes: string | Uint8Array): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.pending`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
    renameSync(temporary, path);
    const directory = openSync(dirname(path), "r");
    try {
        fsyncSync(directory);
    } finally {
        closeSync(directory);
    }
}

/** The lock prevents two controllers from simulating the same missing cases. */
export function openAiMetaRun(directory: string, identity: unknown, resume: boolean) {
    mkdirSync(directory, { recursive: true });
    const lock = join(directory, "collection.lock.json");
    if (existsSync(lock)) {
        const previous = JSON.parse(readFileSync(lock, "utf8")) as { pid: number; host: string };
        if (previous.host !== hostname() || !Number.isSafeInteger(previous.pid) || previous.pid < 1)
            throw new Error("Cannot reclaim a foreign or invalid collection lock");
        let alive = true;
        try {
            process.kill(previous.pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
            else throw error;
        }
        if (alive || !resume) throw new Error("AI meta controller is still active; do not duplicate it");
        renameSync(lock, `${lock}.retired-${Date.now()}`);
    }
    const lockFd = openSync(lock, "wx", 0o600);
    writeFileSync(lockFd, JSON.stringify({ pid: process.pid, host: hostname() }));
    closeSync(lockFd);
    try {
        const path = join(directory, "collection-registration.json");
        const identitySha256 = digest(JSON.stringify(identity));
        if (resume && !existsSync(path)) throw new Error("Resume requires an existing fixed collection registration");
        const registration = existsSync(path)
            ? JSON.parse(readFileSync(path, "utf8"))
            : { schema: "ai-meta-checkpoints-v1", identity, identitySha256, startedAt: new Date().toISOString() };
        if (
            registration.schema !== "ai-meta-checkpoints-v1" ||
            registration.identitySha256 !== identitySha256 ||
            digest(JSON.stringify(registration.identity)) !== identitySha256
        )
            throw new Error("Collection source, policy or fixed cases changed; preserve the original run");
        if (!existsSync(path)) writeAiMetaAtomic(path, JSON.stringify(registration, null, 2) + "\n");
        return { registration, close: () => unlinkSync(lock) };
    } catch (error) {
        unlinkSync(lock);
        throw error;
    }
}

/** Completed pairs are immutable; only a missing fixed index may be scheduled. */
export class AiMetaPairCheckpoints {
    private readonly directory: string;
    public constructor(
        directory: string,
        private readonly identitySha256: string,
        private readonly options: IAiMetaRunOptions,
    ) {
        this.directory = join(directory, "pairs", options.cohort);
        mkdirSync(this.directory, { recursive: true });
    }
    private path(pair: number) {
        return join(this.directory, `${pair}.json.gz`);
    }
    private validate(record: IAiMetaPairRecord, pair: number): void {
        if (
            !Number.isSafeInteger(pair) ||
            pair < 0 ||
            pair >= this.options.games / 2 ||
            record.pair !== pair ||
            record.cohort !== this.options.cohort ||
            record.setupSeed !==
                hashSimulationParts("ai-meta-setup", this.options.baseSeed, this.options.cohort, pair) ||
            record.combatSeed !==
                hashSimulationParts("ai-meta-combat", this.options.baseSeed, this.options.cohort, pair) ||
            record.games?.length !== 2 ||
            !record.games[0].aIsGreen ||
            record.games[1].aIsGreen
        )
            throw new Error(`Checkpoint does not match fixed ${this.options.cohort}/${pair}`);
        if (this.options.collectEvidence) validateAiMetaEvidence(record);
    }
    public read(pair: number): IAiMetaPairRecord | undefined {
        if (!existsSync(this.path(pair))) return undefined;
        const envelope = JSON.parse(gunzipSync(readFileSync(this.path(pair))).toString("utf8"));
        if (
            envelope.identitySha256 !== this.identitySha256 ||
            envelope.recordSha256 !== digest(JSON.stringify(envelope.record))
        )
            throw new Error(`Checkpoint hash mismatch ${this.options.cohort}/${pair}`);
        this.validate(envelope.record, pair);
        return envelope.record;
    }
    public save(record: IAiMetaPairRecord): void {
        this.validate(record, record.pair);
        const text = JSON.stringify(record);
        const previous = this.read(record.pair);
        if (previous) {
            if (JSON.stringify(previous) !== text) throw new Error("Refusing to overwrite a different completed pair");
            return;
        }
        writeAiMetaAtomic(
            this.path(record.pair),
            gzipSync(
                JSON.stringify({
                    identitySha256: this.identitySha256,
                    recordSha256: digest(text),
                    record,
                }),
                { level: 1 },
            ),
        );
    }
}
