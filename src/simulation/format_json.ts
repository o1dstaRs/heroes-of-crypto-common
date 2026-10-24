import { spawnSync } from "node:child_process";

/** Print JSON the way `bun fmt` does, with the same width and indent the old Prettier call used. */
export const formatJson = (value: unknown): string => {
    const source = JSON.stringify(value, null, 4);
    const result = spawnSync(
        process.execPath,
        ["fmt", "--no-script", "--parser=json", "--print-width=120", "--tab-width=4", "--stdin-filepath=artifact.json"],
        { input: source, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error((result.stderr || `bun fmt exited ${result.status}`).trim());
    }
    return result.stdout;
};
