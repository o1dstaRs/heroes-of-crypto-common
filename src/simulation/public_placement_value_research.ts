import { buildPlacementInput } from "../ai/placement/adapter";
import { propose, valid, cells, type PublicInput, type Point } from "../ai/placement/layout";
import { relationFeatures } from "../ai/placement/relations";
import { draftSynergyEffects, DRAFT_BATTLEFIELD_FACTIONS } from "../ai/setup/draft_battlefield_context";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import { GridSettings } from "../grid/grid_settings";
import { GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X } from "../grid/grid_constants";
import { getPositionForCells } from "../grid/grid_math";
import { traceGridRayCells } from "../grid/ray_traversal";
import { SynergyKeysToPower } from "../synergies/synergy_properties";

export const PUBLIC_PLACEMENT_VALUE_FEATURE_SCHEMA = "native-public-placement-value-v1";
export const PUBLIC_PLACEMENT_VALUE_FEATURE_COUNT = 2772;
export const PUBLIC_PLACEMENT_VALUE_RESEARCH_ONLY = true;

export interface IPublicPlacementValueContext {
    input: PublicInput;
    neutralCells: Point[];
    synergyVariants: RankedDraftSynergyVariants;
    ownActiveSynergies: string[];
    positiveAuraRanges: number[][];
}

const raySettings = new GridSettings(GRID_SIZE, MAX_Y, MIN_Y, MAX_X, MIN_X, 0, 0);
const inputKeys = ["bodies", "enemyIds", "enemyKits", "map", "artifacts", "doctrine", "augments", "left", "legal"];
const bodyKeys = [
    "id",
    "creature",
    "name",
    "amount",
    "width",
    "height",
    "ranged",
    "caster",
    "healer",
    "aura",
    "fly",
    "driven",
    "hp",
    "damage",
    "range",
    "steps",
    "initiative",
    "level",
];

function requireValue(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Invalid public placement research context: ${message}`);
}
function exactKeys(value: object, expected: readonly string[]): void {
    requireValue(Object.getPrototypeOf(value) === Object.prototype, "plain objects only");
    requireValue(Object.getOwnPropertySymbols(value).length === 0, "symbol fields");
    requireValue(
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
        "unexpected fields",
    );
}
function ordered(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(ordered).join(",")}]`;
    if (value !== null && typeof value === "object")
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${ordered((value as Record<string, unknown>)[key])}`)
            .join(",")}}`;
    requireValue(
        value === null ||
            typeof value === "string" ||
            typeof value === "boolean" ||
            (typeof value === "number" && Number.isFinite(value)),
        "non-JSON value",
    );
    return JSON.stringify(value);
}

/** Restore the native body constructor order before its order-sensitive proposal seed is used. */
export function normalizePublicPlacementValueContext(
    context: IPublicPlacementValueContext,
): IPublicPlacementValueContext {
    exactKeys(context, ["input", "neutralCells", "synergyVariants", "ownActiveSynergies", "positiveAuraRanges"]);
    const input = context.input;
    exactKeys(input, inputKeys);
    requireValue(Array.isArray(input.bodies) && input.bodies.length >= 6 && input.bodies.length <= 12, "body count");
    for (const body of input.bodies) {
        exactKeys(body, bodyKeys);
        requireValue(
            typeof body.id === "string" && body.id.length > 0 && typeof body.name === "string",
            "body identity",
        );
        requireValue(
            [body.width, body.height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 16),
            "body geometry",
        );
    }
    requireValue(
        Array.isArray(input.legal) &&
            input.legal.length <= 256 &&
            new Set(input.legal).size === input.legal.length &&
            input.legal.every((value) => Number.isSafeInteger(value) && value >= 0 && value < 256),
        "legal cells",
    );
    requireValue(typeof input.left === "boolean", "physical side");
    for (const augment of input.augments) exactKeys(augment, ["kind", "value"]);
    const restored = buildPlacementInput(
        input.bodies.map((body) => ({
            getId: () => body.id,
            getName: () => body.name,
            getAmountAlive: () => body.amount,
            getFootprintWidth: () => body.width,
            getFootprintHeight: () => body.height,
        })),
        {
            team: input.left ? 2 : 1,
            gridType: input.map,
            sideOrientedPlacement: true,
            legalCellHashes: new Set(input.legal),
            publicOpponentCreatureIds: input.enemyIds,
            artifacts: input.artifacts as [number, number],
            doctrine: input.doctrine,
            augments: input.augments,
        },
    );
    requireValue(restored && ordered(restored) === ordered(input), "native model domain or catalog mismatch");
    exactKeys(context.synergyVariants, DRAFT_BATTLEFIELD_FACTIONS);
    requireValue(
        DRAFT_BATTLEFIELD_FACTIONS.every((faction) => [1, 2].includes(context.synergyVariants[faction])),
        "public variants",
    );
    requireValue(Array.isArray(context.neutralCells) && context.neutralCells.length <= 256, "neutral layout");
    requireValue(input.map === 4 || context.neutralCells.length === 0, "neutral cells on an unsupported map");
    const occupied = new Set<number>();
    for (const cell of context.neutralCells) {
        exactKeys(cell, ["x", "y"]);
        requireValue(
            [cell.x, cell.y].every((value) => Number.isSafeInteger(value) && value >= 0 && value < 16),
            "neutral cell",
        );
        const key = cell.x * 16 + cell.y;
        requireValue(!occupied.has(key), "duplicate neutral cell");
        occupied.add(key);
    }
    requireValue(
        Array.isArray(context.positiveAuraRanges) && context.positiveAuraRanges.length === input.bodies.length,
        "aura alignment",
    );
    requireValue(
        context.positiveAuraRanges.every(
            (ranges) =>
                Array.isArray(ranges) &&
                ranges.length <= 32 &&
                ranges.every((range) => Number.isFinite(range) && range >= 0 && range <= 32),
        ),
        "positive aura ranges",
    );
    requireValue(
        Array.isArray(context.ownActiveSynergies) && context.ownActiveSynergies.length <= 4,
        "active synergies",
    );
    const own = draftSynergyEffects(
        input.bodies.map((body) => body.creature),
        context.synergyVariants,
    );
    const seen = new Set<string>();
    for (const key of context.ownActiveSynergies) {
        requireValue(typeof key === "string", "active synergy key");
        const parts = key.split(":"),
            faction = parts[0] as (typeof DRAFT_BATTLEFIELD_FACTIONS)[number];
        const index = DRAFT_BATTLEFIELD_FACTIONS.indexOf(faction),
            variant = Number(parts[1]),
            level = Number(parts[2]);
        requireValue(parts.length === 3 && index >= 0 && !seen.has(faction), "active synergy faction");
        requireValue(
            variant === context.synergyVariants[faction] &&
                Number.isSafeInteger(level) &&
                level >= 1 &&
                level <= own.levels[index] &&
                !!SynergyKeysToPower[key],
            "active synergy level or variant",
        );
        seen.add(faction);
    }
    return {
        input: restored,
        neutralCells: context.neutralCells.map((cell) => ({ ...cell })),
        synergyVariants: { ...context.synergyVariants },
        ownActiveSynergies: [...context.ownActiveSynergies],
        positiveAuraRanges: context.positiveAuraRanges.map((ranges) => [...ranges]),
    };
}

export function publicPlacementValueProposals(
    context: IPublicPlacementValueContext,
    reference: readonly Point[],
): Point[][] {
    const checked = normalizePublicPlacementValueContext(context);
    requireValue(valid(checked.input, reference), "reference formation");
    const blocked = new Set(checked.neutralCells.map((cell) => cell.x * 16 + cell.y));
    const proposals = Array.from({ length: 8 }, (_, index) => propose(checked.input, reference, index));
    requireValue(
        proposals.every((points) =>
            points.every((point, i) =>
                cells(checked.input.bodies[i], point).every((cell) => !blocked.has(cell.x * 16 + cell.y)),
            ),
        ),
        "proposal intersects neutral terrain",
    );
    return proposals;
}

function effectVector(power: (faction: string, variant: number, component?: number) => number): number[] {
    return [
        power("Chaos", 1) / 5,
        power("Nature", 1) / 6,
        power("Might", 1) / 5,
        power("Nature", 2) / 100,
        power("Might", 2) / 100,
        power("Life", 1) / 100,
        power("Life", 2) / 10,
        power("Life", 2, 1) / 10,
        power("Chaos", 2) / 100,
    ];
}

export function publicPlacementValueRayBits(
    context: IPublicPlacementValueContext,
    positions: readonly Point[],
): number[] {
    requireValue(valid(context.input, positions), "ray formation");
    const blocked = new Set(context.neutralCells.map((cell) => cell.x * 16 + cell.y));
    const result: number[] = [];
    for (let i = 0; i < 12; i++) {
        const body = context.input.bodies[i];
        if (!body?.ranged) {
            result.push(...Array(14).fill(0));
            continue;
        }
        const origin = getPositionForCells(raySettings, cells(body, positions[i]))!;
        for (let y = 1; y <= 14; y++) {
            const target = getPositionForCells(raySettings, [{ x: context.input.left ? 12 : 3, y }])!;
            result.push(
                Number(
                    traceGridRayCells(raySettings, origin, target).some(([cell]) => blocked.has(cell.x * 16 + cell.y)),
                ),
            );
        }
    }
    return result;
}

/** Tensor construction accepts only the explicit own/public envelope; audit snapshots stay outside it. */
export function publicPlacementValueFeatures(
    context: IPublicPlacementValueContext,
    positions: readonly Point[],
    reference: readonly Point[],
): number[] {
    const checked = normalizePublicPlacementValueContext(context),
        input = checked.input;
    requireValue(valid(input, positions) && valid(input, reference), "candidate or reference formation");
    const x = relationFeatures(input, positions, reference);
    const canonicalNeutral = new Set(
        checked.neutralCells.map((cell) => (input.left ? cell.x : 15 - cell.x) * 16 + cell.y),
    );
    for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 16; cy++) x.push(Number(canonicalNeutral.has(cx * 16 + cy)));
    x.push(...publicPlacementValueRayBits(checked, positions));
    const footprints = input.bodies.map((body, i) => cells(body, positions[i]));
    for (let source = 0; source < 12; source++)
        for (let target = 0; target < 12; target++) {
            if (source === target || !footprints[source] || !footprints[target]) {
                x.push(0);
                continue;
            }
            const distance = Math.min(
                ...footprints[source].flatMap((a) =>
                    footprints[target].map((b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))),
                ),
            );
            x.push(Number(checked.positiveAuraRanges[source].some((range) => distance <= range)));
        }
    for (const faction of DRAFT_BATTLEFIELD_FACTIONS)
        for (const variant of [1, 2]) x.push(Number(checked.synergyVariants[faction] === variant));
    const active = new Map(
        checked.ownActiveSynergies.map((key) => {
            const [faction, variant, level] = key.split(":");
            return [faction, { variant: Number(variant), level: Number(level) }] as const;
        }),
    );
    for (const faction of DRAFT_BATTLEFIELD_FACTIONS)
        for (const variant of [1, 2])
            for (const level of [1, 2, 3])
                x.push(Number(active.get(faction)?.variant === variant && active.get(faction)?.level === level));
    const own = draftSynergyEffects(
        input.bodies.map((body) => body.creature),
        checked.synergyVariants,
    );
    x.push(...own.factionCounts.map((value) => value / 6), ...own.levels.map((value) => value / 3));
    x.push(
        ...effectVector((faction, variant, component = 0) => {
            const selected = active.get(faction);
            return selected?.variant === variant
                ? (SynergyKeysToPower[`${faction}:${variant}:${selected.level}`]?.[component] ?? 0)
                : 0;
        }),
    );
    const enemy = draftSynergyEffects(input.enemyIds, checked.synergyVariants);
    x.push(...enemy.factionCounts.map((value) => value / 6), ...enemy.levels.map((value) => value / 3));
    x.push(
        ...effectVector((faction, variant, component = 0) => {
            const index = DRAFT_BATTLEFIELD_FACTIONS.indexOf(faction as (typeof DRAFT_BATTLEFIELD_FACTIONS)[number]);
            const level = enemy.levels[index];
            return checked.synergyVariants[faction as keyof RankedDraftSynergyVariants] === variant && level > 0
                ? (SynergyKeysToPower[`${faction}:${variant}:${level}`]?.[component] ?? 0)
                : 0;
        }),
    );
    requireValue(
        x.length === PUBLIC_PLACEMENT_VALUE_FEATURE_COUNT && x.every(Number.isFinite),
        "feature schema or finite values",
    );
    return x;
}
