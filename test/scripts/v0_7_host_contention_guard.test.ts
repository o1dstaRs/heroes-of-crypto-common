import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
    assessHostContention,
    idleCpuEquivalent,
    isHocComputeProcess,
    parsePsSnapshot,
} from "../../scripts/v0_7_host_contention_guard.mjs";

const roots: string[] = [];
const repoRoot = resolve(import.meta.dir, "../..");
const supervisor = join(repoRoot, "scripts/run_v0_7_96h.sh");

const cpu = (user: number, idle: number) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
const snapshot = (user: number, idle: number, count = 2) => Array.from({ length: count }, () => cpu(user, idle));

const fixture = (before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>, processes = []) => ({
    schemaVersion: 1,
    cumulative: true,
    cpuSamples: [before, after],
    processes,
});

const temporaryRoot = () => {
    const path = mkdtempSync(join(tmpdir(), "v07-host-guard-"));
    roots.push(path);
    return path;
};

const atomicJson = (path: string, value: unknown) => {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`);
    renameSync(temporary, path);
};

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await Bun.sleep(25);
    }
    throw new Error(`condition did not become true within ${timeoutMs}ms`);
};

const waitForExit = (child: ReturnType<typeof spawn>, timeoutMs = 10_000) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
        const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`child did not exit within ${timeoutMs}ms`));
        }, timeoutMs);
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            resolveExit({ code, signal });
        });
    });

const writeExecutable = (path: string, content: string) => {
    writeFileSync(path, content);
    chmodSync(path, 0o755);
};

const portableCommandStubs = (root: string) => {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeExecutable(join(bin, "flock"), "#!/bin/sh\nexit 0\n");
    writeExecutable(
        join(bin, "realpath"),
        '#!/bin/sh\n[ "$1" = "-m" ] && shift\n[ "$1" = "--" ] && shift\nexec /usr/bin/python3 -c \'import os,sys; print(os.path.abspath(sys.argv[1]))\' "$1"\n',
    );
    writeExecutable(
        join(bin, "setsid"),
        "#!/usr/bin/python3\nimport os, sys\nos.setsid()\nos.execvp(sys.argv[1], sys.argv[1:])\n",
    );
    return bin;
};

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("v0.7 host contention assessment", () => {
    it("uses an explicit idle-CPU boundary and rejects counter or CPU-count drift", () => {
        const before = snapshot(0, 0, 4);
        const boundary = snapshot(100, 100, 4);
        expect(idleCpuEquivalent(before, boundary).idleCpus).toBe(2);
        expect(
            assessHostContention({
                processes: [],
                cpuSamples: [before, boundary],
                minimumIdleCpus: 2,
            }).ok,
        ).toBe(true);
        expect(
            assessHostContention({
                processes: [],
                cpuSamples: [before, snapshot(101, 99, 4)],
                minimumIdleCpus: 2,
            }),
        ).toMatchObject({ ok: false, reasons: ["insufficient-idle-cpu"] });
        expect(() => idleCpuEquivalent(before, snapshot(1, 1, 3))).toThrow("CPU count changed");
        expect(() => idleCpuEquivalent(boundary, before)).toThrow("counter regressed");
        expect(() =>
            assessHostContention({ processes: [], cpuSamples: [before, boundary], minimumIdleCpus: 5 }),
        ).toThrow("exceeds detected CPU count");
    });

    it("rejects foreign live HoC compute but excludes the active PGID, zombies, and shell text", () => {
        const processes = [
            { pid: 10, pgid: 10, state: "R", comm: "bun", command: "bun src/simulation/run_tournament.ts" },
            { pid: 11, pgid: 40, state: "S", comm: "bun", command: "bun src/simulation/optimizer/v0_7_overnight.mjs" },
            { pid: 12, pgid: 12, state: "Z", comm: "bun", command: "bun src/simulation/run_match.ts" },
            {
                pid: 13,
                pgid: 13,
                state: "S",
                comm: "zsh",
                command: "zsh -lc echo scripts/run_v0_7_96h.sh",
            },
        ];
        const result = assessHostContention({
            processes,
            cpuSamples: [snapshot(0, 0), snapshot(0, 100)],
            minimumIdleCpus: 1,
            excludedPgids: [40],
        });
        expect(result).toMatchObject({
            ok: false,
            reasons: ["other-hoc-compute-process"],
            blockers: [{ pid: 10, state: "R" }],
        });
        expect(isHocComputeProcess(processes[1])).toBe(true);
        expect(isHocComputeProcess(processes[3])).toBe(false);
        expect(isHocComputeProcess({ comm: "bash", command: "bash ./run_v0_7_96h.sh" })).toBe(true);
        expect(isHocComputeProcess({ comm: "run_v0_7_96h.sh", command: "./run_v0_7_96h.sh" })).toBe(true);
        expect(isHocComputeProcess({ comm: "bash", command: "bash -e -c 'echo scripts/run_v0_7_96h.sh'" })).toBe(false);
        expect(
            isHocComputeProcess({ comm: "bash", command: "bash --noprofile -c 'echo scripts/run_v0_7_96h.sh'" }),
        ).toBe(false);
        expect(isHocComputeProcess({ comm: "bash", command: "bash -O extglob -c echo scripts/run_v0_7_96h.sh" })).toBe(
            false,
        );
        expect(
            isHocComputeProcess({ comm: "bash", command: "bash --rcfile /tmp/rc -c echo scripts/run_v0_7_96h.sh" }),
        ).toBe(false);
        expect(
            isHocComputeProcess({ comm: "zsh", command: "zsh -o SH_WORD_SPLIT -c echo scripts/run_v0_7_96h.sh" }),
        ).toBe(false);
        expect(isHocComputeProcess({ comm: "bash", command: "bash scripts/run_v0_7_96h.sh -- -c" })).toBe(true);
        expect(
            parsePsSnapshot(" 21 21 S /opt/homebrew/bi /opt/homebrew/bin/bun src/simulation/run_match.ts\n"),
        ).toEqual([
            {
                pid: 21,
                pgid: 21,
                state: "S",
                comm: "/opt/homebrew/bi",
                command: "/opt/homebrew/bin/bun src/simulation/run_match.ts",
            },
        ]);
    });
});

describe("v0.7 guarded supervisor lifecycle", () => {
    it("covers CPU work between polls and permanently quarantines partial checkpoints", async () => {
        const root = temporaryRoot();
        const out = join(root, "run");
        const fixturePath = join(root, "fixture.json");
        const optimizer = join(root, "optimizer.mjs");
        const bin = portableCommandStubs(root);
        atomicJson(fixturePath, fixture(snapshot(0, 0), snapshot(0, 100)));
        writeFileSync(
            optimizer,
            'import { mkdirSync, writeFileSync } from "node:fs";\n' +
                'const out = process.argv.find((value) => value.startsWith("--out="))?.slice(6);\n' +
                "mkdirSync(`${out}/checkpoints`, { recursive: true });\n" +
                'writeFileSync(`${out}/checkpoints/partial.json`, "partial\\n");\n' +
                "setInterval(() => {}, 1000);\n",
        );
        const env = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            V07_96H_HOST_GUARD: "1",
            V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
            V07_96H_HOST_GUARD_SAMPLE_MS: "10",
            V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
            V07_96H_HOST_GUARD_TEST_MODE: "1",
            V07_96H_HOST_GUARD_FIXTURE: fixturePath,
            V07_96H_HEARTBEAT_SECONDS: "1",
            V07_96H_STOP_GRACE_SECONDS: "2",
            V07_96H_HOURS: "1",
            V07_96H_OPTIMIZER: optimizer,
        };
        const child = spawn("/bin/bash", [supervisor, out], { cwd: repoRoot, env, stdio: "ignore" });

        try {
            await waitFor(
                () => existsSync(join(out, "optimizer.pid")) && existsSync(join(out, "checkpoints/partial.json")),
            );
        } catch (error) {
            const log = existsSync(join(out, "supervisor.log"))
                ? readFileSync(join(out, "supervisor.log"), "utf8")
                : "no supervisor log";
            throw new Error(`${String(error)}\n${log}`);
        }
        // The persisted baseline is idle=100. This next endpoint represents a fully busy
        // cumulative interval, including a foreign burst that ended before this poll.
        atomicJson(fixturePath, fixture(snapshot(0, 0), snapshot(100, 100)));
        const exited = await waitForExit(child);
        expect(exited).toEqual({ code: 80, signal: null });
        const marker = readFileSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8");
        expect(marker).toContain("phase=ongoing");
        expect(marker).toContain("insufficient-idle-cpu");
        expect(readFileSync(join(out, "supervisor.heartbeat"), "utf8")).toContain("state=host-contention-quarantined");
        expect(existsSync(join(out, "checkpoints/partial.json"))).toBe(true);
        expect(existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"))).toBe(false);

        const refused = spawnSync("/bin/bash", [supervisor, out], {
            cwd: repoRoot,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, V07_96H_HOURS: "1" },
            timeout: 5_000,
        });
        expect(refused.status).toBe(80);
        expect(readFileSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8")).toBe(marker);
    }, 20_000);

    it("quarantines when the armed sentinel disappears during a live run", async () => {
        const root = temporaryRoot();
        const out = join(root, "missing-armed");
        const fixturePath = join(root, "fixture.json");
        const optimizer = join(root, "optimizer.mjs");
        const bin = portableCommandStubs(root);
        atomicJson(fixturePath, fixture(snapshot(0, 0), snapshot(0, 100)));
        writeFileSync(optimizer, "setInterval(() => {}, 1000);\n");
        const child = spawn("/bin/bash", [supervisor, out], {
            cwd: repoRoot,
            stdio: "ignore",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
                V07_96H_HEARTBEAT_SECONDS: "1",
                V07_96H_STOP_GRACE_SECONDS: "2",
                V07_96H_HOURS: "1",
                V07_96H_OPTIMIZER: optimizer,
            },
        });
        await waitFor(
            () => existsSync(join(out, "optimizer.pid")) && existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED")),
        );
        rmSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"));
        expect(await waitForExit(child)).toEqual({ code: 80, signal: null });
        const marker = readFileSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8");
        expect(marker).toContain("missing-or-corrupt-armed-ongoing");
        expect(existsSync(join(out, "optimizer.pid"))).toBe(false);
    }, 20_000);

    it("quarantines malformed status-64 helper output", () => {
        const root = temporaryRoot();
        const out = join(root, "malformed-64");
        const fixturePath = join(root, "fixture.json");
        const optimizer = join(root, "optimizer.mjs");
        const bin = portableCommandStubs(root);
        atomicJson(fixturePath, {
            ...fixture(snapshot(0, 0), snapshot(0, 100)),
            responseOverride: { status: 64, output: "" },
        });
        writeFileSync(optimizer, "process.exit(0);\n");
        const result = spawnSync("/bin/bash", [supervisor, out], {
            cwd: repoRoot,
            timeout: 5_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
                V07_96H_HOURS: "1",
                V07_96H_OPTIMIZER: optimizer,
            },
        });
        expect(result.status).toBe(80);
        expect(readFileSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8")).toContain(
            "phase=preflight helper_status=64",
        );
        expect(existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"))).toBe(false);

        const validOut = join(root, "valid-config-64");
        atomicJson(fixturePath, fixture(snapshot(0, 0), snapshot(0, 100)));
        const valid = spawnSync("/bin/bash", [supervisor, validOut], {
            cwd: repoRoot,
            timeout: 5_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "3",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
                V07_96H_HOURS: "1",
                V07_96H_OPTIMIZER: optimizer,
            },
        });
        expect(valid.status).toBe(64);
        expect(existsSync(join(validOut, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"))).toBe(false);
        expect(existsSync(join(validOut, "SUPERVISOR_HOST_GUARD_ARMED"))).toBe(false);

        const malformedSuccessOut = join(root, "malformed-success");
        atomicJson(fixturePath, {
            ...fixture(snapshot(0, 0), snapshot(0, 100)),
            responseOverride: { status: 0, output: "{}\n" },
        });
        const malformedSuccess = spawnSync("/bin/bash", [supervisor, malformedSuccessOut], {
            cwd: repoRoot,
            timeout: 5_000,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
                V07_96H_HOURS: "1",
                V07_96H_OPTIMIZER: optimizer,
            },
        });
        expect(malformedSuccess.status).toBe(80);
        expect(readFileSync(join(malformedSuccessOut, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8")).toContain(
            "invalid success response",
        );
    });

    it("cleanly disarms a healthy signal before optimizer spawn", async () => {
        const root = temporaryRoot();
        const out = join(root, "signal-before-spawn");
        const fixturePath = join(root, "fixture.json");
        const optimizer = join(root, "optimizer.mjs");
        const bin = portableCommandStubs(root);
        atomicJson(fixturePath, { ...fixture(snapshot(0, 0), snapshot(0, 100)), cumulative: false });
        writeFileSync(optimizer, "setInterval(() => {}, 1000);\n");
        const child = spawn("/bin/bash", [supervisor, out], {
            cwd: repoRoot,
            stdio: "ignore",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
                V07_96H_HOST_GUARD_TEST_PRESPAWN_SECONDS: "5",
                V07_96H_HOURS: "1",
                V07_96H_OPTIMIZER: optimizer,
            },
        });
        await waitFor(
            () =>
                existsSync(join(out, "supervisor.host_guard.config")) &&
                existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED")) &&
                !existsSync(join(out, "optimizer.pid")),
        );
        child.kill("SIGTERM");
        expect(await waitForExit(child)).toEqual({ code: 143, signal: null });
        expect(existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"))).toBe(false);
        expect(existsSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"))).toBe(false);
        expect(existsSync(join(out, "supervisor.host_guard.config"))).toBe(true);
    }, 20_000);

    it("refuses guard downgrade, mismatch, and retrofitting an unguarded output", () => {
        const root = temporaryRoot();
        const bin = portableCommandStubs(root);
        const guarded = join(root, "guarded");
        mkdirSync(guarded);
        writeFileSync(
            join(guarded, "supervisor.host_guard.config"),
            "schema=1 enabled=1 min_idle_cpus=1 sample_ms=10 check_seconds=1 helper_protocol=1 test_mode=0 fixture=none\n",
        );
        const base = { cwd: repoRoot, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 5_000 };
        expect(spawnSync("/bin/bash", [supervisor, guarded], base).status).toBe(64);

        const fixturePath = join(root, "fixture.json");
        atomicJson(fixturePath, fixture(snapshot(0, 0), snapshot(0, 100)));
        const mismatch = spawnSync("/bin/bash", [supervisor, guarded], {
            ...base,
            env: {
                ...base.env,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "2",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
            },
        });
        expect(mismatch.status).toBe(64);

        const unguarded = join(root, "unguarded");
        mkdirSync(unguarded);
        writeFileSync(join(unguarded, "run.json"), "{}\n");
        const retrofit = spawnSync("/bin/bash", [supervisor, unguarded], {
            ...base,
            env: {
                ...base.env,
                V07_96H_HOST_GUARD: "1",
                V07_96H_HOST_GUARD_MIN_IDLE_CPUS: "1",
                V07_96H_HOST_GUARD_SAMPLE_MS: "10",
                V07_96H_HOST_GUARD_CHECK_SECONDS: "1",
                V07_96H_HOST_GUARD_TEST_MODE: "1",
                V07_96H_HOST_GUARD_FIXTURE: fixturePath,
            },
        });
        expect(retrofit.status).toBe(64);
    });

    it("promotes a stale armed sentinel before considering terminal state", () => {
        const root = temporaryRoot();
        const bin = portableCommandStubs(root);
        const out = join(root, "stale");
        mkdirSync(out);
        writeFileSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"), "damaged-but-authoritative\n");
        writeFileSync(join(out, "TERMINAL.json"), "{}\n");
        const result = spawnSync("/bin/bash", [supervisor, out], {
            cwd: repoRoot,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            timeout: 5_000,
        });
        expect(result.status).toBe(80);
        expect(existsSync(join(out, "SUPERVISOR_HOST_GUARD_ARMED"))).toBe(false);
        expect(readFileSync(join(out, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"), "utf8")).toBe(
            "damaged-but-authoritative\n",
        );
        expect(readFileSync(join(out, "supervisor.heartbeat"), "utf8")).toContain("state=host-contention-quarantined");

        const dangling = join(root, "dangling");
        mkdirSync(dangling);
        symlinkSync(join(dangling, "missing"), join(dangling, "SUPERVISOR_HOST_CONTENTION_QUARANTINE"));
        const danglingResult = spawnSync("/bin/bash", [supervisor, dangling], {
            cwd: repoRoot,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
            timeout: 5_000,
        });
        expect(danglingResult.status).toBe(80);
    });
});
