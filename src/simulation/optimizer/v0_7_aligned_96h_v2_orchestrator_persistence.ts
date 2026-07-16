/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import {
    applyV07AlignedV2OrchestratorCommand,
    deriveV07AlignedV2OrchestratorState,
    validateV07AlignedV2AppendedEventEvidence,
    validateV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorApplyResult,
    type IV07AlignedV2OrchestratorCommand,
    type IV07AlignedV2OrchestratorDefinition,
    type IV07AlignedV2OrchestratorEvent,
    type IV07AlignedV2OrchestratorReplayResolvers,
    type IV07AlignedV2OrchestratorState,
    type IV07AlignedV2OrchestratorTerminal,
} from "./v0_7_aligned_96h_v2_orchestrator";
import { canonicalV07AlignedV2Json, fingerprintV07AlignedV2 } from "./v0_7_aligned_96h_v2_protocol";
import { quarantineV07AlignedV2Path, type V07AlignedV2QuarantineReason } from "./v0_7_aligned_96h_v2_quarantine";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TRANSITION_PATTERN = /^(\d{6})-([0-9a-f]{64})\.json$/;

export interface IV07AlignedV2OrchestratorCurrent {
    schemaVersion: 1;
    artifactKind: "v0_7_aligned_96h_v2_orchestrator_current";
    runFingerprint: string;
    nextSequence: number;
    eventHeadSha256: string | null;
    lastNowMs: number;
    terminalSha256: string | null;
    currentSha256: string;
}

export interface IV07AlignedV2OrchestratorPersistenceFaultInjector {
    afterDurableStep(step: string): void;
}

export interface IV07AlignedV2PersistedOrchestrator {
    directory: string;
    definition: IV07AlignedV2OrchestratorDefinition;
    events: IV07AlignedV2OrchestratorEvent[];
    state: IV07AlignedV2OrchestratorState;
    current: IV07AlignedV2OrchestratorCurrent;
    terminalPath: string | null;
    reused: boolean;
}

export interface IV07AlignedV2PersistedOrchestratorApplyResult {
    orchestration: IV07AlignedV2PersistedOrchestrator;
    command: IV07AlignedV2OrchestratorApplyResult;
}

let tempSequence = 0;

interface ITrustedLedgerIdentity {
    directory: string;
    definitionSha256: string;
    eventsSha256: string;
    stateSha256: string;
    currentSha256: string;
    terminalPath: string | null;
}

const trustedLedgers = new WeakMap<IV07AlignedV2PersistedOrchestrator, Readonly<ITrustedLedgerIdentity>>();

function ledgerIdentity(ledger: IV07AlignedV2PersistedOrchestrator): ITrustedLedgerIdentity {
    return {
        directory: ledger.directory,
        definitionSha256: fingerprintV07AlignedV2(ledger.definition),
        eventsSha256: fingerprintV07AlignedV2(ledger.events),
        stateSha256: fingerprintV07AlignedV2(ledger.state),
        currentSha256: fingerprintV07AlignedV2(ledger.current),
        terminalPath: ledger.terminalPath,
    };
}

function trustLedger<T extends IV07AlignedV2PersistedOrchestrator>(ledger: T): T {
    trustedLedgers.set(ledger, Object.freeze(ledgerIdentity(ledger)));
    return ledger;
}

function requireTrustedLedger(ledger: IV07AlignedV2PersistedOrchestrator): void {
    const trusted = trustedLedgers.get(ledger);
    if (!trusted) throw new Error("aligned v2 incremental append requires an opaque strictly loaded ledger");
    if (canonicalV07AlignedV2Json(ledgerIdentity(ledger)) !== canonicalV07AlignedV2Json(trusted)) {
        throw new Error("aligned v2 incremental append strictly loaded ledger was mutated after validation");
    }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    return canonicalV07AlignedV2Json(Object.keys(value).sort()) === canonicalV07AlignedV2Json([...expected].sort());
}

function requireSafeInteger(value: unknown, label: string): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`${label} must be a nonnegative integer`);
    }
}

function requireSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256`);
    }
}

function canonicalJsonFile(value: unknown): string {
    return `${canonicalV07AlignedV2Json(value)}\n`;
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
    let decoded: string;
    try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error(`${label} is not canonical UTF-8`);
    return decoded;
}

function requireRegularFile(path: string, label: string): void {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function requireDirectory(path: string, label: string): void {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`${label} must be a regular non-symlink directory`);
    }
}

function parseCanonicalJsonFile<T>(path: string, label: string): T {
    requireRegularFile(path, label);
    const contents = decodeUtf8Exact(readFileSync(path), label);
    if (!contents.endsWith("\n")) throw new Error(`${label} lacks a terminal newline`);
    let parsed: T;
    try {
        parsed = JSON.parse(contents) as T;
    } catch (error) {
        throw new Error(`${label} is malformed JSON (${String(error)})`);
    }
    if (contents !== canonicalJsonFile(parsed)) throw new Error(`${label} is not canonical JSON`);
    return parsed;
}

function fsyncDirectory(path: string): void {
    const fd = openSync(path, "r");
    try {
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function ensureDurableDirectory(path: string): void {
    if (existsSync(path)) {
        requireDirectory(path, `durable directory ${path}`);
        return;
    }
    const parent = dirname(path);
    if (parent === path) throw new Error(`cannot create durable filesystem root ${path}`);
    ensureDurableDirectory(parent);
    mkdirSync(path, { mode: 0o700 });
    fsyncDirectory(path);
    fsyncDirectory(parent);
}

function writeDurableExclusive(path: string, contents: string): void {
    const fd = openSync(path, "wx", 0o600);
    try {
        writeFileSync(fd, contents, "utf8");
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function writeAtomicReplacement(path: string, contents: string): void {
    const parent = dirname(path);
    const tempPath = join(parent, `.${basename(path)}.tmp-${process.pid}-${tempSequence++}`);
    writeDurableExclusive(tempPath, contents);
    renameSync(tempPath, path);
    fsyncDirectory(parent);
}

function quarantine(path: string, quarantineDirectory: string, reason: V07AlignedV2QuarantineReason): void {
    quarantineV07AlignedV2Path(path, quarantineDirectory, reason);
    fsyncDirectory(dirname(path));
    fsyncDirectory(quarantineDirectory);
}

function makeCurrent(
    definition: IV07AlignedV2OrchestratorDefinition,
    state: IV07AlignedV2OrchestratorState,
): IV07AlignedV2OrchestratorCurrent {
    const unsigned = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_orchestrator_current" as const,
        runFingerprint: definition.definitionSha256,
        nextSequence: state.nextSequence,
        eventHeadSha256: state.eventHeadSha256,
        lastNowMs: state.lastNowMs,
        terminalSha256: state.terminal?.terminalSha256 ?? null,
    };
    return { ...unsigned, currentSha256: fingerprintV07AlignedV2(unsigned) };
}

function validateCurrentShape(
    value: IV07AlignedV2OrchestratorCurrent,
    definition: IV07AlignedV2OrchestratorDefinition,
): void {
    if (
        !isObjectRecord(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "artifactKind",
            "runFingerprint",
            "nextSequence",
            "eventHeadSha256",
            "lastNowMs",
            "terminalSha256",
            "currentSha256",
        ]) ||
        value.schemaVersion !== 1 ||
        value.artifactKind !== "v0_7_aligned_96h_v2_orchestrator_current" ||
        value.runFingerprint !== definition.definitionSha256
    ) {
        throw new Error("aligned v2 CURRENT fields/header do not match the immutable run");
    }
    requireSafeInteger(value.nextSequence, "CURRENT.nextSequence");
    requireSafeInteger(value.lastNowMs, "CURRENT.lastNowMs");
    if (value.eventHeadSha256 !== null) requireSha256(value.eventHeadSha256, "CURRENT.eventHeadSha256");
    if (value.terminalSha256 !== null) requireSha256(value.terminalSha256, "CURRENT.terminalSha256");
    requireSha256(value.currentSha256, "CURRENT.currentSha256");
    const unsigned = { ...value };
    delete (unsigned as Partial<IV07AlignedV2OrchestratorCurrent>).currentSha256;
    if (value.currentSha256 !== fingerprintV07AlignedV2(unsigned)) {
        throw new Error("aligned v2 CURRENT self-hash mismatch");
    }
}

function requireReplayResolvers(
    events: readonly IV07AlignedV2OrchestratorEvent[],
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
): void {
    if (!resolvers.seedCommitment) {
        throw new Error("aligned v2 exact resume requires a seed-commitment resolver");
    }
    if (
        events.some((event) =>
            ["train_recorded", "confirmation_recorded", "final_recorded"].includes(event.eventType),
        ) &&
        !resolvers.evidence
    ) {
        throw new Error("aligned v2 exact resume requires an evidence resolver for persisted panel evidence");
    }
    if (events.some((event) => event.eventType === "final_plan_revealed") && !resolvers.seedPlans) {
        throw new Error("aligned v2 exact resume requires a final seed-reveal resolver");
    }
}

function transitionFileName(event: IV07AlignedV2OrchestratorEvent): string {
    if (event.sequence > 999999) throw new Error("aligned v2 transition sequence exceeds the finite ledger bound");
    return `${String(event.sequence).padStart(6, "0")}-${event.eventSha256}.json`;
}

function acquireIncrementalAppendClaim(
    directory: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    event: IV07AlignedV2OrchestratorEvent,
): string {
    // The supervisor supplies single-writer ownership; this file records reentrancy/crash boundaries.
    const transitionsDirectory = join(directory, "transitions");
    const path = join(transitionsDirectory, `.append-${String(event.sequence).padStart(6, "0")}.claim`);
    const claim = {
        schemaVersion: 1 as const,
        artifactKind: "v0_7_aligned_96h_v2_incremental_append_claim" as const,
        runFingerprint: definition.definitionSha256,
        sequence: event.sequence,
        previousEventSha256: event.previousEventSha256,
        eventSha256: event.eventSha256,
        processId: process.pid,
    };
    try {
        writeDurableExclusive(path, canonicalJsonFile(claim));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(`aligned v2 incremental append sequence ${event.sequence} is already claimed`);
        }
        throw error;
    }
    fsyncDirectory(transitionsDirectory);
    return path;
}

function releaseIncrementalAppendClaim(path: string): void {
    unlinkSync(path);
    fsyncDirectory(dirname(path));
}

function quarantineTemporaryEntries(directory: string): void {
    const quarantineDirectory = join(directory, "quarantine");
    const transitionsDirectory = join(directory, "transitions");
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".CURRENT.tmp-") || entry.name.startsWith(".TERMINAL.json.tmp-")) {
            quarantine(join(directory, entry.name), quarantineDirectory, "abandoned");
        }
    }
    for (const entry of readdirSync(transitionsDirectory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) {
            quarantine(join(transitionsDirectory, entry.name), quarantineDirectory, "abandoned");
        }
    }
}

function validateRootInventory(directory: string, terminalExpected: boolean): void {
    const expected = [
        "CURRENT",
        "quarantine",
        "run.json",
        "transitions",
        ...(terminalExpected ? ["TERMINAL.json"] : []),
    ];
    const actual = readdirSync(directory).sort();
    if (canonicalV07AlignedV2Json(actual) !== canonicalV07AlignedV2Json(expected.sort())) {
        throw new Error("aligned v2 orchestration directory inventory is not exact");
    }
}

function loadTransitionFiles(directory: string, permittedClaimName?: string): IV07AlignedV2OrchestratorEvent[] {
    const transitionsDirectory = join(directory, "transitions");
    requireDirectory(transitionsDirectory, "aligned v2 transitions");
    let permittedClaimSeen = false;
    const entries = readdirSync(transitionsDirectory, { withFileTypes: true })
        .filter((entry) => {
            if (entry.name !== permittedClaimName) return true;
            if (!entry.isFile() || entry.isSymbolicLink()) {
                throw new Error(`aligned v2 transition inventory contains unsafe entry ${entry.name}`);
            }
            permittedClaimSeen = true;
            return false;
        })
        .sort((left, right) => left.name.localeCompare(right.name));
    if (permittedClaimName && !permittedClaimSeen) {
        throw new Error("aligned v2 incremental append lost its durable claim");
    }
    const events: IV07AlignedV2OrchestratorEvent[] = [];
    for (const [index, entry] of entries.entries()) {
        const match = TRANSITION_PATTERN.exec(entry.name);
        if (!entry.isFile() || entry.isSymbolicLink() || !match) {
            throw new Error(`aligned v2 transition inventory contains unsafe entry ${entry.name}`);
        }
        const sequence = Number(match[1]);
        if (sequence !== index) throw new Error("aligned v2 transition ledger has a gap, fork, or duplicate sequence");
        const path = join(transitionsDirectory, entry.name);
        const event = parseCanonicalJsonFile<IV07AlignedV2OrchestratorEvent>(path, `transition ${sequence}`);
        if (event.sequence !== sequence || event.eventSha256 !== match[2] || transitionFileName(event) !== entry.name) {
            throw new Error(`aligned v2 transition ${sequence} filename does not bind its exact event`);
        }
        events.push(event);
    }
    return events;
}

function ensureTerminalFile(
    directory: string,
    terminal: IV07AlignedV2OrchestratorTerminal | null,
): { path: string | null; published: boolean } {
    const path = join(directory, "TERMINAL.json");
    if (!terminal) {
        if (existsSync(path)) throw new Error("aligned v2 TERMINAL.json exists before a terminal transition");
        return { path: null, published: false };
    }
    const expected = canonicalJsonFile(terminal);
    if (existsSync(path)) {
        const parsed = parseCanonicalJsonFile<IV07AlignedV2OrchestratorTerminal>(path, "TERMINAL.json");
        if (canonicalJsonFile(parsed) !== expected) {
            throw new Error("aligned v2 TERMINAL.json differs from the authoritative terminal transition");
        }
        return { path, published: false };
    }
    writeAtomicReplacement(path, expected);
    return { path, published: true };
}

function readDefinition(directory: string): IV07AlignedV2OrchestratorDefinition {
    const definition = parseCanonicalJsonFile<IV07AlignedV2OrchestratorDefinition>(
        join(directory, "run.json"),
        "aligned v2 run.json",
    );
    return validateV07AlignedV2OrchestratorDefinition(definition);
}

function loadPersistedOrchestrator(
    directory: string,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    expectedDefinition?: IV07AlignedV2OrchestratorDefinition,
    recoverTemporaryEntries = true,
): IV07AlignedV2PersistedOrchestrator {
    requireDirectory(directory, "aligned v2 orchestration root");
    requireDirectory(join(directory, "quarantine"), "aligned v2 quarantine");
    requireDirectory(join(directory, "transitions"), "aligned v2 transitions");
    if (recoverTemporaryEntries) quarantineTemporaryEntries(directory);
    const definition = readDefinition(directory);
    if (expectedDefinition && canonicalV07AlignedV2Json(definition) !== canonicalV07AlignedV2Json(expectedDefinition)) {
        throw new Error("aligned v2 orchestration directory belongs to a different immutable definition");
    }
    const events = loadTransitionFiles(directory);
    requireReplayResolvers(events, resolvers);
    const state = deriveV07AlignedV2OrchestratorState(definition, events, resolvers);
    const currentPath = join(directory, "CURRENT");
    if (!existsSync(currentPath)) throw new Error("aligned v2 CURRENT is missing");
    const current = parseCanonicalJsonFile<IV07AlignedV2OrchestratorCurrent>(currentPath, "aligned v2 CURRENT");
    validateCurrentShape(current, definition);
    if (current.nextSequence > events.length) throw new Error("aligned v2 CURRENT points ahead of durable transitions");
    const prefixState =
        current.nextSequence === events.length
            ? state
            : deriveV07AlignedV2OrchestratorState(definition, events.slice(0, current.nextSequence), resolvers);
    const expectedAtPointer = makeCurrent(definition, prefixState);
    if (canonicalV07AlignedV2Json(current) !== canonicalV07AlignedV2Json(expectedAtPointer)) {
        throw new Error("aligned v2 CURRENT forks from its referenced durable transition prefix");
    }
    const expectedCurrent = makeCurrent(definition, state);
    if (current.nextSequence < events.length) {
        writeAtomicReplacement(currentPath, canonicalJsonFile(expectedCurrent));
    }
    const terminal = ensureTerminalFile(directory, state.terminal);
    validateRootInventory(directory, state.terminal !== null);
    return trustLedger({
        directory,
        definition,
        events,
        state,
        current: expectedCurrent,
        terminalPath: terminal.path,
        reused: true,
    });
}

/**
 * Cold-recovery entrypoint. The external supervisor lifecycle must exclude an active writer:
 * hidden append claims are abandoned-boundary evidence and are quarantined during this load.
 */
export function loadV07AlignedV2PersistedOrchestrator(
    directory: string,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    expectedDefinition?: IV07AlignedV2OrchestratorDefinition,
): IV07AlignedV2PersistedOrchestrator {
    return loadPersistedOrchestrator(directory, resolvers, expectedDefinition);
}

function quarantineAbandonedInitializations(directory: string): void {
    const parent = dirname(directory);
    const prefix = `.${basename(directory)}.tmp-`;
    for (const entry of readdirSync(parent).filter((name) => name.startsWith(prefix))) {
        const path = join(parent, entry);
        quarantineV07AlignedV2Path(path, parent, "abandoned");
        fsyncDirectory(parent);
    }
}

export function initializeV07AlignedV2OrchestratorPersistence(
    directory: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    faultInjector?: IV07AlignedV2OrchestratorPersistenceFaultInjector,
): IV07AlignedV2PersistedOrchestrator {
    validateV07AlignedV2OrchestratorDefinition(definition);
    if (!resolvers.seedCommitment) throw new Error("aligned v2 initialization requires a seed-commitment resolver");
    const parent = dirname(directory);
    ensureDurableDirectory(parent);
    fsyncDirectory(parent);
    quarantineAbandonedInitializations(directory);
    if (existsSync(directory)) {
        const existingDefinition = readDefinition(directory);
        if (canonicalV07AlignedV2Json(existingDefinition) !== canonicalV07AlignedV2Json(definition)) {
            throw new Error("aligned v2 orchestration path already contains a different valid definition");
        }
        return loadV07AlignedV2PersistedOrchestrator(directory, resolvers, definition);
    }
    const tempDirectory = mkdtempSync(join(parent, `.${basename(directory)}.tmp-`));
    mkdirSync(join(tempDirectory, "transitions"), { mode: 0o700 });
    mkdirSync(join(tempDirectory, "quarantine"), { mode: 0o700 });
    const state = deriveV07AlignedV2OrchestratorState(definition, [], resolvers);
    writeDurableExclusive(join(tempDirectory, "run.json"), canonicalJsonFile(definition));
    faultInjector?.afterDurableStep("init_file:run.json");
    writeDurableExclusive(join(tempDirectory, "CURRENT"), canonicalJsonFile(makeCurrent(definition, state)));
    faultInjector?.afterDurableStep("init_file:CURRENT");
    fsyncDirectory(join(tempDirectory, "transitions"));
    fsyncDirectory(join(tempDirectory, "quarantine"));
    fsyncDirectory(tempDirectory);
    faultInjector?.afterDurableStep("init_directory_fsynced");
    renameSync(tempDirectory, directory);
    faultInjector?.afterDurableStep("init_directory_published");
    fsyncDirectory(parent);
    faultInjector?.afterDurableStep("init_parent_fsynced");
    const loaded = loadV07AlignedV2PersistedOrchestrator(directory, resolvers, definition);
    return trustLedger({ ...loaded, reused: false });
}

/** Event-level append retained for callers already holding external single-writer ownership. */
export function appendV07AlignedV2OrchestratorEvent(
    directory: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    event: IV07AlignedV2OrchestratorEvent,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    faultInjector?: IV07AlignedV2OrchestratorPersistenceFaultInjector,
): IV07AlignedV2PersistedOrchestrator {
    // A live claim must fail this append, not be mistaken for cold-start recovery debris.
    const loaded = loadPersistedOrchestrator(directory, resolvers, definition, false);
    const existing = loaded.events[event.sequence];
    if (existing) {
        if (canonicalV07AlignedV2Json(existing) !== canonicalV07AlignedV2Json(event)) {
            throw new Error("aligned v2 immutable transition sequence already contains different content");
        }
        return trustLedger({ ...loaded, reused: true });
    }
    if (event.sequence !== loaded.events.length) {
        throw new Error("aligned v2 transition append is not the exact next finite sequence");
    }
    const events = [...loaded.events, event];
    const state = deriveV07AlignedV2OrchestratorState(definition, events);
    return persistAppendedEventFromLoaded(loaded, definition, event, state, resolvers, faultInjector);
}

export function applyAndPersistV07AlignedV2OrchestratorCommand(
    directory: string,
    definition: IV07AlignedV2OrchestratorDefinition,
    command: IV07AlignedV2OrchestratorCommand,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    faultInjector?: IV07AlignedV2OrchestratorPersistenceFaultInjector,
): IV07AlignedV2PersistedOrchestratorApplyResult {
    const loaded = loadV07AlignedV2PersistedOrchestrator(directory, resolvers, definition);
    const result = applyV07AlignedV2OrchestratorCommand(definition, loaded.events, command);
    if (!result.appended) return { orchestration: loaded, command: result };
    const orchestration = appendV07AlignedV2OrchestratorEvent(
        directory,
        definition,
        result.appended,
        resolvers,
        faultInjector,
    );
    return { orchestration, command: result };
}

function assertLoadedOrchestratorMatchesDurableHead(
    loaded: IV07AlignedV2PersistedOrchestrator,
    definition: IV07AlignedV2OrchestratorDefinition,
    permittedClaimName?: string,
): void {
    if (
        canonicalV07AlignedV2Json(loaded.definition) !== canonicalV07AlignedV2Json(definition) ||
        loaded.directory === ""
    ) {
        throw new Error("aligned v2 incremental append received a different loaded definition or directory");
    }
    requireDirectory(loaded.directory, "aligned v2 incremental orchestration root");
    requireDirectory(join(loaded.directory, "quarantine"), "aligned v2 incremental quarantine");
    requireDirectory(join(loaded.directory, "transitions"), "aligned v2 incremental transitions");
    const durableDefinition = readDefinition(loaded.directory);
    if (canonicalV07AlignedV2Json(durableDefinition) !== canonicalV07AlignedV2Json(definition)) {
        throw new Error("aligned v2 incremental append definition changed after the loaded replay");
    }
    const durableEvents = loadTransitionFiles(loaded.directory, permittedClaimName);
    if (canonicalV07AlignedV2Json(durableEvents) !== canonicalV07AlignedV2Json(loaded.events)) {
        throw new Error("aligned v2 incremental append transition head changed after the loaded replay");
    }
    const structuralState = deriveV07AlignedV2OrchestratorState(definition, durableEvents);
    if (canonicalV07AlignedV2Json(structuralState) !== canonicalV07AlignedV2Json(loaded.state)) {
        throw new Error("aligned v2 incremental append loaded state does not match its transition head");
    }
    const current = parseCanonicalJsonFile<IV07AlignedV2OrchestratorCurrent>(
        join(loaded.directory, "CURRENT"),
        "aligned v2 incremental CURRENT",
    );
    validateCurrentShape(current, definition);
    if (
        canonicalV07AlignedV2Json(current) !== canonicalV07AlignedV2Json(loaded.current) ||
        canonicalV07AlignedV2Json(current) !== canonicalV07AlignedV2Json(makeCurrent(definition, structuralState))
    ) {
        throw new Error("aligned v2 incremental append CURRENT changed after the loaded replay");
    }
    const terminalPath = join(loaded.directory, "TERMINAL.json");
    if (!loaded.state.terminal) {
        if (loaded.terminalPath !== null || existsSync(terminalPath)) {
            throw new Error("aligned v2 incremental append terminal changed after the loaded replay");
        }
    } else {
        if (loaded.terminalPath !== terminalPath || !existsSync(terminalPath)) {
            throw new Error("aligned v2 incremental append terminal changed after the loaded replay");
        }
        const terminal = parseCanonicalJsonFile<IV07AlignedV2OrchestratorTerminal>(
            terminalPath,
            "aligned v2 incremental TERMINAL.json",
        );
        if (canonicalV07AlignedV2Json(terminal) !== canonicalV07AlignedV2Json(loaded.state.terminal)) {
            throw new Error("aligned v2 incremental append terminal changed after the loaded replay");
        }
    }
    validateRootInventory(loaded.directory, loaded.state.terminal !== null);
}

function persistAppendedEventFromLoaded(
    loaded: IV07AlignedV2PersistedOrchestrator,
    definition: IV07AlignedV2OrchestratorDefinition,
    event: IV07AlignedV2OrchestratorEvent,
    state: IV07AlignedV2OrchestratorState,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    faultInjector?: IV07AlignedV2OrchestratorPersistenceFaultInjector,
): IV07AlignedV2PersistedOrchestrator {
    requireTrustedLedger(loaded);
    const claimPath = acquireIncrementalAppendClaim(loaded.directory, definition, event);
    faultInjector?.afterDurableStep("append_claim_fsynced");
    assertLoadedOrchestratorMatchesDurableHead(loaded, definition, basename(claimPath));
    validateV07AlignedV2AppendedEventEvidence(definition, state, event, resolvers);
    const transitionsDirectory = join(loaded.directory, "transitions");
    const finalPath = join(transitionsDirectory, transitionFileName(event));
    const tempPath = join(transitionsDirectory, `.${transitionFileName(event)}.tmp-${process.pid}-${tempSequence++}`);
    writeDurableExclusive(tempPath, canonicalJsonFile(event));
    faultInjector?.afterDurableStep("transition_temp_fsynced");
    renameSync(tempPath, finalPath);
    fsyncDirectory(transitionsDirectory);
    faultInjector?.afterDurableStep("transition_published");
    const current = makeCurrent(definition, state);
    writeAtomicReplacement(join(loaded.directory, "CURRENT"), canonicalJsonFile(current));
    faultInjector?.afterDurableStep("current_published");
    releaseIncrementalAppendClaim(claimPath);
    faultInjector?.afterDurableStep("append_claim_released");
    const terminal = ensureTerminalFile(loaded.directory, state.terminal);
    if (terminal.published) faultInjector?.afterDurableStep("terminal_published");
    validateRootInventory(loaded.directory, state.terminal !== null);
    return trustLedger({
        directory: loaded.directory,
        definition,
        events: [...loaded.events, event],
        state,
        current,
        terminalPath: terminal.path,
        reused: false,
    });
}

/**
 * Append from one already strict-replayed ledger without revalidating historical shard evidence.
 * The external supervisor lifecycle must provide single-writer ownership. A fresh process must
 * still enter through loadV07AlignedV2PersistedOrchestrator before starting that owned writer.
 */
export function applyAndPersistV07AlignedV2OrchestratorCommandFromLoaded(
    loaded: IV07AlignedV2PersistedOrchestrator,
    definition: IV07AlignedV2OrchestratorDefinition,
    command: IV07AlignedV2OrchestratorCommand,
    resolvers: IV07AlignedV2OrchestratorReplayResolvers,
    faultInjector?: IV07AlignedV2OrchestratorPersistenceFaultInjector,
): IV07AlignedV2PersistedOrchestratorApplyResult {
    requireTrustedLedger(loaded);
    assertLoadedOrchestratorMatchesDurableHead(loaded, definition);
    const result = applyV07AlignedV2OrchestratorCommand(definition, loaded.events, command);
    if (!result.appended) {
        return { orchestration: trustLedger({ ...loaded, reused: true }), command: result };
    }
    return {
        orchestration: persistAppendedEventFromLoaded(
            loaded,
            definition,
            result.appended,
            result.state,
            resolvers,
            faultInjector,
        ),
        command: result,
    };
}
