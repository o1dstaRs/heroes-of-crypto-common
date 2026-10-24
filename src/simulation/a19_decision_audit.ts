/* Offline decision diagnostics. No production policy imports this module. */
import { createHash } from "node:crypto";
import ts from "typescript";
import { ARTIFACT_FIT_SETUP_PREFIX_V6 } from "../ai/setup/artifact_fit";
import { buildV08A19SearchEnvironment } from "../ai/versions/v0_8_a19_profile";
import { withScopedAIEnvironment } from "./v0_8_a13_search";
import { hashSimulationParts } from "./army";

export const AUDIT_CATEGORIES = ["missing", "shortlist", "scoring"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];
export const auditDigest = (value: unknown): string =>
    createHash("sha256")
        .update(JSON.stringify(value, (_key, item) => (item instanceof Map || item instanceof Set ? [...item] : item)))
        .digest("hex");

const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
        node = node.expression;
    }
    return node;
};
const sourceFile = (text: string) => ts.createSourceFile("profile.ts", text, ts.ScriptTarget.Latest, true);
const initializer = (source: string, name: string): ts.Expression => {
    let found: ts.Expression | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer) {
            if (found) throw new Error(`Repeated profile binding ${name}`);
            found = unwrap(node.initializer);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile(source));
    if (!found) throw new Error(`Missing profile binding ${name}`);
    return found;
};
const literal = (source: string, name: string): string => {
    const node = initializer(source, name);
    if (!ts.isStringLiteral(node)) throw new Error(`${name} must be a static string`);
    return node.text;
};

/** Read defaults from server source without importing configuration, credentials, or serving code. */
export function readA19AuditProfile(sources: { search: string; draft: string; setup: string }) {
    let object: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (ts.isPropertyAssignment(node) && node.name.getText() === "a19") {
            const call = unwrap(node.initializer);
            if (ts.isCallExpression(call) && call.expression.getText() === "Object.freeze") {
                const value = call.arguments[0];
                if (value && ts.isObjectLiteralExpression(value)) {
                    if (object) throw new Error("Ambiguous server A19 environment");
                    object = value;
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile(sources.search));
    if (!object) throw new Error("Missing server A19 environment");
    const overrides: Record<string, string | undefined> = {};
    let bases = 0;
    for (const property of object.properties) {
        if (ts.isSpreadAssignment(property)) {
            if (property.expression.getText() !== "buildV08A19SearchEnvironment()") {
                throw new Error("Unknown server A19 base environment");
            }
            bases++;
        } else if (ts.isPropertyAssignment(property)) {
            const key = property.name.getText().replace(/^['"]|['"]$/g, "");
            const value = unwrap(property.initializer);
            if (Object.hasOwn(overrides, key)) throw new Error(`Repeated A19 override ${key}`);
            if (ts.isStringLiteral(value)) overrides[key] = value.text;
            else if (ts.isIdentifier(value) && value.text === "undefined") overrides[key] = undefined;
            else throw new Error(`Non-static A19 override ${key}`);
        } else throw new Error("Unknown server A19 environment property");
    }
    if (bases !== 1) throw new Error("Expected one server A19 base environment");
    const setup = initializer(sources.setup, "V08_RANKED_SETUP_POLICY_SPEC");
    if (
        !ts.isTemplateExpression(setup) ||
        setup.head.text !== "" ||
        setup.templateSpans.length !== 1 ||
        setup.templateSpans[0].expression.getText() !== "ARTIFACT_FIT_SETUP_PREFIX_V6"
    )
        throw new Error("Unrecognized server setup policy; update the source parser deliberately");
    const base = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, buildV08A19SearchEnvironment);
    return {
        revision: literal(sources.search, "BOT_SEARCH_PRODUCTION_REVISION"),
        draft: literal(sources.draft, "DEFAULT_RANKED_DRAFT_POLICY_SPEC"),
        setup: ARTIFACT_FIT_SETUP_PREFIX_V6 + setup.templateSpans[0].literal.text,
        environment: { ...base, ...overrides },
        overrides,
        sourceSha256: Object.fromEntries(
            Object.entries(sources).map(([key, source]) => [key, createHash("sha256").update(source).digest("hex")]),
        ),
    };
}
export type A19AuditProfile = ReturnType<typeof readA19AuditProfile>;

export interface IAuditTurn {
    ordinal: number;
    team: number;
    lap: number;
}
/** Outcome-blind, deterministic sampling from all native A19 decisions, including unpruned catalogs. */
export function selectAuditTurns(turns: readonly IAuditTurn[], seed: number, perStratum = 1): number[] {
    if (!Number.isSafeInteger(perStratum) || perStratum < 1) throw new Error("Invalid sampling quota");
    const strata = new Map<string, IAuditTurn[]>();
    for (const turn of turns) {
        const phase = turn.lap <= 2 ? "opening" : turn.lap <= 5 ? "middle" : "late";
        const key = `${turn.team}:${phase}`;
        const entries = strata.get(key) ?? [];
        entries.push(turn);
        strata.set(key, entries);
    }
    return [...strata.values()]
        .flatMap((entries) =>
            [...entries]
                .sort(
                    (left, right) =>
                        hashSimulationParts("a19-decision-audit-sample-v1", seed, left.ordinal) -
                            hashSimulationParts("a19-decision-audit-sample-v1", seed, right.ordinal) ||
                        left.ordinal - right.ordinal,
                )
                .slice(0, perStratum),
        )
        .map((turn) => turn.ordinal)
        .sort((left, right) => left - right);
}

export function auditCandidateCategory(
    signature: string,
    production: ReadonlySet<string>,
    shortlisted: ReadonlySet<string>,
): AuditCategory {
    return !production.has(signature) ? "missing" : !shortlisted.has(signature) ? "shortlist" : "scoring";
}

/** Exact paired sign-flip test for terminal score differences (multiples of half a point). */
export function pairedAuditEvidence(baseline: readonly number[], challenger: readonly number[]) {
    if (!baseline.length || baseline.length !== challenger.length) throw new Error("Unpaired validation samples");
    const differences = baseline.map((value, index) => {
        const other = challenger[index];
        if (![0, 0.5, 1].includes(value) || ![0, 0.5, 1].includes(other)) {
            throw new Error("Terminal evidence requires completed win/draw/loss samples");
        }
        return other - value;
    });
    let distribution = new Map<number, number>([[0, 1]]);
    for (const difference of differences) {
        const weight = Math.abs(difference * 2);
        if (!weight) continue;
        const next = new Map<number, number>();
        for (const [sum, probability] of distribution) {
            for (const sign of [-1, 1]) {
                const key = sum + sign * weight;
                next.set(key, (next.get(key) ?? 0) + probability / 2);
            }
        }
        distribution = next;
    }
    const total = differences.reduce((sum, value) => sum + value, 0);
    const mean = total / differences.length;
    const variance =
        differences.length > 1
            ? differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (differences.length - 1)
            : 0;
    const p = [...distribution].reduce(
        (sum, [value, probability]) => sum + (Math.abs(value) >= Math.abs(total * 2) ? probability : 0),
        0,
    );
    return {
        samples: differences.length,
        mean,
        standardError: Math.sqrt(variance / differences.length),
        improved: differences.filter((value) => value > 0).length,
        worsened: differences.filter((value) => value < 0).length,
        tied: differences.filter((value) => value === 0).length,
        p: Math.min(1, p),
    };
}

/** Family-wise adjustment across every tested position/category, including negative comparisons. */
export function holmAuditPValues(values: readonly number[]): number[] {
    if (values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid p-value");
    const ordered = values.map((p, index) => ({ p, index })).sort((left, right) => left.p - right.p);
    const adjusted = new Array<number>(values.length);
    let previous = 0;
    ordered.forEach(({ p, index }, rank) => {
        previous = Math.min(1, Math.max(previous, p * (values.length - rank)));
        adjusted[index] = previous;
    });
    return adjusted;
}

export const auditEscapeHtml = (value: unknown): string =>
    String(value).replace(
        /[&<>"']/g,
        (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
    );
