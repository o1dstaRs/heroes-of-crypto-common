/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * -----------------------------------------------------------------------------
 */

import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type UnknownRecord = Record<string, unknown>;

const RANKING_DEFINITIONS = [
    { key: "units", label: "Units", singular: "unit" },
    { key: "synergies", label: "Synergies", singular: "synergy" },
    { key: "artifactsT1", label: "Artifacts · Tier 1", singular: "artifact" },
    { key: "artifactsT2", label: "Artifacts · Tier 2", singular: "artifact" },
    { key: "augmentPlans", label: "Augment plans", singular: "plan" },
    { key: "augmentLevels", label: "Augment levels", singular: "augment" },
] as const;

type RankingCategory = (typeof RANKING_DEFINITIONS)[number]["key"];

const MAP_DEFINITIONS = [
    { id: "live", label: "Live maps" },
    { id: "all", label: "All simulated" },
    { id: "1", label: "Normal" },
    { id: "3", label: "Lava" },
    { id: "4", label: "Block" },
    { id: "2", label: "Water · NON-LIVE", nonLive: true },
] as const;

interface INormalizedRow {
    category: RankingCategory;
    categoryLabel: string;
    key: string;
    name: string;
    imageId: string;
    kind: string;
    level: string;
    cohort: string;
    map: string;
    games: number | null;
    pairs: number | null;
    sample: number;
    wins: number | null;
    losses: number | null;
    draws: number | null;
    scoreRate: number | null;
    winRate: number | null;
    rate: number | null;
    ciLow: number | null;
    ciHigh: number | null;
    pickRate: number | null;
    liftPp: number | null;
}

interface INormalizedCohort {
    id: string;
    label: string;
    description: string;
    games: number | null;
    mapGames: Record<string, number>;
}

interface IEmbeddedAsset {
    id: string;
    uri: string;
}

export interface IRenderAiMetaReportOptions {
    /** heroes-of-crypto-client repository root. Auto-detected from this source file when omitted. */
    repositoryRoot?: string;
    title?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPOSITORY_ROOT = resolve(MODULE_DIR, "../../../..");

const isRecord = (value: unknown): value is UnknownRecord =>
    !!value && typeof value === "object" && !Array.isArray(value);

const asRecord = (value: unknown): UnknownRecord => (isRecord(value) ? value : {});

const textValue = (record: UnknownRecord, keys: readonly string[], fallback = ""): string => {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return fallback;
};

const finiteNumber = (record: UnknownRecord, keys: readonly string[]): number | null => {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim()) {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
    }
    return null;
};

const countValue = (record: UnknownRecord, keys: readonly string[]): number | null => {
    const value = finiteNumber(record, keys);
    return value === null ? null : Math.max(0, Math.round(value));
};

/** Accept either a fraction (0.53) or a human percentage (53). */
const rateValue = (record: UnknownRecord, keys: readonly string[]): number | null => {
    const value = finiteNumber(record, keys);
    if (value === null) return null;
    if (Math.abs(value) > 1 && Math.abs(value) <= 100) return value / 100;
    return value;
};

const clampRate = (value: number | null): number | null => (value === null ? null : Math.max(0, Math.min(1, value)));

const mapValue = (row: UnknownRecord): string => {
    const value = textValue(row, ["map"], "all").toLowerCase();
    return ["all", "live", "1", "2", "3", "4"].includes(value) ? value : "all";
};

const mapGamesValue = (record: UnknownRecord): Record<string, number> => {
    const source = asRecord(record.mapGames);
    return Object.fromEntries(
        ["1", "2", "3", "4"].flatMap((map) => {
            const games = countValue(source, [map]);
            return games === null ? [] : [[map, games]];
        }),
    );
};

const slug = (value: string): string =>
    value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");

const imageToken = (value: string): string => {
    const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
    const base = withoutQuery.split(/[\\/]/).pop() ?? withoutQuery;
    const extension = extname(base);
    return (extension ? base.slice(0, -extension.length) : base).replace(/[^a-zA-Z0-9_-]/g, "");
};

const titleCase = (value: string): string =>
    value
        .replace(/[_:-]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .trim();

const augmentImageToken = (kind: string): string => {
    const normalized = slug(kind);
    if (normalized.includes("placement") || normalized.includes("board") || normalized.includes("plan")) {
        return "board_augment_256";
    }
    if (normalized.includes("armor")) return "armor_augment_256";
    if (normalized.includes("might")) return "might_augment_256";
    if (normalized.includes("sniper")) return "sniper_augment_256";
    if (normalized.includes("movement")) return "movement_augment_256";
    return "board_augment_256";
};

const synergyImageToken = (name: string): string => {
    const normalized = slug(name);
    if (normalized.includes("supply")) return "synergy_supply_256";
    if (normalized.includes("morale") || normalized.includes("luck")) return "synergy_morale_256";
    if (normalized.includes("break")) return "synergy_break_on_attack_256";
    if (normalized.includes("movement")) return "synergy_movement_256";
    if (normalized.includes("aura")) return "synergy_auras_range_256";
    if (normalized.includes("ability")) return "synergy_abilities_power_256";
    if (normalized.includes("board") || normalized.includes("units")) return "synergy_increase_board_units_256";
    if (normalized.includes("fly") || normalized.includes("armor")) return "synergy_plus_fly_armor_256";
    return "synergy_supply_256";
};

const rowImageId = (category: RankingCategory, row: UnknownRecord, name: string, kind: string): string => {
    const supplied = imageToken(textValue(row, ["imageKey", "image", "icon"], ""));
    if (supplied) return supplied;
    if (category === "units") return `${slug(name) || "unknown_creature"}_512`;
    if (category === "synergies") return synergyImageToken(name);
    if (category === "artifactsT1") return `artifact_t1_${slug(name)}_256`;
    if (category === "artifactsT2") return `artifact_t2_${slug(name)}_256`;
    return augmentImageToken(kind || name);
};

const wilson = (wins: number, total: number, z = 1.959963984540054): [number, number] => {
    if (total <= 0) return [0, 0];
    const p = wins / total;
    const z2 = z * z;
    const denominator = 1 + z2 / total;
    const center = (p + z2 / (2 * total)) / denominator;
    const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
    return [Math.max(0, center - margin), Math.min(1, center + margin)];
};

const normalizeRow = (
    category: RankingCategory,
    categoryLabel: string,
    value: unknown,
    index: number,
): INormalizedRow => {
    const row = asRecord(value);
    const kind = textValue(row, ["kind", "type", "augmentKind"], "");
    const levelRaw = textValue(row, ["level", "tier", "augmentLevel"], "");
    const key = textValue(row, ["key", "id", "slug", "name"], `${category}-${index + 1}`);
    const inferredName = kind && levelRaw ? `${titleCase(kind)} · Level ${levelRaw}` : titleCase(key);
    const name = textValue(row, ["name", "label", "title"], inferredName || `Entry ${index + 1}`);
    const games = countValue(row, ["games", "appearances", "observations", "n"]);
    const pairs = countValue(row, ["pairs", "exclusiveGames", "clusters"]);
    const wins = countValue(row, ["wins", "winCount"]);
    const losses = countValue(row, ["losses", "lossCount"]);
    const draws = countValue(row, ["draws", "drawCount"]);
    const decisive = (wins ?? 0) + (losses ?? 0);
    const totalOutcomes = decisive + (draws ?? 0);
    const reportedScoreRate = clampRate(rateValue(row, ["scoreRate", "score_rate"]));
    const reportedWinRate = clampRate(rateValue(row, ["winRate", "win_rate", "wr"]));
    const scoreRate =
        reportedScoreRate ?? (totalOutcomes > 0 && wins !== null ? (wins + (draws ?? 0) * 0.5) / totalOutcomes : null);
    const winRate = reportedWinRate ?? (decisive > 0 && wins !== null ? wins / decisive : null);
    // Pair-cluster support is mandatory for comparative claims. Unsupported precreated
    // buckets remain visible in the audit table through scoreRate/winRate, but get no chart rate.
    const rate = pairs !== null && pairs > 0 ? (scoreRate ?? winRate) : null;
    let ciLow = clampRate(rateValue(row, ["ciLow", "ci_low", "confidenceLow", "lower"]));
    let ciHigh = clampRate(rateValue(row, ["ciHigh", "ci_high", "confidenceHigh", "upper"]));
    if ((ciLow === null || ciHigh === null) && wins !== null && decisive > 0 && (draws ?? 0) === 0) {
        [ciLow, ciHigh] = wilson(wins, decisive);
    }
    if (ciLow !== null && ciHigh !== null && ciLow > ciHigh) [ciLow, ciHigh] = [ciHigh, ciLow];
    const pickRate = clampRate(rateValue(row, ["pickRate", "pick_rate", "selectionRate", "share"]));
    const explicitLift = finiteNumber(row, ["liftPp", "lift_pp", "deltaPp", "gainPp"]);
    return {
        category,
        categoryLabel,
        key,
        name,
        imageId: rowImageId(category, row, name, kind),
        kind: kind ? titleCase(kind) : "",
        level: levelRaw,
        cohort: textValue(row, ["cohort", "cohortId", "segment"], "all"),
        map: mapValue(row),
        games,
        pairs,
        sample: pairs ?? games ?? Math.max(0, (wins ?? 0) + (losses ?? 0) + (draws ?? 0)),
        wins,
        losses,
        draws,
        scoreRate,
        winRate,
        rate,
        ciLow,
        ciHigh,
        pickRate,
        liftPp: explicitLift ?? (rate === null ? null : (rate - 0.5) * 100),
    };
};

const normalizeRows = (summary: UnknownRecord): INormalizedRow[] => {
    const rankings = asRecord(summary.rankings);
    return RANKING_DEFINITIONS.flatMap((definition) => {
        const candidate = rankings[definition.key];
        const values: unknown[] = Array.isArray(candidate) ? candidate : [];
        return values.map((row, index) => normalizeRow(definition.key, definition.label, row, index));
    });
};

const normalizeCohorts = (summary: UnknownRecord, rows: readonly INormalizedRow[]): INormalizedCohort[] => {
    const output = new Map<string, INormalizedCohort>();
    const input = Array.isArray(summary.cohorts) ? summary.cohorts : [];
    input.forEach((value, index) => {
        if (typeof value === "string" || typeof value === "number") {
            const id = String(value);
            if (id && id !== "all") {
                output.set(id, { id, label: titleCase(id), description: "", games: null, mapGames: {} });
            }
            return;
        }
        const cohort = asRecord(value);
        const id = textValue(cohort, ["id", "key", "cohort", "slug", "name"], `cohort-${index + 1}`);
        if (!id || id === "all") return;
        output.set(id, {
            id,
            label: textValue(cohort, ["label", "name", "title"], titleCase(id)),
            description: textValue(cohort, ["description", "note", "definition"], ""),
            games: countValue(cohort, ["games", "pairs", "n"]),
            mapGames: mapGamesValue(cohort),
        });
    });
    for (const row of rows) {
        if (!row.cohort || row.cohort === "all" || output.has(row.cohort)) continue;
        output.set(row.cohort, {
            id: row.cohort,
            label: titleCase(row.cohort),
            description: "",
            games: null,
            mapGames: {},
        });
    }
    return [...output.values()];
};

const escapeHtml = (value: string): string =>
    value.replace(/[&<>"']/g, (character) => {
        const entities: Record<string, string> = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        };
        return entities[character] ?? character;
    });

const scriptSafeJson = (value: unknown): string =>
    JSON.stringify(value)
        .replace(/&/g, "\\u0026")
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");

const dataUri = (path: string): string | null => {
    if (!existsSync(path)) return null;
    const extension = extname(path).toLowerCase();
    const mime = extension === ".svg" ? "image/svg+xml" : extension === ".png" ? "image/png" : "image/webp";
    return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
};

const firstDataUri = (paths: readonly string[]): string | null => {
    for (const path of paths) {
        const uri = dataUri(path);
        if (uri) return uri;
    }
    return null;
};

const placeholderUri = (label: string): string => {
    const initials = label
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? "")
        .join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#202a33"/><stop offset="1" stop-color="#090b0d"/></linearGradient></defs><rect width="256" height="256" rx="24" fill="url(#g)"/><circle cx="128" cy="128" r="87" fill="none" stroke="#f2c75d" stroke-opacity=".45" stroke-width="5"/><text x="128" y="145" text-anchor="middle" fill="#f2c75d" font-family="system-ui,sans-serif" font-size="54" font-weight="800">${escapeHtml(initials || "?")}</text></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

const assetCandidates = (root: string, category: RankingCategory, token: string): string[] => {
    if (category === "units") {
        return [
            resolve(root, "site/public/assets/images/units/units", `${token}.webp`),
            resolve(root, "game/core/images", `${token}.webp`),
        ];
    }
    if (category === "artifactsT1" || category === "artifactsT2") {
        return [
            resolve(root, "site/public/assets/images/artifacts", `${token}.webp`),
            resolve(root, "game/core/images", `${token}.webp`),
        ];
    }
    return [
        resolve(root, "site/public/assets/images/units/abilities", `${token}.webp`),
        resolve(root, "game/core/images", `${token}.webp`),
    ];
};

const embedAssets = (root: string, rows: readonly INormalizedRow[]): IEmbeddedAsset[] => {
    const assets = new Map<string, string>();
    for (const row of rows) {
        if (assets.has(row.imageId)) continue;
        const uri = firstDataUri(assetCandidates(root, row.category, row.imageId)) ?? placeholderUri(row.name);
        assets.set(row.imageId, uri);
    }
    if (!assets.has("unknown_creature_512")) {
        const fallback = firstDataUri(assetCandidates(root, "units", "unknown_creature_512"));
        assets.set("unknown_creature_512", fallback ?? placeholderUri("Unknown"));
    }
    return [...assets.entries()].map(([id, uri]) => ({ id, uri }));
};

const stringifyCompact = (value: unknown): string => {
    if (value === null || value === undefined) return "—";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    try {
        return JSON.stringify(value);
    } catch {
        return "[unavailable]";
    }
};

const flattenProvenance = (value: unknown): { key: string; value: string }[] => {
    const provenance = asRecord(value);
    const rows: { key: string; value: string }[] = [];
    for (const [key, nested] of Object.entries(provenance)) {
        if (isRecord(nested)) {
            for (const [childKey, childValue] of Object.entries(nested)) {
                rows.push({ key: `${key}.${childKey}`, value: stringifyCompact(childValue) });
            }
        } else {
            rows.push({ key, value: stringifyCompact(nested) });
        }
    }
    return rows.slice(0, 24);
};

const formatInteger = (value: number): string => new Intl.NumberFormat("en-US").format(value);

/**
 * Render an arbitrary AI meta-analysis summary as one portable HTML document.
 * Missing optional fields intentionally remain blank instead of rejecting the report.
 */
export function renderAiMetaReport(summaryValue: unknown, options: IRenderAiMetaReportOptions = {}): string {
    const summary = asRecord(summaryValue);
    const rows = normalizeRows(summary);
    const cohorts = normalizeCohorts(summary, rows);
    const root = options.repositoryRoot ? resolve(options.repositoryRoot) : DEFAULT_REPOSITORY_ROOT;
    const assets = embedAssets(root, rows);
    const assetMap = Object.fromEntries(assets.map((asset) => [asset.id, asset.uri]));
    const logo =
        firstDataUri([resolve(root, "game/core/images/logo_hoc.webp")]) ??
        assetMap.unknown_creature_512 ??
        placeholderUri("HoC");
    const background = firstDataUri([
        resolve(root, "game/core/images/background_dark.webp"),
        resolve(root, "site/public/assets/images/background_dark_old.webp"),
    ]);
    const title = options.title?.trim() || "AI Meta Performance Report";
    const schemaVersion = textValue(summary, ["schemaVersion"], "unknown");
    const provenanceRecord = asRecord(summary.provenance);
    const fightVersion = textValue(provenanceRecord, ["fightVersion", "aiVersion"], "unknown");
    const generatedAt = textValue(summary, ["generatedAt"], "Not reported");
    const totalGames = cohorts.reduce((sum, cohort) => sum + (cohort.games ?? 0), 0);
    const provenanceMaps = Array.isArray(provenanceRecord.maps) ? provenanceRecord.maps.map(String) : [];
    const hasWaterData =
        rows.some((row) => row.map === "2") ||
        cohorts.some((cohort) => (cohort.mapGames["2"] ?? 0) > 0) ||
        provenanceMaps.includes("2");
    const hasLiveRows = rows.some((row) => row.map === "live");
    const mapDefinitions = MAP_DEFINITIONS.map((definition) =>
        definition.id === "all" && hasWaterData
            ? { ...definition, label: "All simulated · includes NON-LIVE Water", nonLive: true }
            : definition,
    );
    const provenance = flattenProvenance(summary.provenance);
    const provenanceHtml = provenance.length
        ? provenance
              .map(
                  (entry) =>
                      `<div class="provenance-row"><dt>${escapeHtml(entry.key)}</dt><dd>${escapeHtml(entry.value)}</dd></div>`,
              )
              .join("")
        : '<p class="empty-inline">No provenance fields were supplied.</p>';
    const cohortDescriptionHtml = cohorts.length
        ? cohorts
              .map(
                  (cohort) =>
                      `<article class="cohort-note"><strong>${escapeHtml(cohort.label)}</strong><span>${escapeHtml(
                          cohort.description || "No additional definition supplied.",
                      )}</span></article>`,
              )
              .join("")
        : '<p class="empty-inline">No explicit cohort definitions were supplied.</p>';
    const reportData = {
        schemaVersion,
        generatedAt,
        provenance,
        rows,
        cohorts,
        assets: assetMap,
        categories: RANKING_DEFINITIONS,
        mapDefinitions,
    };
    const heroStyle = background ? ` style="--hero-image:url('${background}')"` : "";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#070808">
<title>${escapeHtml(title)} · Heroes of Crypto</title>
<style>
:root{color-scheme:dark;--bg:#070808;--bg2:#0d1114;--panel:#11171c;--panel2:#182029;--panel3:#202a33;--ink:#fbf4e8;--white:#fff;--muted:#b8b0a2;--muted2:#8f9aa3;--line:rgba(255,255,255,.13);--line2:rgba(255,255,255,.24);--gold:#f2c75d;--gold2:#ffe4a3;--green:#63d28a;--red:#ef4a3f;--blue:#67aef6;--shadow:0 22px 70px rgba(0,0,0,.42);--radius:16px}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(180deg,var(--bg),var(--bg2) 44%,var(--bg));color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;text-rendering:optimizeLegibility}button,input,select{font:inherit}button{color:inherit}img{display:block;max-width:100%}.shell{width:min(1260px,calc(100vw - 40px));margin:auto}.hero{position:relative;isolation:isolate;min-height:360px;overflow:hidden;border-bottom:1px solid var(--line);background:radial-gradient(circle at 72% 12%,rgba(242,199,93,.15),transparent 34%),linear-gradient(135deg,#0a0c0e,#11171c)}.hero::before{content:"";position:absolute;z-index:-2;inset:0;background-image:linear-gradient(90deg,rgba(7,8,8,.96) 0%,rgba(7,8,8,.73) 48%,rgba(7,8,8,.42)),var(--hero-image);background-size:cover;background-position:center;opacity:.68}.hero::after{content:"";position:absolute;z-index:-1;inset:0;background:linear-gradient(180deg,transparent 55%,var(--bg))}.hero-inner{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:36px;align-items:end;padding:54px 0 66px}.brand{display:flex;align-items:center;gap:13px;margin-bottom:32px;color:var(--gold);font-size:.78rem;font-weight:850;letter-spacing:.15em;text-transform:uppercase}.brand img{width:54px;height:54px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.45))}.eyebrow{margin:0 0 10px;color:var(--gold);font-size:.78rem;font-weight:850;letter-spacing:.12em;text-transform:uppercase}.hero h1{max-width:850px;margin:0 0 15px;color:var(--white);font-size:clamp(2.65rem,6vw,5.65rem);font-weight:900;letter-spacing:-.045em;line-height:.94}.subtitle{max-width:760px;margin:0;color:var(--muted);font-size:clamp(1rem,1.5vw,1.18rem)}.hero-stats{display:grid;grid-template-columns:repeat(2,minmax(132px,1fr));gap:10px;width:min(380px,100%)}.hero-stat{padding:17px 18px;border:1px solid var(--line);border-radius:12px;background:rgba(7,8,8,.7);backdrop-filter:blur(14px)}.hero-stat strong{display:block;color:var(--white);font-size:1.55rem;line-height:1.1}.hero-stat span{display:block;margin-top:4px;color:var(--muted2);font-size:.7rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase}.report-main{padding:28px 0 72px}.notice{display:grid;grid-template-columns:auto 1fr;gap:16px;margin:0 0 22px;padding:19px 22px;border:1px solid rgba(242,199,93,.3);border-left:4px solid var(--gold);border-radius:12px;background:linear-gradient(90deg,rgba(242,199,93,.1),rgba(17,23,28,.88))}.non-live-notice{border-color:rgba(239,74,63,.38);border-left-color:var(--red);background:linear-gradient(90deg,rgba(239,74,63,.12),rgba(17,23,28,.88))}.non-live-notice .notice-mark{border-color:rgba(239,74,63,.45);color:#ff8c82}.notice-mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid rgba(242,199,93,.4);border-radius:50%;color:var(--gold);font-weight:900}.notice h2{margin:0 0 5px;font-size:1rem}.notice p{margin:0;color:var(--muted);font-size:.9rem}.sticky-filter{position:sticky;z-index:20;top:0;margin:0 -10px 26px;padding:11px 10px;border-bottom:1px solid var(--line);background:rgba(7,8,8,.9);backdrop-filter:blur(18px)}.filter-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px}.cohort-tabs{display:flex;flex:1 1 100%;flex-wrap:wrap;gap:7px;min-width:0}.cohort-tab{flex:0 0 auto;padding:9px 14px;border:1px solid var(--line);border-radius:999px;background:var(--panel);font-size:.78rem;font-weight:800;cursor:pointer}.cohort-tab:hover{border-color:var(--line2)}.cohort-tab.active{border-color:rgba(242,199,93,.65);background:rgba(242,199,93,.12);color:var(--gold2)}.map-picker{display:flex;flex:0 0 auto;align-items:center;gap:7px;margin-left:auto;color:var(--muted2);font-size:.68rem;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.map-filter{min-height:38px;padding:7px 30px 7px 10px;border:1px solid var(--line);border-radius:9px;outline:none;background:#0b0e11;color:var(--ink);font-size:.76rem;font-weight:750;letter-spacing:0;text-transform:none}.map-filter:focus{border-color:rgba(242,199,93,.65)}.filter-coverage{flex:0 0 auto;min-width:130px;color:var(--muted2);font-size:.68rem;line-height:1.25;text-align:right}.filter-coverage strong{display:block;color:var(--white);font-size:.8rem}.filter-coverage.non-live strong,.filter-coverage.non-live span{color:#ff8c82}.section-head{display:flex;justify-content:space-between;gap:18px;align-items:end;margin:38px 0 15px}.section-head h2{margin:0;color:var(--white);font-size:clamp(1.55rem,3vw,2.25rem);letter-spacing:-.025em}.section-head p{max-width:680px;margin:0;color:var(--muted);font-size:.88rem}.leaders{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px}.leader{position:relative;min-width:0;overflow:hidden;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(155deg,rgba(255,255,255,.05),transparent 48%),var(--panel);box-shadow:var(--shadow)}.leader-art{position:relative;height:172px;overflow:hidden;background:radial-gradient(circle at 50% 42%,rgba(242,199,93,.13),transparent 55%),#090b0d}.leader-art::after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(transparent,rgba(9,11,13,.95))}.leader-art img{width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 14px 19px rgba(0,0,0,.5))}.leader-copy{position:relative;margin-top:-42px;padding:0 16px 17px}.leader-type{display:block;color:var(--gold);font-size:.66rem;font-weight:850;letter-spacing:.1em;text-transform:uppercase}.leader h3{min-height:2.4em;margin:5px 0 12px;color:var(--white);font-size:1rem;line-height:1.2}.leader-metric{display:flex;align-items:end;justify-content:space-between;gap:8px}.leader-rate{color:var(--white);font-size:1.6rem;font-weight:900;line-height:1}.leader-lift{font-size:.75rem;font-weight:850}.positive{color:var(--green)}.negative{color:var(--red)}.neutral{color:var(--muted2)}.leader-meta{margin-top:8px;color:var(--muted2);font-size:.72rem}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.chart-card,.analysis-card,.table-card,.details-card{min-width:0;border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(155deg,rgba(255,255,255,.028),transparent 40%),var(--panel);box-shadow:0 15px 40px rgba(0,0,0,.2)}.chart-card{padding:18px}.chart-card:first-child{grid-column:1/-1}.chart-title{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:15px}.chart-title h3{margin:0;color:var(--white);font-size:1rem}.chart-count{color:var(--muted2);font-size:.72rem}.forest{display:grid;gap:9px}.forest-row{display:grid;grid-template-columns:minmax(150px,210px) minmax(130px,1fr) 65px;gap:10px;align-items:center}.forest-label{display:grid;grid-template-columns:34px minmax(0,1fr);gap:8px;align-items:center;min-width:0}.forest-label img{width:34px;height:34px;border-radius:7px;background:#090b0d;object-fit:contain}.forest-name{overflow:hidden;color:var(--ink);font-size:.76rem;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.forest-sample{display:block;color:var(--muted2);font-size:.63rem;font-weight:500}.forest-track{position:relative;height:22px;border-radius:5px;background:linear-gradient(90deg,rgba(239,74,63,.08),rgba(255,255,255,.025) 50%,rgba(99,210,138,.08));box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)}.forest-track::before{content:"";position:absolute;z-index:1;top:0;bottom:0;left:50%;width:1px;background:rgba(242,199,93,.62)}.forest-ci{position:absolute;z-index:2;top:9px;height:4px;border-radius:4px;background:rgba(251,244,232,.55)}.forest-ci::before,.forest-ci::after{content:"";position:absolute;top:-3px;width:1px;height:10px;background:rgba(251,244,232,.72)}.forest-ci::before{left:0}.forest-ci::after{right:0}.forest-dot{position:absolute;z-index:3;top:5px;width:12px;height:12px;margin-left:-6px;border:2px solid #fff;border-radius:50%;background:var(--gold);box-shadow:0 3px 9px rgba(0,0,0,.55)}.forest-rate{text-align:right;color:var(--white);font-size:.78rem;font-weight:850}.empty{display:grid;place-items:center;min-height:110px;padding:20px;color:var(--muted2);font-size:.82rem;text-align:center}.analysis-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.85fr);gap:14px}.analysis-card{padding:18px;overflow:hidden}.analysis-card h3{margin:0 0 4px;color:var(--white);font-size:1rem}.analysis-card>p{margin:0 0 13px;color:var(--muted2);font-size:.75rem}.scatter-svg{display:block;width:100%;min-height:310px}.scatter-grid{stroke:rgba(255,255,255,.08);stroke-width:1}.scatter-axis{stroke:rgba(255,255,255,.3);stroke-width:1}.scatter-parity{stroke:var(--gold);stroke-width:1;stroke-dasharray:5 5;opacity:.75}.scatter-label{fill:var(--muted2);font:11px system-ui,sans-serif}.scatter-dot{stroke:#fff;stroke-width:1.5;opacity:.9}.heatmap-wrap{max-height:370px;overflow:auto}.heatmap{width:100%;border-collapse:separate;border-spacing:3px;font-size:.68rem}.heatmap th{position:sticky;top:0;z-index:1;padding:7px;background:var(--panel);color:var(--muted2);font-weight:800;text-align:center}.heatmap th:first-child{left:0;z-index:2;text-align:left}.heatmap td{min-width:60px;padding:8px 6px;border-radius:5px;text-align:center;font-variant-numeric:tabular-nums}.heatmap .heat-name{position:sticky;left:0;min-width:145px;max-width:190px;overflow:hidden;background:var(--panel2);color:var(--ink);font-weight:750;text-align:left;text-overflow:ellipsis;white-space:nowrap}.table-card{overflow:hidden}.table-tools{display:grid;grid-template-columns:minmax(220px,1fr) 220px auto;gap:10px;padding:14px;border-bottom:1px solid var(--line)}.search,.type-filter{width:100%;min-height:42px;padding:9px 12px;border:1px solid var(--line);border-radius:9px;outline:none;background:#0b0e11;color:var(--ink)}.search:focus,.type-filter:focus{border-color:rgba(242,199,93,.65)}.table-total{align-self:center;color:var(--muted2);font-size:.75rem;white-space:nowrap}.table-wrap{overflow:auto}.ranking-table{width:100%;border-collapse:collapse;font-size:.76rem}.ranking-table th{position:sticky;z-index:2;top:0;padding:0;border-bottom:1px solid var(--line);background:var(--panel2);text-align:left;white-space:nowrap}.ranking-table th button{width:100%;padding:11px 10px;border:0;background:transparent;color:var(--gold);font-size:.67rem;font-weight:850;letter-spacing:.07em;text-align:left;text-transform:uppercase;cursor:pointer}.ranking-table td{padding:9px 10px;border-bottom:1px solid rgba(255,255,255,.07);color:var(--muted);white-space:nowrap}.ranking-table tr:hover td{background:rgba(255,255,255,.025)}.table-entry{display:flex;align-items:center;gap:9px;min-width:200px}.table-entry img{width:35px;height:35px;border-radius:7px;background:#090b0d;object-fit:contain}.table-entry strong{display:block;max-width:230px;overflow:hidden;color:var(--ink);text-overflow:ellipsis}.type-chip{display:inline-flex;padding:4px 7px;border:1px solid var(--line);border-radius:999px;color:var(--muted2);font-size:.62rem;font-weight:800}.rate-cell{color:var(--white)!important;font-weight:850}.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.details-card{padding:20px}.details-card h3{margin:0 0 14px;color:var(--white);font-size:1rem}.provenance{display:grid;gap:0}.provenance-row{display:grid;grid-template-columns:minmax(120px,.4fr) minmax(0,1fr);gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07)}.provenance-row:last-child{border-bottom:0}.provenance-row dt{color:var(--muted2);font-size:.7rem;font-weight:800;overflow-wrap:anywhere}.provenance-row dd{margin:0;color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.7rem;overflow-wrap:anywhere}.cohort-notes{display:grid;gap:8px}.cohort-note{display:grid;gap:2px;padding:10px 12px;border-left:2px solid rgba(242,199,93,.55);background:rgba(255,255,255,.025)}.cohort-note strong{font-size:.76rem}.cohort-note span,.empty-inline{margin:0;color:var(--muted2);font-size:.7rem}.footer{display:flex;justify-content:space-between;gap:18px;margin-top:40px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted2);font-size:.7rem}.noscript{margin:20px;padding:18px;border:1px solid var(--red);background:#21100f;color:#ffd4cf}
.leaders{grid-template-columns:repeat(auto-fit,minmax(185px,1fr))}
@media(max-width:1040px){.hero-inner{grid-template-columns:1fr}.hero-stats{width:100%;grid-template-columns:repeat(4,1fr)}.leaders{grid-template-columns:repeat(3,1fr)}.analysis-grid{grid-template-columns:1fr}.chart-card:first-child{grid-column:auto}.chart-grid{grid-template-columns:1fr}}
@media(max-width:720px){.shell{width:min(100% - 24px,1260px)}.hero-inner{padding:34px 0 52px}.brand{margin-bottom:24px}.hero-stats{grid-template-columns:repeat(2,1fr)}.notice{grid-template-columns:1fr}.notice-mark{display:none}.filter-row{align-items:stretch}.cohort-tabs{flex-basis:100%;flex-wrap:nowrap;overflow-x:auto;padding-bottom:5px;scrollbar-color:var(--gold) transparent;scrollbar-width:thin}.map-picker{flex:1 1 auto;margin-left:0}.map-filter{flex:1}.filter-coverage{min-width:105px}.leaders{grid-template-columns:repeat(2,1fr)}.forest-row{grid-template-columns:minmax(110px,150px) minmax(100px,1fr) 54px}.table-tools{grid-template-columns:1fr}.details-grid{grid-template-columns:1fr}.section-head{display:block}.section-head p{margin-top:7px}.footer{display:block}.footer span{display:block;margin-top:5px}}
@media(max-width:460px){.leaders{grid-template-columns:1fr}.leader-art{height:150px}.forest-row{grid-template-columns:112px minmax(90px,1fr) 49px;gap:6px}.forest-label{grid-template-columns:27px minmax(0,1fr);gap:6px}.forest-label img{width:27px;height:27px}.forest-name{font-size:.67rem}.chart-card,.analysis-card{padding:13px}}
@media print{.sticky-filter,.table-tools{position:static;display:none}.hero{min-height:0}.hero-inner{padding:24px 0}.hero::before{opacity:.16}.report-main{padding-bottom:0}.chart-card,.analysis-card,.table-card,.details-card,.leader{break-inside:avoid;box-shadow:none}.shell{width:100%}.ranking-table th{position:static}}
</style>
</head>
<body>
<header class="hero"${heroStyle}>
  <div class="shell hero-inner">
    <div>
      <div class="brand"><img src="${logo}" alt=""><span>Heroes of Crypto · Simulation intelligence</span></div>
      <p class="eyebrow">Non-mirrored cohort analysis</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="subtitle">Units, exact active synergies, artifacts, and augment loadouts ranked by draw-aware score rate—with uncertainty and selection frequency kept visible.</p>
    </div>
    <div class="hero-stats" aria-label="Report summary">
      <div class="hero-stat"><strong>${escapeHtml(fightVersion)}</strong><span>Fight AI</span></div>
      <div class="hero-stat"><strong>${formatInteger(cohorts.length)}</strong><span>Cohorts</span></div>
      <div class="hero-stat"><strong>${formatInteger(rows.length)}</strong><span>Ranking rows</span></div>
      <div class="hero-stat"><strong>${totalGames ? formatInteger(totalGames) : "—"}</strong><span>Reported games</span></div>
    </div>
  </div>
</header>
<main class="shell report-main">
  <aside class="notice" aria-label="Interpretation caveat">
    <div class="notice-mark">!</div>
    <div><h2>Controlled strength and associative composition</h2><p>Artifact and augment score rates use the policy's 20% uniform exploration assignments, breaking the link between a strong army and its usual item choice. Synergy rows instead track exact faction, choice, and active level under the deployed deterministic setup policy; they remain composition-confounded associations, not randomized causal effects. Augment plans are the causal unit; individual levels remain compositional diagnostics.</p></div>
  </aside>
  ${
      hasWaterData
          ? `<aside class="notice non-live-notice" aria-label="Non-live map notice"><div class="notice-mark">!</div><div><h2>${
                hasLiveRows ? "Live rankings exclude Water" : "Aggregate includes NON-LIVE Water"
            }</h2><p>${
                hasLiveRows
                    ? "This simulation includes Water, which is not a live-game map. Rankings default to Live maps (Normal, Lava, and Block); choose the non-live aggregate or Water only for historical research."
                    : "This legacy summary includes Water, which is not a live-game map, but has no live-only ranking rows. Reaggregate its raw pair files before making production-map balance claims."
            }</p></div></aside>`
          : ""
  }
  <div class="sticky-filter"><div class="filter-row"><nav class="cohort-tabs" id="cohort-tabs" aria-label="Filter report by cohort"></nav><label class="map-picker" for="map-filter"><span>Map</span><select class="map-filter" id="map-filter" aria-label="Filter report by map"></select></label><div class="filter-coverage" id="filter-coverage" aria-live="polite"></div></div></div>

  <section aria-labelledby="leaders-title">
    <div class="section-head"><div><p class="eyebrow">At a glance</p><h2 id="leaders-title">Category leaders</h2></div><p>Highest observed draw-aware score rate in the selected cohort and map set. Treat close results as a tier rather than a proven unique winner: confidence intervals can overlap, synergy rows inherit roster composition, and the augment-plan view compares 96 candidates.</p></div>
    <div class="leaders" id="leaders"></div>
  </section>

  <section aria-labelledby="rankings-title">
    <div class="section-head"><div><p class="eyebrow">Comparative performance</p><h2 id="rankings-title">Score-rate forest plots</h2></div><p>The selected cohort and map set apply to every chart. Unit and synergy panels include every supported entry and activation level; the gold rule marks 50%, and whiskers show reported 95% intervals.</p></div>
    <div class="chart-grid" id="forest-grid"></div>
  </section>

  <section aria-labelledby="patterns-title">
    <div class="section-head"><div><p class="eyebrow">Selection patterns</p><h2 id="patterns-title">Context behind the leaderboard</h2></div><p>Pick frequency can expose policy preference; cohort matrices show where aggregate score rates hide composition-specific reversals.</p></div>
    <div class="analysis-grid">
      <article class="analysis-card" id="scatter-card"><h3>Pick rate vs score rate</h3><p>Each point is one ranked item with both metrics available.</p><div id="scatter"></div></article>
      <article class="analysis-card" id="heatmap-card"><h3>Cohort performance matrix</h3><p>Color encodes percentage-point lift from 50%.</p><div id="heatmap"></div></article>
    </div>
  </section>

  <section aria-labelledby="table-title">
    <div class="section-head"><div><p class="eyebrow">Audit the numbers</p><h2 id="table-title">Full rankings</h2></div><p>Search any unit, synergy, or item within the selected cohort and map, restrict by category, and sort on every reported metric.</p></div>
    <div class="table-card">
      <div class="table-tools"><input class="search" id="table-search" type="search" placeholder="Search name, key, cohort…" aria-label="Search rankings"><select class="type-filter" id="type-filter" aria-label="Filter ranking category"><option value="all">All categories</option></select><span class="table-total" id="table-total"></span></div>
      <div class="table-wrap"><table class="ranking-table"><thead><tr><th><button data-sort="categoryLabel">Type</button></th><th><button data-sort="name">Entry</button></th><th><button data-sort="cohort">Cohort</button></th><th><button data-sort="map">Map</button></th><th><button data-sort="sample">Sample</button></th><th><button data-sort="wins">W</button></th><th><button data-sort="losses">L</button></th><th><button data-sort="draws">D</button></th><th><button data-sort="scoreRate">Score rate</button></th><th><button data-sort="winRate">Win rate</button></th><th><button data-sort="ciLow">95% CI</button></th><th><button data-sort="pickRate">Pick rate</button></th><th><button data-sort="liftPp">Lift</button></th></tr></thead><tbody id="ranking-body"></tbody></table></div>
    </div>
  </section>

  <section aria-labelledby="method-title">
    <div class="section-head"><div><p class="eyebrow">Reproducibility</p><h2 id="method-title">Method and provenance</h2></div><p>Keep these identifiers with screenshots or exported conclusions so the result remains traceable.</p></div>
    <div class="details-grid">
      <article class="details-card"><h3>Run provenance</h3><dl class="provenance">${provenanceHtml}</dl></article>
      <article class="details-card"><h3>Cohort definitions</h3><div class="cohort-notes">${cohortDescriptionHtml}</div></article>
    </div>
  </section>
  <footer class="footer"><span>Generated ${escapeHtml(generatedAt)}</span><span>Heroes of Crypto · self-contained report · no external assets</span></footer>
</main>
<noscript><p class="noscript">JavaScript is required to assemble the interactive charts and tables. All report data remains embedded in this file.</p></noscript>
<script type="application/json" id="report-data">${scriptSafeJson(reportData)}</script>
<script>
(function(){
"use strict";
var dataNode=document.getElementById("report-data");
var DATA=JSON.parse(dataNode&&dataNode.textContent?dataNode.textContent:"{}");
var rows=Array.isArray(DATA.rows)?DATA.rows:[];
var categories=Array.isArray(DATA.categories)?DATA.categories:[];
var cohorts=Array.isArray(DATA.cohorts)?DATA.cohorts:[];
var assets=DATA.assets||{};
var mapDefinitions=Array.isArray(DATA.mapDefinitions)?DATA.mapDefinitions:[];
var reportedMaps=new Set(rows.map(function(row){return row.map||"all"}));
var waterContributes=reportedMaps.has("2")||cohorts.some(function(cohort){return finite(cohort.mapGames&&cohort.mapGames["2"])&&cohort.mapGames["2"]>0})||mapDefinitions.some(function(map){return map.id==="all"&&map.nonLive});
var visibleMaps=availableMapDefinitions();
var defaultMap=reportedMaps.has("live")?"live":reportedMaps.has("all")?"all":visibleMaps.length?visibleMaps[0].id:"all";
var state={cohort:"all",map:defaultMap,query:"",type:"all",sort:"rate",direction:-1};
var numberFormat=new Intl.NumberFormat("en-US");
var svgNS="http://www.w3.org/2000/svg";
function node(tag,className,text){var item=document.createElement(tag);if(className)item.className=className;if(text!==undefined)item.textContent=text;return item}
function svg(tag,attributes){var item=document.createElementNS(svgNS,tag);Object.keys(attributes||{}).forEach(function(key){item.setAttribute(key,String(attributes[key]))});return item}
function finite(value){return typeof value==="number"&&Number.isFinite(value)}
function rate(value){return finite(value)?(value*100).toFixed(1)+"%":"—"}
function lift(value){if(!finite(value))return "—";return (value>0?"+":"")+value.toFixed(1)+"pp"}
function sample(row){return finite(row.sample)?numberFormat.format(row.sample):"—"}
function image(row){return assets[row.imageId]||assets.unknown_creature_512||""}
function tone(value){return !finite(value)||Math.abs(value)<.05?"neutral":value>0?"positive":"negative"}
function cohortLabel(id){var found=cohorts.find(function(item){return item.id===id});return found?found.label:(id==="all"?"All cohorts":id)}
function categoryLabel(key){var found=categories.find(function(item){return item.key===key});return found?found.label:key}
function mapLabel(id){var found=mapDefinitions.find(function(item){return item.id===id});return found?found.label:(id||"All simulated")}
function mapIsNonLive(id){var found=mapDefinitions.find(function(item){return item.id===id});return Boolean(found&&found.nonLive)}
function availableMapDefinitions(){return mapDefinitions.filter(function(map){if(map.id==="all")return (!reportedMaps.size||reportedMaps.has("all"))&&(!reportedMaps.has("live")||waterContributes);return reportedMaps.has(map.id)})}
function selectedMapRows(values){return values.filter(function(row){return (row.map||"all")===state.map})}
function exactCohortRows(category){var categoryRows=selectedMapRows(rows.filter(function(row){return row.category===category})).filter(supported);if(state.cohort!=="all")return categoryRows.filter(function(row){return row.cohort===state.cohort});var aggregate=categoryRows.filter(function(row){return !row.cohort||row.cohort==="all"});return aggregate.length?aggregate:categoryRows}
function supported(row){return finite(row.pairs)&&row.pairs>0}
function tableRows(){var filtered=state.cohort==="all"?rows.slice():rows.filter(function(row){return row.cohort===state.cohort});filtered=selectedMapRows(filtered);if(state.type!=="all")filtered=filtered.filter(function(row){return row.category===state.type});if(state.query){var q=state.query.toLowerCase();filtered=filtered.filter(function(row){return [row.name,row.key,row.kind,row.level,row.cohort,row.categoryLabel,mapLabel(row.map)].join(" ").toLowerCase().includes(q)})}var key=state.sort;var direction=state.direction;return filtered.sort(function(a,b){var av=a[key],bv=b[key];if(finite(av)||finite(bv)){if(!finite(av))return 1;if(!finite(bv))return -1;return (av-bv)*direction}return String(av||"").localeCompare(String(bv||""))*direction})}
function renderTabs(){var host=document.getElementById("cohort-tabs");host.replaceChildren();var values=[{id:"all",label:"All cohorts"}].concat(cohorts);values.forEach(function(cohort){var button=node("button","cohort-tab"+(state.cohort===cohort.id?" active":""),cohort.label);button.type="button";button.setAttribute("aria-pressed",state.cohort===cohort.id?"true":"false");button.addEventListener("click",function(){state.cohort=cohort.id;renderAll()});host.append(button)})}
function renderMapFilter(){var select=document.getElementById("map-filter");select.replaceChildren();visibleMaps.forEach(function(map){var option=document.createElement("option");option.value=map.id;option.textContent=map.label;select.append(option)});select.value=state.map;select.addEventListener("change",function(){state.map=select.value;renderAll()})}
function coverageForCohort(cohort){var mapGames=cohort.mapGames||{};if(state.map==="all"&&finite(cohort.games))return cohort.games;var ids=state.map==="live"?["1","3","4"]:state.map==="all"?["1","2","3","4"]:[state.map];var values=ids.filter(function(id){return finite(mapGames[id])}).map(function(id){return mapGames[id]});return values.length?values.reduce(function(sum,value){return sum+value},0):null}
function selectedCoverage(){var selected=state.cohort==="all"?cohorts:cohorts.filter(function(cohort){return cohort.id===state.cohort});if(!selected.length)return null;var values=selected.map(coverageForCohort);return values.every(finite)?values.reduce(function(sum,value){return sum+value},0):null}
function renderCoverage(){var host=document.getElementById("filter-coverage");var coverage=selectedCoverage();host.className="filter-coverage"+(mapIsNonLive(state.map)?" non-live":"");host.replaceChildren();host.append(node("strong","",finite(coverage)?numberFormat.format(coverage)+" fights":"Coverage unavailable"));var context=cohortLabel(state.cohort)+" · "+mapLabel(state.map);if(mapIsNonLive(state.map))context+=" · research only";host.append(node("span","",context))}
function eligibleLeader(row,category){return supported(row)&&finite(row.rate)&&(category.key!=="augmentLevels"||String(row.level)!=="0")}
function renderLeaders(){var host=document.getElementById("leaders");host.replaceChildren();categories.forEach(function(category){var candidates=exactCohortRows(category.key).filter(function(row){return eligibleLeader(row,category)}).sort(function(a,b){return b.rate-a.rate});var row=candidates[0];if(!row)return;var card=node("article","leader");var art=node("div","leader-art");var img=node("img");img.src=image(row);img.alt="";art.append(img);var copy=node("div","leader-copy");copy.append(node("span","leader-type",category.label));copy.append(node("h3","",row.name));var metric=node("div","leader-metric");metric.append(node("strong","leader-rate",rate(row.rate)));metric.append(node("span","leader-lift "+tone(row.liftPp),lift(row.liftPp)));copy.append(metric);var basis=finite(row.scoreRate)?"Score rate":"Win-rate fallback";copy.append(node("div","leader-meta",basis+" · "+cohortLabel(row.cohort)+" · "+mapLabel(row.map)+" · n "+sample(row)));card.append(art,copy);host.append(card)});if(!host.children.length)host.append(node("div","empty","No ranking rows with a reported rate are available for the selected cohort and map."))}
function renderForest(category,host){var candidates=exactCohortRows(category.key).filter(function(row){return eligibleLeader(row,category)}).sort(function(a,b){return b.rate-a.rate});if(category.key!=="units"&&category.key!=="synergies")candidates=candidates.slice(0,12);host.replaceChildren();if(!candidates.length){host.append(node("div","empty","No rate data for "+category.label+" in the selected cohort and map."));return}var forest=node("div","forest");candidates.forEach(function(row){var line=node("div","forest-row");var label=node("div","forest-label");var img=node("img");img.src=image(row);img.alt="";var labelText=node("div");labelText.append(node("span","forest-name",row.name));var unitLevel=row.category==="units"&&row.level?"L"+row.level+" · ":"";labelText.append(node("span","forest-sample",unitLevel+"n "+sample(row)));label.append(img,labelText);var track=node("div","forest-track");var low=finite(row.ciLow)?row.ciLow:row.rate;var high=finite(row.ciHigh)?row.ciHigh:row.rate;var ci=node("span","forest-ci");ci.style.left=(Math.max(0,Math.min(1,low))*100)+"%";ci.style.width=(Math.max(0,Math.min(1,high)-Math.max(0,Math.min(1,low)))*100)+"%";var dot=node("span","forest-dot");dot.style.left=(Math.max(0,Math.min(1,row.rate))*100)+"%";var basis=finite(row.scoreRate)?"score rate":"win-rate fallback";track.title=row.name+" · "+mapLabel(row.map)+" · "+basis+" "+rate(row.rate)+" · decisive win rate "+rate(row.winRate)+" · CI "+rate(low)+"–"+rate(high);track.append(ci,dot);line.append(label,track,node("span","forest-rate",rate(row.rate)));forest.append(line)});host.append(forest)}
function renderForests(){var grid=document.getElementById("forest-grid");grid.replaceChildren();categories.forEach(function(category){var card=node("article","chart-card");var heading=node("header","chart-title");heading.append(node("h3","",category.label));var count=exactCohortRows(category.key).filter(function(row){return eligibleLeader(row,category)}).length;heading.append(node("span","chart-count",numberFormat.format(count)+" supported"));var host=node("div");card.append(heading,host);grid.append(card);renderForest(category,host)})}
function scatterColor(category){return category==="units"?"#67aef6":category==="synergies"?"#ff7db8":category==="artifactsT1"?"#f2c75d":category==="artifactsT2"?"#ffe4a3":category==="augmentPlans"?"#b98cff":"#63d28a"}
function renderScatter(){var host=document.getElementById("scatter");host.replaceChildren();var points=categories.flatMap(function(category){return exactCohortRows(category.key)}).filter(function(row){return finite(row.pickRate)&&finite(row.rate)});if(points.length<2){host.append(node("div","empty","Pick-rate data is not available for enough entries in the selected cohort and map."));return}var width=760,height=340,p={left:54,right:20,top:18,bottom:45};var maxX=Math.max(.1,Math.min(1,Math.max.apply(null,points.map(function(row){return row.pickRate}))*1.08));var rates=points.map(function(row){return row.rate});var minY=Math.max(0,Math.min(.5,Math.min.apply(null,rates))-.04);var maxY=Math.min(1,Math.max(.5,Math.max.apply(null,rates))+.04);if(maxY-minY<.1){minY=Math.max(0,minY-.05);maxY=Math.min(1,maxY+.05)}var x=function(value){return p.left+(value/maxX)*(width-p.left-p.right)};var y=function(value){return p.top+(maxY-value)/(maxY-minY)*(height-p.top-p.bottom)};var chart=svg("svg",{viewBox:"0 0 "+width+" "+height,class:"scatter-svg",role:"img","aria-label":"Scatter plot of pick rate versus score rate"});for(var i=0;i<=5;i+=1){var gx=p.left+i*(width-p.left-p.right)/5;chart.append(svg("line",{x1:gx,y1:p.top,x2:gx,y2:height-p.bottom,class:"scatter-grid"}));var xt=svg("text",{x:gx,y:height-19,class:"scatter-label","text-anchor":"middle"});xt.textContent=((maxX*i/5)*100).toFixed(0)+"%";chart.append(xt);var gy=p.top+i*(height-p.top-p.bottom)/5;chart.append(svg("line",{x1:p.left,y1:gy,x2:width-p.right,y2:gy,class:"scatter-grid"}));var value=maxY-i*(maxY-minY)/5;var yt=svg("text",{x:p.left-9,y:gy+4,class:"scatter-label","text-anchor":"end"});yt.textContent=(value*100).toFixed(0)+"%";chart.append(yt)}chart.append(svg("line",{x1:p.left,y1:height-p.bottom,x2:width-p.right,y2:height-p.bottom,class:"scatter-axis"}));chart.append(svg("line",{x1:p.left,y1:p.top,x2:p.left,y2:height-p.bottom,class:"scatter-axis"}));if(.5>=minY&&.5<=maxY)chart.append(svg("line",{x1:p.left,y1:y(.5),x2:width-p.right,y2:y(.5),class:"scatter-parity"}));points.forEach(function(row){var circle=svg("circle",{cx:x(row.pickRate),cy:y(row.rate),r:6,fill:scatterColor(row.category),class:"scatter-dot"});var tooltip=svg("title",{});tooltip.textContent=row.name+" · "+mapLabel(row.map)+" · pick "+rate(row.pickRate)+" · score "+rate(row.rate)+" · decisive win "+rate(row.winRate);circle.append(tooltip);chart.append(circle)});var xLabel=svg("text",{x:(p.left+width-p.right)/2,y:height-2,class:"scatter-label","text-anchor":"middle"});xLabel.textContent="Pick rate";chart.append(xLabel);var yLabel=svg("text",{x:13,y:(p.top+height-p.bottom)/2,class:"scatter-label",transform:"rotate(-90 13 "+((p.top+height-p.bottom)/2)+")","text-anchor":"middle"});yLabel.textContent="Score rate";chart.append(yLabel);host.append(chart)}
function cellColor(delta){var strength=Math.min(.72,.1+Math.abs(delta)/18);return delta>=0?"rgba(99,210,138,"+strength+")":"rgba(239,74,63,"+strength+")"}
function renderHeatmap(){var host=document.getElementById("heatmap");host.replaceChildren();var cohortIds=cohorts.map(function(item){return item.id});if(cohortIds.length<2){host.append(node("div","empty","At least two named cohorts are needed for a matrix."));return}var groups=new Map();selectedMapRows(rows).forEach(function(row){if(!supported(row)||!finite(row.rate)||!cohortIds.includes(row.cohort))return;var id=row.category+":"+row.key;if(!groups.has(id))groups.set(id,{name:row.name,category:row.category,values:new Map()});groups.get(id).values.set(row.cohort,row.rate)});var ranked=Array.from(groups.values()).filter(function(group){return group.values.size>=2}).sort(function(a,b){return b.values.size-a.values.size}).slice(0,14);if(!ranked.length){host.append(node("div","empty","No entries have rates in two or more cohorts for the selected map."));return}var wrap=node("div","heatmap-wrap");var table=node("table","heatmap");var head=node("thead");var header=node("tr");header.append(node("th","","Entry"));cohorts.forEach(function(cohort){header.append(node("th","",cohort.label))});head.append(header);var body=node("tbody");ranked.forEach(function(group){var line=node("tr");var label=node("td","heat-name",group.name);label.title=categoryLabel(group.category)+" · "+mapLabel(state.map);line.append(label);cohortIds.forEach(function(id){var value=group.values.get(id);var cell=node("td","",finite(value)?rate(value):"—");if(finite(value)){var delta=(value-.5)*100;cell.style.background=cellColor(delta);cell.title=lift(delta)}line.append(cell)});body.append(line)});table.append(head,body);wrap.append(table);host.append(wrap)}
function renderTypeFilter(){var select=document.getElementById("type-filter");if(select.options.length>1)return;categories.forEach(function(category){var option=document.createElement("option");option.value=category.key;option.textContent=category.label;select.append(option)})}
function td(text,className){return node("td",className||"",text)}
function renderTable(){var body=document.getElementById("ranking-body");var values=tableRows();body.replaceChildren();values.forEach(function(row){var line=node("tr");line.append(td(row.categoryLabel));var entry=td("");var wrap=node("div","table-entry");var img=node("img");img.src=image(row);img.alt="";var copy=node("div");copy.append(node("strong","",row.name));copy.append(node("span","type-chip",row.key));wrap.append(img,copy);entry.append(wrap);line.append(entry);line.append(td(cohortLabel(row.cohort)));line.append(td(mapLabel(row.map),mapIsNonLive(row.map)?"negative":""));line.append(td(sample(row)));line.append(td(finite(row.wins)?numberFormat.format(row.wins):"—"));line.append(td(finite(row.losses)?numberFormat.format(row.losses):"—"));line.append(td(finite(row.draws)?numberFormat.format(row.draws):"—"));line.append(td(rate(row.scoreRate),"rate-cell"));line.append(td(rate(row.winRate)));line.append(td(finite(row.ciLow)&&finite(row.ciHigh)?rate(row.ciLow)+" – "+rate(row.ciHigh):"—"));line.append(td(rate(row.pickRate)));line.append(td(lift(row.liftPp),tone(row.liftPp)));body.append(line)});if(!values.length){var line=node("tr");var empty=td("No ranking rows match the selected cohort, map, and table filters.","empty");empty.colSpan=13;line.append(empty);body.append(line)}document.getElementById("table-total").textContent=numberFormat.format(values.length)+" rows"}
function bindTable(){var search=document.getElementById("table-search");search.addEventListener("input",function(){state.query=search.value.trim();renderTable()});var select=document.getElementById("type-filter");select.addEventListener("change",function(){state.type=select.value;renderTable()});document.querySelectorAll("[data-sort]").forEach(function(button){button.addEventListener("click",function(){var key=button.getAttribute("data-sort");if(state.sort===key)state.direction*=-1;else{state.sort=key;state.direction=key==="name"||key==="categoryLabel"||key==="cohort"||key==="map"?1:-1}renderTable()})})}
function renderAll(){renderTabs();renderCoverage();renderLeaders();renderForests();renderScatter();renderHeatmap();renderTable()}
renderTypeFilter();renderMapFilter();bindTable();renderAll();
})();
</script>
</body>
</html>`;
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
    const [summaryArgument, outputArgument] = argv;
    if (!summaryArgument) {
        throw new Error("Usage: bun src/simulation/render_ai_meta_report.ts <summary.json> [report.html]");
    }
    const summaryPath = resolve(summaryArgument);
    const outputPath = outputArgument
        ? resolve(outputArgument)
        : summaryPath.toLowerCase().endsWith(".json")
          ? `${summaryPath.slice(0, -5)}.html`
          : `${summaryPath}.html`;
    const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
    const html = renderAiMetaReport(parsed);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);
    console.log(`AI meta report -> ${outputPath}`);
}

if ((import.meta as unknown as { main?: boolean }).main) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
