import { expect, test } from "bun:test";
import {
    V09_A19_CANDIDATE_FEATURES,
    V09_A19_OBSERVATION_SHA256,
    V09_A19_SPELL_NAMES,
} from "../../src/simulation/v0_9/a19_observation";

const trainedContract = "8215d66c7477692586be173c382ed40b3dafc2d4161769fef3be8ae7eb418af3";

test("V2 retains the feature layout used by existing fitted models", () => {
    expect(V09_A19_OBSERVATION_SHA256).toBe(trainedContract);
    expect(V09_A19_CANDIDATE_FEATURES).toHaveLength(204);
    expect(V09_A19_SPELL_NAMES).toHaveLength(90);
    expect(Object.isFrozen(V09_A19_SPELL_NAMES)).toBe(true);
    expect(V09_A19_CANDIDATE_FEATURES.indexOf("spell_Fireball")).toBe(143);
    expect(V09_A19_CANDIDATE_FEATURES.indexOf("spell_Whirlpool")).toBe(199);
});

test("new spell configuration cannot insert or shift trained V2 columns", () => {
    const script = `
        import spells from "./src/configuration/spells.json";
        spells["future-spell-contract-probe"] = {
            first: {name: "AAA future spell"},
            middle: {name: "Sylvan Focus Blessing"},
            last: {name: "ZZZ future spell"},
        };
        const observation = await import("./src/simulation/v0_9/a19_observation.ts");
        console.log(JSON.stringify({
            hash: observation.V09_A19_OBSERVATION_SHA256,
            columns: observation.V09_A19_CANDIDATE_FEATURES,
        }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: new URL("../..", import.meta.url).pathname,
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const actual = JSON.parse(result.stdout.toString());
    expect(actual.hash).toBe(trainedContract);
    expect(actual.columns).toEqual(V09_A19_CANDIDATE_FEATURES);
});
