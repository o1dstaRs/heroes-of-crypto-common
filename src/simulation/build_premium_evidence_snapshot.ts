import { Database } from "bun:sqlite";
import { summarizePremiumParticipation, PREMIUM_PARTICIPATION_SCHEMA } from "./ai_meta_participation";
import {
    summarizePremiumHealth,
    summarizePremiumUnitHealth,
    PREMIUM_HEALTH_LEDGER_SCHEMA,
    PREMIUM_HEALTH_UNIT_METRICS_SCHEMA,
} from "./ai_meta_health_ledger";
import {
    summarizePremiumCombatMetrics,
    premiumDraftedCombatMetrics,
    PREMIUM_COMBAT_METRICS_SCHEMA,
    PREMIUM_COMBAT_UNIT_METRICS_SCHEMA,
} from "./ai_meta_combat_metrics";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, linkSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip, gzipSync } from "node:zlib";
import { PBTypes } from "../generated/protobuf/v1/types";
import { aiMetaEvidencePartition } from "./ai_meta_evidence";
import {
    AI_META_COHORTS,
    AI_META_MAPS,
    aiMetaSynergyLevel,
    rostersAreStrictlyDistinct,
    type AiMetaCohort,
} from "./ai_meta_cohorts_core";
import {
    PREMIUM_META_FULL_AUGMENTS_STUDY,
    PREMIUM_META_FULL_AUGMENTS_SCHEMA,
    PREMIUM_META_EVIDENCE_SCHEMA,
    isPremiumMetaStudy,
} from "./ai_meta_study";
import { parsePairRecord } from "./reaggregate_ai_meta_summary";
import {
    PREMIUM_SNAPSHOT_SCHEMA,
    PREMIUM_SNAPSHOT_SQL,
    type IPremiumSnapshotManifest,
} from "./premium_evidence_snapshot";

async function fileHash(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
}

export async function buildPremiumEvidenceSnapshot(
    summaryPath: string,
    outputPath: string,
    options: { development?: boolean; includeTraces?: boolean } = {},
): Promise<IPremiumSnapshotManifest> {
    const summaryText = readFileSync(summaryPath, "utf8");
    const summary = JSON.parse(summaryText);
    const provenance = summary.provenance;
    if (
        summary.schemaVersion !== 1 ||
        summary.complete !== true ||
        !Array.isArray(summary.cohorts) ||
        !summary.cohorts.length ||
        !isPremiumMetaStudy(provenance?.fightProfile?.studyProfile) ||
        !["premium-cohort-evidence-v3", PREMIUM_META_EVIDENCE_SCHEMA, PREMIUM_META_FULL_AUGMENTS_SCHEMA].includes(
            provenance?.fightProfile?.evidenceSchema,
        ) ||
        provenance?.fightProfile?.searchBudget !== "offline-deterministic-work" ||
        !/^[a-f0-9]{64}$/.test(provenance?.sourceSha256 ?? "") ||
        !Number.isSafeInteger(provenance?.baseSeed)
    ) {
        throw new Error("A complete Premium ranked study with deterministic work and source identity is required");
    }
    if (
        !Number.isSafeInteger(provenance.gamesPerCohort) ||
        provenance.gamesPerCohort < 2 ||
        provenance.gamesPerCohort % 2 !== 0 ||
        provenance.pairWindow?.start !== 0 ||
        provenance.pairWindow?.count !== provenance.gamesPerCohort / 2 ||
        provenance.pairWindow?.fullPairCount !== provenance.gamesPerCohort / 2 ||
        summary.cohorts.some((cohort: { games: number }) => cohort.games !== provenance.gamesPerCohort)
    )
        throw new Error("A complete snapshot must cover the entire declared pair window in every cohort");
    if (
        !Array.isArray(provenance.maps) ||
        JSON.stringify([...provenance.maps].sort()) !== JSON.stringify([...AI_META_MAPS].sort())
    )
        throw new Error("Snapshot requires the current live map set");
    const cohortIds = summary.cohorts.map((cohort: { cohort: string }) => cohort.cohort);
    if (
        new Set(cohortIds).size !== cohortIds.length ||
        cohortIds.some((cohort: string) => !AI_META_COHORTS.includes(cohort as AiMetaCohort))
    )
        throw new Error("Duplicate or unknown cohort");
    if (
        !options.development &&
        (provenance.fightProfile.studyProfile !== PREMIUM_META_FULL_AUGMENTS_STUDY ||
            provenance.fightProfile.evidenceSchema !== PREMIUM_META_FULL_AUGMENTS_SCHEMA ||
            provenance.commonDirty !== false ||
            AI_META_COHORTS.some((id) => !cohortIds.includes(id)) ||
            summary.cohorts.some((cohort: { games: number }) => cohort.games < 10000))
    ) {
        throw new Error(
            "Candidate snapshot requires the six-axis Empower study, a clean source and at least 10,000 fights in each of seven cohorts; use development for smoke data",
        );
    }
    const target = resolve(outputPath);
    if (existsSync(target)) throw new Error("Refusing to overwrite an existing snapshot");
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    let db: Database | undefined;
    try {
        db = new Database(temporary, { create: true, strict: true });
        chmodSync(temporary, 0o600);
        db.exec(PREMIUM_SNAPSHOT_SQL);
        const addSource = db.query("INSERT INTO source VALUES (?, ?, ?, ?)");
        const addFamily = db.query("INSERT INTO family VALUES (?, ?, ?, ?, ?, ?, ?)");
        const addArmy = db.query("INSERT INTO army VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const addUnit = db.query("INSERT INTO unit VALUES (?, ?)");
        const addSynergy = db.query("INSERT INTO synergy VALUES (?, ?, ?, ?)");
        const addDecision = db.query("INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const addTrace = db.query("INSERT INTO record_trace VALUES (?, ?, ?, ?)");
        const addFormation = db.query("INSERT INTO formation VALUES (?, ?, ?)");
        const addParticipation = db.query("INSERT INTO combat_participation VALUES (?, ?, ?)");
        const addCombatMetrics = db.query("INSERT INTO combat_metrics VALUES (?, ?, ?)");
        const addCombatUnitMetric = db.query("INSERT INTO combat_unit_metric VALUES (?, ?, ?, ?)");
        const addHealthSummary = db.query("INSERT INTO health_summary VALUES (?, ?, ?)");
        const addHealthUnit = db.query("INSERT INTO health_unit_metric VALUES (?, ?, ?, ?)");
        let families = 0;
        const sources: IPremiumSnapshotManifest["sources"] = [];
        for (const [sourceIndex, cohort] of summary.cohorts.entries()) {
            if (
                typeof cohort.rawPath !== "string" ||
                basename(cohort.rawPath) !== cohort.rawPath ||
                !cohort.rawPath.endsWith(".jsonl.gz") ||
                !Number.isSafeInteger(cohort.pairs) ||
                cohort.pairs < 1 ||
                cohort.games !== cohort.pairs * 2 ||
                cohort.rejectedActions !== 0 ||
                cohort.distinctRosterViolations !== 0 ||
                cohort.overlappingCreatureViolations !== 0
            )
                throw new Error("Invalid cohort completeness or quality");
            const rawPath = resolve(dirname(summaryPath), cohort.rawPath);
            const hash = await fileHash(rawPath);
            addSource.run(sourceIndex + 1, cohort.rawPath, hash, cohort.pairs);
            const input = createReadStream(rawPath);
            const gzip = createGunzip();
            input.on("error", (error) => gzip.destroy(error));
            const lines = createInterface({ input: input.pipe(gzip), crlfDelay: Infinity });
            let lineNumber = 0;
            const mapGames = new Map<number, number>();
            db.exec("BEGIN");
            try {
                for await (const line of lines) {
                    lineNumber++;
                    const record = parsePairRecord(
                        JSON.parse(line),
                        cohort.cohort,
                        [...AI_META_MAPS],
                        `${cohort.rawPath}:${lineNumber}`,
                    );
                    const evidence = record.evidence;
                    if (
                        !evidence ||
                        evidence.schema !== provenance.fightProfile.evidenceSchema ||
                        evidence.studyProfile !== provenance.fightProfile.studyProfile ||
                        evidence.scenarioId !== `ai-meta:${provenance.baseSeed}:${record.cohort}:${record.pair}` ||
                        evidence.partition !== aiMetaEvidencePartition(provenance.baseSeed, record.cohort, record.pair)
                    )
                        throw new Error("Invalid scenario identity or partition");
                    if (
                        record.games[0].aIsGreen !== true ||
                        record.games[1].aIsGreen !== false ||
                        record.games.some((game) => game.rejectedA || game.rejectedB) ||
                        !rostersAreStrictlyDistinct(record.armyA.roster, record.armyB.roster)
                    )
                        throw new Error("Invalid paired battle quality");
                    addFamily.run(
                        evidence.scenarioId,
                        record.cohort,
                        record.pair,
                        record.map,
                        evidence.partition,
                        sourceIndex + 1,
                        lineNumber,
                    );
                    if (options.includeTraces) {
                        const bytes = Buffer.from(line, "utf8");
                        if (bytes.length > 64 * 1024 * 1024)
                            throw new Error("Evidence trace exceeds the 64 MiB decode limit");
                        addTrace.run(
                            evidence.scenarioId,
                            gzipSync(bytes),
                            createHash("sha256").update(bytes).digest("hex"),
                            bytes.length,
                        );
                    }
                    for (const [index, side, army] of [
                        [0, "a", record.armyA],
                        [1, "b", record.armyB],
                    ] as const) {
                        const armyId = families * 2 + index + 1;
                        const score =
                            record.games.reduce(
                                (sum, game) => sum + (game.winner === side ? 1 : game.winner === "draw" ? 0.5 : 0),
                                0,
                            ) / 2;
                        addArmy.run(
                            armyId,
                            evidence.scenarioId,
                            side,
                            score,
                            army.doctrine,
                            army.artifactT1.id,
                            army.artifactT2.id,
                            army.augment.planId,
                        );
                        for (const id of army.creatureIds) addUnit.run(armyId, id);
                        for (const [name, faction] of [
                            ["Life", PBTypes.FactionVals.LIFE],
                            ["Chaos", PBTypes.FactionVals.CHAOS],
                            ["Might", PBTypes.FactionVals.MIGHT],
                            ["Nature", PBTypes.FactionVals.NATURE],
                        ] as const) {
                            const synergy = evidence.synergyVariants[name];
                            const active = army.synergies.some(
                                (choice) => choice.faction === faction && choice.synergy === synergy,
                            );
                            addSynergy.run(
                                armyId,
                                faction,
                                synergy,
                                active ? aiMetaSynergyLevel(army.creatureIds, faction) : 0,
                            );
                        }
                    }
                    for (const decision of evidence.rankedDraft?.decisions ?? []) {
                        const action = decision.action;
                        const armyId = families * 2 + (action.team === PBTypes.TeamVals.LEFT ? 1 : 2);
                        const key =
                            action.type === "select_bundle"
                                ? action.bundleIndex
                                : action.type === "select_doctrine"
                                  ? action.doctrine
                                  : action.type === "select_tier2"
                                    ? action.artifactId
                                    : action.creatureId;
                        addDecision.run(
                            evidence.scenarioId,
                            decision.index,
                            armyId,
                            decision.observation.phaseSequence,
                            action.type,
                            key,
                            decision.status,
                            decision.behaviorProbability,
                            JSON.stringify(decision),
                        );
                    }
                    for (const fight of evidence.fights!) {
                        if (fight.healthLedger) {
                            addHealthSummary.run(
                                evidence.scenarioId,
                                Number(fight.aIsGreen),
                                JSON.stringify(summarizePremiumHealth(fight.healthLedger)),
                            );
                            for (const side of ["a", "b"] as const) {
                                const formation = fight.formations[side];
                                for (const creatureId of new Set(formation.draftedCreatureIdsByStack)) {
                                    const ids = new Set(
                                        formation.unitIdsByStack.filter(
                                            (_, index) => formation.draftedCreatureIdsByStack[index] === creatureId,
                                        ),
                                    );
                                    const summary = summarizePremiumUnitHealth(fight.healthLedger, ids);
                                    addHealthUnit.run(
                                        families * 2 + (side === "a" ? 1 : 2),
                                        creatureId,
                                        Number(fight.aIsGreen),
                                        JSON.stringify(summary),
                                    );
                                }
                            }
                        }
                        if (fight.committedEventBatches) {
                            const metrics = fight.combatMetrics ?? summarizePremiumCombatMetrics(fight);
                            addCombatMetrics.run(evidence.scenarioId, Number(fight.aIsGreen), JSON.stringify(metrics));
                            for (const group of premiumDraftedCombatMetrics(
                                metrics,
                                fight.participation ?? summarizePremiumParticipation(fight),
                            ))
                                addCombatUnitMetric.run(
                                    families * 2 + (group.army === "a" ? 1 : 2),
                                    group.creatureId,
                                    Number(fight.aIsGreen),
                                    JSON.stringify(group.values),
                                );
                        }
                        if (fight.committedEventBatches)
                            addParticipation.run(
                                evidence.scenarioId,
                                Number(fight.aIsGreen),
                                JSON.stringify(fight.participation ?? summarizePremiumParticipation(fight)),
                            );
                        addFormation.run(
                            families * 2 + 1,
                            fight.aIsGreen ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT,
                            JSON.stringify(fight.formations.a),
                        );
                        addFormation.run(
                            families * 2 + 2,
                            fight.aIsGreen ? PBTypes.TeamVals.RIGHT : PBTypes.TeamVals.LEFT,
                            JSON.stringify(fight.formations.b),
                        );
                    }
                    mapGames.set(record.map, (mapGames.get(record.map) ?? 0) + 2);
                    families++;
                }
                if (
                    lineNumber !== cohort.pairs ||
                    AI_META_MAPS.some((map) => (mapGames.get(map) ?? 0) !== (cohort.mapGames?.[map] ?? 0))
                )
                    throw new Error("Raw records disagree with declared cohort counts");
                const window = provenance.pairWindow;
                if (
                    !window ||
                    lineNumber !== window.count ||
                    db
                        .query<{ minimum: number; maximum: number }, [string]>(
                            "SELECT MIN(pair_index) minimum, MAX(pair_index) maximum FROM family WHERE cohort=?",
                        )
                        .get(cohort.cohort)?.minimum !== window.start ||
                    db
                        .query<{ maximum: number }, [string]>(
                            "SELECT MAX(pair_index) maximum FROM family WHERE cohort=?",
                        )
                        .get(cohort.cohort)?.maximum !==
                        window.start + window.count - 1
                )
                    throw new Error("Missing or out-of-window scenario families");
                if ((await fileHash(rawPath)) !== hash) throw new Error("Archive changed while building snapshot");
                db.exec("COMMIT");
            } finally {
                lines.close();
                input.destroy();
                gzip.destroy();
            }
            sources.push({ name: cohort.rawPath, sha256: hash, pairs: lineNumber });
        }
        if (families !== provenance.totalPairs || families * 2 !== provenance.totalGames)
            throw new Error("Snapshot totals disagree with summary");
        const healthFights = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM health_summary").get()!.n;
        if (healthFights && healthFights !== families * 2)
            throw new Error(
                "Refusing partial committed health coverage; a snapshot must capture every fight or omit the capability",
            );
        if (!options.development && healthFights !== families * 2)
            throw new Error("Candidate snapshot requires committed health coverage in every fight");
        const snapshotId = createHash("sha256")
            .update(PREMIUM_SNAPSHOT_SCHEMA)
            .update(PREMIUM_PARTICIPATION_SCHEMA)
            .update(PREMIUM_COMBAT_METRICS_SCHEMA)
            .update(PREMIUM_COMBAT_UNIT_METRICS_SCHEMA)
            .update(PREMIUM_HEALTH_LEDGER_SCHEMA)
            .update(PREMIUM_HEALTH_UNIT_METRICS_SCHEMA)
            .update(summaryText)
            .update(JSON.stringify(sources))
            .digest("hex")
            .slice(0, 24);
        const manifest: IPremiumSnapshotManifest = {
            schema: PREMIUM_SNAPSHOT_SCHEMA,
            snapshotId,
            sourceSha256: provenance.sourceSha256,
            studyProfile: provenance.fightProfile.studyProfile,
            createdAt: new Date().toISOString(),
            status: options.development ? "development" : "candidate",
            families,
            fights: families * 2,
            cohorts: cohortIds,
            evidenceKind: "observational-association",
            modelStatus: "not-fitted",
            capabilities: [
                "contextual-associations",
                ...(provenance.fightProfile.studyProfile === PREMIUM_META_FULL_AUGMENTS_STUDY
                    ? ["six-axis-empower-v1"]
                    : []),
                "draft-observations",
                "formation-examples",
                ...(healthFights ? ["committed-health-v1", "committed-health-unit-v2"] : []),
                ...(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM combat_metrics").get()!.n
                    ? ["combat-metrics-v1", "combat-unit-metrics-v2"]
                    : []),
                ...(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM combat_participation").get()!.n
                    ? ["combat-participation-v1"]
                    : []),
                ...(options.includeTraces ? ["indexed-fight-traces"] : []),
            ],
            sources,
            provenance,
        };
        db.query("INSERT INTO metadata VALUES ('manifest', ?)").run(JSON.stringify(manifest));
        if (
            db.query("PRAGMA foreign_key_check").all().length ||
            (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check !== "ok"
        )
            throw new Error("Snapshot failed SQLite integrity checks");
        db.exec("ANALYZE; VACUUM");
        db.close();
        db = undefined;
        linkSync(temporary, target);
        return manifest;
    } finally {
        db?.close();
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}

if (import.meta.main) {
    const [summary, output, ...flags] = process.argv.slice(2);
    if (!summary || !output || flags.some((flag) => !["--development", "--include-traces"].includes(flag))) {
        console.error(
            "Usage: bun src/simulation/build_premium_evidence_snapshot.ts <summary.json> <snapshot.sqlite> [--development] [--include-traces]",
        );
        process.exitCode = 1;
    } else {
        const manifest = await buildPremiumEvidenceSnapshot(resolve(summary), resolve(output), {
            development: flags.includes("--development"),
            includeTraces: flags.includes("--include-traces"),
        });
        console.log(
            JSON.stringify(
                {
                    snapshotId: manifest.snapshotId,
                    status: manifest.status,
                    families: manifest.families,
                    fights: manifest.fights,
                    output,
                },
                null,
                2,
            ),
        );
    }
}
