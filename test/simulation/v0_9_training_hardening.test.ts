import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";

import { describe, expect, it } from "bun:test";

import {
    runV09ActorCommandsFailFast,
    V09CommandExecutionError,
    type ICommandResult,
} from "../../src/simulation/v0_9/orchestrator";
import { v09TeacherRejectedActionsMessage } from "../../src/simulation/v0_9/teacher_actor";

async function commandFailure(promise: Promise<unknown>): Promise<V09CommandExecutionError> {
    try {
        await promise;
        throw new Error("expected the actor command to fail");
    } catch (error) {
        if (!(error instanceof V09CommandExecutionError)) throw error;
        return error;
    }
}

async function waitForFile(path: string, timeoutMilliseconds = 3_000): Promise<void> {
    const deadline = performance.now() + timeoutMilliseconds;
    while (!existsSync(path)) {
        if (performance.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await Bun.sleep(10);
    }
}

function processExists(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
    }
}

function killIfAlive(pid: number | undefined): void {
    if (pid === undefined) return;
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

function failureAfterMarker(marker: string, exitCode: number, diagnostic: string): string[] {
    return [
        "-e",
        [
            'import { existsSync } from "node:fs";',
            "const deadline = Date.now() + 3_000;",
            `while (!existsSync(${JSON.stringify(marker)}) && Date.now() < deadline) await Bun.sleep(5);`,
            `if (!existsSync(${JSON.stringify(marker)})) process.exit(24);`,
            `process.stderr.write(${JSON.stringify(`${diagnostic}\n`)});`,
            `process.exit(${exitCode});`,
        ].join(" "),
    ];
}

async function childExit(
    child: ChildProcessByStdio<null, Readable, Readable>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
    });
    return new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => accept({ code, signal, stdout, stderr }));
    });
}

describe("v0.9 training failure hardening", () => {
    it("preserves the complete engine rejection diagnosis in the teacher failure", () => {
        const message = v09TeacherRejectedActionsMessage("wide_teacher_train:5896:455935021:binding:anchor", {
            rejectedGreen: 0,
            rejectedRed: 1,
            rejectedDetails: [
                {
                    type: "melee_attack",
                    reason: "unit_not_found",
                    version: "v0.8",
                    creature: "Angel",
                    ammo: 0,
                    possible: "4",
                    cause: "other",
                },
            ],
        });

        expect(message).toBe(
            "teacher game wide_teacher_train:5896:455935021:binding:anchor emitted rejected actions: " +
                'rejectedGreen=0, rejectedRed=1, rejectedDetails=[{"type":"melee_attack",' +
                '"reason":"unit_not_found","version":"v0.8","creature":"Angel","ammo":0,"possible":"4",' +
                '"cause":"other"}]',
        );
        expect(
            v09TeacherRejectedActionsMessage("healthy", {
                rejectedGreen: 0,
                rejectedRed: 0,
                rejectedDetails: [],
            }),
        ).toBeNull();
    });

    it("carries structured command output while bounding the diagnostic message", () => {
        const result: ICommandResult = {
            command: ["bun", "teacher_actor.ts"],
            exitCode: 23,
            signalCode: null,
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:01.000Z",
            elapsedSeconds: 1,
            stdout: `stdout-prefix-${"o".repeat(20_000)}-stdout-tail`,
            stderr: `stderr-prefix-${"e".repeat(20_000)}-stderr-tail`,
            gpuSamples: [],
        };
        const error = new V09CommandExecutionError(result);

        expect(error.result).not.toBe(result);
        expect(error.result.stdout.length).toBe(16_384);
        expect(error.result.stderr.length).toBe(16_384);
        expect(error.diagnostics.stdout).toMatchObject({
            totalCharacters: result.stdout.length,
            omittedCharacters: result.stdout.length - 16_384,
        });
        expect(error.diagnostics.stderr).toMatchObject({
            totalCharacters: result.stderr.length,
            omittedCharacters: result.stderr.length - 16_384,
        });
        expect(error.message).not.toContain("stdout-prefix");
        expect(error.message).not.toContain("stderr-prefix");
        expect(error.message).toContain("stdout-tail");
        expect(error.message).toContain("stderr-tail");
        expect(error.message.length).toBeLessThan(34_000);
    });

    it("does not surface a spawn error until the failed child lifecycle has closed", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-spawn-error-"));
        const sigintListeners = process.listenerCount("SIGINT");
        const sigtermListeners = process.listenerCount("SIGTERM");
        const failure = await commandFailure(
            runV09ActorCommandsFailFast([
                {
                    executable: join(directory, "missing-v0.9-actor"),
                    args: [],
                    cwd: directory,
                },
            ]),
        );

        expect(failure.result).toMatchObject({
            signalCode: null,
            stdout: "",
            stderr: "",
        });
        expect(failure.result.exitCode).toBeLessThan(0);
        expect((failure.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
        expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
        expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    });

    it("terminates sibling actors and escalates from TERM to bounded KILL before surfacing the primary failure", async () => {
        const directory = mkdtempSync(join(tmpdir(), "hoc-v09-fail-fast-"));
        const readyMarker = join(directory, "ready");
        const termMarker = join(directory, "term-observed");
        const stubbornActor = [
            "-e",
            [
                'import { writeFileSync } from "node:fs";',
                `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(termMarker)}, "term\\n"));`,
                `writeFileSync(${JSON.stringify(readyMarker)}, "ready\\n");`,
                "setInterval(() => {}, 1_000);",
            ].join(" "),
        ];
        const failedActor = failureAfterMarker(readyMarker, 23, "primary-diagnostic-token");
        const started = performance.now();
        const sigintListeners = process.listenerCount("SIGINT");
        const sigtermListeners = process.listenerCount("SIGTERM");

        const failure = await commandFailure(
            runV09ActorCommandsFailFast(
                [
                    { executable: process.execPath, args: stubbornActor, cwd: directory },
                    { executable: process.execPath, args: failedActor, cwd: directory },
                ],
                100,
            ),
        );

        expect(failure.message).toContain("command failed (23)");
        expect(failure.message).toContain("primary-diagnostic-token");
        expect(failure.result.stderr).toBe("primary-diagnostic-token\n");
        expect(performance.now() - started).toBeLessThan(3_000);
        expect(existsSync(termMarker)).toBe(true);
        expect(readFileSync(termMarker, "utf8")).toBe("term\n");
        expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
        expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
    });

    if (process.platform !== "win32") {
        it("terminates and reaps the complete POSIX actor process group before returning", async () => {
            const directory = mkdtempSync(join(tmpdir(), "hoc-v09-process-group-"));
            const parentPidMarker = join(directory, "parent.pid");
            const parentTermMarker = join(directory, "parent.term");
            const groupReadyMarker = join(directory, "group.ready");
            const inheritedPidMarker = join(directory, "inherited.pid");
            const inheritedReadyMarker = join(directory, "inherited.ready");
            const inheritedTermMarker = join(directory, "inherited.term");
            const detachedIoPidMarker = join(directory, "detached-io.pid");
            const detachedIoReadyMarker = join(directory, "detached-io.ready");
            const detachedIoTermMarker = join(directory, "detached-io.term");
            const inheritedSource = [
                'import { writeFileSync } from "node:fs";',
                `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(inheritedTermMarker)}, "term\\n"));`,
                `writeFileSync(${JSON.stringify(inheritedReadyMarker)}, "ready\\n");`,
                "setInterval(() => {}, 1_000);",
            ].join(" ");
            const detachedIoSource = [
                'import { writeFileSync } from "node:fs";',
                `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(detachedIoTermMarker)}, "term\\n"));`,
                `writeFileSync(${JSON.stringify(detachedIoReadyMarker)}, "ready\\n");`,
                "setInterval(() => {}, 1_000);",
            ].join(" ");
            const actorSource = [
                'import { spawn } from "node:child_process";',
                'import { existsSync, writeFileSync } from "node:fs";',
                `writeFileSync(${JSON.stringify(parentPidMarker)}, String(process.pid));`,
                `process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(parentTermMarker)}, "term\\n"); ` +
                    "process.exit(0); });",
                `const inherited = spawn(process.execPath, ${JSON.stringify(["-e", inheritedSource])}, ` +
                    '{ stdio: "inherit" });',
                `const detachedIo = spawn(process.execPath, ${JSON.stringify(["-e", detachedIoSource])}, ` +
                    '{ stdio: "ignore" });',
                `writeFileSync(${JSON.stringify(inheritedPidMarker)}, String(inherited.pid));`,
                `writeFileSync(${JSON.stringify(detachedIoPidMarker)}, String(detachedIo.pid));`,
                `while ((!existsSync(${JSON.stringify(inheritedReadyMarker)}) || ` +
                    `!existsSync(${JSON.stringify(detachedIoReadyMarker)}))) await Bun.sleep(5);`,
                `writeFileSync(${JSON.stringify(groupReadyMarker)}, "ready\\n");`,
                "setInterval(() => {}, 1_000);",
            ].join(" ");
            let parentPid: number | undefined;
            let inheritedPid: number | undefined;
            let detachedIoPid: number | undefined;

            try {
                const failure = await commandFailure(
                    runV09ActorCommandsFailFast(
                        [
                            { executable: process.execPath, args: ["-e", actorSource], cwd: directory },
                            {
                                executable: process.execPath,
                                args: failureAfterMarker(groupReadyMarker, 23, "tree-primary-failure"),
                                cwd: directory,
                            },
                        ],
                        100,
                    ),
                );
                parentPid = Number(readFileSync(parentPidMarker, "utf8"));
                inheritedPid = Number(readFileSync(inheritedPidMarker, "utf8"));
                detachedIoPid = Number(readFileSync(detachedIoPidMarker, "utf8"));

                expect(failure.message).toContain("tree-primary-failure");
                expect(existsSync(parentTermMarker)).toBe(true);
                expect(existsSync(inheritedTermMarker)).toBe(true);
                expect(existsSync(detachedIoTermMarker)).toBe(true);
                expect(processExists(parentPid)).toBe(false);
                expect(processExists(inheritedPid)).toBe(false);
                expect(processExists(detachedIoPid)).toBe(false);
            } finally {
                killIfAlive(parentPid);
                killIfAlive(inheritedPid);
                killIfAlive(detachedIoPid);
            }
        });

        it("cleans surviving detached-stdio descendants after either successful or failed leader exit", async () => {
            for (const leaderExitCode of [0, 23]) {
                const directory = mkdtempSync(join(tmpdir(), `hoc-v09-leader-exit-${leaderExitCode}-`));
                const descendantPidMarker = join(directory, "descendant.pid");
                const descendantReadyMarker = join(directory, "descendant.ready");
                const descendantTermMarker = join(directory, "descendant.term");
                const descendantSource = [
                    'import { writeFileSync } from "node:fs";',
                    `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(descendantTermMarker)}, "term\\n"));`,
                    `writeFileSync(${JSON.stringify(descendantReadyMarker)}, "ready\\n");`,
                    "setInterval(() => {}, 1_000);",
                ].join(" ");
                const leaderSource = [
                    'import { spawn } from "node:child_process";',
                    'import { existsSync, writeFileSync } from "node:fs";',
                    `const descendant = spawn(process.execPath, ${JSON.stringify(["-e", descendantSource])}, ` +
                        '{ stdio: "ignore" });',
                    `writeFileSync(${JSON.stringify(descendantPidMarker)}, String(descendant.pid));`,
                    `while (!existsSync(${JSON.stringify(descendantReadyMarker)})) await Bun.sleep(5);`,
                    `process.exit(${leaderExitCode});`,
                ].join(" ");
                let descendantPid: number | undefined;

                try {
                    const failure = await commandFailure(
                        runV09ActorCommandsFailFast(
                            [{ executable: process.execPath, args: ["-e", leaderSource], cwd: directory }],
                            100,
                        ),
                    );
                    descendantPid = Number(readFileSync(descendantPidMarker, "utf8"));

                    expect(failure.result.exitCode).toBe(leaderExitCode);
                    expect((failure.cause as Error).message).toContain("survived its leader exit");
                    expect(existsSync(descendantTermMarker)).toBe(true);
                    expect(processExists(descendantPid)).toBe(false);
                } finally {
                    killIfAlive(descendantPid);
                }
            }
        });

        it("converts external TERM into cleanup-first interruption without module-global signal handlers", async () => {
            const directory = mkdtempSync(join(tmpdir(), "hoc-v09-signal-cleanup-"));
            const actorPidMarker = join(directory, "actor.pid");
            const actorReadyMarker = join(directory, "actor.ready");
            const actorTermMarker = join(directory, "actor.term");
            const resultMarker = join(directory, "result.json");
            const orchestratorModule = resolve(process.cwd(), "src/simulation/v0_9/orchestrator.ts");
            const actorSource = [
                'import { writeFileSync } from "node:fs";',
                `writeFileSync(${JSON.stringify(actorPidMarker)}, String(process.pid));`,
                `process.on("SIGTERM", () => writeFileSync(${JSON.stringify(actorTermMarker)}, "term\\n"));`,
                `writeFileSync(${JSON.stringify(actorReadyMarker)}, "ready\\n");`,
                "setInterval(() => {}, 1_000);",
            ].join(" ");
            const harnessSource = [
                `import { runV09ActorCommandsFailFast, V09ActorCommandsInterruptedError } from ` +
                    `${JSON.stringify(orchestratorModule)};`,
                'import { writeFileSync } from "node:fs";',
                "try {",
                `  await runV09ActorCommandsFailFast([{ executable: process.execPath, args: ` +
                    `${JSON.stringify(["-e", actorSource])}, cwd: ${JSON.stringify(directory)} }], 100);`,
                "  process.exitCode = 96;",
                "} catch (error) {",
                "  const interrupted = error instanceof V09ActorCommandsInterruptedError;",
                `  writeFileSync(${JSON.stringify(resultMarker)}, JSON.stringify({`,
                '    name: error instanceof Error ? error.name : "unknown",',
                "    message: error instanceof Error ? error.message : String(error),",
                "    signal: interrupted ? error.signal : null,",
                "    exitCode: interrupted ? error.exitCode : 97,",
                "  }));",
                "  process.exitCode = interrupted ? error.exitCode : 97;",
                "}",
            ].join("\n");
            const harness = spawn(process.execPath, ["-e", harnessSource], {
                cwd: process.cwd(),
                stdio: ["ignore", "pipe", "pipe"],
            });
            let actorPid: number | undefined;

            try {
                await waitForFile(actorReadyMarker);
                actorPid = Number(readFileSync(actorPidMarker, "utf8"));
                expect(harness.kill("SIGTERM")).toBe(true);
                const outcome = await childExit(harness);
                const result = JSON.parse(readFileSync(resultMarker, "utf8")) as {
                    name: string;
                    message: string;
                    signal: string | null;
                    exitCode: number;
                };

                expect(outcome).toMatchObject({ code: 143, signal: null });
                expect(outcome.stderr).toBe("");
                expect(result).toEqual({
                    name: "V09ActorCommandsInterruptedError",
                    message:
                        "v0.9 actor commands were interrupted by SIGTERM; " +
                        "every owned actor process group was terminated",
                    signal: "SIGTERM",
                    exitCode: 143,
                });
                expect(existsSync(actorTermMarker)).toBe(true);
                expect(processExists(actorPid)).toBe(false);
            } finally {
                killIfAlive(actorPid);
                if (harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
            }
        });
    }
});
