import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directories: string[] = [];
afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function run(mode: string) {
    const directory = mkdtempSync(join(tmpdir(), "hoc-completed-worker-cli-"));
    directories.push(directory);
    const artifact = join(directory, "results.json");
    const child = Bun.spawn(
        [
            process.execPath,
            fileURLToPath(new URL("./completed_worker_cli_fixture.ts", import.meta.url)),
            artifact,
            mode,
        ],
        { stdout: "pipe", stderr: "pipe" },
    );
    const timeout = setTimeout(() => child.kill(), 4_000);
    // Leave the child's pipes full briefly. A direct exit without draining loses the completion receipts.
    await Bun.sleep(30);
    try {
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { artifact, stdout, stderr, code };
    } finally {
        clearTimeout(timeout);
        child.kill();
    }
}

test("a completed worker CLI saves every result and drains both output pipes before exiting", async () => {
    const result = await run("success");
    expect(result.code).toBe(0);
    const records = JSON.parse(readFileSync(result.artifact, "utf8")) as { value: number }[];
    expect(records.map(({ value }) => value)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.stdout).toBe("o".repeat(1024 * 1024) + "\ncomplete\n");
    expect(result.stderr).toBe("e".repeat(1024 * 1024) + "\nreceipt\n");
});

for (const mode of ["task-error", "write-error"]) {
    test(`a ${mode} cannot produce a successful worker CLI receipt`, async () => {
        const result = await run(mode);
        expect(result.code).toBe(1);
        expect(existsSync(result.artifact)).toBe(false);
        expect(result.stdout).not.toContain("complete");
        expect(result.stderr).toContain(mode === "task-error" ? "fixture failure 3" : "ENOENT");
    });
}
