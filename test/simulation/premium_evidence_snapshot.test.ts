import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { AI_META_COHORTS, AI_META_MAPS, type IAiMetaPairRecord } from "../../src/simulation/ai_meta_cohorts_core";
import {
    PremiumEvidenceAudit,
    auditPremiumEvidence,
    auditPremiumFormationGeometry,
} from "../../src/simulation/audit_premium_evidence";
import {
    PREMIUM_META_FULL_AUGMENTS_STUDY,
    PREMIUM_META_FULL_AUGMENTS_SCHEMA,
} from "../../src/simulation/ai_meta_study";
import { buildPremiumEvidenceSnapshot } from "../../src/simulation/build_premium_evidence_snapshot";
import { PremiumEvidenceSnapshot } from "../../src/simulation/premium_evidence_snapshot";
import { summarizePremiumParticipation } from "../../src/simulation/ai_meta_participation";
import { summarizePremiumCombatMetrics } from "../../src/simulation/ai_meta_combat_metrics";
import { summarizePremiumHealth } from "../../src/simulation/ai_meta_health_ledger";
import { runAiMetaWorkerPool, resolveAiMetaFightProfile } from "../../src/simulation/measure_ai_meta_cohorts";

const sourceSha256 = "a".repeat(64);
let directory: string;
let captured: IAiMetaPairRecord;
let summary: any;
const rawName = "ranked-draft.pairs.jsonl.gz";
const save = (name: string, records: IAiMetaPairRecord[], metadata = summary): string => {
    const folder = join(directory, name);
    const path = join(folder, "summary.json");
    mkdirSync(folder);
    writeFileSync(path, JSON.stringify(metadata));
    writeFileSync(join(folder, rawName), gzipSync(records.map((record) => JSON.stringify(record)).join("\n") + "\n"));
    return path;
};

beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "hoc-premium-snapshot-test-"));
    await runAiMetaWorkerPool(
        {
            cohort: "ranked-draft",
            games: 6,
            baseSeed: 85000717,
            collectEvidence: true,
            studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY,
        },
        1,
        resolveAiMetaFightProfile("a19-work"),
        (record) => {
            captured = record;
        },
        { pairCount: 1 },
    );
    summary = {
        schemaVersion: 1,
        complete: true,
        provenance: {
            sourceSha256,
            baseSeed: 85000717,
            commonDirty: true,
            maps: AI_META_MAPS,
            gamesPerCohort: 2,
            pairWindow: { start: 0, count: 1, fullPairCount: 1 },
            totalPairs: 1,
            totalGames: 2,
            fightProfile: {
                studyProfile: PREMIUM_META_FULL_AUGMENTS_STUDY,
                evidenceSchema: PREMIUM_META_FULL_AUGMENTS_SCHEMA,
                searchBudget: "offline-deterministic-work",
            },
        },
        cohorts: [
            {
                cohort: "ranked-draft",
                rawPath: rawName,
                pairs: 1,
                games: 2,
                rejectedActions: 0,
                distinctRosterViolations: 0,
                overlappingCreatureViolations: 0,
                mapGames: { [captured.map]: 2 },
            },
        ],
    };
}, 180_000);
afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("immutable Premium evidence snapshots", () => {
    it("round-trips real battle evidence with family-level support and indexed compound filters", async () => {
        const input = save("roundtrip", [captured]);
        const output = join(directory, "evidence.sqlite");
        const manifest = await buildPremiumEvidenceSnapshot(input, output, { development: true, includeTraces: true });
        expect(manifest.fights).toBe(2);
        expect(manifest.status).toBe("development");
        expect(manifest.capabilities).toContain("six-axis-empower-v1");
        expect(() => new PremiumEvidenceSnapshot(output, sourceSha256)).toThrow("Development");
        expect(() => new PremiumEvidenceSnapshot(output, "b".repeat(64), { allowDevelopment: true })).toThrow(
            "Incompatible",
        );
        const reader = new PremiumEvidenceSnapshot(output, sourceSha256, { allowDevelopment: true });
        try {
            expect(manifest.capabilities).toContain("combat-participation-v1");
            const participation = reader.participation(captured.evidence!.scenarioId, captured.evidence!.partition);
            expect(participation).toHaveLength(2);
            expect(participation.map((row) => row.aIsGreen)).toEqual([true, false]);
            expect(participation.map((row) => row.participation)).toEqual(
                captured.evidence!.fights!.map(summarizePremiumParticipation),
            );
            expect(
                reader.participation(
                    captured.evidence!.scenarioId,
                    captured.evidence!.partition === "test" ? "train" : "test",
                ),
            ).toEqual([]);
            expect(reader.participation("' OR 1=1 --")).toEqual([]);
            expect(manifest.capabilities).toContain("combat-metrics-v1");
            expect(manifest.capabilities).toContain("combat-unit-metrics-v2");
            expect(
                reader
                    .combatMetrics(captured.evidence!.scenarioId, captured.evidence!.partition)
                    .map((row) => row.metrics),
            ).toEqual(captured.evidence!.fights!.map(summarizePremiumCombatMetrics));
            expect(
                reader.combatMetrics(
                    captured.evidence!.scenarioId,
                    captured.evidence!.partition === "test" ? "train" : "test",
                ),
            ).toEqual([]);
            const creatureId = captured.armyA.creatureIds[0];
            const combatQuery = {
                cohort: "ranked-draft" as const,
                creatureId,
                partition: captured.evidence!.partition,
            };
            const combat = reader.unitCombatMetrics(combatQuery);
            expect(Object.keys(combat.metrics)).toHaveLength(48);
            expect(combat.metrics.offensiveStacks.mean! + combat.metrics.stacksWithoutRecordedOffense.mean!).toBe(
                combat.metrics.stacks.mean!,
            );
            expect(combat.metrics.openingMeasuredStacks.mean).toBe(combat.metrics.stacks.mean);
            expect(manifest.capabilities).toContain("committed-health-v1");
            expect(manifest.capabilities).toContain("committed-health-unit-v2");
            expect(
                reader
                    .healthSummary(captured.evidence!.scenarioId, captured.evidence!.partition)
                    .map((row) => row.summary),
            ).toEqual(captured.evidence!.fights!.map((fight) => summarizePremiumHealth(fight.healthLedger!)));
            const health = reader.unitHealthMetrics(combatQuery);
            expect(health.independentFamilies).toBe(1);
            expect(health.fights).toBe(2);
            expect(health.armyFightObservations).toBe(2);
            expect(combat.fights).toBe(2);
            expect(combat.armyFightObservations).toBe(2);
            const healthBySeat = captured.evidence!.fights!.map((fight) => {
                const ids = new Set(
                    fight.formations.a.unitIdsByStack.filter(
                        (_, index) => fight.formations.a.draftedCreatureIdsByStack[index] === creatureId,
                    ),
                );
                return fight
                    .healthLedger!.flatMap((row) => row.changes)
                    .filter((row) => ids.has(row.unitId) && row.kind === "damage")
                    .reduce((sum, row) => sum + Math.max(0, row.before.hp - row.after.hp), 0);
            });
            expect(health.metrics.damageHp.mean).toBe((healthBySeat[0] + healthBySeat[1]) / 2);
            expect(
                reader.unitHealthMetrics({ ...combatQuery, opponentUnits: [creatureId] }).metrics.damageHp.mean,
            ).toBeNull();
            expect(
                reader.healthSummary(
                    captured.evidence!.scenarioId,
                    captured.evidence!.partition === "test" ? "train" : "test",
                ),
            ).toEqual([]);
            expect(combat.independentFamilies).toBe(1);
            expect(combat.fights).toBe(2);
            // Independently count committed selections for every split child of this drafted creature.
            const perSeat = captured.evidence!.fights!.map((fight) => {
                const ids = new Set(
                    fight.formations.a.unitIdsByStack.filter(
                        (_, index) => fight.formations.a.draftedCreatureIdsByStack[index] === creatureId,
                    ),
                );
                return fight
                    .committedEventBatches!.flatMap((batch) => batch.events)
                    .filter((event) => event.type === "next_unit_selected" && ids.has(event.unitId)).length;
            });
            expect(combat.metrics.activations.mean).toBe((perSeat[0] + perSeat[1]) / 2);
            const unsupported = reader.unitCombatMetrics({ ...combatQuery, opponentUnits: [creatureId] });
            expect(unsupported.independentFamilies).toBe(0);
            expect(unsupported.metrics.activations.mean).toBeNull();
            expect(
                reader.unitCombatMetrics({
                    ...combatQuery,
                    partition: captured.evidence!.partition === "test" ? "train" : "test",
                }).independentFamilies,
            ).toBe(0);
            expect(() => reader.unitCombatMetrics({ ...combatQuery, creatureId: NaN })).toThrow("creature ID");
            const own = captured.armyA;
            const faction = [1, 2, 3, 4].find((id) => !own.synergies.some((choice) => choice.faction === id))!;
            const factionName = ({ 1: "Chaos", 2: "Might", 3: "Nature", 4: "Life" } as const)[faction as 1 | 2 | 3 | 4];
            const inactive = { faction, synergy: captured.evidence!.synergyVariants[factionName], level: 0 };
            expect(reader.unitHealthMetrics({ ...combatQuery, activeSynergies: [inactive] }).independentFamilies).toBe(
                1,
            );
            expect(
                reader.unitHealthMetrics({ ...combatQuery, activeSynergies: [{ ...inactive, level: 1 }] })
                    .independentFamilies,
            ).toBe(0);
            expect(
                reader.query({ ...combatQuery, ownUnits: [creatureId], activeSynergies: [inactive] })
                    .independentFamilies,
            ).toBe(1);
            const query = {
                cohort: captured.cohort,
                partition: captured.evidence!.partition,
                map: captured.map,
                ownUnits: own.creatureIds.slice(0, 2),
                opponentUnits: captured.armyB.creatureIds.slice(0, 1),
                artifactT1: own.artifactT1.id,
                artifactT2: own.artifactT2.id,
                doctrine: own.doctrine,
                augmentPlanId: own.augment.planId,
                variants: [{ faction: PBTypes.FactionVals.LIFE, synergy: captured.evidence!.synergyVariants.Life }],
            };
            const packet = reader.query(query);
            const expected =
                captured.games.reduce(
                    (sum, game) => sum + (game.winner === "a" ? 1 : game.winner === "draw" ? 0.5 : 0),
                    0,
                ) / 2;
            expect(packet.scoreRate).toBe(expected);
            expect(packet.independentFamilies).toBe(1);
            expect(packet.fights).toBe(2);
            expect(packet.armyObservations).toBe(1);
            expect(packet.status).toBe("limited_evidence");
            expect(packet.interval95).toEqual([0, 1]);
            expect(packet.examples[0]).toEqual({ familyId: captured.evidence!.scenarioId, source: rawName, line: 1 });
            expect(reader.query({ ...query, ownUnits: [...query.ownUnits].reverse() }).evidenceId).toBe(
                packet.evidenceId,
            );
            expect(reader.trace(captured.evidence!.scenarioId)).toEqual(captured);
            expect(() => reader.trace("missing")).toThrow("Unknown evidence family");
            const examples = reader.examples(query);
            expect(examples).toHaveLength(1);
            expect(examples[0].draft).toEqual(captured.evidence!.rankedDraft!.decisions);
            expect(examples[0].armies.every((army) => army.formations.length === 2)).toBe(true);
            expect(() => reader.examples(query, 100)).toThrow("bounded");
            const decision = captured.evidence!.rankedDraft!.decisions.find(
                (item) => item.action.type === "pick_creature" && item.status === "accepted",
            )!;
            const draftPacket = reader.draftSupport({
                kind: "pick_creature",
                phase: decision.observation.phaseSequence,
                actionKey: (decision.action as { creatureId: number }).creatureId,
                partition: captured.evidence!.partition,
                ownUnits: decision.observation.creaturesPicked,
                knownOpponentUnits: decision.observation.knownOpponentCreatures,
                doctrine: decision.observation.doctrine,
                variants: [{ faction: PBTypes.FactionVals.LIFE, synergy: captured.evidence!.synergyVariants.Life }],
            });
            expect(draftPacket.independentFamilies).toBe(1);
            expect(draftPacket.interval95).toEqual([0, 1]);
            expect(() => reader.draftSupport({ kind: "select_bundle", phase: 1, actionKey: 0 })).toThrow(
                "exact offer context",
            );
            const bundleDecision = captured.evidence!.rankedDraft!.decisions.find(
                (item) => item.action.type === "select_bundle" && item.status === "accepted",
            )!;
            const bundleIndex = (bundleDecision.action as { bundleIndex: number }).bundleIndex;
            const bundle = bundleDecision.observation.bundles[bundleIndex];
            const bundleScope = {
                kind: "select_bundle" as const,
                phase: 1,
                bundle,
                partition: captured.evidence!.partition,
            };
            expect(reader.draftSupport(bundleScope).independentFamilies).toBe(1);
            expect(reader.draftSupport({ ...bundleScope, map: captured.map }).independentFamilies).toBe(0);
            expect(
                reader.draftSupport({ ...bundleScope, ownUnits: captured.armyA.creatureIds }).independentFamilies,
            ).toBe(0);
            expect(
                reader.draftSupport({ ...bundleScope, bundle: [bundle[0], bundle[1], 2147483647] }).independentFamilies,
            ).toBe(0);
            const both = reader.query({ cohort: captured.cohort, partition: captured.evidence!.partition });
            expect(both.scoreRate).toBe(0.5);
            expect(both.independentFamilies).toBe(1);
            expect(both.armyObservations).toBe(2);
            expect(reader.query({ ...query, ownUnits: [captured.armyB.creatureIds[0]] }).status).toBe("no_evidence");
            expect(() => reader.query({ ...query, augmentPlanId: "' OR 1=1" })).toThrow("Invalid");
            expect(() => reader.query({ ...query, ownUnits: Array(7).fill(1) })).toThrow("six");
        } finally {
            reader.close();
        }
        const sqlite = new Database(output, { readonly: true });
        expect(sqlite.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
        expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
        sqlite.close();
        const bytes = readFileSync(output);
        await expect(buildPremiumEvidenceSnapshot(input, output, { development: true })).rejects.toThrow("overwrite");
        expect(readFileSync(output)).toEqual(bytes);
    });

    it("audits archive identity, seat-aware legal formations, and missing geometry", async () => {
        const audit = new PremiumEvidenceAudit();
        audit.add(captured);
        expect(audit.result().telemetry.placementGeometryFailures).toBe(0);
        expect(audit.result().telemetry.effectiveBoards).toBe(2);
        expect(audit.result().telemetry.unplacedStacks).toBe(0);
        const mechanics = audit.result().telemetry.namedMechanics.scopes;
        const scope = `${captured.cohort}/${captured.evidence!.partition}`;
        expect(Object.keys(mechanics)).toEqual([scope]);
        for (const entries of Object.values(mechanics[scope]))
            for (const row of Object.values(entries)) {
                expect(row.independentFamilies).toBe(1);
                expect(row.occurrences).toBeGreaterThan(0);
            }
        expect(() => audit.add(captured)).toThrow("Duplicate family");
        const broken = structuredClone(captured.evidence!.fights![1]);
        broken.formations.a.placements[0].cell = { x: -1, y: 5 };
        expect(auditPremiumFormationGeometry(broken).some((failure) => failure.endsWith("outside-board"))).toBe(true);
        const input = save("audit", [captured]);
        const output = join(directory, "audit.sqlite");
        await buildPremiumEvidenceSnapshot(input, output, { development: true });
        const report = await auditPremiumEvidence(input, output);
        expect(report.failures).toEqual([]);
        expect(report.fights).toBe(2);
        const changed = structuredClone(captured);
        changed.evidence!.fights![0].telemetryScope = "accepted-action-events-not-complete-damage-attribution";
        // Even semantically equivalent reserialization must not be paired with a snapshot of different archive bytes.
        writeFileSync(join(directory, "audit", rawName), gzipSync(JSON.stringify(changed) + "\n", { level: 0 }));
        await expect(auditPremiumEvidence(input, output)).rejects.toThrow("does not match these raw archives");
    });

    it("refuses smoke publication, partial input, duplicate families and invalid retained artifacts", async () => {
        const input = save("candidate", [captured]);
        await expect(buildPremiumEvidenceSnapshot(input, join(directory, "candidate.sqlite"))).rejects.toThrow(
            "clean source",
        );
        const incomplete = save("incomplete", [captured], { ...summary, complete: false });
        await expect(
            buildPremiumEvidenceSnapshot(incomplete, join(directory, "partial.sqlite"), { development: true }),
        ).rejects.toThrow("complete Premium");
        const missingWindow = save("missing-window", [captured], {
            ...summary,
            provenance: { ...summary.provenance, pairWindow: { start: 0, count: 1, fullPairCount: 3 } },
        });
        await expect(
            buildPremiumEvidenceSnapshot(missingWindow, join(directory, "missing-window.sqlite"), {
                development: true,
            }),
        ).rejects.toThrow("entire declared pair window");
        const duplicate = save("duplicate", [captured, captured]);
        const output = join(directory, "duplicate.sqlite");
        await expect(buildPremiumEvidenceSnapshot(duplicate, output, { development: true })).rejects.toThrow("UNIQUE");
        expect(existsSync(output)).toBe(false);
        const bad = structuredClone(captured);
        bad.armyA.artifactT1.id += 1;
        const invalid = save("invalid", [bad]);
        await expect(
            buildPremiumEvidenceSnapshot(invalid, join(directory, "invalid.sqlite"), { development: true }),
        ).rejects.toThrow("retain");
    });

    it("rejects modified participation totals and derives old V4 summaries without raw trace storage", async () => {
        const bad = structuredClone(captured);
        bad.evidence!.fights![0].participation!.stacks[0].spellHealingGiven += 100;
        const invalid = save("participation-mismatch", [bad]);
        await expect(
            buildPremiumEvidenceSnapshot(invalid, join(directory, "participation-mismatch.sqlite"), {
                development: true,
            }),
        ).rejects.toThrow("participation summary disagrees");
        const old = structuredClone(captured);
        for (const fight of old.evidence!.fights!) {
            delete fight.participation;
            delete fight.combatMetrics;
            delete fight.healthLedger;
        }
        const input = save("old-v4-participation", [old]);
        const output = join(directory, "old-v4-participation.sqlite");
        await buildPremiumEvidenceSnapshot(input, output, { development: true });
        const reader = new PremiumEvidenceSnapshot(output, sourceSha256, { allowDevelopment: true });
        try {
            expect(reader.participation(old.evidence!.scenarioId, old.evidence!.partition)).toHaveLength(2);
            expect(reader.combatMetrics(old.evidence!.scenarioId, old.evidence!.partition)).toHaveLength(2);
            expect(reader.manifest.capabilities).not.toContain("committed-health-v1");
            expect(() => reader.healthSummary(old.evidence!.scenarioId)).toThrow("no committed health ledger");
            expect(() => reader.trace(old.evidence!.scenarioId)).toThrow("no indexed fight traces");
        } finally {
            reader.close();
        }
    });

    it("rejects combat metrics that disagree with committed events", async () => {
        const bad = structuredClone(captured);
        bad.evidence!.fights![0].combatMetrics!.stacks[0].waterShieldAbsorbedHp += 100;
        const input = save("combat-metrics-mismatch", [bad]);
        await expect(
            buildPremiumEvidenceSnapshot(input, join(directory, "combat-metrics-mismatch.sqlite"), {
                development: true,
            }),
        ).rejects.toThrow("combat metrics disagree");
    });

    it("rejects partial health coverage instead of biasing the indexed averages", async () => {
        const partial = structuredClone(captured);
        delete partial.evidence!.fights![1].healthLedger;
        const input = save("partial-health", [partial]);
        await expect(
            buildPremiumEvidenceSnapshot(input, join(directory, "partial-health.sqlite"), {
                development: true,
            }),
        ).rejects.toThrow("partial committed health coverage");
    });

    it("accepts the exact 70k study budget at the publication gate but still rejects incomplete archives", async () => {
        const metadata = structuredClone(summary);
        Object.assign(metadata.provenance, {
            commonDirty: false,
            gamesPerCohort: 10000,
            pairWindow: { start: 0, count: 5000, fullPairCount: 5000 },
            totalPairs: 35000,
            totalGames: 70000,
        });
        metadata.cohorts = [captured.cohort, ...AI_META_COHORTS.filter((id) => id !== captured.cohort)].map(
            (cohort) => ({ ...summary.cohorts[0], cohort, games: 10000, pairs: 5000 }),
        );
        const input = save("exact-70k-budget-incomplete-archive", [captured], metadata);
        await expect(buildPremiumEvidenceSnapshot(input, join(directory, "exact-70k.sqlite"))).rejects.toThrow(
            "Raw records disagree with declared cohort counts",
        );
        expect(existsSync(join(directory, "exact-70k.sqlite"))).toBe(false);
    });

    it("rejects leaked draft observations and options removed from a visible offer", async () => {
        const leaked = structuredClone(captured);
        leaked
            .evidence!.rankedDraft!.decisions.find(({ action }) => action.type === "select_bundle")!
            .observation.knownOpponentCreatures.push(captured.armyB.creatureIds[0]);
        const input = save("leaked", [leaked]);
        await expect(
            buildPremiumEvidenceSnapshot(input, join(directory, "leaked.sqlite"), { development: true }),
        ).rejects.toThrow("viewer-safe replay");
        const filtered = structuredClone(captured);
        filtered
            .evidence!.rankedDraft!.decisions.find(({ action }) => action.type === "pick_creature")!
            .choice!.candidates.pop();
        const filteredInput = save("filtered", [filtered]);
        await expect(
            buildPremiumEvidenceSnapshot(filteredInput, join(directory, "filtered.sqlite"), { development: true }),
        ).rejects.toThrow("visible offers");
    });

    it("rejects incomplete raw archives and mismatched summary totals", async () => {
        const input = save("truncated", [captured]);
        const raw = join(directory, "truncated", rawName);
        writeFileSync(raw, readFileSync(raw).subarray(0, 64));
        await expect(
            buildPremiumEvidenceSnapshot(input, join(directory, "truncated.sqlite"), { development: true }),
        ).rejects.toThrow();
        const mismatch = save("mismatch", [captured], {
            ...summary,
            provenance: { ...summary.provenance, totalPairs: 2 },
        });
        await expect(
            buildPremiumEvidenceSnapshot(mismatch, join(directory, "mismatch.sqlite"), { development: true }),
        ).rejects.toThrow("totals");
    });

    it("rejects an outcome or truncated action list that disagrees with its capture", async () => {
        for (const field of ["hp", "actions"] as const) {
            const altered = structuredClone(captured);
            if (field === "hp") altered.games[1].hpA += 1;
            else altered.evidence!.fights![1].actions.pop();
            const input = save(`capture-mismatch-${field}`, [altered]);
            await expect(
                buildPremiumEvidenceSnapshot(input, join(directory, `capture-mismatch-${field}.sqlite`), {
                    development: true,
                }),
            ).rejects.toThrow("disagrees with paired outcome or action count");
        }
    });
});
