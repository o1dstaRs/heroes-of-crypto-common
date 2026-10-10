import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type { IAiMetaPairRecord } from "./ai_meta_cohorts_core";
import { AI_META_COHORTS, AI_META_MAPS, AI_META_SYNERGY_DEFINITIONS, type AiMetaCohort } from "./ai_meta_cohorts_core";
import type { IAiMetaDraftDecision, IAiMetaFormationEvidence } from "./ai_meta_evidence";
import { isPremiumMetaStudy, type AiMetaStudy } from "./ai_meta_study";
import type { IPremiumCombatParticipation } from "./ai_meta_participation";
import {
    PREMIUM_COMBAT_UNIT_METRICS,
    PREMIUM_COMBAT_UNIT_METRICS_V1,
    type IPremiumCombatMetrics,
} from "./ai_meta_combat_metrics";
import {
    PREMIUM_HEALTH_METRICS,
    PREMIUM_HEALTH_UNIT_METRICS,
    type summarizePremiumHealth,
} from "./ai_meta_health_ledger";

export const PREMIUM_SNAPSHOT_SCHEMA = "hoc-premium-evidence-snapshot-v2";

export interface IPremiumSnapshotManifest {
    schema: typeof PREMIUM_SNAPSHOT_SCHEMA | "hoc-premium-evidence-snapshot-v1";
    snapshotId: string;
    sourceSha256: string;
    studyProfile: AiMetaStudy;
    createdAt: string;
    status: "development" | "candidate";
    families: number;
    fights: number;
    cohorts: string[];
    evidenceKind: "observational-association";
    modelStatus: "not-fitted";
    capabilities?: readonly string[];
    sources: { name: string; sha256: string; pairs: number }[];
    provenance: Record<string, unknown>;
}

export interface IPremiumEvidenceQuery {
    cohort: AiMetaCohort;
    map?: number;
    partition?: "train" | "validation" | "test";
    ownUnits?: readonly number[];
    opponentUnits?: readonly number[];
    artifactT1?: number;
    artifactT2?: number;
    doctrine?: number;
    augmentPlanId?: string;
    /** Faction-local protocol IDs always travel with their faction. */
    variants?: readonly { faction: number; synergy: number }[];
    /** Exact activation state. Level zero means the rolled variant is not activated. */
    activeSynergies?: readonly { faction: number; synergy: number; level: number }[];
}

export interface IPremiumEvidenceResult {
    snapshotId: string;
    evidenceId: string;
    scope: IPremiumEvidenceQuery;
    status: "supported" | "limited_evidence" | "no_evidence";
    evidenceKind: "observational-association";
    independentFamilies: number;
    fights: number;
    armyObservations: number;
    /** Mean seat-paired score: win=1, draw=0.5, loss=0; not a calibrated live win prediction. */
    scoreRate: number | null;
    interval95: [number, number];
    uncertainty: "family-bounded-hoeffding-95";
    examples: { familyId: string; source: string; line: number }[];
}

export const PREMIUM_SNAPSHOT_SQL = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value))) STRICT;
CREATE TABLE source (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, pairs INTEGER NOT NULL) STRICT;
CREATE TABLE family (
    id TEXT PRIMARY KEY, cohort TEXT NOT NULL, pair_index INTEGER NOT NULL, map INTEGER NOT NULL,
    partition TEXT NOT NULL CHECK(partition IN ('train','validation','test')),
    source_id INTEGER NOT NULL REFERENCES source(id), source_line INTEGER NOT NULL,
    UNIQUE(cohort, pair_index), UNIQUE(source_id, source_line)
) STRICT;
CREATE INDEX family_scope ON family(cohort, map, partition);
CREATE TABLE army (
    id INTEGER PRIMARY KEY, family_id TEXT NOT NULL REFERENCES family(id), side TEXT NOT NULL CHECK(side IN ('a','b')),
    score REAL NOT NULL CHECK(score BETWEEN 0 AND 1), doctrine INTEGER NOT NULL,
    artifact_t1 INTEGER NOT NULL, artifact_t2 INTEGER NOT NULL, augment_plan TEXT NOT NULL,
    UNIQUE(family_id, side)
) STRICT;
CREATE INDEX army_setup ON army(artifact_t1, artifact_t2, doctrine, augment_plan, family_id);
CREATE TABLE unit (army_id INTEGER NOT NULL REFERENCES army(id), creature_id INTEGER NOT NULL, PRIMARY KEY(army_id, creature_id)) STRICT;
CREATE INDEX unit_lookup ON unit(creature_id, army_id);
CREATE TABLE synergy (
    army_id INTEGER NOT NULL REFERENCES army(id), faction INTEGER NOT NULL, synergy INTEGER NOT NULL,
    level INTEGER NOT NULL CHECK(level BETWEEN 0 AND 3), PRIMARY KEY(army_id, faction)
) STRICT;
CREATE INDEX synergy_lookup ON synergy(faction, synergy, level, army_id);
CREATE TABLE decision (
    family_id TEXT NOT NULL REFERENCES family(id), decision_index INTEGER NOT NULL,
    army_id INTEGER NOT NULL REFERENCES army(id), phase INTEGER NOT NULL, kind TEXT NOT NULL,
    action_key INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','collision')),
    behavior_probability REAL NOT NULL CHECK(behavior_probability > 0 AND behavior_probability <= 1),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(family_id, decision_index)
) STRICT;
CREATE INDEX decision_lookup ON decision(kind, phase, action_key, army_id);
CREATE TABLE record_trace (
    family_id TEXT PRIMARY KEY REFERENCES family(id), compressed BLOB NOT NULL,
    sha256 TEXT NOT NULL, uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes > 0)
) STRICT;
CREATE TABLE formation (
    army_id INTEGER NOT NULL REFERENCES army(id), physical_team INTEGER NOT NULL,
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(army_id, physical_team)
) STRICT;
CREATE TABLE combat_participation (
    family_id TEXT NOT NULL REFERENCES family(id), a_is_green INTEGER NOT NULL CHECK(a_is_green IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(family_id, a_is_green)
) STRICT;
CREATE TABLE combat_metrics (
    family_id TEXT NOT NULL REFERENCES family(id), a_is_green INTEGER NOT NULL CHECK(a_is_green IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(family_id, a_is_green)
) STRICT;
CREATE TABLE combat_unit_metric (
    army_id INTEGER NOT NULL REFERENCES army(id), creature_id INTEGER NOT NULL,
    a_is_green INTEGER NOT NULL CHECK(a_is_green IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(army_id, creature_id, a_is_green)
) STRICT;
CREATE INDEX combat_unit_metric_lookup ON combat_unit_metric(creature_id, army_id);
CREATE TABLE health_summary (
    family_id TEXT NOT NULL REFERENCES family(id), a_is_green INTEGER NOT NULL CHECK(a_is_green IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(family_id, a_is_green)
) STRICT;
CREATE TABLE health_unit_metric (
    army_id INTEGER NOT NULL REFERENCES army(id), creature_id INTEGER NOT NULL,
    a_is_green INTEGER NOT NULL CHECK(a_is_green IN (0,1)),
    payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(army_id, creature_id, a_is_green)
) STRICT;
CREATE INDEX health_unit_metric_lookup ON health_unit_metric(creature_id, army_id);
`;

const validId = (id: number): boolean => Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
const ids = (values: readonly number[] | undefined): number[] => {
    if (!Array.isArray(values ?? []) || (values?.length ?? 0) > 6 || (values ?? []).some((id) => !validId(id)))
        throw new Error("Evidence unit filters must contain at most six protocol IDs");
    return [...new Set(values ?? [])].sort((a, b) => a - b);
};

export function canonicalPremiumEvidenceQuery(query: IPremiumEvidenceQuery): IPremiumEvidenceQuery {
    if (!AI_META_COHORTS.includes(query.cohort)) throw new Error("An explicit known cohort is required");
    if (query.map !== undefined && !AI_META_MAPS.some((id) => id === query.map)) throw new Error("Unknown map");
    if (query.partition !== undefined && !["train", "validation", "test"].includes(query.partition))
        throw new Error("Unknown partition");
    for (const value of [query.artifactT1, query.artifactT2, query.doctrine])
        if (value !== undefined && !validId(value)) throw new Error("Invalid setup ID");
    if (query.doctrine !== undefined && query.doctrine > 3) throw new Error("Invalid doctrine");
    if (
        query.augmentPlanId !== undefined &&
        !/^P[0-2]-A[0-3]-M[0-3]-S[0-3]-V[0-2](?:-E[1-3])?$/.test(query.augmentPlanId)
    )
        throw new Error("Invalid augment plan ID");
    for (const choices of [query.variants, query.activeSynergies]) {
        if (
            !Array.isArray(choices ?? []) ||
            (choices?.length ?? 0) > 4 ||
            new Set((choices ?? []).map((choice) => choice.faction)).size !== (choices?.length ?? 0)
        )
            throw new Error("Invalid synergy filters");
        for (const choice of choices ?? []) {
            if (
                !validId(choice.faction) ||
                !validId(choice.synergy) ||
                ("level" in choice &&
                    (!Number.isInteger(choice.level) || Number(choice.level) < 0 || Number(choice.level) > 3))
            )
                throw new Error("Invalid synergy ID or level");
        }
    }
    return {
        cohort: query.cohort,
        ...(query.map === undefined ? {} : { map: query.map }),
        partition: query.partition ?? "train",
        ownUnits: ids(query.ownUnits),
        opponentUnits: ids(query.opponentUnits),
        ...(query.artifactT1 === undefined ? {} : { artifactT1: query.artifactT1 }),
        ...(query.artifactT2 === undefined ? {} : { artifactT2: query.artifactT2 }),
        ...(query.doctrine === undefined ? {} : { doctrine: query.doctrine }),
        ...(query.augmentPlanId === undefined ? {} : { augmentPlanId: query.augmentPlanId }),
        variants: [...(query.variants ?? [])]
            .map(({ faction, synergy }) => ({ faction, synergy }))
            .sort((a, b) => a.faction - b.faction),
        activeSynergies: [...(query.activeSynergies ?? [])]
            .map(({ faction, synergy, level }) => ({ faction, synergy, level }))
            .sort((a, b) => a.faction - b.faction),
    };
}

/** Server-local reader; expose bounded evidence packets, never the database or arbitrary SQL. */
export class PremiumEvidenceSnapshot {
    public readonly manifest: IPremiumSnapshotManifest;
    private readonly db: Database;
    public constructor(path: string, expectedSourceSha256: string, options: { allowDevelopment?: boolean } = {}) {
        this.db = new Database(path, { readonly: true, strict: true });
        try {
            this.db.exec("PRAGMA query_only=ON");
            const metadata = this.db
                .query<{ value: string }, []>("SELECT value FROM metadata WHERE key='manifest'")
                .get();
            if (!metadata) throw new Error("Snapshot is missing its manifest");
            this.manifest = JSON.parse(metadata.value) as IPremiumSnapshotManifest;
            if (
                ![PREMIUM_SNAPSHOT_SCHEMA, "hoc-premium-evidence-snapshot-v1"].includes(this.manifest.schema) ||
                !isPremiumMetaStudy(this.manifest.studyProfile) ||
                this.manifest.sourceSha256 !== expectedSourceSha256 ||
                !/^[a-f0-9]{64}$/.test(expectedSourceSha256)
            )
                throw new Error("Incompatible Premium snapshot");
            if (
                this.manifest.status !== "candidate" &&
                !(this.manifest.status === "development" && options.allowDevelopment)
            )
                throw new Error("Development snapshot cannot serve normal requests");
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    private matchingArmies(input: IPremiumEvidenceQuery) {
        const scope = canonicalPremiumEvidenceQuery(input);
        const parameters: (string | number)[] = [scope.cohort, scope.partition!];
        const where = ["f.cohort=?", "f.partition=?"];
        const equals = (column: string, value: string | number | undefined) => {
            if (value === undefined) return;
            where.push(`${column}=?`);
            parameters.push(value);
        };
        equals("f.map", scope.map);
        equals("a.artifact_t1", scope.artifactT1);
        equals("a.artifact_t2", scope.artifactT2);
        equals("a.doctrine", scope.doctrine);
        equals("a.augment_plan", scope.augmentPlanId);
        for (const id of scope.ownUnits!) {
            where.push("EXISTS(SELECT 1 FROM unit u WHERE u.army_id=a.id AND u.creature_id=?)");
            parameters.push(id);
        }
        for (const id of scope.opponentUnits!) {
            where.push(
                "EXISTS(SELECT 1 FROM army enemy JOIN unit u ON u.army_id=enemy.id WHERE enemy.family_id=a.family_id AND enemy.side<>a.side AND u.creature_id=?)",
            );
            parameters.push(id);
        }
        for (const choice of [...scope.variants!, ...scope.activeSynergies!]) {
            const level = "level" in choice ? choice.level : undefined;
            where.push(
                `EXISTS(SELECT 1 FROM synergy s WHERE s.army_id=a.id AND s.faction=? AND s.synergy=?${level === undefined ? "" : " AND s.level=?"})`,
            );
            parameters.push(choice.faction, choice.synergy);
            if (level !== undefined) parameters.push(Number(level));
        }
        const matched = `FROM army a JOIN family f ON f.id=a.family_id WHERE ${where.join(" AND ")}`;
        return { scope, parameters, matched };
    }
    public query(input: IPremiumEvidenceQuery): IPremiumEvidenceResult {
        const { scope, parameters, matched } = this.matchingArmies(input);
        const result = this.db
            .query<{ n: number; observations: number | null; score: number | null }, (string | number)[]>(
                `SELECT COUNT(*) n, SUM(observations) observations, AVG(score) score FROM (SELECT f.id, AVG(a.score) score, COUNT(*) observations ${matched} GROUP BY f.id)`,
            )
            .get(...parameters)!;
        const n = result.n;
        const radius = n ? Math.sqrt(Math.log(40) / (2 * n)) : 1;
        const examples = this.db
            .query<{ familyId: string; source: string; line: number }, (string | number)[]>(
                `SELECT f.id familyId, (SELECT name FROM source WHERE id=f.source_id) source, f.source_line line ${matched} GROUP BY f.id ORDER BY f.id LIMIT 3`,
            )
            .all(...parameters);
        const hash = new Bun.CryptoHasher("sha256").update(JSON.stringify(scope)).digest("hex");
        return {
            snapshotId: this.manifest.snapshotId,
            evidenceId: `${this.manifest.snapshotId}:${hash}`,
            scope,
            status: n === 0 ? "no_evidence" : n < 50 ? "limited_evidence" : "supported",
            evidenceKind: "observational-association",
            independentFamilies: n,
            fights: n * 2,
            armyObservations: result.observations ?? 0,
            scoreRate: result.score,
            interval95:
                result.score === null
                    ? [0, 1]
                    : [Math.max(0, result.score - radius), Math.min(1, result.score + radius)],
            uncertainty: "family-bounded-hoeffding-95",
            examples,
        };
    }
    /** Historical synthetic examples only. The caller must supply the authoritative current viewer context separately. */
    public examples(input: IPremiumEvidenceQuery, limit = 3) {
        if (this.manifest.schema !== PREMIUM_SNAPSHOT_SCHEMA)
            throw new Error("Snapshot has no indexed draft/formation examples");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3)
            throw new Error("Evidence examples are bounded to 1-3 families");
        const packet = this.query(input);
        return packet.examples.slice(0, limit).map((reference) => {
            const armies = this.db
                .query<
                    {
                        id: number;
                        side: string;
                        doctrine: number;
                        artifact_t1: number;
                        artifact_t2: number;
                        augment_plan: string;
                        score: number;
                    },
                    [string]
                >(
                    "SELECT id,side,doctrine,artifact_t1,artifact_t2,augment_plan,score FROM army WHERE family_id=? ORDER BY side",
                )
                .all(reference.familyId)
                .map((army) => ({
                    side: army.side,
                    doctrine: army.doctrine,
                    artifactT1: army.artifact_t1,
                    artifactT2: army.artifact_t2,
                    augmentPlanId: army.augment_plan,
                    observedScore: army.score,
                    creatureIds: this.db
                        .query<{ creature_id: number }, [number]>(
                            "SELECT creature_id FROM unit WHERE army_id=? ORDER BY creature_id",
                        )
                        .all(army.id)
                        .map((row) => row.creature_id),
                    formations: this.db
                        .query<{ physical_team: number; payload: string }, [number]>(
                            "SELECT physical_team,payload FROM formation WHERE army_id=? ORDER BY physical_team",
                        )
                        .all(army.id)
                        .map((row) => ({
                            physicalTeam: row.physical_team,
                            formation: JSON.parse(row.payload) as IAiMetaFormationEvidence,
                        })),
                }));
            const draft = this.db
                .query<{ payload: string }, [string]>(
                    "SELECT payload FROM decision WHERE family_id=? ORDER BY decision_index",
                )
                .all(reference.familyId)
                .map((row) => JSON.parse(row.payload) as IAiMetaDraftDecision);
            return {
                ...reference,
                snapshotId: packet.snapshotId,
                sourceKind: "historical-ai-simulation" as const,
                armies,
                draft,
            };
        });
    }
    /** Compare observed draft actions at the same phase; this deliberately makes no counterfactual gain claim. */
    public draftSupport(input: {
        kind: IAiMetaDraftDecision["action"]["type"];
        phase: number;
        actionKey?: number;
        /** Bundle identity is its ordered L1/L2/artifact tuple, never its local offer index. */
        bundle?: readonly [number, number, number];
        doctrine?: number;
        artifactT1?: number;
        variants?: IPremiumEvidenceQuery["variants"];
        ownUnits?: readonly number[];
        knownOpponentUnits?: readonly number[];
        map?: number;
        partition?: "train" | "validation" | "test";
    }) {
        if (this.manifest.schema !== PREMIUM_SNAPSHOT_SCHEMA)
            throw new Error("Snapshot has no indexed draft decisions");
        if (
            !["select_doctrine", "select_bundle", "pick_creature", "select_tier2"].includes(input.kind) ||
            !Number.isSafeInteger(input.phase) ||
            input.phase < 0 ||
            input.phase > 10 ||
            (input.kind !== "select_bundle" && (!Number.isSafeInteger(input.actionKey) || !validId(input.actionKey!)))
        )
            throw new Error("Invalid draft action scope");
        // Bundle indices are local to their offers and cannot be pooled as if 'bundle 0' meant one unit/artifact set.
        if (
            input.kind === "select_bundle" &&
            (!Array.isArray(input.bundle) ||
                input.bundle.length !== 3 ||
                input.bundle.some((id) => !validId(id)) ||
                input.actionKey !== undefined)
        )
            throw new Error("Bundle evidence requires exact offer context as an L1/L2/artifact tuple");
        if (input.kind !== "select_bundle" && input.bundle !== undefined)
            throw new Error("A bundle tuple is only valid for a bundle decision");
        const scope = canonicalPremiumEvidenceQuery({
            cohort: "ranked-draft",
            ownUnits: input.ownUnits,
            opponentUnits: input.knownOpponentUnits,
            map: input.map,
            partition: input.partition,
            doctrine: input.doctrine,
            artifactT1: input.artifactT1,
            variants: input.variants,
        });
        const parameters: (string | number)[] = [input.kind, input.phase, scope.partition!];
        const where = ["d.kind=?", "d.phase=?", "f.partition=?", "d.status='accepted'"];
        if (input.kind === "select_bundle") {
            where.push(
                "EXISTS(SELECT 1 FROM json_each(d.payload,'$.observation.bundles') WHERE key=d.action_key AND json_extract(value,'$[0]')=? AND json_extract(value,'$[1]')=? AND json_extract(value,'$[2]')=?)",
            );
            parameters.push(...input.bundle!);
        } else {
            where.push("d.action_key=?");
            parameters.push(input.actionKey!);
        }
        for (const id of scope.ownUnits!) {
            where.push("EXISTS(SELECT 1 FROM json_each(d.payload,'$.observation.creaturesPicked') WHERE value=?)");
            parameters.push(id);
        }
        for (const id of scope.opponentUnits!) {
            where.push(
                "EXISTS(SELECT 1 FROM json_each(d.payload,'$.observation.knownOpponentCreatures') WHERE value=?)",
            );
            parameters.push(id);
        }
        if (scope.map !== undefined) {
            where.push("json_extract(d.payload,'$.observation.revealedMap')=?");
            parameters.push(scope.map);
        }
        if (scope.doctrine !== undefined) {
            where.push("json_extract(d.payload,'$.observation.doctrine')=?");
            parameters.push(scope.doctrine);
        }
        if (scope.artifactT1 !== undefined) {
            where.push(
                "EXISTS(SELECT 1 FROM json_each(d.payload,'$.observation.artifacts') WHERE json_extract(value,'$[0]')=1 AND json_extract(value,'$[1]')=?)",
            );
            parameters.push(scope.artifactT1);
        }
        for (const choice of scope.variants ?? []) {
            const faction = AI_META_SYNERGY_DEFINITIONS.find(
                (item) => item.faction === choice.faction && item.synergy === choice.synergy,
            )?.factionName;
            if (!faction) throw new Error("Unknown synergy variant");
            where.push("json_extract(d.payload,?)=?");
            parameters.push(`$.observation.synergyVariants.${faction}`, choice.synergy);
        }
        const row = this.db
            .query<{ families: number; decisions: number | null; observedScore: number | null }, (string | number)[]>(
                `SELECT COUNT(*) families,SUM(decisions) decisions,AVG(score) observedScore FROM (SELECT f.id,COUNT(*) decisions,AVG(a.score) score FROM decision d JOIN army a ON a.id=d.army_id JOIN family f ON f.id=d.family_id WHERE ${where.join(" AND ")} GROUP BY f.id)`,
            )
            .get(...parameters)!;
        return {
            snapshotId: this.manifest.snapshotId,
            evidenceId: `${this.manifest.snapshotId}:draft:${new Bun.CryptoHasher("sha256")
                .update(
                    JSON.stringify({
                        kind: input.kind,
                        phase: input.phase,
                        actionKey: input.actionKey,
                        bundle: input.bundle,
                        scope,
                    }),
                )
                .digest("hex")
                .slice(0, 24)}`,
            evidenceKind: "observed-draft-association" as const,
            scope: { ...input, partition: scope.partition },
            independentFamilies: row.families,
            decisions: row.decisions ?? 0,
            observedScore: row.observedScore,
            interval95:
                row.observedScore === null
                    ? [0, 1]
                    : [
                          Math.max(0, row.observedScore - Math.sqrt(Math.log(40) / (2 * row.families))),
                          Math.min(1, row.observedScore + Math.sqrt(Math.log(40) / (2 * row.families))),
                      ],
            uncertainty: "family-bounded-hoeffding-95",
            status: row.families === 0 ? "no_evidence" : row.families < 50 ? "limited_evidence" : "supported",
        };
    }
    /** Descriptive means, summed over split children then averaged over seats and independent families. */
    public unitCombatMetrics(input: IPremiumEvidenceQuery & { creatureId: number }) {
        if (!this.manifest.capabilities?.includes("combat-metrics-v1"))
            throw new Error("Snapshot has no combat metrics");
        const extended = this.manifest.capabilities.includes("combat-unit-metrics-v2");
        return this.aggregateUnitMetrics(
            input,
            "combat_unit_metric",
            extended ? PREMIUM_COMBAT_UNIT_METRICS : PREMIUM_COMBAT_UNIT_METRICS_V1,
            extended ? "combat-unit-v2" : "combat-unit-v1",
        );
    }
    public unitHealthMetrics(input: IPremiumEvidenceQuery & { creatureId: number }) {
        if (!this.manifest.capabilities?.includes("committed-health-v1"))
            throw new Error("Snapshot has no committed health ledger");
        const extended = this.manifest.capabilities.includes("committed-health-unit-v2");
        return this.aggregateUnitMetrics(
            input,
            "health_unit_metric",
            extended ? PREMIUM_HEALTH_UNIT_METRICS : PREMIUM_HEALTH_METRICS,
            extended ? "health-unit-v2" : "health-unit-v1",
        );
    }
    private aggregateUnitMetrics(
        input: IPremiumEvidenceQuery & { creatureId: number },
        table: "combat_unit_metric" | "health_unit_metric",
        descriptions: Readonly<Record<string, string>>,
        recipe: string,
    ) {
        if (!validId(input.creatureId)) throw new Error("Invalid combat metric creature ID");
        const { scope, parameters, matched } = this.matchingArmies(input);
        const names = Object.keys(descriptions);
        const grouped = `SELECT c.family_id,COUNT(*) samples,COUNT(DISTINCT m.a_is_green) fights,${names
            .map((name) => `AVG(json_extract(m.payload,'$.${name}')) ${name}`)
            .join(",")}
            FROM (SELECT a.id army_id,f.id family_id ${matched}) c
            JOIN ${table} m ON m.army_id=c.army_id WHERE m.creature_id=? GROUP BY c.family_id`;
        const row = this.db
            .query<Record<string, number | null>, (string | number)[]>(
                `SELECT COUNT(*) families,SUM(samples) samples,SUM(fights) fights,${names
                    .flatMap((name) => [
                        `AVG(${name}) ${name}_mean`,
                        `MIN(${name}) ${name}_min`,
                        `MAX(${name}) ${name}_max`,
                    ])
                    .join(",")} FROM (${grouped})`,
            )
            .get(...parameters, input.creatureId)!;
        return {
            snapshotId: this.manifest.snapshotId,
            evidenceId: createHash("sha256")
                .update(this.manifest.snapshotId)
                .update(recipe)
                .update("distinct-fights-v2")
                .update(JSON.stringify({ scope, creatureId: input.creatureId }))
                .digest("hex")
                .slice(0, 24),
            evidenceKind: table === "health_unit_metric" ? "observed-health-metrics" : "observed-combat-metrics",
            scope: { ...scope, creatureId: input.creatureId },
            independentFamilies: row.families!,
            fights: row.fights ?? 0,
            armyFightObservations: row.samples ?? 0,
            aggregation: "sum-drafted-split-stacks-average-seats-then-families" as const,
            status: !row.families ? "no_evidence" : row.families < 50 ? "limited_evidence" : "supported",
            metrics: Object.fromEntries(
                names.map((name) => [
                    name,
                    {
                        description: descriptions[name],
                        mean: row[`${name}_mean`],
                        minFamilyMean: row[`${name}_min`],
                        maxFamilyMean: row[`${name}_max`],
                    },
                ]),
            ),
            limitations: [
                "Descriptive policy-conditional means, not causal pick effects or a complete contribution ledger.",
                table === "health_unit_metric"
                    ? "Physical drafted stacks and split children are included; merged reinforcements cannot be separated. Standalone summons are excluded."
                    : "Summons and ambiguous merged ancestry are excluded; split children are not independent samples.",
                "Min/max are observed family means, not confidence bounds. Unsupported contexts return null means.",
                "Fight counts deduplicate both armies in the same seat. Army observations and split children are not independent families.",
            ],
        };
    }
    public healthSummary(familyId: string, partition: "train" | "validation" | "test" = "train") {
        if (!this.manifest.capabilities?.includes("committed-health-v1"))
            throw new Error("Snapshot has no committed health ledger");
        if (
            typeof familyId !== "string" ||
            familyId.length > 256 ||
            !["train", "validation", "test"].includes(partition)
        )
            throw new Error("Invalid health scope");
        return this.db
            .query<{ a_is_green: number; payload: string }, [string, string]>(
                "SELECT h.a_is_green,h.payload FROM health_summary h JOIN family f ON f.id=h.family_id WHERE f.id=? AND f.partition=? ORDER BY h.a_is_green DESC LIMIT 2",
            )
            .all(familyId, partition)
            .map((row) => ({
                snapshotId: this.manifest.snapshotId,
                familyId,
                aIsGreen: Boolean(row.a_is_green),
                summary: JSON.parse(row.payload) as ReturnType<typeof summarizePremiumHealth>,
            }));
    }
    public combatMetrics(familyId: string, partition: "train" | "validation" | "test" = "train") {
        if (!this.manifest.capabilities?.includes("combat-metrics-v1"))
            throw new Error("Snapshot has no combat metrics");
        if (
            typeof familyId !== "string" ||
            familyId.length > 256 ||
            !["train", "validation", "test"].includes(partition)
        )
            throw new Error("Invalid combat metric scope");
        return this.db
            .query<{ a_is_green: number; payload: string }, [string, string]>(
                "SELECT m.a_is_green,m.payload FROM combat_metrics m JOIN family f ON f.id=m.family_id WHERE f.id=? AND f.partition=? ORDER BY m.a_is_green DESC LIMIT 2",
            )
            .all(familyId, partition)
            .map((row) => ({
                snapshotId: this.manifest.snapshotId,
                familyId,
                aIsGreen: Boolean(row.a_is_green),
                metrics: JSON.parse(row.payload) as IPremiumCombatMetrics,
            }));
    }
    /** Bounded examples, kept in their source partition; no raw trace decompression is needed. */
    public participation(familyId: string, partition: "train" | "validation" | "test" = "train") {
        if (!this.manifest.capabilities?.includes("combat-participation-v1"))
            throw new Error("Snapshot has no committed combat participation summaries");
        if (
            typeof familyId !== "string" ||
            familyId.length > 256 ||
            !["train", "validation", "test"].includes(partition)
        )
            throw new Error("Invalid participation scope");
        return this.db
            .query<{ a_is_green: number; payload: string }, [string, string]>(
                "SELECT p.a_is_green,p.payload FROM combat_participation p JOIN family f ON f.id=p.family_id WHERE f.id=? AND f.partition=? ORDER BY p.a_is_green DESC LIMIT 2",
            )
            .all(familyId, partition)
            .map((row) => ({
                snapshotId: this.manifest.snapshotId,
                familyId,
                aIsGreen: Boolean(row.a_is_green),
                participation: JSON.parse(row.payload) as IPremiumCombatParticipation,
            }));
    }
    /** Internal diagnostics: one checksummed family by primary key, without scanning a cohort gzip. */
    public trace(familyId: string): IAiMetaPairRecord {
        if (!this.manifest.capabilities?.includes("indexed-fight-traces"))
            throw new Error("Snapshot has no indexed fight traces; rebuild with includeTraces");
        if (typeof familyId !== "string" || familyId.length > 256) throw new Error("Invalid family ID");
        const row = this.db
            .query<{ compressed: Uint8Array; sha256: string; uncompressed_bytes: number }, [string]>(
                "SELECT compressed,sha256,uncompressed_bytes FROM record_trace WHERE family_id=?",
            )
            .get(familyId);
        if (!row) throw new Error("Unknown evidence family");
        const bytes = gunzipSync(row.compressed, { maxOutputLength: 64 * 1024 * 1024 });
        if (
            bytes.length !== row.uncompressed_bytes ||
            new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== row.sha256
        )
            throw new Error("Evidence trace checksum mismatch");
        const record = JSON.parse(bytes.toString("utf8")) as IAiMetaPairRecord;
        if (record.evidence?.scenarioId !== familyId) throw new Error("Evidence trace family mismatch");
        return record;
    }
    public close(): void {
        this.db.close();
    }
}

if (import.meta.main) {
    const [path, sourceSha256, query, mode] = process.argv.slice(2);
    if (!path || !sourceSha256 || !query || (mode !== undefined && mode !== "--development")) {
        console.error(
            "Usage: bun src/simulation/premium_evidence_snapshot.ts <snapshot.sqlite> <expected-source-sha256> '<query-json>' [--development]",
        );
        process.exitCode = 1;
    } else {
        const snapshot = new PremiumEvidenceSnapshot(path, sourceSha256, {
            allowDevelopment: mode === "--development",
        });
        try {
            console.log(JSON.stringify(snapshot.query(JSON.parse(query)), null, 2));
        } finally {
            snapshot.close();
        }
    }
}
