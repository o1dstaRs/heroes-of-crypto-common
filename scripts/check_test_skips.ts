import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const testFileGlobs = [
    new Bun.Glob("**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx}"),
    new Bun.Glob("**/{test_*.py,*_test.py,*.test.py,*.spec.py}"),
];
const forbiddenSkip =
    /\b(?:xdescribe|xit|xtest)\s*\(|\b(?:test|it|describe|suite)\s*\.\s*(?:skip|todo|skipIf|todoIf)\s*\(|\b(?:skip|todo)\s*:\s*true\b|@(?:unittest\.)?skip(?:If|Unless)?\s*\(|\bpytest\.mark\.skip(?:if)?\b|\bself\.skipTest\s*\(/;
const testFiles = new Set<string>();
const violations: string[] = [];

for (const testFileGlob of testFileGlobs) {
    for await (const filePath of testFileGlob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
        if (filePath.split("/").some((part) => part === "node_modules" || part === "dist" || part === ".git")) {
            continue;
        }
        testFiles.add(filePath);
    }
}

for (const filePath of testFiles) {
    const absoluteFilePath = resolve(repositoryRoot, filePath);
    const lines = (await readFile(absoluteFilePath, "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
        if (forbiddenSkip.test(line)) {
            violations.push(`${relative(repositoryRoot, absoluteFilePath)}:${index + 1}: ${line.trim()}`);
        }
    }
}

if (violations.length) {
    console.error("Skipped or todo tests are not allowed:\n" + violations.join("\n"));
    process.exit(1);
}

console.log("Test skip check passed: all common tests are enabled.");
