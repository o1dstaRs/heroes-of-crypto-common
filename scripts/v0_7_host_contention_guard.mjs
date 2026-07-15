#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const EXIT_USAGE = 64;
const EXIT_CONTENTION = 75;
const EXIT_PROBE_ERROR = 70;
const CPU_BASELINE_SCHEMA = 1;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Bun caches os.cpus() within a process on some macOS releases. A fresh runtime
// process provides portable scheduler counters on both macOS and Linux.
const freshCpus = () =>
    JSON.parse(
        execFileSync(
            process.execPath,
            ["-e", 'import { cpus } from "node:os"; process.stdout.write(JSON.stringify(cpus()))'],
            { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
        ),
    );

const finiteInteger = (value, label, minimum = 0) => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`${label} must be an integer >= ${minimum}`);
    }
    return parsed;
};

const normalizeCpu = (cpu, label) => {
    if (!cpu || typeof cpu !== "object" || !cpu.times || typeof cpu.times !== "object") {
        throw new Error(`${label} must contain CPU times`);
    }
    const times = Object.fromEntries(
        ["user", "nice", "sys", "idle", "irq"].map((key) => {
            const value = Number(cpu.times[key]);
            if (!Number.isFinite(value) || value < 0) {
                throw new Error(`${label}.times.${key} must be a non-negative number`);
            }
            return [key, value];
        }),
    );
    return { times };
};

export const idleCpuEquivalent = (beforeRaw, afterRaw) => {
    if (!Array.isArray(beforeRaw) || !Array.isArray(afterRaw) || beforeRaw.length === 0) {
        throw new Error("CPU snapshots must be non-empty arrays");
    }
    if (beforeRaw.length !== afterRaw.length) {
        throw new Error("CPU count changed during the contention sample");
    }

    let totalDelta = 0;
    let idleDelta = 0;
    for (let index = 0; index < beforeRaw.length; index += 1) {
        const before = normalizeCpu(beforeRaw[index], `cpuSamples[0][${index}]`);
        const after = normalizeCpu(afterRaw[index], `cpuSamples[1][${index}]`);
        for (const key of ["user", "nice", "sys", "idle", "irq"]) {
            const delta = after.times[key] - before.times[key];
            if (delta < 0) {
                throw new Error(`CPU counter regressed for cpu ${index} field ${key}`);
            }
            totalDelta += delta;
            if (key === "idle") idleDelta += delta;
        }
    }
    if (totalDelta <= 0) throw new Error("CPU sample contained no elapsed scheduler time");
    return {
        cpuCount: beforeRaw.length,
        idleCpus: (idleDelta / totalDelta) * beforeRaw.length,
    };
};

const shellWithInlineCommand = (comm, command) => {
    const executables = executableNames(comm, command);
    if (![...executables].some((name) => new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]).has(name))) {
        return false;
    }
    const tokens = command.trim().split(/\s+/);
    const scriptIndex = tokens.findIndex(
        (token) =>
            token
                .replace(/^['"]|['"]$/g, "")
                .split("/")
                .at(-1) === "run_v0_7_96h.sh",
    );
    const prefixEnd = scriptIndex < 0 ? tokens.length : scriptIndex;
    return tokens.slice(1, prefixEnd).some((argument) => /^-[^-]*c/i.test(argument));
};

const executableNames = (comm, command) =>
    new Set(
        [comm, command.trim().split(/\s/, 1)[0]]
            .map((value) => value.toLowerCase().split("/").at(-1) ?? "")
            .filter(Boolean),
    );

export const isHocComputeProcess = ({ comm = "", command = "" }) => {
    if (typeof comm !== "string" || typeof command !== "string") return false;
    if (shellWithInlineCommand(comm, command)) return false;

    const executables = executableNames(comm, command);
    const runtime = [...executables].some((name) => /^(?:bun|bunx|node|nodejs)$/.test(name));
    const wrapper = [...executables].some((name) => /^(?:bash|dash|sh|zsh|run_v0_7_96h\.sh)$/.test(name));
    const normalized = command.toLowerCase();
    const simulationEntry = /(?:^|[\s/])(?:src|dist)\/simulation\//.test(normalized);
    const namedEntry =
        /(?:^|[\s/])(?:run_(?:match|tournament)|v0_7_(?:96h|overnight|search_trial))\.(?:js|mjs|ts)(?:\s|$)/.test(
            normalized,
        );
    const supervisor = normalized.split(/\s+/).some(
        (token) =>
            token
                .replace(/^['"]|['"]$/g, "")
                .split("/")
                .at(-1) === "run_v0_7_96h.sh",
    );
    return (runtime && (simulationEntry || namedEntry)) || (wrapper && supervisor);
};

export const parsePsSnapshot = (text) => {
    if (typeof text !== "string") throw new Error("ps snapshot must be text");
    const processes = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!match) throw new Error(`unparseable ps row: ${line.slice(0, 160)}`);
        processes.push({
            pid: finiteInteger(match[1], "process pid", 1),
            pgid: finiteInteger(match[2], "process pgid", 1),
            state: match[3],
            comm: match[4],
            command: match[5],
        });
    }
    return processes;
};

const normalizeProcesses = (raw) => {
    if (!Array.isArray(raw)) throw new Error("fixture processes must be an array");
    return raw.map((process, index) => {
        if (!process || typeof process !== "object") throw new Error(`processes[${index}] must be an object`);
        const comm = process.comm ?? "bun";
        const state = process.state ?? "R";
        if (typeof comm !== "string" || comm.length === 0) {
            throw new Error(`processes[${index}].comm must be a non-empty string`);
        }
        if (typeof process.command !== "string" || process.command.length === 0) {
            throw new Error(`processes[${index}].command must be a non-empty string`);
        }
        if (typeof state !== "string" || !/^[A-Za-z]/.test(state)) {
            throw new Error(`processes[${index}].state must start with a letter`);
        }
        return {
            pid: finiteInteger(process.pid, `processes[${index}].pid`, 1),
            pgid: finiteInteger(process.pgid, `processes[${index}].pgid`, 1),
            state,
            comm,
            command: process.command,
        };
    });
};

export const assessHostContention = ({
    processes,
    cpuSamples,
    minimumIdleCpus,
    excludedPids = [],
    excludedPgids = [],
}) => {
    const minimum = finiteInteger(minimumIdleCpus, "minimumIdleCpus", 1);
    if (!Array.isArray(cpuSamples) || cpuSamples.length !== 2) {
        throw new Error("cpuSamples must contain exactly two snapshots");
    }
    const excludedPidSet = new Set(excludedPids.map((pid) => finiteInteger(pid, "excluded pid", 1)));
    const excludedPgidSet = new Set(excludedPgids.map((pgid) => finiteInteger(pgid, "excluded pgid", 1)));
    const blockers = normalizeProcesses(processes)
        .filter((process) => !excludedPidSet.has(process.pid) && !excludedPgidSet.has(process.pgid))
        .filter((process) => !process.state.startsWith("Z"))
        .filter(isHocComputeProcess)
        .map(({ pid, pgid, state, comm, command }) => ({
            pid,
            pgid,
            state,
            comm,
            command: command.slice(0, 500),
        }));
    const cpu = idleCpuEquivalent(cpuSamples[0], cpuSamples[1]);
    if (minimum > cpu.cpuCount) {
        const error = new Error(`minimumIdleCpus ${minimum} exceeds detected CPU count ${cpu.cpuCount}`);
        error.exitCode = EXIT_USAGE;
        throw error;
    }
    const reasons = [];
    if (blockers.length > 0) reasons.push("other-hoc-compute-process");
    if (cpu.idleCpus < minimum) reasons.push("insufficient-idle-cpu");
    return {
        schemaVersion: 1,
        ok: reasons.length === 0,
        reasons,
        minimumIdleCpus: minimum,
        cpuCount: cpu.cpuCount,
        idleCpus: Number(cpu.idleCpus.toFixed(3)),
        blockers,
    };
};

const loadFixture = (path) => {
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    if (!fixture || typeof fixture !== "object" || fixture.schemaVersion !== 1) {
        throw new Error("host guard fixture must have schemaVersion 1");
    }
    if (fixture.cumulative !== undefined && typeof fixture.cumulative !== "boolean") {
        throw new Error("host guard fixture cumulative must be a boolean when provided");
    }
    let responseOverride = null;
    if (fixture.responseOverride !== undefined) {
        const override = fixture.responseOverride;
        if (
            !override ||
            typeof override !== "object" ||
            !Number.isInteger(override.status) ||
            override.status < 0 ||
            override.status > 255 ||
            typeof override.output !== "string"
        ) {
            throw new Error("host guard fixture responseOverride must contain status and output");
        }
        responseOverride = { status: override.status, output: override.output };
    }
    return {
        processes: fixture.processes,
        cpuSamples: fixture.cpuSamples,
        cumulative: fixture.cumulative === true,
        responseOverride,
    };
};

const readBaseline = (path) => {
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    if (!baseline || baseline.schemaVersion !== CPU_BASELINE_SCHEMA || !Array.isArray(baseline.cpus)) {
        throw new Error("host guard CPU baseline is malformed");
    }
    return baseline.cpus;
};

const writeBaseline = (path, snapshot) => {
    const temporary = `${path}.tmp.${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: CPU_BASELINE_SCHEMA, cpus: snapshot })}\n`, {
        mode: 0o600,
    });
    renameSync(temporary, path);
};

const liveProcesses = () => {
    const ps = execFileSync("ps", ["-axo", "pid=,pgid=,state=,comm=,args="], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
    });
    return parsePsSnapshot(ps);
};

const parseArguments = (args) => {
    const options = { excludedPids: [], excludedPgids: [], fixture: null, resetBaseline: false };
    for (const argument of args) {
        const [name, value] = argument.split(/=(.*)/s, 2);
        if (value === undefined || value === "") throw new Error(`invalid argument: ${argument}`);
        switch (name) {
            case "--min-idle-cpus":
                if (options.minimumIdleCpus !== undefined) throw new Error(`${name} may be provided only once`);
                options.minimumIdleCpus = finiteInteger(value, name, 1);
                break;
            case "--sample-ms":
                if (options.sampleMilliseconds !== undefined) throw new Error(`${name} may be provided only once`);
                options.sampleMilliseconds = finiteInteger(value, name, 10);
                if (options.sampleMilliseconds > 60_000) throw new Error(`${name} must be <= 60000`);
                break;
            case "--exclude-pid":
                options.excludedPids.push(finiteInteger(value, name, 1));
                break;
            case "--exclude-pgid":
                options.excludedPgids.push(finiteInteger(value, name, 1));
                break;
            case "--fixture":
                if (options.fixture !== null) throw new Error(`${name} may be provided only once`);
                options.fixture = value;
                break;
            case "--cpu-baseline":
                if (options.cpuBaseline !== undefined) throw new Error(`${name} may be provided only once`);
                options.cpuBaseline = value;
                break;
            case "--reset-baseline":
                if (value !== "0" && value !== "1") throw new Error(`${name} must be exactly 0 or 1`);
                options.resetBaseline = value === "1";
                break;
            default:
                throw new Error(`unknown argument: ${name}`);
        }
    }
    if (options.minimumIdleCpus === undefined) throw new Error("--min-idle-cpus is required");
    if (options.sampleMilliseconds === undefined) throw new Error("--sample-ms is required");
    if (options.cpuBaseline === undefined || options.cpuBaseline.length === 0) {
        throw new Error("--cpu-baseline is required");
    }
    return options;
};

const main = async () => {
    let options;
    try {
        options = parseArguments(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(
            `${JSON.stringify({ schemaVersion: 1, ok: false, kind: "usage-error", error: String(error) })}\n`,
        );
        process.exit(EXIT_USAGE);
    }

    try {
        const fixture = options.fixture ? loadFixture(options.fixture) : null;
        if (fixture?.responseOverride) {
            process.stdout.write(fixture.responseOverride.output);
            process.exit(fixture.responseOverride.status);
        }
        let before;
        let after;
        if (options.resetBaseline) {
            before = fixture ? fixture.cpuSamples[0] : freshCpus();
            if (!fixture) await sleep(options.sampleMilliseconds);
            after = fixture ? fixture.cpuSamples[1] : freshCpus();
        } else if (fixture && !fixture.cumulative) {
            before = fixture.cpuSamples[0];
            after = fixture.cpuSamples[1];
        } else {
            before = readBaseline(options.cpuBaseline);
            after = fixture ? fixture.cpuSamples[1] : freshCpus();
        }
        const processes = fixture ? fixture.processes : liveProcesses();
        const snapshot = { processes, cpuSamples: [before, after] };
        const assessment = assessHostContention({ ...snapshot, ...options });
        writeBaseline(options.cpuBaseline, after);
        process.stdout.write(`${JSON.stringify(assessment)}\n`);
        process.exit(assessment.ok ? 0 : EXIT_CONTENTION);
    } catch (error) {
        const kind = error?.exitCode === EXIT_USAGE ? "configuration-error" : "probe-error";
        process.stderr.write(`${JSON.stringify({ schemaVersion: 1, ok: false, kind, error: String(error) })}\n`);
        process.exit(error?.exitCode ?? EXIT_PROBE_ERROR);
    }
};

if (import.meta.main) await main();
