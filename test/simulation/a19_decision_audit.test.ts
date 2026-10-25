import { describe, expect, test } from "bun:test";
import {
    auditCandidateCategory,
    holmAuditPValues,
    pairedAuditEvidence,
    readA19AuditProfile,
    selectAuditTurns,
} from "../../src/simulation/a19_decision_audit";

const sources = {
    search: `export const BOT_SEARCH_PRODUCTION_REVISION = "a19-material-r2-v1" as const;
        const environments = Object.freeze({ a19: Object.freeze({
            ...buildV08A19SearchEnvironment(), SEARCH_A19_MATERIAL_ARBITRATION: "ties",
            SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1", SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1",
            V08_A19_SEARCH_ENV_OVERRIDES: undefined,
        }) });`,
    draft: `export const DEFAULT_RANKED_DRAFT_POLICY_SPEC = "ranked-unit-strength-a19-side-v4-w16-r4" satisfies Policy;`,
    setup: "export const V08_RANKED_SETUP_POLICY_SPEC = `${ARTIFACT_FIT_SETUP_PREFIX_V6}conditional-v1:sniper+t2a19`;",
};

describe("server A19 profile receipt", () => {
    test("reads server overrides and setup without executing serving code or ambient research overrides", () => {
        const prior = process.env.V08_A19_SEARCH_ENV_OVERRIDES;
        process.env.V08_A19_SEARCH_ENV_OVERRIDES = '{"SEARCH_ROLLOUTS":"99"}';
        try {
            const profile = readA19AuditProfile(sources);
            expect(profile.revision).toBe("a19-material-r2-v1");
            expect(profile.environment.SEARCH_ROLLOUTS).toBe("2");
            expect(profile.environment.SEARCH_A19_COMPLEMENTARY_R2).toBe("1");
            expect(profile.environment.SEARCH_A19_CERTIFIED_TIGHT_BOUNDS).toBe("1");
            expect(profile.environment.SEARCH_A19_MATERIAL_ARBITRATION).toBe("ties");
            expect(profile.setup).toBe("artifact-fit-v6:conditional-v1:sniper+t2a19");
            expect(process.env.V08_A19_SEARCH_ENV_OVERRIDES).toBe('{"SEARCH_ROLLOUTS":"99"}');
        } finally {
            if (prior === undefined) delete process.env.V08_A19_SEARCH_ENV_OVERRIDES;
            else process.env.V08_A19_SEARCH_ENV_OVERRIDES = prior;
        }
    });
    test("refuses an unknown computed override rather than silently measuring a different baseline", () => {
        expect(() =>
            readA19AuditProfile({ ...sources, search: sources.search.replace('"ties"', "getMode()") }),
        ).toThrow("Non-static");
        expect(() =>
            readA19AuditProfile({
                ...sources,
                search: sources.search.replace("buildV08A19SearchEnvironment()", "otherProfile()"),
            }),
        ).toThrow("Unknown server");
        expect(() =>
            readA19AuditProfile({ ...sources, setup: sources.setup.replace("PREFIX_V6", "PREFIX_V7") }),
        ).toThrow("Unrecognized");
    });
});

test("sampling covers both teams and fight phases without inspecting pruning, actions or outcomes", () => {
    const turns = Array.from({ length: 60 }, (_, ordinal) => ({
        ordinal,
        team: ordinal % 2,
        lap: Math.floor(ordinal / 6) + 1,
    }));
    const sampled = selectAuditTurns(turns, 918283);
    expect(sampled).toHaveLength(6);
    expect(selectAuditTurns([...turns].reverse(), 918283)).toEqual(sampled);
    const strata = sampled.map((ordinal) => {
        const turn = turns[ordinal];
        return `${turn.team}:${turn.lap <= 2 ? "opening" : turn.lap <= 5 ? "middle" : "late"}`;
    });
    expect(new Set(strata).size).toBe(6);
    expect(selectAuditTurns(turns, 918283, 2)).toHaveLength(12);
});

test("candidate causes distinguish pre-shortlist omission, shortlist rejection and final scoring", () => {
    const full = new Set(["anchor", "a", "b"]),
        shortlist = new Set(["anchor", "b"]);
    expect(auditCandidateCategory("new", full, shortlist)).toBe("missing");
    expect(auditCandidateCategory("a", full, shortlist)).toBe("shortlist");
    expect(auditCandidateCategory("b", full, shortlist)).toBe("scoring");
});

test("paired terminal evidence preserves negative results, draws and seed pairing", () => {
    const evidence = pairedAuditEvidence([0, 1, 0.5, 0.5], [1, 0, 0.5, 1]);
    expect(evidence.mean).toBe(0.125);
    expect([evidence.improved, evidence.worsened, evidence.tied]).toEqual([2, 1, 1]);
    expect(evidence.p).toBeGreaterThan(0.05);
    expect(pairedAuditEvidence(Array(8).fill(0), Array(8).fill(1)).p).toBe(2 / 256);
    expect(pairedAuditEvidence([1, 1], [0, 0]).mean).toBe(-1);
    expect(pairedAuditEvidence([0, 1], [0, 1]).p).toBe(1);
    expect(() => pairedAuditEvidence([0.7], [1])).toThrow("completed");
    expect(() => pairedAuditEvidence([0], [1, 1])).toThrow("Unpaired");
});

test("Holm adjustment includes every comparison and is monotone in sorted p-values", () => {
    expect(holmAuditPValues([0.04, 0.001, 0.02])).toEqual([0.04, 0.003, 0.04]);
    expect(holmAuditPValues([1, 1, 1])).toEqual([1, 1, 1]);
    expect(() => holmAuditPValues([Number.NaN])).toThrow("Invalid");
});

test("importing the audit does not patch production SearchDriver methods", async () => {
    const { SearchDriver } = await import("../../src/simulation/search_driver");
    const names = ["chooseDecision", "shortlistCandidates", "scoreCandidates", "rollout", "simPlayTurn"];
    const before = names.map((name) => Reflect.get(SearchDriver.prototype, name));
    await import("../../src/simulation/measure_a19_decision_audit");
    expect(names.map((name) => Reflect.get(SearchDriver.prototype, name))).toEqual(before);
});
