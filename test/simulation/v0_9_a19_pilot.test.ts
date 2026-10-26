import { describe, expect, test } from "bun:test";

import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import type { A19AuditProfile } from "../../src/simulation/a19_decision_audit";
import { runMatch, GREEN_TEAM, type IMatchConfig } from "../../src/simulation/battle_engine";
import { SearchDriver } from "../../src/simulation/search_driver";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";
import { withV09PilotDriverAudit } from "../../src/simulation/v0_9/a19_pilot";
import { withV09A19Recording } from "../../src/simulation/v0_9/a19_pilot_recording";
import {
    V09_A19_ENTITY_FEATURES,
    V09_A19_CANDIDATE_FEATURES,
    V09_A19_OBSERVATION_SHA256,
} from "../../src/simulation/v0_9/a19_observation";
import {
    buildV09A19PilotManifest,
    validateV09A19PilotManifest,
    v09PilotBoardStatistics,
    V09_A19_PILOT_STAGES,
} from "../../src/simulation/v0_9/a19_pilot_protocol";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import { encodeV09A19Observation } from "../../src/simulation/v0_9/a19_observation";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../src/ai/candidates";
import { FightStateManager } from "../../src/fights/fight_state_manager";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { PathHelper } from "../../src/grid/path_helper";
import { createCombatTestContext, createTestUnit, placeUnit } from "../helpers/combat";

const environment = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () =>
    Object.fromEntries(Object.entries(buildV08A19SearchEnvironment()).filter(([, value]) => value !== undefined)),
) as Record<string, string>;
const profile: A19AuditProfile = {
    revision: "fixture-r2",
    draft: "ranked-unit-strength-a19-side-v4-w16-r4",
    setup: "fixture",
    environment,
    overrides: {},
    sourceSha256: {},
};
const manifest = () =>
    buildV09A19PilotManifest({
        source: { files: {}, sha256: fingerprintV09({}) },
        profile,
        seed: 732619,
        sourceCommit: "a".repeat(40),
        runtime: Bun.version,
        protectedV08Roots: ["/protected-v08"],
    });

describe("A19 R2 learning pilot registration", () => {
    test("freezes the actual R2 opponent and keeps every development/confirmation/corpus board disjoint", () => {
        const value = manifest();
        expect(() => validateV09A19PilotManifest(value)).not.toThrow();
        expect(() => validateV09A19PilotManifest(JSON.parse(JSON.stringify(value)))).not.toThrow();
        expect(value.baseline.SEARCH_ROLLOUTS).toBe("2");
        expect(value.teacher.SEARCH_ROLLOUTS).toBe("4");
        expect(value.teacher.SEARCH_A19_COMPLEMENTARY_R2).toBe("0");
        const seeds = Object.values(value.stages).flat();
        expect(new Set(seeds).size).toBe(seeds.length);
        const channels = seeds.flatMap((seed) => [seed, seed + 1, seed + 2]);
        expect(new Set(channels).size).toBe(channels.length);
        for (const [stage, count] of Object.entries(V09_A19_PILOT_STAGES))
            expect(value.stages[stage as keyof typeof V09_A19_PILOT_STAGES]).toHaveLength(count);
        const { manifestSha256: _hash, ...modified } = {
            ...value,
            teacher: { ...value.teacher, SEARCH_HORIZON: "16" },
        };
        expect(fingerprintV09(modified)).not.toBe(_hash);
        expect(() => validateV09A19PilotManifest({ ...modified, manifestSha256: fingerprintV09(modified) })).toThrow();
    });

    test("registers a higher precision teacher without widening the production candidate catalog", () => {
        const value = buildV09A19PilotManifest({ ...manifest(), teacherPreset: "precise-r8" });
        expect(() => validateV09A19PilotManifest(JSON.parse(JSON.stringify(value)))).not.toThrow();
        expect(value.teacher.SEARCH_ROLLOUTS).toBe("8");
        expect(value.teacher.SEARCH_A19_COMPLEMENTARY_R2).toBe("0");
        for (const key of [
            "SEARCH_HORIZON",
            "SEARCH_SHORTLIST",
            "SEARCH_MAX_MELEE",
            "SEARCH_MAX_MOVES",
            "SEARCH_MAX_SHOTS",
        ])
            expect(value.teacher[key]).toBe(value.baseline[key]);
        expect(value.teacher.SEARCH_A19_CERTIFIED_SELECTION_BOUNDS).toBe("0");
    });

    test("rejects a stale a13 or R4 opponent even when it still uses the v0.8 version label", () => {
        for (const field of [
            { SEARCH_HORIZON: "12" },
            { SEARCH_ROLLOUTS: "4" },
            { SEARCH_A19_COMPLEMENTARY_R2: "0" },
        ]) {
            const value = manifest();
            expect(() =>
                buildV09A19PilotManifest({
                    ...value,
                    profile: { ...profile, environment: { ...environment, ...field } },
                }),
            ).toThrow("complementary R2");
        }
    });

    test("reports independent boards and retains their four correlated games as one sampling unit", () => {
        const result = v09PilotBoardStatistics(Array(12).fill(0.5), 1, 1000);
        expect(result).toEqual({ boards: 12, games: 48, score: 0.5, lower95: 0.5, upper95: 0.5 });
        const varied = [0, 0.5, 1, 1, 0.5, 0, 0, 0.5, 1, 1, 0.5, 0];
        expect(v09PilotBoardStatistics(varied, 9, 1000)).toEqual(v09PilotBoardStatistics(varied, 9, 1000));
        expect(v09PilotBoardStatistics(varied, 9, 1000).lower95).toBeLessThan(0.5);
        expect(v09PilotBoardStatistics(varied, 9, 1000).upper95).toBeGreaterThan(0.5);
        expect(() => v09PilotBoardStatistics([0.5], 1)).toThrow();
        expect(v09PilotBoardStatistics([0, 0.5, 1], 1).lower95).toBeNull();
    });
});

const tinyMatch: IMatchConfig = {
    greenVersion: "v0.8",
    redVersion: "v0.8",
    roster: [{ faction: "Life", creatureName: "Arbalester", level: 1, size: 1, amount: 20 }],
    redRoster: [{ faction: "Life", creatureName: "Peasant", level: 1, size: 1, amount: 100 }],
    seed: 24691,
    maxLaps: 2,
    searchOfflineDeterministicWork: true,
    researchA19BaseSearchEnvironment: environment,
};

test("pilot instrumentation preserves complete real-engine results and restores itself after a mismatch", () => {
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const original = SearchDriver.prototype.chooseDecision;
            const control = runMatch(tinyMatch);
            const audited = withV09PilotDriverAudit(GREEN_TEAM, environment, environment, () => runMatch(tinyMatch));
            expect(audited.value).toEqual(control);
            expect(audited.counts.baseline).toBeGreaterThan(0);
            expect(audited.counts.candidate).toBeGreaterThan(0);
            expect(SearchDriver.prototype.chooseDecision).toBe(original);
            expect(() =>
                withV09PilotDriverAudit(GREEN_TEAM, environment, { ...environment, SEARCH_ROLLOUTS: "8" }, () =>
                    runMatch(tinyMatch),
                ),
            ).toThrow("Actual pilot search");
            expect(SearchDriver.prototype.chooseDecision).toBe(original);
        },
    );
}, 120_000);

test("board recording preserves played actions and retains aligned independent rollout samples", () => {
    const teacher = {
        ...environment,
        SEARCH_ROLLOUTS: "4",
        SEARCH_A19_COMPLEMENTARY_R2: "0",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "0",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "0",
    };
    const config = { ...tinyMatch, maxLaps: 4, researchA19BaseSearchEnvironment: teacher };
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const control = runMatch(config);
            const captured = withV09A19Recording(GREEN_TEAM, 11328, () => runMatch(config), 1);
            expect(captured.value).toEqual(control);
            expect(captured.decisions.length).toBeGreaterThan(0);
            for (const row of captured.decisions) {
                expect(row.observation.contractSha256).toBe(V09_A19_OBSERVATION_SHA256);
                expect(row.observation.terrain).toHaveLength(256);
                expect(row.observation.terrain.every((value) => value >= 0 && value < 5)).toBe(true);
                expect(row.observation.entities[row.observation.actorIndex][1]).toBe(1);
                for (const entity of row.observation.entities) {
                    expect(entity).toHaveLength(V09_A19_ENTITY_FEATURES.length);
                    expect(entity.every(Number.isFinite)).toBe(true);
                }
                for (const candidate of row.observation.candidates)
                    expect(candidate.features).toHaveLength(V09_A19_CANDIDATE_FEATURES.length);
                for (const samples of row.samples)
                    if (samples) {
                        expect(samples.map((sample) => sample.index)).toEqual([0, 1, 2, 3]);
                        expect(
                            samples.every(
                                (sample) =>
                                    Number.isFinite(sample.material) && sample.material >= 0 && sample.material <= 1,
                            ),
                        ).toBe(true);
                    }
                expect(row.teacherMaterialMeans).toEqual(
                    row.samples.map((samples) =>
                        samples ? samples.reduce((sum, sample) => sum + sample.material, 0) / samples.length : null,
                    ),
                );
                expect(row.samples[row.selectedIndex]).not.toBeNull();
                expect(
                    row.teacherStandardErrors
                        .filter((value) => value !== null)
                        .every((value) => Number.isFinite(value) && value >= 0),
                ).toBe(true);
            }
        },
    );
}, 120_000);

test("precision recording retains every R8 sample without changing played actions", () => {
    const teacher = {
        ...environment,
        SEARCH_ROLLOUTS: "8",
        SEARCH_A19_COMPLEMENTARY_R2: "0",
        SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "0",
        SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "0",
    };
    const config = { ...tinyMatch, maxLaps: 4, researchA19BaseSearchEnvironment: teacher };
    withScopedAIEnvironment(
        { V08_A19_SEARCH: "1", V08_A13_SEARCH: undefined, V08_A19_SEARCH_ENV_OVERRIDES: undefined },
        () => {
            const control = runMatch(config);
            const captured = withV09A19Recording(GREEN_TEAM, 11328, () => runMatch(config), 1);
            expect(captured.value).toEqual(control);
            expect(captured.decisions.length).toBeGreaterThan(0);
            for (const row of captured.decisions)
                for (const samples of row.samples)
                    if (samples) expect(samples.map((sample) => sample.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        },
    );
}, 120_000);

test("observation preserves occupied lava, mirrored rectangle geometry, and distinct spell actions", () => {
    const fixture = (right: boolean) => {
        const base = createCombatTestContext(PBTypes.GridVals.LAVA_CENTER);
        const actor = createTestUnit({
            team: right ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
            footprintWidth: 2,
            footprintHeight: 1,
            abilities: ["Made of Fire"],
        });
        const enemy = createTestUnit({ team: right ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT });
        placeUnit(base.grid, base.unitsHolder, actor, { x: right ? 9 : 7, y: 7 });
        placeUnit(base.grid, base.unitsHolder, enemy, { x: right ? 1 : 14, y: 12 });
        const fightProperties = FightStateManager.getInstance().getFightProperties();
        fightProperties.setSideOrientedPlacement(true);
        fightProperties.startFight();
        const context = {
            ...base,
            fightProperties,
            matrix: base.grid.getMatrix(),
            pathHelper: new PathHelper(base.grid.getSettings()),
        };
        const candidate = enumerateCandidates(actor, context, [{ type: "defend_turn", unitId: actor.getId() }])
            .candidates[0];
        return { ...base, actor, context, candidate };
    };
    const left = fixture(false);
    expect(left.grid.getMatrixNoUnits()[7][7]).toBe(0);
    const observed = encodeV09A19Observation(left.actor, left.context, [left.candidate]);
    expect(observed.terrain[7 * 16 + 7]).toBe(3);
    const right = fixture(true);
    const mirrored = encodeV09A19Observation(right.actor, right.context, [right.candidate]);
    for (const column of [2, 3, 4, 5])
        expect(mirrored.entities[mirrored.actorIndex][column]).toBe(observed.entities[observed.actorIndex][column]);
    const spells: IEnumeratedCandidate[] = ["Heal", "Blessing"].map((spellName) => ({
        ...right.candidate,
        kind: "spell",
        spellName,
        actions: [{ type: "cast_spell", casterId: right.actor.getId(), spellName, targetId: right.actor.getId() }],
    }));
    const spellInputs = encodeV09A19Observation(right.actor, right.context, spells);
    expect(spellInputs.candidates[0].features[V09_A19_CANDIDATE_FEATURES.indexOf("spell_Heal")]).toBe(1);
    expect(spellInputs.candidates[1].features[V09_A19_CANDIDATE_FEATURES.indexOf("spell_Heal")]).toBe(0);
    right.grid.cleanupCenterObstacle();
    expect(encodeV09A19Observation(right.actor, right.context, [right.candidate]).terrain[7 * 16 + 7]).toBe(0);
});
