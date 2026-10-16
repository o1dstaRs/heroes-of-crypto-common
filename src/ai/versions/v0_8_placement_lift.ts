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

import type { GameAction } from "../../engine/actions";
import CREATURES_JSON from "../../configuration/creatures.json";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import { SpellTargetType } from "../../spells/spell_properties";
import { roundUnitStat } from "../../units/stat_rounding";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai_strategy";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";
import { byFootprintAreaLargestFirst, footprintArea } from "./v0_1";

/** Placement-only candidates. Each one is a post-pass on today's placeArmy. */
export const PLACEMENT_LIFT_CANDIDATES = [
    "r1c1",
    "r1c2",
    "r1c3",
    "r2c1",
    "r2c2",
    "r2c3",
    "r3c1",
    "r3c2",
    "r3c3",
    "r4c1",
    "r4c2",
    "r4c3",
    "r5c1",
    "r5c2",
    "r5c3",
    "r6c1",
    "r6c2",
    "r6c3",
    "r7c1",
    "r7c2",
    "r7c3",
    "r8c1",
    "r8c2",
    "r8c3",
    "r9c1",
    "r9c2",
    "r9c3",
    "r10c1",
    "r10c2",
    "r10c3",
] as const;
export type PlacementLiftCandidateId = (typeof PLACEMENT_LIFT_CANDIDATES)[number];

export const PLACEMENT_LIFT_TITLES: Readonly<Record<PlacementLiftCandidateId, string>> = {
    r1c1: "Threat files for the bows, corners locked",
    r1c2: "Screens, chargers, and flyers by the public roster",
    r1c3: "Casters leave the cell the threat can reach",
    r2c1: "Bows leave the back rank only for the roster that punishes corners",
    r2c2: "Seam wall, empty charger lane, and off-file flyers",
    r2c3: "Ward and screen stand where that public threat misses",
    r3c1: "One-cell bow keeps the corner, extras finish the front",
    r3c2: "One step off the breath, or a front pack beside the charger",
    r3c3: "Caster and screen at the distance that threat misses",
    r4c1: "Pierce clears the bow file, blasts use back-rank thirds, HP holds the corners",
    r4c2: "Nothing in the cell behind a strike, or flyers on one high file",
    r4c3: "Caster outside the aim, screen on the cell that is hit first",
    r5c1: "Empty-aim ring, cannon files, or full-damage corners",
    r5c2: "Armor on the face, empty charger wing, split flyers",
    r5c3: "Blast bait, two files off the plug, or a three-wide shield",
    r6c1: "Front throw, aura partner, reach-11 file, or a ground cap",
    r6c2: "Immune file, skewer plug, or a packed wing",
    r6c3: "Screen on the ray, ward outside the landing",
    r7c1: "Rallying pair, absolving lane, inner reach-11 file, or a Handyman front",
    r7c2: "Immune file, shot cage, plugged back rank, or the empty centre runway",
    r7c3: "Angel takes the boulder, the second body takes the breath, the screen takes the landing",
    r8c1: "Reach-10 middle, flyer pocket, or a charge on the low half",
    r8c2: "Filled charge wing, empty-back cup, or a same-file shadow",
    r8c3: "Buffer gap, pierce-sized screen, or one cell beside the caster",
    r9c1: "Extra bows peel, leather leaves only under shots and wings",
    r9c2: "Skewer face, breath diagonal, half landing, or a checker",
    r9c3: "Caster outside the shell, the breath, the meteor, or the packed file",
    r10c1: "Centre-front gaze, winds one rank up, cannon off the edge",
    r10c2: "Low charge file, breath off the zone, flyers on the shoulders",
    r10c3: "Next-file splash, empty breath bait, centre outside the null",
};

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;
const LEFT = PBTypes.TeamVals.LEFT;
const SNIPER_REACH = 1.7;
const PROTECTORS = new Set(["Abomination", "Angel", "Arachna Queen"]);
const CASTER_STAYS = new Set(["Monk", "Dryad"]);

interface ICreatureJson {
    abilities?: string[];
    spells?: string[];
    attack_damage_min?: number;
    attack_damage_max?: number;
}

interface ICatalogEntry {
    readonly abilities: readonly string[];
    readonly spells: readonly string[];
    readonly damageMin: number;
    readonly damageMax: number;
}

const spellName = (entry: string): string => {
    const colon = entry.indexOf(":");
    return colon < 0 ? entry : entry.slice(colon + 1);
};

const buildCatalog = (): Map<string, ICatalogEntry> => {
    const catalog = new Map<string, ICatalogEntry>();
    for (const faction of Object.values(CREATURES_JSON)) {
        if (!faction || typeof faction !== "object") continue;
        for (const [name, cfg] of Object.entries(faction as Record<string, ICreatureJson>)) {
            if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.abilities)) continue;
            catalog.set(name, {
                abilities: cfg.abilities,
                spells: (cfg.spells ?? []).map(spellName),
                damageMin: cfg.attack_damage_min ?? 0,
                damageMax: cfg.attack_damage_max ?? 0,
            });
        }
    }
    return catalog;
};

const CATALOG = buildCatalog();

const hasNamed = (names: readonly string[] | undefined, needle: string): boolean =>
    (names ?? []).some((name) => name === needle || name.startsWith(`${needle} `));

export interface IPublicPlacementThreats {
    readonly areaThrow: boolean;
    readonly largeCaliber: boolean;
    readonly fireBreath: boolean;
    readonly skewerStrike: boolean;
    readonly lightningSpin: boolean;
    readonly throughShot: boolean;
    readonly chakram: boolean;
    readonly fireball: boolean;
    readonly ringOfFire: boolean;
    readonly meteorShower: boolean;
    readonly chainLightning: boolean;
    readonly rangeNullField: boolean;
    readonly rapidCharge: boolean;
    readonly rangeCreatures: number;
    readonly flyers: number;
    /** Fire Breath, Skewer Strike, Lightning Spin, Through Shot, or Chakram. */
    readonly lineAttack: boolean;
}

const EMPTY_THREATS: IPublicPlacementThreats = {
    areaThrow: false,
    largeCaliber: false,
    fireBreath: false,
    skewerStrike: false,
    lightningSpin: false,
    throughShot: false,
    chakram: false,
    fireball: false,
    ringOfFire: false,
    meteorShower: false,
    chainLightning: false,
    rangeNullField: false,
    rapidCharge: false,
    rangeCreatures: 0,
    flyers: 0,
    lineAttack: false,
};

/** Identities only. Positions, stack sizes, and the live holder are not consulted. */
export const publicPlacementThreats = (creatureIds: readonly number[] | undefined): IPublicPlacementThreats => {
    if (!creatureIds?.length) return EMPTY_THREATS;
    const threats = { ...EMPTY_THREATS };
    let rangeCreatures = 0;
    let flyers = 0;
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        if (!info) continue;
        if (info.ranged) rangeCreatures += 1;
        if (info.canFly) flyers += 1;
        const entry = CATALOG.get(info.name);
        const abilities = entry?.abilities ?? [];
        const spells = entry?.spells ?? [];
        if (hasNamed(abilities, "Area Throw")) threats.areaThrow = true;
        if (hasNamed(abilities, "Large Caliber")) threats.largeCaliber = true;
        if (hasNamed(abilities, "Fire Breath")) threats.fireBreath = true;
        if (hasNamed(abilities, "Skewer Strike")) threats.skewerStrike = true;
        if (hasNamed(abilities, "Lightning Spin")) threats.lightningSpin = true;
        if (hasNamed(abilities, "Through Shot")) threats.throughShot = true;
        if (hasNamed(abilities, "Chakram")) threats.chakram = true;
        if (hasNamed(abilities, "Rapid Charge")) threats.rapidCharge = true;
        if (hasNamed(abilities, "Chain Lightning") || hasNamed(spells, "Chain Lightning"))
            threats.chainLightning = true;
        if (hasNamed(abilities, "Range Null Field")) threats.rangeNullField = true;
        if (hasNamed(spells, "Fireball")) threats.fireball = true;
        if (hasNamed(spells, "Ring of Fire")) threats.ringOfFire = true;
        if (hasNamed(spells, "Meteor Shower")) threats.meteorShower = true;
    }
    threats.rangeCreatures = rangeCreatures;
    threats.flyers = flyers;
    threats.lineAttack =
        threats.fireBreath || threats.skewerStrike || threats.lightningSpin || threats.throughShot || threats.chakram;
    return threats;
};

const hasBlast = (threats: IPublicPlacementThreats): boolean =>
    threats.fireball || threats.ringOfFire || threats.chainLightning;

/**
 * Chebyshev distance between footprints. Range Null Field at 5 is the Griffin case: a 2×1 body
 * touching one bow still covers a bow four cells away, so five is the first safe distance.
 * Chakram bounces across one or two empty cells (distance 2 or 3) and stops at distance 4.
 */
export const separationGapForThreats = (threats: IPublicPlacementThreats): number => {
    if (threats.rangeNullField) return 5;
    if (threats.chakram && hasBlast(threats)) return 4;
    if (threats.meteorShower) return 3;
    if (hasBlast(threats)) return 2;
    return 0;
};

const blocksShortBowPull = (threats: IPublicPlacementThreats): boolean =>
    threats.areaThrow ||
    threats.largeCaliber ||
    threats.throughShot ||
    threats.fireBreath ||
    threats.fireball ||
    threats.ringOfFire ||
    threats.meteorShower ||
    threats.chainLightning ||
    threats.rangeNullField;

const keyOf = (cell: XY): number => (cell.x << 4) | cell.y;

const chebyshev = (a: XY, b: XY): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const minChebyshev = (left: readonly XY[], right: readonly XY[]): number => {
    let best = Infinity;
    for (const a of left) {
        for (const b of right) best = Math.min(best, chebyshev(a, b));
    }
    return best;
};

const sameCell = (a: XY, b: XY): boolean => a.x === b.x && a.y === b.y;

const byId = (a: Unit, b: Unit): number => (a.getId() < b.getId() ? -1 : a.getId() > b.getId() ? 1 : 0);

interface IGeom {
    readonly baseCells: readonly XY[];
    readonly legal: ReadonlySet<number>;
    readonly centreLat: number;
    readonly backFront: number;
    readonly lateral: (cell: XY) => number;
    readonly frontness: (cell: XY) => number;
    readonly edgeness: (cell: XY) => number;
    readonly towardEnemy: (cell: XY, steps: number) => XY;
    readonly shiftLateral: (cell: XY, delta: number) => XY;
    readonly inwardDelta: (cell: XY) => number;
}

const geomFor = (context: IPlacementContext): IGeom | undefined => {
    const legal = context.placement.possibleCellHashes();
    const baseCells = [...legal].map((hash) => ({ x: hash >> 4, y: hash & 0xf }));
    if (!baseCells.length) return undefined;
    const sideOriented = context.sideOrientedPlacement === true;
    const along = (cell: XY): number => (sideOriented ? cell.x : cell.y);
    const lateral = (cell: XY): number => (sideOriented ? cell.y : cell.x);
    const frontness = (cell: XY): number => (context.team === LEFT ? along(cell) : GRID_SIZE - 1 - along(cell));
    const lats = baseCells.map(lateral);
    const centreLat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const edgeness = (cell: XY): number => Math.abs(lateral(cell) - centreLat);
    const backFront = Math.min(...baseCells.map(frontness));
    const enemySign = context.team === LEFT ? 1 : -1;
    return {
        baseCells,
        legal,
        centreLat,
        backFront,
        lateral,
        frontness,
        edgeness,
        towardEnemy: (cell, steps) =>
            sideOriented ? { x: cell.x + enemySign * steps, y: cell.y } : { x: cell.x, y: cell.y + enemySign * steps },
        shiftLateral: (cell, delta) =>
            sideOriented ? { x: cell.x, y: cell.y + delta } : { x: cell.x + delta, y: cell.y },
        inwardDelta: (cell) => {
            const lat = lateral(cell);
            if (lat > centreLat) return -1;
            if (lat < centreLat) return 1;
            return 0;
        },
    };
};

interface IBoard {
    readonly geom: IGeom;
    readonly cells: Map<string, XY>;
    readonly units: readonly Unit[];
    readonly forbidden: ReadonlySet<number>;
    footprint(unit: Unit): XY[];
    laterals(unit: Unit): number[];
    free(unit: Unit, anchor: XY): boolean;
    place(unit: Unit, anchor: XY): boolean;
    sharesLateral(unit: Unit): boolean;
    occupiedLaterals(except: Unit): Set<number>;
}

const boardFrom = (
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    geom: IGeom,
    forbidden: ReadonlySet<number>,
): IBoard => {
    const cells = new Map<string, XY>();
    for (const [id, cell] of incumbent) cells.set(id, { x: cell.x, y: cell.y });
    const board: IBoard = {
        geom,
        cells,
        units,
        forbidden,
        footprint(unit) {
            const anchor = cells.get(unit.getId());
            return anchor ? footprintCellsForAnchor(unit, anchor) : [];
        },
        laterals(unit) {
            return this.footprint(unit).map((cell) => geom.lateral(cell));
        },
        free(unit, anchor) {
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!footprint.length) return false;
            const occupied = new Set<number>();
            for (const other of units) {
                if (other.getId() === unit.getId()) continue;
                for (const cell of this.footprint(other)) occupied.add(keyOf(cell));
            }
            return footprint.every((cell) => geom.legal.has(keyOf(cell)) && !occupied.has(keyOf(cell)));
        },
        place(unit, anchor) {
            if (!this.free(unit, anchor)) return false;
            const previous = cells.get(unit.getId());
            cells.set(unit.getId(), { x: anchor.x, y: anchor.y });
            return !previous || !sameCell(previous, anchor);
        },
        sharesLateral(unit) {
            const mine = new Set(this.laterals(unit));
            if (!mine.size) return false;
            for (const other of units) {
                if (other.getId() === unit.getId()) continue;
                if (this.laterals(other).some((lat) => mine.has(lat))) return true;
            }
            return false;
        },
        occupiedLaterals(except) {
            const occupied = new Set<number>();
            for (const other of units) {
                if (other.getId() === except.getId()) continue;
                for (const lat of this.laterals(other)) occupied.add(lat);
            }
            return occupied;
        },
    };
    return board;
};

const changedFrom = (before: ReadonlyMap<string, XY>, after: ReadonlyMap<string, XY>): boolean => {
    if (before.size !== after.size) return true;
    for (const [id, cell] of after) {
        const prior = before.get(id);
        if (!prior || !sameCell(prior, cell)) return true;
    }
    return false;
};

const placedRange = (units: readonly Unit[], board: IBoard): Unit[] =>
    units.filter((unit) => unit.getAttackType() === RANGE && board.footprint(unit).length > 0);

const onBackRank = (unit: Unit, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => board.geom.frontness(cell) === board.geom.backFront);

const backEdgeness = (unit: Unit, board: IBoard): number => {
    const cells = board.footprint(unit).filter((cell) => board.geom.frontness(cell) === board.geom.backFront);
    return cells.length ? Math.max(...cells.map((cell) => board.geom.edgeness(cell))) : -1;
};

/** Up to two RANGE stacks already on the highest-edgeness cells of the back rank. */
const lockedBows = (range: readonly Unit[], board: IBoard): Unit[] =>
    range
        .filter((unit) => onBackRank(unit, board))
        .slice()
        .sort((a, b) => backEdgeness(b, board) - backEdgeness(a, board) || byId(a, b))
        .slice(0, 2);

const cornerBan = (geom: IGeom): Set<number> => {
    const back = geom.baseCells.filter((cell) => geom.frontness(cell) === geom.backFront);
    back.sort(
        (a, b) => geom.edgeness(b) - geom.edgeness(a) || geom.lateral(a) - geom.lateral(b) || a.x - b.x || a.y - b.y,
    );
    const banned = new Set<number>();
    for (const cell of back.slice(0, 2)) banned.add(keyOf(cell));
    if (back.length > 2) {
        const nextEdgeness = geom.edgeness(back[2]);
        for (const cell of back) {
            if (geom.edgeness(cell) === nextEdgeness) banned.add(keyOf(cell));
        }
    }
    return banned;
};

const coversBanned = (footprint: readonly XY[], banned: ReadonlySet<number>): boolean =>
    footprint.some((cell) => banned.has(keyOf(cell)));

const touchesAlly = (unit: Unit, board: IBoard): boolean => {
    const footprint = board.footprint(unit);
    if (!footprint.length) return false;
    for (const other of board.units) {
        if (other.getId() === unit.getId()) continue;
        const otherFootprint = board.footprint(other);
        if (otherFootprint.length && minChebyshev(footprint, otherFootprint) <= 1) return true;
    }
    return false;
};

const leaveWithWard = (unit: Unit, board: IBoard): boolean =>
    PROTECTORS.has(unit.getName()) && touchesAlly(unit, board);

const isGroundMelee = (unit: Unit, board: IBoard): boolean => {
    if (unit.getAttackType() === RANGE || unit.canFly()) return false;
    const attack = unit.getAttackType();
    if (attack !== MELEE && attack !== MELEE_MAGIC) return false;
    return board.footprint(unit).length > 0 && !leaveWithWard(unit, board);
};

const shooterLaterals = (range: readonly Unit[], board: IBoard): Set<number> => {
    const laterals = new Set<number>();
    for (const bow of range) {
        for (const lat of board.laterals(bow)) laterals.add(lat);
    }
    return laterals;
};

const onLaterals = (unit: Unit, laterals: ReadonlySet<number>, board: IBoard): boolean =>
    board.laterals(unit).some((lat) => laterals.has(lat));

const centerFront = (unit: Unit, blocked: ReadonlySet<number>, board: IBoard): XY | undefined => {
    const spots = board.geom.baseCells.filter((anchor) => {
        if (!board.free(unit, anchor)) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        return footprint.every((cell) => !blocked.has(board.geom.lateral(cell)));
    });
    spots.sort(
        (a, b) =>
            board.geom.frontness(b) - board.geom.frontness(a) ||
            board.geom.edgeness(a) - board.geom.edgeness(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    return spots[0];
};

const relocateOffFile = (unit: Unit, blocked: ReadonlySet<number>, board: IBoard): boolean => {
    const anchor = board.cells.get(unit.getId());
    if (!anchor) return false;
    const inward = board.geom.inwardDelta(anchor);
    if (inward !== 0) {
        const diagonal = board.geom.towardEnemy(board.geom.shiftLateral(anchor, inward), 1);
        const footprint = footprintCellsForAnchor(unit, diagonal);
        if (board.free(unit, diagonal) && footprint.every((cell) => !blocked.has(board.geom.lateral(cell)))) {
            return board.place(unit, diagonal);
        }
    }
    const fallback = centerFront(unit, blocked, board);
    return fallback ? board.place(unit, fallback) : false;
};

const fileIsClear = (footprint: readonly XY[], occupied: ReadonlySet<number>, geom: IGeom): boolean => {
    const laterals = new Set(footprint.map((cell) => geom.lateral(cell)));
    for (const lat of laterals) {
        if (occupied.has(lat)) return false;
        for (const other of occupied) {
            if (Math.abs(lat - other) < 2) return false;
        }
    }
    return laterals.size > 0;
};

const deepestClearFile = (unit: Unit, board: IBoard): XY | undefined => {
    const occupied = board.occupiedLaterals(unit);
    const spots = board.geom.baseCells.filter((anchor) => {
        if (!board.free(unit, anchor)) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (coversBanned(footprint, board.forbidden)) return false;
        return fileIsClear(footprint, occupied, board.geom);
    });
    spots.sort(
        (a, b) =>
            board.geom.frontness(a) - board.geom.frontness(b) ||
            board.geom.edgeness(a) - board.geom.edgeness(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    return spots[0];
};

const applyFireBreath = (range: readonly Unit[], locked: readonly Unit[], board: IBoard): void => {
    const blocked = shooterLaterals(range, board);
    const movers = board.units
        .filter(
            (unit) =>
                unit.getAttackType() !== RANGE &&
                board.footprint(unit).length > 0 &&
                !leaveWithWard(unit, board) &&
                onLaterals(unit, blocked, board),
        )
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of movers) relocateOffFile(unit, blocked, board);
    if (range.length < 3) return;
    const lockedIds = new Set(locked.map((unit) => unit.getId()));
    const extras = range
        .filter((unit) => !lockedIds.has(unit.getId()))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const extra of extras) {
        if (!board.sharesLateral(extra)) continue;
        const spot = deepestClearFile(extra, board);
        if (spot) board.place(extra, spot);
    }
};

const rangeFootprintsExcept = (range: readonly Unit[], except: Unit, board: IBoard): XY[][] =>
    range.filter((unit) => unit.getId() !== except.getId()).map((unit) => board.footprint(unit));

const gapToOthers = (footprint: readonly XY[], others: readonly (readonly XY[])[]): number => {
    if (!others.length) return Infinity;
    return Math.min(...others.map((other) => minChebyshev(footprint, other)));
};

const deepestGapCell = (
    unit: Unit,
    gap: number,
    range: readonly Unit[],
    lockedLaterals: ReadonlySet<number>,
    board: IBoard,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    const others = rangeFootprintsExcept(range, unit, board);
    const spots = board.geom.baseCells.filter((anchor) => {
        if (!board.free(unit, anchor)) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (coversBanned(footprint, board.forbidden)) return false;
        if (footprint.some((cell) => lockedLaterals.has(board.geom.lateral(cell)))) return false;
        return gapToOthers(footprint, others) >= gap;
    });
    spots.sort((a, b) => {
        const depth = board.geom.frontness(a) - board.geom.frontness(b);
        if (depth) return depth;
        const aHere = current && sameCell(a, current) ? 0 : 1;
        const bHere = current && sameCell(b, current) ? 0 : 1;
        if (aHere !== bHere) return aHere - bHere;
        const spread =
            gapToOthers(footprintCellsForAnchor(unit, b), others) -
            gapToOthers(footprintCellsForAnchor(unit, a), others);
        return spread || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const applyGap = (range: readonly Unit[], locked: readonly Unit[], gap: number, board: IBoard): void => {
    const lockedIds = new Set(locked.map((unit) => unit.getId()));
    const lockedLaterals = shooterLaterals(locked, board);
    const extras = range
        .filter((unit) => !lockedIds.has(unit.getId()))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const extra of extras) {
        const spot = deepestGapCell(extra, gap, range, lockedLaterals, board);
        if (spot) board.place(extra, spot);
    }
};

const shotDistance = (unit: Unit): number => unit.getRangeShotDistance();

const anchorCovering = (unit: Unit, target: XY, board: IBoard): XY | undefined => {
    const spots = board.geom.baseCells.filter((anchor) => {
        if (!board.free(unit, anchor)) return false;
        return footprintCellsForAnchor(unit, anchor).some((cell) => sameCell(cell, target));
    });
    spots.sort((a, b) => {
        const aExact = sameCell(a, target) ? 0 : 1;
        const bExact = sameCell(b, target) ? 0 : 1;
        return aExact - bExact || board.geom.frontness(b) - board.geom.frontness(a) || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const coversCell = (unit: Unit, target: XY, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => sameCell(cell, target));

const applyScreen = (
    range: readonly Unit[],
    locked: readonly Unit[],
    threats: IPublicPlacementThreats,
    board: IBoard,
): void => {
    const distance = hasBlast(threats) ? 2 : 1;
    const primary = (range.length === 1 ? range : locked.length > 0 ? locked : range.slice(0, 2))
        .slice()
        .sort((a, b) => shotDistance(a) - shotDistance(b) || byId(a, b));
    const melees = board.units
        .filter((unit) => isGroundMelee(unit, board))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    const used = new Set<string>();
    const filled = new Set<string>();
    const assign = (bow: Unit): boolean => {
        const anchor = board.cells.get(bow.getId());
        if (!anchor) return false;
        const target = board.geom.towardEnemy(anchor, distance);
        const already = melees.find((melee) => !used.has(melee.getId()) && coversCell(melee, target, board));
        if (already) {
            used.add(already.getId());
            return true;
        }
        const choices = melees
            .filter((melee) => !used.has(melee.getId()))
            .sort((a, b) => {
                const aAnchor = board.cells.get(a.getId());
                const bAnchor = board.cells.get(b.getId());
                const aDist = aAnchor ? chebyshev(aAnchor, target) : Infinity;
                const bDist = bAnchor ? chebyshev(bAnchor, target) : Infinity;
                return aDist - bDist || byId(a, b);
            });
        for (const melee of choices) {
            const spot = anchorCovering(melee, target, board);
            if (!spot) continue;
            board.place(melee, spot);
            used.add(melee.getId());
            return true;
        }
        return false;
    };
    for (const bow of primary) {
        if (assign(bow)) filled.add(bow.getId());
    }
    if (!primary.length || primary.some((bow) => !filled.has(bow.getId()))) return;
    const primaryIds = new Set(primary.map((bow) => bow.getId()));
    const extras = range
        .filter((unit) => !primaryIds.has(unit.getId()))
        .sort((a, b) => shotDistance(a) - shotDistance(b) || byId(a, b));
    for (const bow of extras) assign(bow);
};

const reachOf = (unit: Unit): number => {
    const base = unit.getRangeShotDistance();
    return unit.hasAbilityActive("Sniper") ? base : base * SNIPER_REACH;
};

const reflectedZone = (geom: IGeom): XY[] =>
    geom.baseCells.map((cell) => ({ x: GRID_SIZE - 1 - cell.x, y: GRID_SIZE - 1 - cell.y }));

const nearestReflected = (anchor: XY, reflected: readonly XY[]): number => {
    let nearest = Infinity;
    for (const cell of reflected) nearest = Math.min(nearest, chebyshev(anchor, cell));
    return nearest;
};

const isShortBow = (unit: Unit, reflected: readonly XY[], board: IBoard): boolean => {
    const anchor = board.cells.get(unit.getId());
    if (!anchor) return false;
    return nearestReflected(anchor, reflected) > reachOf(unit);
};

// Rallying Volley Blessing reaches the whole army, so only Guiding Winds needs a nearby carrier.
const auraCarriers = (units: readonly Unit[]): Unit[] =>
    units.filter((unit) => unit.hasAbilityActive("Guiding Winds Aura"));

const applyShortBowPull = (range: readonly Unit[], locked: readonly Unit[], board: IBoard): void => {
    const carriers = auraCarriers(board.units).filter((unit) => board.footprint(unit).length > 0);
    if (!carriers.length) return;
    const anchorOf = (unit: Unit): XY => board.cells.get(unit.getId()) ?? { x: 0, y: 0 };
    carriers.sort((a, b) => {
        const aAnchor = anchorOf(a);
        const bAnchor = anchorOf(b);
        return (
            board.geom.frontness(bAnchor) - board.geom.frontness(aAnchor) ||
            board.geom.edgeness(aAnchor) - board.geom.edgeness(bAnchor) ||
            byId(a, b)
        );
    });
    const carrier = carriers[0];
    const carrierFootprint = board.footprint(carrier);
    const reflected = reflectedZone(board.geom);
    const lockedIds = new Set(locked.map((unit) => unit.getId()));
    const reserved = new Set<number>();
    for (const bow of range) {
        // Corner bows stay on the cells today's layout already gave them, even when they are short.
        if (lockedIds.has(bow.getId()) || !isShortBow(bow, reflected, board) || bow.getId() === carrier.getId()) {
            for (const lat of board.laterals(bow)) reserved.add(lat);
        }
    }
    const shortBows = range
        .filter(
            (bow) =>
                !lockedIds.has(bow.getId()) && bow.getId() !== carrier.getId() && isShortBow(bow, reflected, board),
        )
        .sort((a, b) => reachOf(a) - reachOf(b) || byId(a, b));
    for (const bow of shortBows) {
        const current = board.cells.get(bow.getId());
        const spots = board.geom.baseCells.filter((anchor) => {
            if (!board.free(bow, anchor)) return false;
            if (!carrierFootprint.some((cell) => chebyshev(anchor, cell) === 1)) return false;
            const footprint = footprintCellsForAnchor(bow, anchor);
            if (!footprint.length || minChebyshev(footprint, carrierFootprint) !== 1) return false;
            if (coversBanned(footprint, board.forbidden)) return false;
            return footprint.every((cell) => !reserved.has(board.geom.lateral(cell)));
        });
        spots.sort(
            (a, b) =>
                board.geom.frontness(b) - board.geom.frontness(a) ||
                board.geom.edgeness(a) - board.geom.edgeness(b) ||
                (current && sameCell(a, current) ? 0 : 1) - (current && sameCell(b, current) ? 0 : 1) ||
                a.x - b.x ||
                a.y - b.y,
        );
        const spot = spots[0];
        if (spot) board.place(bow, spot);
        for (const lat of board.laterals(bow)) reserved.add(lat);
    }
};

/**
 * r1c1 post-pass. Today's placeArmy has already run. The two back-rank corner bows stay on the
 * cells they already occupy; only screens and extra stacks move.
 */
export function placeArmyR1C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const banned = cornerBan(geom);
    const board = boardFrom(incumbent, units, geom, banned);
    const range = placedRange(units, board);
    if (!range.length) return new Map(board.cells);
    const locked = lockedBows(range, board);
    const before = new Map(board.cells);
    if (threats.fireBreath) {
        applyFireBreath(range, locked, board);
    } else if (threats.throughShot) {
        // The inherited screen is already off the shooter's file. Do not put one on it, and do not reshuffle extras.
    } else if (range.length >= 3 && separationGapForThreats(threats) > 0) {
        applyGap(range, locked, separationGapForThreats(threats), board);
    } else if (threats.rangeCreatures >= 2) {
        applyScreen(range, locked, threats, board);
    }
    const auraEligible =
        range.length >= 2 &&
        threats.rangeCreatures >= 2 &&
        !blocksShortBowPull(threats) &&
        auraCarriers(units).length > 0;
    if (!changedFrom(before, board.cells) && auraEligible) applyShortBowPull(range, locked, board);
    return board.cells;
}

const isBoardEdge = (cell: XY): boolean =>
    cell.x <= 0 || cell.y <= 0 || cell.x >= GRID_SIZE - 1 || cell.y >= GRID_SIZE - 1;

const isCharger = (unit: Unit): boolean => unit.hasAbilityActive("Rapid Charge");

const isSpellbookUnit = (unit: Unit): boolean => {
    const creatureId = creatureIdForName(unit.getName());
    return creatureId !== undefined && creatureInfo(creatureId)?.nativeSpellbook === true;
};

const bySlowest = (a: Unit, b: Unit): number =>
    a.getSteps() - b.getSteps() || b.getArmor() - a.getArmor() || byId(a, b);

const isSlowerThan = (unit: Unit, than: Unit): boolean => bySlowest(unit, than) < 0;

const lateralSpanCount = (unit: Unit, sideOriented: boolean): number => {
    const width = Math.max(1, unit.getFootprintWidth());
    const height = Math.max(1, unit.getFootprintHeight());
    return sideOriented ? height : width;
};

interface ISpan {
    readonly cells: readonly XY[];
    readonly laterals: readonly number[];
    readonly minLat: number;
    readonly maxLat: number;
    readonly minFront: number;
    readonly maxFront: number;
}

interface IZoneLimits {
    readonly minLat: number;
    readonly maxLat: number;
    readonly maxFront: number;
}

const zoneLimits = (geom: IGeom): IZoneLimits => {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let maxFront = -Infinity;
    for (const cell of geom.baseCells) {
        minLat = Math.min(minLat, geom.lateral(cell));
        maxLat = Math.max(maxLat, geom.lateral(cell));
        maxFront = Math.max(maxFront, geom.frontness(cell));
    }
    return { minLat, maxLat, maxFront };
};

const spanAt = (unit: Unit, anchor: XY, geom: IGeom): ISpan | undefined => {
    const cells = footprintCellsForAnchor(unit, anchor);
    if (!cells.length) return undefined;
    const laterals = cells.map((cell) => geom.lateral(cell));
    const fronts = cells.map((cell) => geom.frontness(cell));
    return {
        cells,
        laterals,
        minLat: Math.min(...laterals),
        maxLat: Math.max(...laterals),
        minFront: Math.min(...fronts),
        maxFront: Math.max(...fronts),
    };
};

const spanIsLegal = (span: ISpan, geom: IGeom, taken: ReadonlySet<number>): boolean =>
    span.cells.every((cell) => geom.legal.has(keyOf(cell)) && !taken.has(keyOf(cell)) && !isBoardEdge(cell));

const medianNumber = (values: readonly number[]): number => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const medianLat = (unit: Unit, board: IBoard): number => medianNumber(board.laterals(unit));

const lateralDistance = (left: readonly number[], right: readonly number[]): number => {
    let best = Infinity;
    for (const a of left) {
        for (const b of right) best = Math.min(best, Math.abs(a - b));
    }
    return best;
};

const bodyRank = (unit: Unit, board: IBoard): number => {
    const cells = board.footprint(unit);
    return cells.length ? Math.max(...cells.map((cell) => board.geom.frontness(cell))) : 0;
};

const dominantRank = (units: readonly Unit[], board: IBoard): number => {
    const counts = new Map<number, number>();
    for (const unit of units) {
        const rank = bodyRank(unit, board);
        counts.set(rank, (counts.get(rank) ?? 0) + 1);
    }
    let best = 0;
    let bestCount = -1;
    for (const [rank, count] of counts) {
        if (count > bestCount || (count === bestCount && rank > best)) {
            best = rank;
            bestCount = count;
        }
    }
    return best;
};

const takenCells = (board: IBoard, ignore: ReadonlySet<string>): Set<number> => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    return taken;
};

const occupiedLateralsOf = (board: IBoard): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const commitAssignments = (board: IBoard, assignments: ReadonlyMap<string, XY>, preserveFiles: boolean): boolean => {
    if (!assignments.size) return false;
    const movers = new Set(assignments.keys());
    const occupied = takenCells(board, movers);
    const nextLaterals = new Set<number>();
    for (const unit of board.units) {
        if (movers.has(unit.getId())) continue;
        for (const lat of board.laterals(unit)) nextLaterals.add(lat);
    }
    for (const [id, anchor] of assignments) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const previous = board.cells.get(id);
        if (!unit) return false;
        const staying = !!previous && sameCell(previous, anchor);
        const span = spanAt(unit, anchor, board.geom);
        if (!span) return false;
        if (!staying && !spanIsLegal(span, board.geom, occupied)) return false;
        if (staying) {
            for (const cell of span.cells) {
                if (occupied.has(keyOf(cell))) return false;
                occupied.add(keyOf(cell));
            }
        } else {
            for (const cell of span.cells) occupied.add(keyOf(cell));
        }
        for (const lat of span.laterals) nextLaterals.add(lat);
    }
    if (preserveFiles) {
        for (const lat of occupiedLateralsOf(board)) {
            if (!nextLaterals.has(lat)) return false;
        }
    }
    for (const [id, anchor] of assignments) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const cornerBowIds = (board: IBoard): Set<string> =>
    new Set(lockedBows(placedRange(board.units, board), board).map((unit) => unit.getId()));

const sitsOnEdgeRay = (unit: Unit, board: IBoard, bows: ReadonlySet<string>): boolean => {
    const mine = board.footprint(unit);
    for (const bow of board.units) {
        if (!bows.has(bow.getId())) continue;
        const bowCells = board.footprint(bow);
        if (!bowCells.length || !mine.length) continue;
        const bowLaterals = new Set(bowCells.map((cell) => board.geom.lateral(cell)));
        const bowFront = Math.max(...bowCells.map((cell) => board.geom.frontness(cell)));
        if (mine.some((cell) => bowLaterals.has(board.geom.lateral(cell)) && board.geom.frontness(cell) > bowFront)) {
            return true;
        }
    }
    return false;
};

/** Range stacks, a protector's current ward, an edge-ray screen, and a body already off a breath file. */
const placementLocks = (board: IBoard, threats: IPublicPlacementThreats): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (unit.getAttackType() === RANGE && board.footprint(unit).length) locked.add(unit.getId());
    }
    for (const unit of board.units) {
        if (!PROTECTORS.has(unit.getName())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        const wards = board.units.filter((other) => {
            if (other.getId() === unit.getId()) return false;
            const otherFootprint = board.footprint(other);
            return otherFootprint.length > 0 && minChebyshev(footprint, otherFootprint) <= 1;
        });
        if (!wards.length) continue;
        locked.add(unit.getId());
        for (const ward of wards) locked.add(ward.getId());
    }
    const bows = cornerBowIds(board);
    const bowLaterals = new Set<number>();
    for (const bow of board.units) {
        if (bow.getAttackType() !== RANGE) continue;
        for (const lat of board.laterals(bow)) bowLaterals.add(lat);
    }
    for (const unit of board.units) {
        if (locked.has(unit.getId()) || unit.canFly() || !board.footprint(unit).length) continue;
        if (unit.getAttackType() === RANGE) continue;
        if (sitsOnEdgeRay(unit, board, bows)) locked.add(unit.getId());
        else if (
            threats.fireBreath &&
            bowLaterals.size > 0 &&
            !board.laterals(unit).some((lat) => bowLaterals.has(lat))
        ) {
            locked.add(unit.getId());
        }
    }
    return locked;
};

const findWindow = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    lo: number,
    hi: number,
    accept: (span: ISpan) => boolean,
    avoid: ReadonlySet<number>,
): XY | undefined => {
    let best: XY | undefined;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || span.minLat !== lo || span.maxLat !== hi) continue;
        if (span.laterals.some((lat) => avoid.has(lat))) continue;
        if (!spanIsLegal(span, board.geom, taken) || !accept(span)) continue;
        if (!best || anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)) best = anchor;
    }
    return best;
};

const slideTowardLow = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    locked: ReadonlySet<string>,
    sideOriented: boolean,
): void => {
    const sliding = board.units.filter(
        (unit) =>
            !locked.has(unit.getId()) &&
            unit.getAttackType() !== RANGE &&
            !isSpellbookUnit(unit) &&
            board.footprint(unit).length > 0,
    );
    if (!sliding.length) return;
    const limits = zoneLimits(board.geom);
    const single = threats.lineAttack ? dominantRank(sliding, board) : undefined;
    const original = occupiedLateralsOf(board);
    const ignore = new Set(sliding.map((unit) => unit.getId()));
    const taken = takenCells(board, ignore);
    const assignments = new Map<string, XY>();
    let deepId: string | undefined;
    if (threats.flyers > 0) {
        const deep = sliding.filter((unit) => !unit.canFly()).sort(bySlowest)[0];
        if (deep) {
            const others = board.occupiedLaterals(deep);
            const spanCount = lateralSpanCount(deep, sideOriented);
            for (let lo = limits.minLat; lo + spanCount - 1 <= limits.maxLat; lo += 1) {
                const hi = lo + spanCount - 1;
                let known = false;
                for (let lat = lo; lat <= hi; lat += 1) if (others.has(lat)) known = true;
                if (!known) continue;
                const anchor = findWindow(
                    deep,
                    board,
                    taken,
                    lo,
                    hi,
                    (span) => span.minFront === board.geom.backFront,
                    new Set(),
                );
                if (!anchor) continue;
                assignments.set(deep.getId(), anchor);
                for (const cell of footprintCellsForAnchor(deep, anchor)) taken.add(keyOf(cell));
                deepId = deep.getId();
                break;
            }
        }
    }
    const rest = sliding
        .filter((unit) => unit.getId() !== deepId)
        .sort((a, b) => Math.min(...board.laterals(a)) - Math.min(...board.laterals(b)) || byId(a, b));
    for (const unit of rest) {
        const rank = single ?? bodyRank(unit, board);
        const spanCount = lateralSpanCount(unit, sideOriented);
        let chosen: XY | undefined;
        for (let lo = limits.minLat; lo + spanCount - 1 <= limits.maxLat; lo += 1) {
            const hi = lo + spanCount - 1;
            if (threats.flyers > 0) {
                let known = true;
                for (let lat = lo; lat <= hi; lat += 1) if (!original.has(lat)) known = false;
                if (!known) continue;
            }
            const anchor = findWindow(unit, board, taken, lo, hi, (span) => span.maxFront === rank, new Set());
            if (!anchor) continue;
            chosen = anchor;
            break;
        }
        const current = board.cells.get(unit.getId());
        const spot = chosen ?? current;
        if (!spot) continue;
        assignments.set(unit.getId(), spot);
        for (const cell of footprintCellsForAnchor(unit, spot)) taken.add(keyOf(cell));
    }
    commitAssignments(board, assignments, threats.rapidCharge);
};

const directlyBehind = (span: ISpan, board: IBoard, selfId: string): boolean => {
    for (const cell of span.cells) {
        for (const other of board.units) {
            if (other.getId() === selfId) continue;
            for (const occupied of board.footprint(other)) {
                if (
                    board.geom.lateral(occupied) === board.geom.lateral(cell) &&
                    board.geom.frontness(occupied) === board.geom.frontness(cell) + 1
                ) {
                    return true;
                }
            }
        }
    }
    return false;
};

const gapFromSlowerAllies = (unit: Unit, span: ISpan, board: IBoard): boolean => {
    let nearest = Infinity;
    let found = false;
    for (const other of board.units) {
        if (other.getId() === unit.getId() || !isSlowerThan(other, unit) || !board.footprint(other).length) continue;
        nearest = Math.min(nearest, lateralDistance(span.laterals, board.laterals(other)));
        found = true;
    }
    return !found || nearest >= 2;
};

const fileClearOfOthers = (span: ISpan, board: IBoard, selfId: string): boolean => {
    const occupied = new Set<number>();
    for (const other of board.units) {
        if (other.getId() === selfId) continue;
        for (const lat of board.laterals(other)) occupied.add(lat);
    }
    return span.laterals.every((lat) => !occupied.has(lat));
};

const extremeFrontAnchor = (
    unit: Unit,
    extreme: number,
    board: IBoard,
    limits: IZoneLimits,
    requireClear: boolean,
    requireGap: boolean,
    forbidBehind: boolean,
): XY | undefined => {
    let best: XY | undefined;
    let bestExtra = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, takenCells(board, new Set([unit.getId()])))) continue;
        if (span.maxFront !== limits.maxFront) continue;
        if (
            !span.cells.some(
                (cell) => board.geom.lateral(cell) === extreme && board.geom.frontness(cell) === limits.maxFront,
            )
        ) {
            continue;
        }
        if (requireClear && !fileClearOfOthers(span, board, unit.getId())) continue;
        if (requireGap && !gapFromSlowerAllies(unit, span, board)) continue;
        if (forbidBehind && directlyBehind(span, board, unit.getId())) continue;
        const extra = span.maxLat - span.minLat;
        if (
            !best ||
            extra < bestExtra ||
            (extra === bestExtra && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestExtra = extra;
        }
    }
    return best;
};

const seatChargersOnExtremes = (
    board: IBoard,
    locked: ReadonlySet<string>,
    threats: IPublicPlacementThreats,
    reserved: Set<number>,
    requireGap: boolean,
    forbidBehind: boolean,
): void => {
    const limits = zoneLimits(board.geom);
    const chargers = board.units
        .filter((unit) => isCharger(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    if (!chargers.length) return;
    const claimed = new Set<number>();
    const plan: { unit: Unit; extreme: number }[] = [];
    if (chargers.length === 1) {
        const lat = medianLat(chargers[0], board);
        const extreme = Math.abs(lat - limits.minLat) <= Math.abs(lat - limits.maxLat) ? limits.minLat : limits.maxLat;
        plan.push({ unit: chargers[0], extreme });
    } else {
        plan.push({ unit: chargers[0], extreme: limits.minLat });
        plan.push({ unit: chargers[chargers.length - 1], extreme: limits.maxLat });
    }
    for (const item of plan) {
        const extremes = [item.extreme, item.extreme === limits.minLat ? limits.maxLat : limits.minLat];
        let placed = false;
        for (const extreme of extremes) {
            if (claimed.has(extreme)) continue;
            const spot = extremeFrontAnchor(item.unit, extreme, board, limits, requireGap, requireGap, forbidBehind);
            if (!spot) continue;
            if (!commitAssignments(board, new Map([[item.unit.getId(), spot]]), threats.rapidCharge)) continue;
            const span = spanAt(item.unit, spot, board.geom);
            if (span) {
                for (const lat of span.laterals) reserved.add(lat);
                if (requireGap) {
                    if (span.maxLat < board.geom.centreLat) reserved.add(span.maxLat + 1);
                    else if (span.minLat > board.geom.centreLat) reserved.add(span.minLat - 1);
                }
            }
            claimed.add(extreme);
            placed = true;
            break;
        }
        if (!placed) continue;
    }
};

const seatOneChargerLow = (
    board: IBoard,
    locked: Set<string>,
    threats: IPublicPlacementThreats,
    reserved: Set<number>,
): void => {
    if (threats.rapidCharge) return;
    const charger = board.units
        .filter((unit) => isCharger(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((a, b) => b.getSteps() - a.getSteps() || a.getArmor() - b.getArmor() || byId(a, b))[0];
    if (!charger) return;
    const limits = zoneLimits(board.geom);
    const spot = extremeFrontAnchor(charger, limits.minLat, board, limits, true, false, false);
    if (!spot) return;
    const span = spanAt(charger, spot, board.geom);
    if (!span) return;
    const neighborLat = span.maxLat + 1;
    const neighbor = board.units.find(
        (unit) =>
            unit.getId() !== charger.getId() &&
            !unit.canFly() &&
            unit.getAttackType() !== RANGE &&
            board.laterals(unit).includes(neighborLat),
    );
    if (!neighbor) return;
    if (!commitAssignments(board, new Map([[charger.getId(), spot]]), false)) return;
    locked.add(neighbor.getId());
    for (const lat of span.laterals) reserved.add(lat);
};

type PairDepth = "front" | "deep" | "back";

const pairDepthAccept =
    (mode: PairDepth, limits: IZoneLimits, backFront: number): ((span: ISpan) => boolean) =>
    (span) => {
        if (mode === "front") return span.maxFront === limits.maxFront;
        if (mode === "deep") return span.minFront === backFront;
        return span.maxFront === limits.maxFront - 1;
    };

const reseatPairs = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    locked: ReadonlySet<string>,
    reserved: ReadonlySet<number>,
    sideOriented: boolean,
): boolean => {
    const bodies = board.units
        .filter(
            (unit) =>
                !locked.has(unit.getId()) &&
                !unit.canFly() &&
                !isCharger(unit) &&
                unit.getAttackType() !== RANGE &&
                board.footprint(unit).length > 0,
        )
        .sort(bySlowest);
    const pairs: [Unit, Unit][] = [];
    for (let index = 0; index + 1 < bodies.length; index += 2) pairs.push([bodies[index], bodies[index + 1]]);
    if (!pairs.length) return false;
    const shooter = threats.rangeCreatures > 0;
    const flyer = threats.flyers > 0;
    const modes: PairDepth[] = pairs.map((_, index) => {
        if (shooter && index === 1) return "back";
        if (!shooter && flyer && index === 0) return "deep";
        return "front";
    });
    const limits = zoneLimits(board.geom);
    const widths = pairs.map(
        ([left, right]) => lateralSpanCount(left, sideOriented) + lateralSpanCount(right, sideOriented),
    );
    const block = widths.reduce((sum, width) => sum + width, 0) + 2 * (pairs.length - 1);
    const ideal = threats.rapidCharge ? limits.minLat : Math.round(board.geom.centreLat - (block - 1) / 2);
    const starts: number[] = [];
    for (let delta = 0; delta <= limits.maxLat - limits.minLat; delta += 1) {
        for (const sign of delta === 0 ? [0] : [-1, 1]) {
            const start = ideal + sign * delta;
            if (start >= limits.minLat && start + block - 1 <= limits.maxLat) starts.push(start);
        }
    }
    const ignore = new Set(pairs.flat().map((unit) => unit.getId()));
    for (const start of starts) {
        const taken = takenCells(board, ignore);
        const assignments = new Map<string, XY>();
        let cursor = start;
        let fitted = true;
        for (let index = 0; index < pairs.length; index += 1) {
            const [left, right] = pairs[index];
            const leftSpan = lateralSpanCount(left, sideOriented);
            const rightSpan = lateralSpanCount(right, sideOriented);
            const accept = pairDepthAccept(modes[index], limits, board.geom.backFront);
            const leftAnchor = findWindow(left, board, taken, cursor, cursor + leftSpan - 1, accept, reserved);
            if (!leftAnchor) {
                fitted = false;
                break;
            }
            for (const cell of footprintCellsForAnchor(left, leftAnchor)) taken.add(keyOf(cell));
            cursor += leftSpan;
            const rightAnchor = findWindow(right, board, taken, cursor, cursor + rightSpan - 1, accept, reserved);
            if (!rightAnchor) {
                fitted = false;
                break;
            }
            for (const cell of footprintCellsForAnchor(right, rightAnchor)) taken.add(keyOf(cell));
            cursor += rightSpan + 2;
            assignments.set(left.getId(), leftAnchor);
            assignments.set(right.getId(), rightAnchor);
        }
        if (!fitted) continue;
        if (shooter && pairs.length > 1) {
            const frontLaterals = new Set<number>();
            const largeFront: XY[] = [];
            for (let index = 0; index < pairs.length; index += 1) {
                if (modes[index] === "back") continue;
                for (const unit of pairs[index]) {
                    const anchor = assignments.get(unit.getId());
                    const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
                    if (!span) continue;
                    for (const lat of span.laterals) frontLaterals.add(lat);
                    if (!unit.isSmallSize()) largeFront.push(...span.cells);
                }
            }
            let pierced = false;
            for (let index = 0; index < pairs.length; index += 1) {
                if (modes[index] !== "back") continue;
                for (const unit of pairs[index]) {
                    const anchor = assignments.get(unit.getId());
                    const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
                    if (!span) continue;
                    if (span.laterals.some((lat) => frontLaterals.has(lat))) pierced = true;
                    if (
                        span.cells.some((cell) =>
                            largeFront.some(
                                (front) =>
                                    board.geom.lateral(front) === board.geom.lateral(cell) &&
                                    board.geom.frontness(front) === board.geom.frontness(cell) + 1,
                            ),
                        )
                    ) {
                        pierced = true;
                    }
                }
            }
            if (pierced) continue;
        }
        if (commitAssignments(board, assignments, threats.rapidCharge)) return true;
    }
    return false;
};

const frontLaterals = (board: IBoard, ignore: ReadonlySet<string>, limits: IZoneLimits): number[] => {
    const laterals: number[] = [];
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        const cells = board.footprint(unit).filter((cell) => board.geom.frontness(cell) === limits.maxFront);
        for (const cell of cells) laterals.push(board.geom.lateral(cell));
    }
    return laterals;
};

const plugSlowGround = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    locked: ReadonlySet<string>,
    reserved: ReadonlySet<number>,
    sideOriented: boolean,
): void => {
    if (threats.rapidCharge && threats.lineAttack) return;
    if (threats.rangeCreatures > 0 && threats.flyers === 0) return;
    const slow = board.units
        .filter(
            (unit) =>
                !locked.has(unit.getId()) &&
                !unit.canFly() &&
                !isCharger(unit) &&
                unit.getAttackType() !== RANGE &&
                board.footprint(unit).length > 0,
        )
        .sort(bySlowest);
    if (!slow.length) return;
    const limits = zoneLimits(board.geom);
    const avoid = reserved;
    if (threats.lineAttack && threats.flyers > 0) {
        const ignore = new Set(slow.map((unit) => unit.getId()));
        const blocked = new Set(frontLaterals(board, ignore, limits));
        const corners = [limits.minLat, limits.maxLat];
        for (const unit of slow) {
            const spanCount = lateralSpanCount(unit, sideOriented);
            let spot: XY | undefined;
            for (const extreme of corners) {
                const lo = extreme === limits.minLat ? extreme : extreme - spanCount + 1;
                const hi = lo + spanCount - 1;
                if (lo < limits.minLat || hi > limits.maxLat) continue;
                let shares = false;
                for (let lat = lo; lat <= hi; lat += 1) if (blocked.has(lat)) shares = true;
                if (shares) continue;
                const anchor = findWindow(
                    unit,
                    board,
                    takenCells(board, new Set([unit.getId()])),
                    lo,
                    hi,
                    (span) => span.minFront === board.geom.backFront,
                    avoid,
                );
                if (!anchor) continue;
                spot = anchor;
                break;
            }
            if (!spot) continue;
            if (!commitAssignments(board, new Map([[unit.getId(), spot]]), threats.rapidCharge)) continue;
            const span = spanAt(unit, spot, board.geom);
            if (span) for (const lat of span.laterals) blocked.add(lat);
        }
        return;
    }
    if (threats.rapidCharge) {
        const blocks = board.units.filter((unit) => !slow.some((body) => body.getId() === unit.getId()));
        for (const unit of slow) {
            const spanCount = lateralSpanCount(unit, sideOriented);
            let spot: XY | undefined;
            for (let lo = limits.minLat; lo + spanCount - 1 <= limits.maxLat; lo += 1) {
                const hi = lo + spanCount - 1;
                let behind = false;
                for (const block of blocks) {
                    const blockLats = board.laterals(block);
                    if (!blockLats.some((lat) => lat >= lo && lat <= hi)) continue;
                    const blockFront = bodyRank(block, board);
                    if (blockFront > board.geom.backFront) behind = true;
                }
                if (!behind) continue;
                const anchor = findWindow(
                    unit,
                    board,
                    takenCells(board, new Set([unit.getId()])),
                    lo,
                    hi,
                    (span) =>
                        span.minFront === board.geom.backFront &&
                        span.maxFront < bodyRankOfBlock(blocks, lo, hi, board),
                    avoid,
                );
                if (!anchor) continue;
                spot = anchor;
                break;
            }
            if (spot) commitAssignments(board, new Map([[unit.getId(), spot]]), true);
        }
        return;
    }
    const wall = frontLaterals(board, new Set(slow.map((unit) => unit.getId())), limits);
    const median = medianNumber(wall.length ? wall : [board.geom.centreLat]);
    const first = slow[0];
    const firstSpan = lateralSpanCount(first, sideOriented);
    let firstSpot: XY | undefined;
    let firstDistance = Infinity;
    for (let lo = limits.minLat; lo + firstSpan - 1 <= limits.maxLat; lo += 1) {
        const anchor = findWindow(
            first,
            board,
            takenCells(board, new Set([first.getId()])),
            lo,
            lo + firstSpan - 1,
            (span) => span.minFront === board.geom.backFront,
            avoid,
        );
        if (!anchor) continue;
        const span = spanAt(first, anchor, board.geom);
        if (!span) continue;
        const distance = Math.abs(medianNumber(span.laterals) - median);
        if (distance < firstDistance || (distance === firstDistance && lo < (firstSpot?.y ?? Infinity))) {
            firstDistance = distance;
            firstSpot = anchor;
        }
    }
    if (firstSpot) commitAssignments(board, new Map([[first.getId(), firstSpot]]), false);
    if (threats.flyers < 2 || !slow[1]) return;
    const second = slow[1];
    const placedFirst = firstSpot
        ? spanAt(first, firstSpot, board.geom)
        : spanAt(first, board.cells.get(first.getId()) ?? { x: 0, y: 0 }, board.geom);
    const firstLat = placedFirst ? medianNumber(placedFirst.laterals) : median;
    const secondSpan = lateralSpanCount(second, sideOriented);
    const extremes = [limits.minLat, limits.maxLat].sort((a, b) => Math.abs(b - firstLat) - Math.abs(a - firstLat));
    for (const extreme of extremes) {
        const lo = extreme === limits.maxLat ? extreme - secondSpan + 1 : extreme;
        const hi = lo + secondSpan - 1;
        if (lo < limits.minLat || hi > limits.maxLat) continue;
        if (placedFirst && placedFirst.laterals.some((lat) => lat >= lo && lat <= hi)) continue;
        const anchor = findWindow(
            second,
            board,
            takenCells(board, new Set([second.getId()])),
            lo,
            hi,
            (span) => span.minFront === board.geom.backFront,
            avoid,
        );
        if (!anchor) continue;
        if (commitAssignments(board, new Map([[second.getId(), anchor]]), false)) break;
    }
};

const bodyRankOfBlock = (blocks: readonly Unit[], lo: number, hi: number, board: IBoard): number => {
    let front = board.geom.backFront;
    for (const block of blocks) {
        const cells = board.footprint(block).filter((cell) => {
            const lat = board.geom.lateral(cell);
            return lat >= lo && lat <= hi;
        });
        if (cells.length) front = Math.max(front, ...cells.map((cell) => board.geom.frontness(cell)));
    }
    return front;
};

const fileKeptForCharge = (span: ISpan, board: IBoard, unit: Unit, rapidCharge: boolean): boolean => {
    if (!rapidCharge) return true;
    const others = board.occupiedLaterals(unit);
    const mine = new Set(board.laterals(unit));
    return span.laterals.every((lat) => others.has(lat) || mine.has(lat));
};

const deepSplitFlyers = (
    flyers: readonly Unit[],
    board: IBoard,
    threats: IPublicPlacementThreats,
    reserved: ReadonlySet<number>,
    sideOriented: boolean,
): void => {
    const limits = zoneLimits(board.geom);
    const ordered = [...flyers].sort(
        (a, b) => Math.max(...board.laterals(b)) - Math.max(...board.laterals(a)) || byId(a, b),
    );
    const sequence: number[] = [];
    for (let step = 0; sequence.length < limits.maxLat - limits.minLat + 1; step += 1) {
        const high = limits.maxLat - step;
        const low = limits.minLat + step;
        if (high >= limits.minLat && !sequence.includes(high)) sequence.push(high);
        if (low <= limits.maxLat && low !== high && !sequence.includes(low)) sequence.push(low);
        if (low >= high) break;
    }
    const pierce = new Set<number>();
    if (threats.lineAttack) {
        for (const unit of board.units) {
            if (flyers.some((flyer) => flyer.getId() === unit.getId())) continue;
            const cells = board.footprint(unit);
            if (!cells.some((cell) => board.geom.frontness(cell) === limits.maxFront)) continue;
            for (const lat of board.laterals(unit)) pierce.add(lat);
        }
    }
    const used = new Set<number>();
    for (const flyer of ordered) {
        const spanCount = lateralSpanCount(flyer, sideOriented);
        let spot: XY | undefined;
        for (const target of sequence) {
            for (let lo = limits.minLat; lo + spanCount - 1 <= limits.maxLat; lo += 1) {
                const hi = lo + spanCount - 1;
                if (target < lo || target > hi) continue;
                if ([...Array(spanCount).keys()].some((offset) => used.has(lo + offset) || pierce.has(lo + offset))) {
                    continue;
                }
                const anchor = findWindow(
                    flyer,
                    board,
                    takenCells(board, new Set([flyer.getId()])),
                    lo,
                    hi,
                    (span) => span.minFront === board.geom.backFront && span.maxFront < limits.maxFront,
                    reserved,
                );
                if (!anchor) continue;
                const span = spanAt(flyer, anchor, board.geom);
                if (!span || !fileKeptForCharge(span, board, flyer, threats.rapidCharge)) continue;
                spot = anchor;
                break;
            }
            if (spot) break;
        }
        if (!spot) continue;
        if (!commitAssignments(board, new Map([[flyer.getId(), spot]]), threats.rapidCharge)) continue;
        const span = spanAt(flyer, spot, board.geom);
        if (span) for (const lat of span.laterals) used.add(lat);
    }
};

const halvesFor = (flyers: readonly Unit[], board: IBoard): { low: Unit[]; high: Unit[] } => {
    const ordered = [...flyers].sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const low: Unit[] = [];
    const high: Unit[] = [];
    for (const flyer of ordered) {
        if (medianLat(flyer, board) <= board.geom.centreLat) low.push(flyer);
        else high.push(flyer);
    }
    while (low.length > high.length + 1) {
        const moved = low.pop();
        if (moved) high.unshift(moved);
    }
    while (high.length > low.length + 1) {
        const moved = high.shift();
        if (moved) low.push(moved);
    }
    return { low, high };
};

const adjacentToGround = (span: ISpan, grounds: readonly Unit[], board: IBoard, ignore: ReadonlySet<string>): boolean =>
    grounds.some((ground) => {
        if (ignore.has(ground.getId())) return false;
        const footprint = board.footprint(ground);
        return footprint.length > 0 && minChebyshev(span.cells, footprint) <= 1;
    });

const finishFlyerContact = (
    flyers: readonly Unit[],
    board: IBoard,
    locked: ReadonlySet<string>,
    rapidCharge: boolean,
    reserved: ReadonlySet<number>,
): void => {
    const limits = zoneLimits(board.geom);
    const contacts = board.units.filter(
        (unit) => !unit.canFly() && unit.getAttackType() !== RANGE && board.footprint(unit).length > 0,
    );
    const movable = contacts.filter((unit) => !locked.has(unit.getId()) && !isCharger(unit));
    if (!flyers.length || !movable.length) return;
    const gapLaterals = (): Set<number> => {
        const laterals = flyers.flatMap((flyer) => board.laterals(flyer));
        if (laterals.length < 2) return new Set();
        const gaps = new Set<number>();
        const low = Math.min(...laterals);
        const high = Math.max(...laterals);
        for (let lat = low + 1; lat < high; lat += 1) gaps.add(lat);
        return gaps;
    };
    const fillsGap = (span: ISpan, gaps: ReadonlySet<number>): number =>
        span.cells.filter(
            (cell) => board.geom.frontness(cell) === limits.maxFront && gaps.has(board.geom.lateral(cell)),
        ).length;
    const currentlyTouched = flyers.filter((flyer) =>
        contacts.some((ground) => minChebyshev(board.footprint(flyer), board.footprint(ground)) <= 1),
    ).length;
    if (currentlyTouched === flyers.length) return;
    let bestUnit: Unit | undefined;
    let bestAnchor: XY | undefined;
    let bestTouched = currentlyTouched;
    let bestGap = Infinity;
    for (const ground of movable) {
        const gaps = gapLaterals();
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(ground, anchor, board.geom);
            if (!span) continue;
            const staying = sameCell(anchor, board.cells.get(ground.getId()) ?? anchor);
            if (!staying && !spanIsLegal(span, board.geom, takenCells(board, new Set([ground.getId()])))) continue;
            if (span.laterals.some((lat) => reserved.has(lat))) continue;
            if (!fileKeptForCharge(span, board, ground, rapidCharge)) continue;
            const touched = flyers.filter((flyer) => minChebyshev(span.cells, board.footprint(flyer)) <= 1).length;
            const gap = fillsGap(span, gaps);
            if (touched > bestTouched || (touched === bestTouched && touched > currentlyTouched && gap < bestGap)) {
                bestTouched = touched;
                bestGap = gap;
                bestUnit = ground;
                bestAnchor = anchor;
            }
        }
    }
    if (!bestUnit || !bestAnchor || bestTouched <= currentlyTouched) return;
    commitAssignments(board, new Map([[bestUnit.getId(), bestAnchor]]), rapidCharge);
};

const seatFlyersOnFront = (
    flyers: readonly Unit[],
    board: IBoard,
    threats: IPublicPlacementThreats,
    reserved: ReadonlySet<number>,
    sideOriented: boolean,
    separateOnly: boolean,
    locked: ReadonlySet<string>,
): void => {
    const limits = zoneLimits(board.geom);
    const grounds = board.units.filter((unit) => !unit.canFly() && board.footprint(unit).length > 0);
    const { low, high } = halvesFor(flyers, board);
    const groups: { units: Unit[]; lowHalf: boolean }[] = separateOnly
        ? [{ units: [...flyers], lowHalf: false }]
        : [
              { units: low, lowHalf: true },
              { units: high, lowHalf: false },
          ];
    const placed: Unit[] = [];
    for (const group of groups) {
        for (const flyer of separateOnly
            ? group.units.filter(
                  (unit) =>
                      flyers.some(
                          (other) =>
                              other.getId() !== unit.getId() &&
                              minChebyshev(board.footprint(unit), board.footprint(other)) <= 1,
                      ) && !bridgesGround(unit, board),
              )
            : group.units) {
            const spanCount = lateralSpanCount(flyer, sideOriented);
            let spot: XY | undefined;
            let spotDistance = Infinity;
            for (let lo = limits.minLat; lo + spanCount - 1 <= limits.maxLat; lo += 1) {
                const hi = lo + spanCount - 1;
                const median = (lo + hi) / 2;
                if (!separateOnly && group.lowHalf && median > board.geom.centreLat) continue;
                if (!separateOnly && !group.lowHalf && median < board.geom.centreLat) continue;
                const anchor = findWindow(
                    flyer,
                    board,
                    takenCells(board, new Set([flyer.getId()])),
                    lo,
                    hi,
                    (span) => span.maxFront === limits.maxFront,
                    reserved,
                );
                if (!anchor) continue;
                const span = spanAt(flyer, anchor, board.geom);
                if (!span || !fileKeptForCharge(span, board, flyer, threats.rapidCharge)) continue;
                const crowded = placed.some((other) => minChebyshev(span.cells, board.footprint(other)) <= 1);
                const crowdedIncumbent = flyers.some(
                    (other) =>
                        other.getId() !== flyer.getId() &&
                        !placed.some((done) => done.getId() === other.getId()) &&
                        minChebyshev(span.cells, board.footprint(other)) <= 1,
                );
                if (crowded || crowdedIncumbent) continue;
                if (
                    separateOnly &&
                    grounds.length &&
                    !adjacentToGround(span, grounds, board, new Set([flyer.getId()]))
                ) {
                    continue;
                }
                const distance = separateOnly ? 0 : group.lowHalf ? -median : median;
                if (!spot || distance < spotDistance) {
                    spot = anchor;
                    spotDistance = distance;
                }
            }
            if (!spot && grounds.length && !separateOnly) {
                if (swapFlyerWithGround(flyer, group.lowHalf, board, limits, reserved, threats.rapidCharge, placed)) {
                    placed.push(flyer);
                }
                continue;
            }
            if (!spot) continue;
            if (!commitAssignments(board, new Map([[flyer.getId(), spot]]), threats.rapidCharge)) continue;
            placed.push(flyer);
        }
    }
    if (!separateOnly) finishFlyerContact(flyers, board, locked, threats.rapidCharge, reserved);
};

const bridgesGround = (unit: Unit, board: IBoard): boolean => {
    const footprint = board.footprint(unit);
    const grounds = board.units.filter((other) => other.getId() !== unit.getId() && !other.canFly());
    for (let left = 0; left < grounds.length; left += 1) {
        for (let right = left + 1; right < grounds.length; right += 1) {
            const a = board.footprint(grounds[left]);
            const b = board.footprint(grounds[right]);
            if (!a.length || !b.length || minChebyshev(a, b) <= 1) continue;
            if (minChebyshev(a, footprint) <= 1 && minChebyshev(b, footprint) <= 1) return true;
        }
    }
    return false;
};

const swapFlyerWithGround = (
    flyer: Unit,
    lowHalf: boolean,
    board: IBoard,
    limits: IZoneLimits,
    reserved: ReadonlySet<number>,
    rapidCharge: boolean,
    placed: readonly Unit[],
): XY | undefined => {
    const centre = board.geom.centreLat;
    for (const ground of board.units) {
        if (ground.canFly() || ground.getAttackType() === RANGE) continue;
        const groundAnchor = board.cells.get(ground.getId());
        if (!groundAnchor) continue;
        const median = medianLat(ground, board);
        if (lowHalf && median > centre) continue;
        if (!lowHalf && median < centre) continue;
        const span = spanAt(flyer, groundAnchor, board.geom);
        if (!span || span.maxFront !== limits.maxFront) continue;
        if (span.laterals.some((lat) => reserved.has(lat))) continue;
        if (!fileKeptForCharge(span, board, flyer, rapidCharge)) continue;
        const flyerAnchor = board.cells.get(flyer.getId());
        if (!flyerAnchor) continue;
        const swapped = spanAt(ground, flyerAnchor, board.geom);
        if (!swapped) continue;
        const ignore = new Set([flyer.getId(), ground.getId()]);
        if (!spanIsLegal(span, board.geom, takenCells(board, ignore))) continue;
        if (!spanIsLegal(swapped, board.geom, takenCells(board, ignore))) continue;
        if (minChebyshev(span.cells, swapped.cells) > 1) continue;
        if (placed.some((other) => minChebyshev(span.cells, board.footprint(other)) <= 1)) continue;
        const assignments = new Map<string, XY>([
            [flyer.getId(), groundAnchor],
            [ground.getId(), flyerAnchor],
        ]);
        if (commitAssignments(board, assignments, rapidCharge)) return groundAnchor;
    }
    return undefined;
};

const moveFlyers = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    locked: ReadonlySet<string>,
    reserved: ReadonlySet<number>,
    sideOriented: boolean,
): void => {
    const flyers = board.units.filter(
        (unit) =>
            unit.canFly() &&
            unit.getAttackType() !== RANGE &&
            !locked.has(unit.getId()) &&
            board.footprint(unit).length > 0,
    );
    if (!flyers.length) return;
    if (threats.rangeCreatures > 0) {
        deepSplitFlyers(flyers, board, threats, reserved, sideOriented);
        return;
    }
    if (threats.flyers > 0) {
        seatFlyersOnFront(flyers, board, threats, reserved, sideOriented, false, locked);
        return;
    }
    if (threats.lineAttack) seatFlyersOnFront(flyers, board, threats, reserved, sideOriented, true, locked);
};

/**
 * r1c2 post-pass. Today's placeArmy has already run. Chargers move first, then ground pairs or a slow
 * plug, then flyers. Range stacks stay put. Area Throw and Large Caliber leave the map alone.
 */
export function placeArmyR1C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const locked = placementLocks(board, threats);
    const sideOriented = context.sideOrientedPlacement === true;
    const reserved = new Set<number>();
    const ownRange = placedRange(units, board);
    if (ownRange.length >= 2) {
        slideTowardLow(board, threats, locked, sideOriented);
    } else if (threats.rangeCreatures > 0 && !threats.lineAttack && !threats.rapidCharge) {
        seatChargersOnExtremes(board, locked, threats, reserved, true, false);
    } else if (threats.rangeCreatures > 0 && threats.lineAttack) {
        seatChargersOnExtremes(board, locked, threats, reserved, false, true);
    } else if (threats.flyers > 0 && threats.rangeCreatures === 0 && !threats.rapidCharge) {
        seatOneChargerLow(board, locked, threats, reserved);
    }
    const reseated = threats.lineAttack ? reseatPairs(board, threats, locked, reserved, sideOriented) : false;
    if (!reseated && ownRange.length === 0 && threats.flyers > 0) {
        plugSlowGround(board, threats, locked, reserved, sideOriented);
    }
    moveFlyers(board, threats, locked, reserved, sideOriented);
    return board.cells;
}

type LateralHalf = "low" | "high";

interface IProtectorCover {
    readonly cells: readonly XY[];
    readonly range: number;
}

const isCasterUnit = (unit: Unit): boolean =>
    !unit.isSummoned() &&
    unit.getAttackType() !== RANGE &&
    !CASTER_STAYS.has(unit.getName()) &&
    !PROTECTORS.has(unit.getName()) &&
    unit.getCanCastSpells() &&
    unit.getSpells().some((spell) => isSpellUsableByCaster(unit, spell));

const isGenericGuard = (unit: Unit): boolean =>
    unit.getAttackType() === MELEE &&
    !unit.canFly() &&
    !unit.isSummoned() &&
    !isCharger(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    !CASTER_STAYS.has(unit.getName()) &&
    !isCasterUnit(unit);

/** Ground melee that stays packed. Named protectors and casters are not part of that wall. */
const isGroundWall = (unit: Unit): boolean =>
    !unit.canFly() &&
    !isCasterUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    !CASTER_STAYS.has(unit.getName()) &&
    unit.getAttackType() !== RANGE &&
    (unit.getAttackType() === MELEE || unit.getAttackType() === MELEE_MAGIC);

const namedProtectorRange = (unit: Unit): number => {
    if (unit.getName() === "Angel") return 2;
    if (unit.getName() === "Abomination") return unit.getAuraEffect("Flesh Shield")?.getRange() ?? 2;
    if (unit.getName() === "Arachna Queen") return unit.getAuraEffect("Web")?.getRange() ?? 2;
    return 0;
};

const halfOf = (lat: number, centre: number): LateralHalf => (lat <= centre ? "low" : "high");

const otherHalf = (side: LateralHalf): LateralHalf => (side === "low" ? "high" : "low");

const edgeRank = (unit: Unit, board: IBoard): number => Math.abs(medianLat(unit, board) - board.geom.centreLat);

const footprintOnHalf = (laterals: readonly number[], side: LateralHalf, centre: number): boolean =>
    halfOf(medianNumber(laterals), centre) === side;

const separationFrom = (footprint: readonly XY[], others: readonly Unit[], board: IBoard): number => {
    let best = Infinity;
    let found = false;
    for (const other of others) {
        const cells = board.footprint(other);
        if (!cells.length) continue;
        found = true;
        best = Math.min(best, minChebyshev(footprint, cells));
    }
    return found ? best : Infinity;
};

const touchesAny = (footprint: readonly XY[], others: readonly Unit[], board: IBoard): boolean =>
    separationFrom(footprint, others, board) === 1;

const backCornerKeys = (geom: IGeom): Set<number> => {
    const back = geom.baseCells.filter((cell) => geom.frontness(cell) === geom.backFront);
    const keys = new Set<number>();
    if (!back.length) return keys;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const cell of back) {
        const lat = geom.lateral(cell);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }
    for (const cell of back) {
        const lat = geom.lateral(cell);
        if (lat === minLat || lat === maxLat) keys.add(keyOf(cell));
    }
    return keys;
};

const coveringProtectors = (caster: Unit, board: IBoard): IProtectorCover[] => {
    const mine = board.footprint(caster);
    if (!mine.length) return [];
    const covers: IProtectorCover[] = [];
    for (const unit of board.units) {
        if (unit.getId() === caster.getId() || !PROTECTORS.has(unit.getName())) continue;
        const cells = board.footprint(unit);
        const range = namedProtectorRange(unit);
        if (!cells.length || range <= 0 || minChebyshev(mine, cells) > range) continue;
        covers.push({ cells, range });
    }
    return covers;
};

const withinCovers = (footprint: readonly XY[], covers: readonly IProtectorCover[]): boolean =>
    covers.every((cover) => minChebyshev(footprint, cover.cells) <= cover.range);

const kingKeys = (cells: readonly XY[]): number[] => {
    const keys: number[] = [];
    for (const cell of cells) {
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) keys.push(keyOf({ x: cell.x + dx, y: cell.y + dy }));
        }
    }
    return keys;
};

const isStrikeBody = (unit: Unit): boolean => !unit.canFly() && unit.getAttackType() !== RANGE && !isCasterUnit(unit);

const onZoneFront = (unit: Unit, board: IBoard): boolean => {
    const front = zoneLimits(board.geom).maxFront;
    return board.footprint(unit).some((cell) => board.geom.frontness(cell) === front);
};

/**
 * Chain Lightning's first hop is the range-1 aura of the struck body. The second hop is the range-1
 * aura of units standing in that aura. An empty cell does not carry the bolt, so a size-3 back-center
 * cell behind an empty middle file is outside the walk.
 */
const chainReaches = (caster: Unit, board: IBoard): boolean => {
    const front = board.units.filter((unit) => isStrikeBody(unit) && onZoneFront(unit, board));
    const primaries = front.length ? front : board.units.filter((unit) => isStrikeBody(unit));
    if (!primaries.length) return false;
    const hop1 = new Set<number>();
    for (const body of primaries) {
        for (const key of kingKeys(board.footprint(body))) hop1.add(key);
    }
    const casterKeys = board.footprint(caster).map((cell) => keyOf(cell));
    if (casterKeys.some((key) => hop1.has(key))) return true;
    const primaryIds = new Set(primaries.map((unit) => unit.getId()));
    const hop2 = new Set<number>();
    for (const unit of board.units) {
        if (unit.getId() === caster.getId() || primaryIds.has(unit.getId())) continue;
        if (!board.footprint(unit).some((cell) => hop1.has(keyOf(cell)))) continue;
        for (const key of kingKeys(board.footprint(unit))) hop2.add(key);
    }
    return casterKeys.some((key) => hop2.has(key));
};

const fileBlocked = (laterals: readonly number[], board: IBoard, selfId: string): boolean => {
    const mine = new Set(laterals);
    return board.units.some(
        (unit) => unit.getId() !== selfId && !isGenericGuard(unit) && board.laterals(unit).some((lat) => mine.has(lat)),
    );
};

const adjacentToOutsideWall = (
    footprint: readonly XY[],
    laterals: readonly number[],
    board: IBoard,
    selfId: string,
): boolean => {
    const mine = new Set(laterals);
    for (const unit of board.units) {
        if (unit.getId() === selfId || !isGroundWall(unit)) continue;
        if (board.laterals(unit).some((lat) => mine.has(lat))) continue;
        const cells = board.footprint(unit);
        if (cells.length && minChebyshev(footprint, cells) <= 1) return true;
    }
    return false;
};

const sideOrder = (preferred: LateralHalf, used: ReadonlySet<LateralHalf>): LateralHalf[] => {
    const other = otherHalf(preferred);
    return used.has(preferred) && !used.has(other) ? [other, preferred] : [preferred, other];
};

const findSplashSpot = (
    caster: Unit,
    board: IBoard,
    side: LateralHalf,
    strictGap: boolean,
    covers: readonly IProtectorCover[],
): XY | undefined => {
    const others = board.units.filter((unit) => unit.getId() !== caster.getId() && board.footprint(unit).length > 0);
    const otherCasters = others.filter((unit) => isCasterUnit(unit));
    let best: XY | undefined;
    let bestDepth = Infinity;
    let bestEdge = -Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(caster, anchor, board.geom);
        if (!span || !board.free(caster, anchor)) continue;
        if (!footprintOnHalf(span.laterals, side, board.geom.centreLat)) continue;
        if (!withinCovers(span.cells, covers)) continue;
        const gap = strictGap
            ? separationFrom(span.cells, others, board)
            : separationFrom(span.cells, otherCasters, board);
        if (gap < 2) continue;
        const edge = Math.max(...span.laterals.map((lat) => Math.abs(lat - board.geom.centreLat)));
        if (
            !best ||
            span.minFront < bestDepth ||
            (span.minFront === bestDepth && edge > bestEdge) ||
            (span.minFront === bestDepth &&
                edge === bestEdge &&
                (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestDepth = span.minFront;
            bestEdge = edge;
        }
    }
    return best;
};

const frontWallAnchor = (
    guard: Unit,
    board: IBoard,
    avoid: ReadonlySet<number>,
    allowCasterTouch: boolean,
): XY | undefined => {
    const limits = zoneLimits(board.geom);
    const casters = board.units.filter((unit) => isCasterUnit(unit));
    const wall = board.units.filter(
        (unit) =>
            unit.getId() !== guard.getId() && isGroundWall(unit) && !board.laterals(unit).some((lat) => avoid.has(lat)),
    );
    const rank = (requireWallTouch: boolean, forbidCaster: boolean): XY | undefined => {
        let best: XY | undefined;
        let bestEdge = Infinity;
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(guard, anchor, board.geom);
            if (!span || span.maxFront !== limits.maxFront || !board.free(guard, anchor)) continue;
            if (span.laterals.some((lat) => avoid.has(lat))) continue;
            if (
                requireWallTouch &&
                wall.length > 0 &&
                !wall.some((unit) => minChebyshev(span.cells, board.footprint(unit)) === 1)
            ) {
                continue;
            }
            const adjacentCaster = casters.some((caster) => minChebyshev(span.cells, board.footprint(caster)) <= 1);
            if (forbidCaster && adjacentCaster) continue;
            const edge = Math.abs(medianNumber(span.laterals) - board.geom.centreLat);
            if (
                !best ||
                edge < bestEdge ||
                (edge === bestEdge && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
            ) {
                best = anchor;
                bestEdge = edge;
            }
        }
        return best;
    };
    const clear = rank(true, true) ?? rank(false, true);
    if (clear || !allowCasterTouch) return clear;
    return rank(true, false) ?? rank(false, false);
};

const pullGuards = (
    board: IBoard,
    avoid: ReadonlySet<number>,
    only: ReadonlySet<string> | undefined,
    allowCasterTouch: boolean,
): void => {
    const guards = board.units
        .filter((unit) => {
            if (!isGenericGuard(unit) || (only && !only.has(unit.getId()))) return false;
            if (!only && !board.laterals(unit).some((lat) => avoid.has(lat))) return false;
            return true;
        })
        .sort(byId);
    for (const guard of guards) {
        const spot = frontWallAnchor(guard, board, avoid, allowCasterTouch);
        if (spot) board.place(guard, spot);
    }
};

const applySplashCasters = (board: IBoard): void => {
    const casters = board.units
        .filter((unit) => isCasterUnit(unit) && board.footprint(unit).length > 0)
        .sort(
            (a, b) =>
                edgeRank(b, board) - edgeRank(a, board) || medianLat(a, board) - medianLat(b, board) || byId(a, b),
        );
    const attached = new Set<string>();
    const markAttached = (): void => {
        for (const guard of board.units) {
            if (!isGenericGuard(guard)) continue;
            const footprint = board.footprint(guard);
            if (!footprint.length) continue;
            if (
                casters.some((caster) => {
                    const cells = board.footprint(caster);
                    return cells.length > 0 && minChebyshev(footprint, cells) <= 1;
                })
            ) {
                attached.add(guard.getId());
            }
        }
    };
    markAttached();
    const used = new Set<LateralHalf>();
    const seatedStrict = new Set<string>();
    const seat = (strict: boolean): void => {
        for (const caster of casters) {
            if (!strict && seatedStrict.has(caster.getId())) continue;
            const covers = coveringProtectors(caster, board);
            for (const side of sideOrder(halfOf(medianLat(caster, board), board.geom.centreLat), used)) {
                const spot = findSplashSpot(caster, board, side, strict, covers);
                if (!spot) continue;
                board.place(caster, spot);
                used.add(side);
                if (strict) seatedStrict.add(caster.getId());
                break;
            }
        }
    };
    seat(true);
    seat(false);
    markAttached();
    pullGuards(board, new Set(), attached, false);
};

const findLineSpot = (caster: Unit, board: IBoard, side: LateralHalf): XY | undefined => {
    let best: XY | undefined;
    let bestEdge = -Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(caster, anchor, board.geom);
        if (!span || span.minFront !== board.geom.backFront || !board.free(caster, anchor)) continue;
        if (!footprintOnHalf(span.laterals, side, board.geom.centreLat)) continue;
        if (fileBlocked(span.laterals, board, caster.getId())) continue;
        if (adjacentToOutsideWall(span.cells, span.laterals, board, caster.getId())) continue;
        const edge = Math.max(...span.laterals.map((lat) => Math.abs(lat - board.geom.centreLat)));
        if (
            !best ||
            edge > bestEdge ||
            (edge === bestEdge && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestEdge = edge;
        }
    }
    return best;
};

const applyLineCasters = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const pierce = threats.fireBreath || threats.skewerStrike;
    const casters = board.units
        .filter((unit) => isCasterUnit(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const threatened = new Set(casters.filter((caster) => chainReaches(caster, board)).map((caster) => caster.getId()));
    const used = new Set<LateralHalf>();
    const cleared = new Set<number>();
    for (const caster of casters) {
        if (!pierce && !threatened.has(caster.getId())) continue;
        let spot: XY | undefined;
        let side: LateralHalf | undefined;
        for (const candidate of sideOrder(halfOf(medianLat(caster, board), board.geom.centreLat), used)) {
            const found = findLineSpot(caster, board, candidate);
            if (!found) continue;
            spot = found;
            side = candidate;
            break;
        }
        if (!spot || !side) continue;
        const span = spanAt(caster, spot, board.geom);
        const current = board.cells.get(caster.getId());
        const moved = board.place(caster, spot);
        if (!span || (!moved && !(current && sameCell(current, spot)))) continue;
        used.add(side);
        for (const lat of span.laterals) cleared.add(lat);
    }
    pullGuards(board, cleared, undefined, true);
};

const adjacentToRange = (unit: Unit, board: IBoard): boolean => {
    const mine = board.footprint(unit);
    if (!mine.length) return false;
    return board.units.some((other) => {
        if (other.getAttackType() !== RANGE) return false;
        const cells = board.footprint(other);
        return cells.length > 0 && minChebyshev(mine, cells) <= 1;
    });
};

const guardCornerAnchor = (
    guard: Unit,
    open: readonly XY[],
    casterFootprint: readonly XY[],
    board: IBoard,
): XY | undefined => {
    const spots: { anchor: XY; cover: number; exact: number }[] = [];
    for (const anchor of board.geom.baseCells) {
        if (!board.free(guard, anchor)) continue;
        const footprint = footprintCellsForAnchor(guard, anchor);
        const cover = footprint.filter((cell) => open.some((corner) => sameCell(cell, corner))).length;
        if (!cover || minChebyshev(footprint, casterFootprint) > 1) continue;
        spots.push({ anchor, cover, exact: open.some((corner) => sameCell(anchor, corner)) ? 1 : 0 });
    }
    spots.sort((a, b) => b.cover - a.cover || b.exact - a.exact || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
    return spots[0]?.anchor;
};

const applyFlyerCasters = (board: IBoard): void => {
    const corners = backCornerKeys(board.geom);
    const stealable = new Set(
        board.units.filter((unit) => isGenericGuard(unit) && !adjacentToRange(unit, board)).map((unit) => unit.getId()),
    );
    const casters = board.units
        .filter((unit) => isCasterUnit(unit) && board.footprint(unit).some((cell) => corners.has(keyOf(cell))))
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const used = new Set<string>();
    for (const caster of casters) {
        const anchor = board.cells.get(caster.getId());
        if (!anchor) continue;
        const step = board.geom.inwardDelta(anchor);
        if (step === 0) continue;
        const inward = board.geom.shiftLateral(anchor, step);
        if (!board.free(caster, inward)) continue;
        const vacated = board.footprint(caster).filter((cell) => corners.has(keyOf(cell)));
        if (!board.place(caster, inward)) continue;
        const kept = new Set(board.footprint(caster).map((cell) => keyOf(cell)));
        const open = vacated.filter((cell) => !kept.has(keyOf(cell)));
        if (!open.length) continue;
        const guards = board.units
            .filter((unit) => stealable.has(unit.getId()) && !used.has(unit.getId()))
            .sort((a, b) => {
                const aAnchor = board.cells.get(a.getId());
                const bAnchor = board.cells.get(b.getId());
                const distance = (from: XY | undefined): number =>
                    from ? Math.min(...open.map((cell) => chebyshev(from, cell))) : Infinity;
                return distance(aAnchor) - distance(bAnchor) || byId(a, b);
            });
        for (const guard of guards) {
            const spot = guardCornerAnchor(guard, open, board.footprint(caster), board);
            if (!spot || !board.place(guard, spot)) continue;
            used.add(guard.getId());
            break;
        }
    }
};

const findShooterSpot = (
    caster: Unit,
    board: IBoard,
    corners: ReadonlySet<number>,
    homeLat: number,
): XY | undefined => {
    const limits = zoneLimits(board.geom);
    const others = board.units.filter((unit) => unit.getId() !== caster.getId());
    let best: XY | undefined;
    let bestDepth = Infinity;
    let bestBias = Infinity;
    let bestEdge = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(caster, anchor, board.geom);
        if (!span || !board.free(caster, anchor)) continue;
        if (span.cells.some((cell) => corners.has(keyOf(cell)))) continue;
        if (caster.canFly() && span.cells.some((cell) => board.geom.frontness(cell) === limits.maxFront)) continue;
        if (!touchesAny(span.cells, others, board)) continue;
        const bias = Math.abs(medianNumber(span.laterals) - homeLat);
        const edge = Math.abs(medianNumber(span.laterals) - board.geom.centreLat);
        if (
            !best ||
            span.minFront < bestDepth ||
            (span.minFront === bestDepth && bias < bestBias) ||
            (span.minFront === bestDepth && bias === bestBias && edge < bestEdge) ||
            (span.minFront === bestDepth &&
                bias === bestBias &&
                edge === bestEdge &&
                (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestDepth = span.minFront;
            bestBias = bias;
            bestEdge = edge;
        }
    }
    return best;
};

const applyShooterCasters = (board: IBoard): void => {
    const corners = backCornerKeys(board.geom);
    const casters = board.units
        .filter((unit) => isCasterUnit(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    for (const caster of casters) {
        const footprint = board.footprint(caster);
        if (!footprint.length) continue;
        const onCorner = footprint.some((cell) => corners.has(keyOf(cell)));
        const forward =
            caster.canFly() && footprint.some((cell) => board.geom.frontness(cell) === zoneLimits(board.geom).maxFront);
        const others = board.units.filter((unit) => unit.getId() !== caster.getId());
        if (!onCorner && !forward && touchesAny(footprint, others, board)) continue;
        const spot = findShooterSpot(caster, board, corners, medianLat(caster, board));
        if (spot) board.place(caster, spot);
    }
};

/**
 * r1c3 post-pass. Today's placeArmy has already run. Casters leave the cell the public threat can
 * reach. Range stacks, the augment spend, and named protectors stay where they are.
 */
export function placeArmyR1C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (!board.units.some((unit) => isCasterUnit(unit))) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) applySplashCasters(board);
    else if (threats.fireBreath || threats.skewerStrike || threats.chainLightning) applyLineCasters(board, threats);
    else if (threats.flyers >= 2) applyFlyerCasters(board);
    else if (threats.rangeCreatures >= 2 && threats.flyers < 2) applyShooterCasters(board);
    return board.cells;
}

const SNIPER3_DISTANCE_PERCENT = 70;

/** One Sniper-3 application. Matches adjustBaseStats: base + round(base * 70%, 2), then round to 2 decimals. */
const sniper3Distance = (base: number): number =>
    roundUnitStat(base + roundUnitStat((base / 100) * SNIPER3_DISTANCE_PERCENT, 2), 2);

/**
 * floor(base shot distance after exactly one +70% Sniper-3 multiplier).
 * Catalog base wins over the Sniper ability's far-corner overwrite at setPosition.
 * A stored distance that already includes the augment is not multiplied again.
 */
const bowReach = (unit: Unit): number => {
    const creatureId = creatureIdForName(unit.getName());
    const base = creatureId === undefined ? undefined : creatureInfo(creatureId)?.distance;
    if (base === undefined || base <= 0) {
        const stored = unit.getRangeShotDistance();
        if (unit.getBuff("Sniper Augment")) return Math.floor(stored);
        return Math.floor(sniper3Distance(stored));
    }
    const once = sniper3Distance(base);
    const stored = unit.getRangeShotDistance();
    if (Math.abs(stored - once) <= 0.001) return Math.floor(stored);
    return Math.floor(once);
};

const byReachDesc = (a: Unit, b: Unit): number => bowReach(b) - bowReach(a) || byId(a, b);

const byReachAsc = (a: Unit, b: Unit): number => bowReach(a) - bowReach(b) || byId(a, b);

const cellAt = (context: IPlacementContext, front: number, lat: number): XY => {
    const along = context.team === LEFT ? front : GRID_SIZE - 1 - front;
    return context.sideOrientedPlacement === true ? { x: along, y: lat } : { x: lat, y: along };
};

const copyCells = (board: IBoard): Map<string, XY> => {
    const copy = new Map<string, XY>();
    for (const [id, cell] of board.cells) copy.set(id, { x: cell.x, y: cell.y });
    return copy;
};

const restoreCells = (board: IBoard, snapshot: ReadonlyMap<string, XY>): void => {
    board.cells.clear();
    for (const [id, cell] of snapshot) board.cells.set(id, { x: cell.x, y: cell.y });
};

/** The other size-3 rectangle. Not the point reflection of the anchor. */
const oppositeSize3Cells = (context: IPlacementContext): XY[] => {
    const sideOriented = context.sideOrientedPlacement === true;
    const lowBand = [1, 2, 3];
    const highBand = [GRID_SIZE - 4, GRID_SIZE - 3, GRID_SIZE - 2];
    const depthBand = context.team === LEFT ? highBand : lowBand;
    const cells: XY[] = [];
    for (const depth of depthBand) {
        for (let lat = 1; lat <= GRID_SIZE - 2; lat += 1) {
            cells.push(sideOriented ? { x: depth, y: lat } : { x: lat, y: depth });
        }
    }
    return cells;
};

const nearestCellDistance = (anchor: XY, cells: readonly XY[]): number => {
    let best = Infinity;
    for (const cell of cells) best = Math.min(best, chebyshev(anchor, cell));
    return best;
};

/** The anchor's cell on the back rank, or the back-rank cell of the footprint when the body already touches it. */
const backRankAnchorOf = (unit: Unit, board: IBoard, context: IPlacementContext): XY | undefined => {
    const onBack = board.footprint(unit).filter((cell) => board.geom.frontness(cell) === board.geom.backFront);
    if (onBack.length) {
        onBack.sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b) || a.x - b.x || a.y - b.y);
        return onBack[0];
    }
    const anchor = board.cells.get(unit.getId());
    if (!anchor) return undefined;
    return cellAt(context, board.geom.backFront, board.geom.lateral(anchor));
};

const bowIsShort = (unit: Unit, board: IBoard, context: IPlacementContext, opposite: readonly XY[]): boolean => {
    const anchor = backRankAnchorOf(unit, board, context);
    if (!anchor) return false;
    return bowReach(unit) < nearestCellDistance(anchor, opposite);
};

const isAuraCarrier = (unit: Unit): boolean => unit.hasAbilityActive("Guiding Winds Aura");

const footprintFits = (unit: Unit, anchor: XY, geom: IGeom): boolean => {
    const footprint = footprintCellsForAnchor(unit, anchor);
    return footprint.length > 0 && footprint.every((cell) => geom.legal.has(keyOf(cell)) && !isBoardEdge(cell));
};

const lateralsOfAnchor = (unit: Unit, anchor: XY, geom: IGeom): number[] =>
    footprintCellsForAnchor(unit, anchor).map((cell) => geom.lateral(cell));

const anchorsEntirelyOnRank = (
    unit: Unit,
    rank: number,
    board: IBoard,
    accept: (footprint: readonly XY[]) => boolean,
): XY[] => {
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprintFits(unit, anchor, board.geom)) continue;
        if (!footprint.every((cell) => board.geom.frontness(cell) === rank)) continue;
        if (!accept(footprint)) continue;
        spots.push(anchor);
    }
    return spots;
};

const anchorOnRankAt = (
    unit: Unit,
    rank: number,
    lat: number,
    board: IBoard,
    context: IPlacementContext,
): XY | undefined => {
    const target = cellAt(context, rank, lat);
    const spots = anchorsEntirelyOnRank(unit, rank, board, (footprint) =>
        footprint.some((cell) => board.geom.lateral(cell) === lat),
    );
    spots.sort((a, b) => {
        const aLats = lateralsOfAnchor(unit, a, board.geom);
        const bLats = lateralsOfAnchor(unit, b, board.geom);
        const span = Math.max(...aLats) - Math.min(...aLats) - (Math.max(...bLats) - Math.min(...bLats));
        return span || chebyshev(a, target) - chebyshev(b, target) || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const shiftAside = (
    board: IBoard,
    unit: Unit,
    forbidden: ReadonlySet<number>,
    locked: ReadonlySet<string>,
): boolean => {
    if (locked.has(unit.getId())) return false;
    const current = board.cells.get(unit.getId());
    const spots = board.geom.baseCells.filter((anchor) => {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprintFits(unit, anchor, board.geom)) return false;
        if (footprint.some((cell) => forbidden.has(keyOf(cell)))) return false;
        return board.free(unit, anchor);
    });
    spots.sort((a, b) => {
        const aDist = current ? chebyshev(a, current) : 0;
        const bDist = current ? chebyshev(b, current) : 0;
        return aDist - bDist || a.x - b.x || a.y - b.y;
    });
    const spot = spots[0];
    if (!spot) return false;
    if (current && sameCell(current, spot))
        return !footprintCellsForAnchor(unit, spot).some((cell) => forbidden.has(keyOf(cell)));
    return board.place(unit, spot);
};

const overlapsAuraCarrier = (unit: Unit, anchor: XY, board: IBoard): boolean => {
    const footprint = footprintCellsForAnchor(unit, anchor);
    return board.units.some((other) => {
        if (other.getId() === unit.getId() || !isAuraCarrier(other)) return false;
        const cells = board.footprint(other);
        return cells.length > 0 && minChebyshev(footprint, cells) === 0;
    });
};

const placeUnitAt = (
    board: IBoard,
    unit: Unit,
    anchor: XY,
    forbidden: ReadonlySet<number>,
    locked: ReadonlySet<string>,
): boolean => {
    if (!footprintFits(unit, anchor, board.geom)) return false;
    const footprint = footprintCellsForAnchor(unit, anchor);
    if (footprint.some((cell) => forbidden.has(keyOf(cell)))) return false;
    if (overlapsAuraCarrier(unit, anchor, board)) return false;
    const current = board.cells.get(unit.getId());
    if (current && sameCell(current, anchor)) return true;
    const snapshot = copyCells(board);
    const blockers = board.units.filter((other) => {
        if (other.getId() === unit.getId()) return false;
        const cells = board.footprint(other);
        return cells.length > 0 && minChebyshev(footprint, cells) === 0;
    });
    const block = new Set<number>(forbidden);
    for (const cell of footprint) block.add(keyOf(cell));
    for (const blocker of blockers.sort(byId)) {
        if (locked.has(blocker.getId()) || isAuraCarrier(blocker)) {
            restoreCells(board, snapshot);
            return false;
        }
        if (!shiftAside(board, blocker, block, locked)) {
            restoreCells(board, snapshot);
            return false;
        }
    }
    if (!board.free(unit, anchor)) {
        restoreCells(board, snapshot);
        return false;
    }
    board.place(unit, anchor);
    const now = board.cells.get(unit.getId());
    if (!now || !sameCell(now, anchor)) {
        restoreCells(board, snapshot);
        return false;
    }
    return true;
};

const clearCellKeys = (
    board: IBoard,
    keys: ReadonlySet<number>,
    locked: ReadonlySet<string>,
    forbidden: ReadonlySet<number>,
): boolean => {
    if (!keys.size) return true;
    const snapshot = copyCells(board);
    const block = new Set<number>(forbidden);
    for (const key of keys) block.add(key);
    const occupants = board.units.filter((unit) => board.footprint(unit).some((cell) => keys.has(keyOf(cell))));
    for (const occupant of occupants.sort(byId)) {
        if (locked.has(occupant.getId())) {
            restoreCells(board, snapshot);
            return false;
        }
        if (!shiftAside(board, occupant, block, locked)) {
            restoreCells(board, snapshot);
            return false;
        }
    }
    return true;
};

const placeAndClear = (
    board: IBoard,
    unit: Unit,
    anchor: XY,
    clear: ReadonlySet<number>,
    reserved: Set<number>,
    locked: Set<string>,
): boolean => {
    const snapshot = copyCells(board);
    const wasLocked = locked.has(unit.getId());
    if (!placeUnitAt(board, unit, anchor, reserved, locked)) return false;
    locked.add(unit.getId());
    if (!clearCellKeys(board, clear, locked, reserved)) {
        restoreCells(board, snapshot);
        if (!wasLocked) locked.delete(unit.getId());
        return false;
    }
    for (const key of clear) reserved.add(key);
    return true;
};

interface IRanks {
    readonly back: number;
    readonly middle: number;
    readonly front: number;
    readonly minLat: number;
    readonly maxLat: number;
}

const ranksOf = (board: IBoard): IRanks => {
    const limits = zoneLimits(board.geom);
    return {
        back: board.geom.backFront,
        middle: board.geom.backFront + 1,
        front: limits.maxFront,
        minLat: limits.minLat,
        maxLat: limits.maxLat,
    };
};

const lateralsNearestCentre = (board: IBoard): number[] => {
    const ranks = ranksOf(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) laterals.push(lat);
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    return laterals;
};

const keysAt = (context: IPlacementContext, front: number, laterals: readonly number[]): Set<number> => {
    const keys = new Set<number>();
    for (const lat of laterals) keys.add(keyOf(cellAt(context, front, lat)));
    return keys;
};

const oneCellGround = (board: IBoard): Unit[] =>
    board.units.filter(
        (unit) =>
            unit.isSmallSize() && !unit.canFly() && unit.getAttackType() !== RANGE && board.cells.has(unit.getId()),
    );

const nearestGround = (
    board: IBoard,
    target: XY,
    used: ReadonlySet<string>,
    locked: ReadonlySet<string>,
): Unit | undefined => {
    const options = oneCellGround(board).filter((unit) => !used.has(unit.getId()) && !locked.has(unit.getId()));
    options.sort((a, b) => {
        const aAnchor = board.cells.get(a.getId());
        const bAnchor = board.cells.get(b.getId());
        const aDist = aAnchor ? chebyshev(aAnchor, target) : Infinity;
        const bDist = bAnchor ? chebyshev(bAnchor, target) : Infinity;
        return aDist - bDist || byId(a, b);
    });
    return options[0];
};

const lateralGap = (laterals: readonly number[], banned: readonly number[]): number => {
    if (!banned.length || !laterals.length) return Infinity;
    let best = Infinity;
    for (const lat of laterals) {
        for (const ban of banned) best = Math.min(best, Math.abs(lat - ban));
    }
    return best;
};

const pairGapFor = (threats: IPublicPlacementThreats): number => {
    if (threats.chakram) return 4;
    if (threats.fireball || threats.ringOfFire || threats.meteorShower || threats.chainLightning) return 3;
    return 0;
};

const hasBlastThreat = (threats: IPublicPlacementThreats): boolean =>
    threats.fireball || threats.ringOfFire || threats.meteorShower || threats.chainLightning;

const footprintGapOk = (footprint: readonly XY[], others: readonly Unit[], board: IBoard, gap: number): boolean => {
    if (gap <= 0) return true;
    for (const other of others) {
        const cells = board.footprint(other);
        if (cells.length && minChebyshev(footprint, cells) < gap) return false;
    }
    return true;
};

const kingZone = (cells: readonly XY[]): Set<number> => new Set(kingKeys(cells));

const outerAnchor = (
    unit: Unit,
    rank: number,
    outerLat: number,
    towardHigh: boolean,
    board: IBoard,
): XY | undefined => {
    const spots = anchorsEntirelyOnRank(unit, rank, board, (footprint) => {
        const laterals = footprint.map((cell) => board.geom.lateral(cell));
        return towardHigh ? Math.max(...laterals) === outerLat : Math.min(...laterals) === outerLat;
    });
    spots.sort((a, b) => a.x - b.x || a.y - b.y);
    return spots[0];
};

const seatAgainstBreath = (board: IBoard, context: IPlacementContext, range: readonly Unit[]): void => {
    const ranks = ranksOf(board);
    const locked = new Set<string>();
    const reserved = new Set<number>();
    const ordered = [...range].sort(byReachDesc);
    const primary = ordered.slice(0, 2).sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const lowIn = ranks.minLat + 1;
    const highIn = ranks.maxLat - 1;
    const shifted: Unit[] = [];
    const seatShifted = (bow: Unit, outerLat: number, towardHigh: boolean): void => {
        const anchor = outerAnchor(bow, ranks.middle, outerLat, towardHigh, board);
        if (!anchor) return;
        const laterals = lateralsOfAnchor(bow, anchor, board.geom);
        const clear = new Set<number>([
            ...keysAt(context, ranks.front, laterals),
            ...keysAt(context, ranks.back, laterals),
        ]);
        if (!placeAndClear(board, bow, anchor, clear, reserved, locked)) return;
        shifted.push(bow);
    };
    const lowBow = primary[0];
    const highBow = primary[1];
    if (lowBow) seatShifted(lowBow, lowIn, false);
    if (highBow && highBow.getId() !== lowBow?.getId()) seatShifted(highBow, highIn, true);
    const shiftedLaterals = shifted.flatMap((bow) => board.laterals(bow));
    const baitLaterals = [ranks.minLat, ranks.maxLat];
    const banned = [...shiftedLaterals, ...baitLaterals];
    const placedFurther: Unit[] = [];
    for (const extra of ordered.filter((bow) => !shifted.some((seat) => seat.getId() === bow.getId()))) {
        let seated = false;
        for (const lat of lateralsNearestCentre(board)) {
            if (
                lateralGap([lat], banned) < 2 ||
                lateralGap(
                    [lat],
                    placedFurther.flatMap((bow) => board.laterals(bow)),
                ) < 1
            ) {
                continue;
            }
            const anchor = anchorOnRankAt(extra, ranks.middle, lat, board, context);
            if (!anchor) continue;
            const laterals = lateralsOfAnchor(extra, anchor, board.geom);
            if (lateralGap(laterals, banned) < 2) continue;
            if (placeAndClear(board, extra, anchor, new Set(), reserved, locked)) {
                placedFurther.push(extra);
                seated = true;
                break;
            }
        }
        if (seated) continue;
        const failedPrimary = primary.filter((bow) => !shifted.some((seat) => seat.getId() === bow.getId()));
        const obstacles = [...shifted, ...placedFurther, ...failedPrimary];
        const baitCells = baitLaterals.map((lat) => [cellAt(context, ranks.front, lat)]);
        for (const lat of lateralsNearestCentre(board)) {
            const anchor = anchorOnRankAt(extra, ranks.front, lat, board, context);
            if (!anchor) continue;
            const footprint = footprintCellsForAnchor(extra, anchor);
            if (!footprintGapOk(footprint, obstacles, board, 2)) continue;
            if (baitCells.some((cells) => minChebyshev(footprint, cells) < 2)) continue;
            if (placeAndClear(board, extra, anchor, new Set(), reserved, locked)) {
                placedFurther.push(extra);
                break;
            }
        }
    }
    const usedBait = new Set<string>();
    for (const lat of baitLaterals) {
        if (range.some((bow) => board.laterals(bow).includes(lat))) continue;
        const clear = new Set<number>([...keysAt(context, ranks.middle, [lat]), ...keysAt(context, ranks.back, [lat])]);
        if (!clearCellKeys(board, clear, locked, reserved)) continue;
        for (const key of clear) reserved.add(key);
        const target = cellAt(context, ranks.front, lat);
        const bait = nearestGround(board, target, usedBait, locked);
        if (!bait || !bait.isSmallSize()) continue;
        if (placeUnitAt(board, bait, target, reserved, locked)) {
            locked.add(bait.getId());
            usedBait.add(bait.getId());
        }
    }
};

const clearShooterAdjacency = (
    board: IBoard,
    shooters: readonly Unit[],
    keep: ReadonlySet<string>,
    locked: ReadonlySet<string>,
    reserved: ReadonlySet<number>,
): void => {
    const near = new Set<number>();
    for (const bow of shooters) {
        for (const key of kingZone(board.footprint(bow))) near.add(key);
    }
    const forbidden = new Set<number>(reserved);
    for (const key of near) forbidden.add(key);
    const offenders = board.units.filter((unit) => {
        if (unit.getAttackType() === RANGE || keep.has(unit.getId())) return false;
        return board.footprint(unit).some((cell) => near.has(keyOf(cell)));
    });
    for (const offender of offenders.sort(byId)) {
        if (locked.has(offender.getId())) continue;
        shiftAside(board, offender, forbidden, locked);
    }
};

const seatRearGuards = (
    board: IBoard,
    context: IPlacementContext,
    extras: readonly Unit[],
    cornerLaterals: readonly number[],
    reserved: Set<number>,
    locked: Set<string>,
): Set<string> => {
    const ranks = ranksOf(board);
    const guards = new Set<string>();
    const used = new Set<string>();
    for (const extra of extras) {
        for (const lat of board.laterals(extra)) {
            if (cornerLaterals.includes(lat)) continue;
            const target = cellAt(context, ranks.back, lat);
            const guard = nearestGround(board, target, used, locked);
            if (!guard) continue;
            const forward = keysAt(context, ranks.front, [lat]);
            if ([...forward].some((key) => key === keyOf(target))) continue;
            const snapshot = copyCells(board);
            if (!placeUnitAt(board, guard, target, reserved, locked)) continue;
            const footprint = board.footprint(guard);
            const onCorner = footprint.some((cell) => cornerLaterals.includes(board.geom.lateral(cell)));
            const offBack = footprint.some((cell) => board.geom.frontness(cell) !== ranks.back);
            if (onCorner || offBack) {
                restoreCells(board, snapshot);
                continue;
            }
            locked.add(guard.getId());
            used.add(guard.getId());
            guards.add(guard.getId());
        }
    }
    return guards;
};

const keepExistingRearGuards = (board: IBoard, bows: readonly Unit[]): Set<string> => {
    const ranks = ranksOf(board);
    const kept = new Set<string>();
    for (const bow of bows) {
        const laterals = new Set(board.laterals(bow));
        const guard = oneCellGround(board)
            .filter((unit) => {
                const footprint = board.footprint(unit);
                return (
                    footprint.length > 0 &&
                    footprint.every(
                        (cell) => board.geom.frontness(cell) === ranks.back && laterals.has(board.geom.lateral(cell)),
                    )
                );
            })
            .sort(byId)[0];
        if (guard) kept.add(guard.getId());
    }
    return kept;
};

const seatMovedBow = (
    board: IBoard,
    context: IPlacementContext,
    bow: Unit,
    anchor: XY,
    reserved: Set<number>,
    locked: Set<string>,
    others: readonly Unit[],
    gap: number,
    minLateral: number,
    bannedLaterals: readonly number[],
): boolean => {
    const footprint = footprintCellsForAnchor(bow, anchor);
    const laterals = footprint.map((cell) => board.geom.lateral(cell));
    if (lateralGap(laterals, bannedLaterals) < minLateral) return false;
    if (!footprintGapOk(footprint, others, board, gap)) return false;
    const forward = keysAt(context, board.geom.frontness(footprint[0]) + 1, laterals);
    return placeAndClear(board, bow, anchor, forward, reserved, locked);
};

const seatAgainstShooters = (
    board: IBoard,
    context: IPlacementContext,
    range: readonly Unit[],
    threats: IPublicPlacementThreats,
    opposite: readonly XY[],
): void => {
    const ranks = ranksOf(board);
    const ordered = [...range].sort(byReachDesc);
    const gap = pairGapFor(threats);
    const locked = new Set<string>();
    const reserved = new Set<number>();
    const moved: Unit[] = [];
    if (ordered.length === 2) {
        const shorter = [...ordered].sort(byReachAsc)[0];
        const longer = ordered.find((bow) => bow.getId() !== shorter.getId()) ?? ordered[0];
        locked.add(longer.getId());
        if (!shorter || !bowIsShort(shorter, board, context, opposite)) return;
        const banned = board.laterals(longer);
        const need = Math.max(3, gap);
        for (const lat of lateralsNearestCentre(board)) {
            const anchor = anchorOnRankAt(shorter, ranks.middle, lat, board, context);
            if (!anchor) continue;
            if (seatMovedBow(board, context, shorter, anchor, reserved, locked, [longer], gap, need, banned)) {
                moved.push(shorter);
                break;
            }
        }
    } else {
        const staying = ordered.slice(0, 2);
        for (const bow of staying) locked.add(bow.getId());
        const cornerLaterals = staying.flatMap((bow) => board.laterals(bow));
        for (const extra of ordered.slice(2)) {
            const seatedOthers = [...staying, ...moved];
            let seated = false;
            for (const lat of lateralsNearestCentre(board)) {
                const anchor = anchorOnRankAt(extra, ranks.middle, lat, board, context);
                if (!anchor) continue;
                const banned = [...cornerLaterals, ...moved.flatMap((bow) => board.laterals(bow))];
                if (seatMovedBow(board, context, extra, anchor, reserved, locked, seatedOthers, gap, 2, banned)) {
                    moved.push(extra);
                    seated = true;
                    break;
                }
            }
            if (!seated) locked.add(extra.getId());
        }
    }
    if (!moved.length) return;
    if (!hasBlastThreat(threats)) return;
    const stayingBows = range.filter((bow) => !moved.some((seat) => seat.getId() === bow.getId()));
    const cornerLaterals = stayingBows.flatMap((bow) => board.laterals(bow));
    const guards =
        threats.flyers > 0
            ? seatRearGuards(board, context, moved, cornerLaterals, reserved, locked)
            : keepExistingRearGuards(board, moved);
    for (const id of guards) locked.add(id);
    clearShooterAdjacency(board, range, guards, locked, reserved);
};

const shooterGap = (threats: IPublicPlacementThreats): number => (threats.rangeNullField ? 5 : 3);

const seatShooterOffBack = (
    board: IBoard,
    context: IPlacementContext,
    bow: Unit,
    lat: number,
    gap: number,
    placed: readonly Unit[],
    reserved: Set<number>,
    locked: Set<string>,
    allowFront: boolean,
): boolean => {
    const ranks = ranksOf(board);
    const tryRank = (rank: number): boolean => {
        const anchor = anchorOnRankAt(bow, rank, lat, board, context);
        if (!anchor) return false;
        const footprint = footprintCellsForAnchor(bow, anchor);
        if (footprint.some((cell) => board.geom.frontness(cell) === ranks.back)) return false;
        if (!footprintGapOk(footprint, placed, board, gap)) return false;
        return placeAndClear(board, bow, anchor, new Set(), reserved, locked);
    };
    if (tryRank(ranks.middle)) return true;
    return allowFront && tryRank(ranks.front);
};

const seatAgainstFlyers = (
    board: IBoard,
    context: IPlacementContext,
    range: readonly Unit[],
    threats: IPublicPlacementThreats,
): void => {
    const ranks = ranksOf(board);
    const ordered = [...range].sort(byReachDesc);
    const locked = new Set<string>();
    const reserved = new Set<number>();
    const placed: Unit[] = [];
    const preferred = shooterGap(threats);
    const minimum = 3;
    const seatAt = (bow: Unit, lat: number, gap: number, allowFront: boolean, obstacles: readonly Unit[]): boolean =>
        seatShooterOffBack(board, context, bow, lat, gap, obstacles, reserved, locked, allowFront);
    const longest = ordered[0];
    const next = ordered[1];
    if (
        longest &&
        (seatAt(longest, ranks.minLat, preferred, false, []) ||
            (preferred !== minimum && seatAt(longest, ranks.minLat, minimum, false, [])))
    ) {
        placed.push(longest);
    }
    const nextObstacles = longest ? [longest] : [];
    if (
        next &&
        (seatAt(next, ranks.maxLat, preferred, false, nextObstacles) ||
            (preferred !== minimum && seatAt(next, ranks.maxLat, minimum, false, nextObstacles)))
    ) {
        placed.push(next);
    }
    for (let index = 2; index < ordered.length; index += 1) {
        const extra = ordered[index];
        const future = new Set(ordered.slice(index + 1).map((bow) => bow.getId()));
        const obstacles = ordered.filter((bow) => bow.getId() !== extra.getId() && !future.has(bow.getId()));
        const tryGap = (gap: number): boolean => {
            for (const lat of lateralsNearestCentre(board)) {
                if (placed.some((bow) => board.laterals(bow).includes(lat))) continue;
                if (seatAt(extra, lat, gap, false, obstacles)) return true;
            }
            for (const lat of lateralsNearestCentre(board)) {
                if (placed.some((bow) => board.laterals(bow).includes(lat))) continue;
                if (seatAt(extra, lat, gap, true, obstacles)) return true;
            }
            return false;
        };
        if (tryGap(preferred) || (preferred !== minimum && tryGap(minimum))) placed.push(extra);
    }
    const guarded = new Set<number>();
    const used = new Set<string>();
    for (const bow of placed) {
        for (const lat of board.laterals(bow)) {
            if (guarded.has(lat)) continue;
            if (
                board
                    .footprint(bow)
                    .some((cell) => board.geom.frontness(cell) === ranks.back && board.geom.lateral(cell) === lat)
            ) {
                continue;
            }
            const target = cellAt(context, ranks.back, lat);
            const forward = cellAt(context, board.geom.frontness(board.cells.get(bow.getId()) ?? target) + 1, lat);
            if (sameCell(target, forward)) continue;
            const guard = nearestGround(board, target, used, locked);
            if (!guard) continue;
            if (!placeUnitAt(board, guard, target, reserved, locked)) continue;
            if (board.footprint(guard).some((cell) => sameCell(cell, forward))) continue;
            locked.add(guard.getId());
            used.add(guard.getId());
            guarded.add(lat);
        }
    }
};

const cornerLateralsOf = (board: IBoard, bows: readonly Unit[]): number[] => {
    const ranks = ranksOf(board);
    const laterals: number[] = [];
    for (const bow of bows) {
        for (const cell of board.footprint(bow)) {
            if (board.geom.frontness(cell) !== ranks.back) continue;
            const lat = board.geom.lateral(cell);
            if (lat === ranks.minLat || lat === ranks.maxLat) laterals.push(lat);
        }
    }
    return laterals;
};

const violatesFriendlyGap = (
    footprint: readonly XY[],
    board: IBoard,
    ignore: ReadonlySet<string>,
    moved: readonly { unit: Unit; anchor: XY }[],
): boolean => {
    for (const other of board.units) {
        if (ignore.has(other.getId())) continue;
        const movedAnchor = moved.find((seat) => seat.unit.getId() === other.getId());
        const cells = movedAnchor ? footprintCellsForAnchor(other, movedAnchor.anchor) : board.footprint(other);
        if (cells.length && minChebyshev(footprint, cells) < 2) return true;
    }
    return false;
};

const seatAgainstGround = (
    board: IBoard,
    context: IPlacementContext,
    range: readonly Unit[],
    threats: IPublicPlacementThreats,
    opposite: readonly XY[],
): void => {
    const ranks = ranksOf(board);
    const shorts = range
        .filter((bow) => bowIsShort(bow, board, context, opposite))
        .sort(byReachAsc)
        .slice(0, 2);
    if (!shorts.length) return;
    const staying = range.filter((bow) => !shorts.some((short) => short.getId() === bow.getId()));
    const locked = new Set<string>(staying.map((bow) => bow.getId()));
    const reserved = new Set<number>();
    const moved: { unit: Unit; anchor: XY }[] = [];
    const spread = threats.lightningSpin || threats.chainLightning;
    const banned = cornerLateralsOf(board, staying);
    for (const bow of shorts) {
        let seated = false;
        for (const lat of lateralsNearestCentre(board)) {
            const anchor = anchorOnRankAt(bow, ranks.front, lat, board, context);
            if (!anchor) continue;
            const footprint = footprintCellsForAnchor(bow, anchor);
            const laterals = footprint.map((cell) => board.geom.lateral(cell));
            const taken = [...banned, ...moved.flatMap((seat) => lateralsOfAnchor(seat.unit, seat.anchor, board.geom))];
            if (lateralGap(laterals, taken) < 2) continue;
            const middle = keysAt(context, ranks.middle, laterals);
            const ignore = new Set<string>([bow.getId(), ...moved.map((seat) => seat.unit.getId())]);
            for (const other of board.units) {
                if (other.getId() === bow.getId()) continue;
                if (board.footprint(other).some((cell) => middle.has(keyOf(cell)))) ignore.add(other.getId());
                if (minChebyshev(footprint, board.footprint(other)) === 0) ignore.add(other.getId());
            }
            if (spread && violatesFriendlyGap(footprint, board, ignore, moved)) continue;
            const placeForbidden = new Set<number>(reserved);
            for (const key of middle) placeForbidden.add(key);
            if (spread) {
                for (const key of kingZone(footprint)) {
                    if (!footprint.some((cell) => keyOf(cell) === key)) placeForbidden.add(key);
                }
            }
            const snapshot = copyCells(board);
            const wasLocked = locked.has(bow.getId());
            if (!placeUnitAt(board, bow, anchor, placeForbidden, locked)) continue;
            locked.add(bow.getId());
            if (!clearCellKeys(board, middle, locked, placeForbidden)) {
                restoreCells(board, snapshot);
                if (!wasLocked) locked.delete(bow.getId());
                continue;
            }
            for (const key of middle) reserved.add(key);
            moved.push({ unit: bow, anchor });
            seated = true;
            break;
        }
        if (!seated) locked.add(bow.getId());
    }
};

/**
 * r2c1 post-pass. Today's placeArmy has already run. Bows leave the back rank only for the public
 * roster that punishes corners. A bow this pass does not move keeps the incumbent cell, so the
 * corner reseat must not run again for a bow this pass moves.
 */
export function placeArmyR2C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const range = placedRange(units, board);
    if (range.length < 2) return new Map(board.cells);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(board.cells);
    const opposite = oppositeSize3Cells(context);
    if (threats.fireBreath) seatAgainstBreath(board, context, range);
    else if (threats.rangeCreatures >= 2) seatAgainstShooters(board, context, range, threats, opposite);
    else if (threats.flyers >= 1 && threats.rangeCreatures === 0) seatAgainstFlyers(board, context, range, threats);
    else if (threats.flyers === 0 && threats.rangeCreatures === 0) {
        seatAgainstGround(board, context, range, threats, opposite);
    }
    return board.cells;
}

const r2Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (unit.getAttackType() === RANGE || isSpellbookUnit(unit) || PROTECTORS.has(unit.getName())) {
            locked.add(unit.getId());
        }
    }
    for (const unit of board.units) {
        if (!PROTECTORS.has(unit.getName())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        for (const other of board.units) {
            if (other.getId() === unit.getId()) continue;
            const otherFootprint = board.footprint(other);
            if (otherFootprint.length > 0 && minChebyshev(footprint, otherFootprint) <= 1) {
                locked.add(unit.getId());
                locked.add(other.getId());
            }
        }
    }
    return locked;
};

const r2Ground = (unit: Unit, board: IBoard, locked: ReadonlySet<string>): boolean =>
    !locked.has(unit.getId()) &&
    !unit.canFly() &&
    !isCharger(unit) &&
    !isSpellbookUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    unit.getAttackType() !== RANGE &&
    board.footprint(unit).length > 0;

const r2Flyer = (unit: Unit, board: IBoard, locked: ReadonlySet<string>): boolean =>
    unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !locked.has(unit.getId()) &&
    !isSpellbookUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    board.footprint(unit).length > 0;

const r2FastestCharger = (board: IBoard, locked: ReadonlySet<string>): Unit | undefined =>
    board.units
        .filter((unit) => isCharger(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((a, b) => b.getSteps() - a.getSteps() || byId(a, b))[0];

const r2SideOriented = (geom: IGeom): boolean => geom.lateral({ x: 0, y: 0 }) !== geom.lateral({ x: 0, y: 1 });

const r2Unit = (board: IBoard, id: string): Unit | undefined => board.units.find((unit) => unit.getId() === id);

const r2Ranks = (board: IBoard): { back: number; middle: number; front: number } => {
    const limits = zoneLimits(board.geom);
    return { back: board.geom.backFront, middle: limits.maxFront - 1, front: limits.maxFront };
};

const r2Anchors = (
    unit: Unit,
    board: IBoard,
    occupied: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): XY[] => {
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, occupied) || !accept(span)) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => a.x - b.x || a.y - b.y);
    return spots;
};

const r2FileClear = (laterals: readonly number[], board: IBoard, ignore: ReadonlySet<string>): boolean => {
    const mine = new Set(laterals);
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        if (board.laterals(unit).some((lat) => mine.has(lat))) return false;
    }
    return mine.size > 0;
};

const r2AssignmentLegal = (board: IBoard, assignments: ReadonlyMap<string, XY>): boolean => {
    if (!assignments.size) return false;
    const occupied = takenCells(board, new Set(assignments.keys()));
    for (const [id, anchor] of assignments) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!unit || !span) return false;
        const previous = board.cells.get(id);
        const staying = !!previous && sameCell(previous, anchor);
        if (!staying && !spanIsLegal(span, board.geom, occupied)) return false;
        for (const cell of span.cells) {
            const key = keyOf(cell);
            if (staying && occupied.has(key)) return false;
            if (!staying && occupied.has(key)) return false;
            occupied.add(key);
        }
    }
    return true;
};

interface IRowScore {
    readonly plan: Map<string, XY>;
    readonly size: number;
    readonly distance: number;
}

const r2BlockDistance = (board: IBoard, plan: ReadonlyMap<string, XY>): number => {
    const laterals: number[] = [];
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (span) laterals.push(...span.laterals);
    }
    if (!laterals.length) return Infinity;
    return Math.abs(medianNumber(laterals) - board.geom.centreLat);
};

const r2PlaceRow = (
    board: IBoard,
    ordered: readonly Unit[],
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): Map<string, XY> | undefined => {
    if (!ordered.length) return new Map();
    const sideOriented = r2SideOriented(board.geom);
    const widths = ordered.map((unit) => lateralSpanCount(unit, sideOriented));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const limits = zoneLimits(board.geom);
    const ideal = Math.round(board.geom.centreLat - (total - 1) / 2);
    const starts: number[] = [];
    for (let delta = 0; delta <= limits.maxLat - limits.minLat; delta += 1) {
        for (const sign of delta === 0 ? [0] : [-1, 1]) {
            const start = ideal + sign * delta;
            if (start < limits.minLat || start + total - 1 > limits.maxLat) continue;
            let blocked = false;
            for (let lat = start; lat < start + total; lat += 1) if (forbidden.has(lat)) blocked = true;
            if (!blocked) starts.push(start);
        }
    }
    for (const start of starts) {
        const taken = new Set(occupied);
        const plan = new Map<string, XY>();
        let cursor = start;
        let fitted = true;
        for (let index = 0; index < ordered.length; index += 1) {
            const unit = ordered[index];
            const anchor = findWindow(unit, board, taken, cursor, cursor + widths[index] - 1, accept, forbidden);
            if (!anchor) {
                fitted = false;
                break;
            }
            plan.set(unit.getId(), anchor);
            for (const cell of footprintCellsForAnchor(unit, anchor)) taken.add(keyOf(cell));
            cursor += widths[index];
        }
        if (fitted) return plan;
    }
    return undefined;
};

const r2BestRow = (
    board: IBoard,
    units: readonly Unit[],
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): Map<string, XY> => {
    const ordered = [...units].sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const subsets: Unit[][] = [ordered];
    if (ordered.length > 1) {
        for (let index = 0; index < ordered.length; index += 1) {
            subsets.push(ordered.filter((_, item) => item !== index));
        }
    }
    for (const unit of ordered) subsets.push([unit]);
    let best: IRowScore | undefined;
    for (const subset of subsets) {
        const plan = r2PlaceRow(board, subset, occupied, forbidden, accept);
        if (!plan?.size) continue;
        const distance = r2BlockDistance(board, plan);
        if (!best || plan.size > best.size || (plan.size === best.size && distance < best.distance)) {
            best = { plan, size: plan.size, distance };
        }
        if (plan.size === ordered.length) break;
    }
    return best?.plan ?? new Map();
};

const r2PackAroundStays = (
    board: IBoard,
    units: readonly Unit[],
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): Map<string, XY> => {
    const blockers = new Set(occupied);
    const frozen = new Set<string>();
    let plan = new Map<string, XY>();
    for (let guard = 0; guard <= units.length; guard += 1) {
        const active = units.filter((unit) => !frozen.has(unit.getId()));
        plan = r2BestRow(board, active, blockers, forbidden, accept);
        const clashing = active.filter((unit) => {
            if (plan.has(unit.getId())) return false;
            const footprint = board.footprint(unit);
            for (const [id, anchor] of plan) {
                const other = r2Unit(board, id);
                if (!other) continue;
                if (minChebyshev(footprint, footprintCellsForAnchor(other, anchor)) === 0) return true;
            }
            return false;
        });
        if (!clashing.length) return plan;
        for (const unit of clashing) {
            frozen.add(unit.getId());
            for (const cell of board.footprint(unit)) blockers.add(keyOf(cell));
        }
    }
    return plan;
};

interface ILaneOption {
    readonly anchor: XY;
    readonly laterals: readonly number[];
}

const r2BackLanes = (
    board: IBoard,
    unit: Unit,
    ignore: ReadonlySet<string>,
    banned: ReadonlySet<number>,
): ILaneOption[] => {
    const ranks = r2Ranks(board);
    const occupied = takenCells(board, ignore);
    const options: ILaneOption[] = [];
    const seen = new Set<number>();
    for (const anchor of r2Anchors(unit, board, occupied, (span) => {
        if (span.minFront !== ranks.back || span.maxFront >= ranks.front) return false;
        return span.laterals.every((lat) => !banned.has(lat));
    })) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !r2FileClear(span.laterals, board, ignore)) continue;
        const key = keyOf(anchor);
        if (seen.has(key)) continue;
        seen.add(key);
        options.push({ anchor, laterals: [...new Set(span.laterals)] });
    }
    return options;
};

const r2LaneDistance = (laterals: readonly number[], block: ReadonlySet<number>): number => {
    if (!block.size) return 0;
    let best = Infinity;
    for (const lat of laterals) {
        for (const other of block) best = Math.min(best, Math.abs(lat - other));
    }
    return best;
};

const r2SortLanes = (board: IBoard, lanes: readonly ILaneOption[], block: ReadonlySet<number>): ILaneOption[] =>
    [...lanes].sort((a, b) => {
        const aOut = a.laterals.every((lat) => !block.has(lat)) ? 0 : 1;
        const bOut = b.laterals.every((lat) => !block.has(lat)) ? 0 : 1;
        if (aOut !== bOut) return aOut - bOut;
        const gap = r2LaneDistance(a.laterals, block) - r2LaneDistance(b.laterals, block);
        if (gap) return gap;
        const centre =
            Math.abs(medianNumber(a.laterals) - board.geom.centreLat) -
            Math.abs(medianNumber(b.laterals) - board.geom.centreLat);
        if (centre) return centre;
        return Math.min(...a.laterals) - Math.min(...b.laterals);
    });

const r2SortCentre = (board: IBoard, lanes: readonly ILaneOption[]): ILaneOption[] =>
    [...lanes].sort((a, b) => {
        const centre =
            Math.abs(medianNumber(a.laterals) - board.geom.centreLat) -
            Math.abs(medianNumber(b.laterals) - board.geom.centreLat);
        if (centre) return centre;
        return Math.min(...a.laterals) - Math.min(...b.laterals);
    });

const r2PreviewLaterals = (
    board: IBoard,
    grounds: readonly Unit[],
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
): Set<number> => {
    const ranks = r2Ranks(board);
    const plan = r2BestRow(board, grounds, occupied, forbidden, (span) => span.maxFront === ranks.front);
    const laterals = new Set<number>();
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (span) for (const lat of span.laterals) laterals.add(lat);
    }
    return laterals;
};

const r2FrontBans = (
    board: IBoard,
    context: IPlacementContext,
    plan: ReadonlyMap<string, XY>,
): { behind: Set<number>; breath: Set<number>; laterals: Set<number> } => {
    const ranks = r2Ranks(board);
    const behind = new Set<number>();
    const breath = new Set<number>();
    const laterals = new Set<number>();
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span || span.maxFront !== ranks.front) continue;
        for (const lat of span.laterals) laterals.add(lat);
        const face = new Set(
            span.cells
                .filter((cell) => board.geom.frontness(cell) === ranks.front)
                .map((cell) => board.geom.lateral(cell)),
        );
        for (const lat of face) behind.add(keyOf(cellAt(context, ranks.front - 1, lat)));
        if (span.maxFront > span.minFront) {
            for (const lat of span.laterals) {
                const exit = span.minFront - 1;
                if (exit >= ranks.back) breath.add(keyOf(cellAt(context, exit, lat)));
            }
        }
    }
    return { behind, breath, laterals };
};

const r2SeamAnchor = (
    board: IBoard,
    context: IPlacementContext,
    unit: Unit,
    occupied: ReadonlySet<number>,
    front: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
    behind: ReadonlySet<number>,
    breath: ReadonlySet<number>,
): XY | undefined => {
    const ranks = r2Ranks(board);
    const spots = r2Anchors(unit, board, occupied, (span) => {
        if (span.maxFront !== ranks.middle) return false;
        if (span.laterals.some((lat) => forbidden.has(lat) || front.has(lat))) return false;
        if (span.cells.some((cell) => behind.has(keyOf(cell)) || breath.has(keyOf(cell)))) return false;
        return span.laterals.every(
            (lat) => [...front].some((other) => other < lat) && [...front].some((other) => other > lat),
        );
    });
    spots.sort((a, b) => {
        const aSpan = spanAt(unit, a, board.geom);
        const bSpan = spanAt(unit, b, board.geom);
        const aDist = aSpan ? Math.abs(medianNumber(aSpan.laterals) - board.geom.centreLat) : Infinity;
        const bDist = bSpan ? Math.abs(medianNumber(bSpan.laterals) - board.geom.centreLat) : Infinity;
        return aDist - bDist || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const r2OccupyPlan = (board: IBoard, plan: ReadonlyMap<string, XY>, occupied: ReadonlySet<number>): Set<number> => {
    const taken = new Set(occupied);
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        if (!unit) continue;
        for (const cell of footprintCellsForAnchor(unit, anchor)) taken.add(keyOf(cell));
    }
    return taken;
};

const r2LaneHolds = (
    board: IBoard,
    plan: ReadonlyMap<string, XY>,
    lane: ReadonlySet<number>,
    allowed: ReadonlySet<string>,
): boolean => {
    if (!lane.size) return true;
    for (const unit of board.units) {
        const anchor = plan.get(unit.getId()) ?? board.cells.get(unit.getId());
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span || !span.laterals.some((lat) => lane.has(lat))) continue;
        if (!allowed.has(unit.getId())) return false;
    }
    return true;
};

const r2CornerAnchor = (
    board: IBoard,
    unit: Unit,
    extreme: number,
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
): XY | undefined => {
    const ranks = r2Ranks(board);
    const spots = r2Anchors(unit, board, occupied, (span) => {
        if (span.minFront !== ranks.back || span.maxFront !== ranks.back) return false;
        if (
            !span.cells.some(
                (cell) => board.geom.lateral(cell) === extreme && board.geom.frontness(cell) === ranks.back,
            )
        ) {
            return false;
        }
        return span.laterals.every((lat) => !forbidden.has(lat));
    });
    spots.sort((a, b) => {
        const aSpan = spanAt(unit, a, board.geom);
        const bSpan = spanAt(unit, b, board.geom);
        const span = (aSpan?.laterals.length ?? Infinity) - (bSpan?.laterals.length ?? Infinity);
        return span || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const r2ScreenAnchor = (
    board: IBoard,
    unit: Unit,
    lane: readonly number[],
    occupied: ReadonlySet<number>,
    banned: ReadonlySet<number>,
): XY | undefined => {
    const ranks = r2Ranks(board);
    const laneSet = new Set(lane);
    const spots = r2Anchors(unit, board, occupied, (span) => {
        if (span.maxFront !== ranks.front) return false;
        if (span.laterals.some((lat) => banned.has(lat))) return false;
        return lane.some((lat) =>
            span.cells.some((cell) => board.geom.lateral(cell) === lat && board.geom.frontness(cell) === ranks.front),
        );
    });
    spots.sort((a, b) => {
        const aSpan = spanAt(unit, a, board.geom);
        const bSpan = spanAt(unit, b, board.geom);
        const aExtra = aSpan?.laterals.filter((lat) => !laneSet.has(lat)).length ?? Infinity;
        const bExtra = bSpan?.laterals.filter((lat) => !laneSet.has(lat)).length ?? Infinity;
        return aExtra - bExtra || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const r2HighestArmor = (units: readonly Unit[]): Unit | undefined =>
    [...units].sort((a, b) => b.getArmor() - a.getArmor() || byId(a, b))[0];

interface IGroundPlan {
    readonly plan: Map<string, XY>;
    readonly lane: Set<number>;
}

const r2FinishSeams = (
    board: IBoard,
    context: IPlacementContext,
    grounds: readonly Unit[],
    plan: Map<string, XY>,
    occupied: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
): void => {
    const omitted = grounds
        .filter((unit) => !plan.has(unit.getId()))
        .sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b));
    for (const unit of omitted) {
        const bans = r2FrontBans(board, context, plan);
        const spot = r2SeamAnchor(
            board,
            context,
            unit,
            r2OccupyPlan(board, plan, occupied),
            bans.laterals,
            forbidden,
            bans.behind,
            bans.breath,
        );
        if (!spot) continue;
        plan.set(unit.getId(), spot);
        if (!r2AssignmentLegal(board, plan)) plan.delete(unit.getId());
    }
};

const r2PlanPierce = (
    board: IBoard,
    context: IPlacementContext,
    grounds: readonly Unit[],
    charger: Unit | undefined,
    bowLats: ReadonlySet<number>,
): IGroundPlan => {
    const empty: IGroundPlan = { plan: new Map(), lane: new Set() };
    const movers = new Set(grounds.map((unit) => unit.getId()));
    if (charger) movers.add(charger.getId());
    const stayers = takenCells(board, movers);
    const preview = r2PreviewLaterals(board, grounds, stayers, bowLats);
    const lanes = charger ? r2SortLanes(board, r2BackLanes(board, charger, movers, bowLats), preview) : [];
    const attempts: (ILaneOption | undefined)[] = [...lanes, undefined];
    const ranks = r2Ranks(board);
    for (const lane of attempts) {
        const plan = new Map<string, XY>();
        const laneLats = new Set(lane?.laterals ?? []);
        if (charger && lane) plan.set(charger.getId(), lane.anchor);
        const forbidden = new Set<number>([...bowLats, ...laneLats]);
        const occupied = r2OccupyPlan(board, plan, stayers);
        const packed = r2PackAroundStays(board, grounds, occupied, forbidden, (span) => span.maxFront === ranks.front);
        for (const [id, anchor] of packed) plan.set(id, anchor);
        r2FinishSeams(board, context, grounds, plan, stayers, forbidden);
        const allowed = new Set<string>();
        if (charger && lane) allowed.add(charger.getId());
        if (plan.size && r2AssignmentLegal(board, plan) && r2LaneHolds(board, plan, laneLats, allowed)) {
            return { plan, lane: laneLats };
        }
    }
    return empty;
};

const r2PlanCorners = (
    board: IBoard,
    grounds: readonly Unit[],
    charger: Unit | undefined,
    bowLats: ReadonlySet<number>,
    clearLane: boolean,
): IGroundPlan => {
    const empty: IGroundPlan = { plan: new Map(), lane: new Set() };
    const limits = zoneLimits(board.geom);
    const ranks = r2Ranks(board);
    const movers = new Set(grounds.map((unit) => unit.getId()));
    if (charger) movers.add(charger.getId());
    const ignore = clearLane ? movers : new Set(charger ? [charger.getId()] : []);
    const lanes = charger ? r2SortCentre(board, r2BackLanes(board, charger, ignore, bowLats)) : [];
    const attempts: (ILaneOption | undefined)[] = charger ? [...lanes, undefined] : [undefined];
    const smallest = [...grounds].sort((a, b) => footprintArea(a) - footprintArea(b) || byId(a, b));
    for (const lane of attempts) {
        const plan = new Map<string, XY>();
        const laneLats = new Set(lane?.laterals ?? []);
        if (charger && lane) plan.set(charger.getId(), lane.anchor);
        const forbidden = new Set<number>([...bowLats, ...laneLats]);
        let occupied = r2OccupyPlan(board, plan, takenCells(board, movers));
        for (const [index, unit] of smallest.slice(0, 2).entries()) {
            const extreme = index === 0 ? limits.minLat : limits.maxLat;
            const spot = r2CornerAnchor(board, unit, extreme, occupied, forbidden);
            if (!spot) continue;
            plan.set(unit.getId(), spot);
            const span = spanAt(unit, spot, board.geom);
            if (span) for (const lat of span.laterals) forbidden.add(lat);
            occupied = r2OccupyPlan(board, plan, takenCells(board, movers));
        }
        const cornerUnits = smallest.slice(0, 2);
        for (const unit of cornerUnits) {
            if (plan.has(unit.getId())) continue;
            for (const cell of board.footprint(unit)) occupied.add(keyOf(cell));
        }
        const cornerIds = new Set(cornerUnits.map((unit) => unit.getId()));
        const rest = grounds.filter((unit) => !cornerIds.has(unit.getId()));
        const packed = r2PackAroundStays(board, rest, occupied, forbidden, (span) => span.maxFront === ranks.front);
        for (const [id, anchor] of packed) plan.set(id, anchor);
        const allowed = new Set<string>();
        if (charger && lane) allowed.add(charger.getId());
        if (plan.size && r2AssignmentLegal(board, plan) && r2LaneHolds(board, plan, laneLats, allowed)) {
            return { plan, lane: laneLats };
        }
    }
    return empty;
};

const r2PlanSponge = (
    board: IBoard,
    grounds: readonly Unit[],
    charger: Unit | undefined,
    bowLats: ReadonlySet<number>,
    moveTheRest: boolean,
): IGroundPlan => {
    const empty: IGroundPlan = { plan: new Map(), lane: new Set() };
    const screen = r2HighestArmor(grounds);
    const ranks = r2Ranks(board);
    const movers = new Set<string>();
    if (charger) movers.add(charger.getId());
    if (moveTheRest) for (const unit of grounds) movers.add(unit.getId());
    else if (screen) movers.add(screen.getId());
    const lanes = charger ? r2SortCentre(board, r2BackLanes(board, charger, movers, bowLats)) : [];
    const limits = zoneLimits(board.geom);
    const centreFiles: number[] = [];
    let nearest = Infinity;
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        nearest = Math.min(nearest, Math.abs(lat - board.geom.centreLat));
    }
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        if (Math.abs(lat - board.geom.centreLat) === nearest) centreFiles.push(lat);
    }
    if (!moveTheRest && centreFiles.length && centreFiles.every((lat) => bowLats.has(lat))) return empty;
    const centreLanes = lanes.filter((lane) => lane.laterals.every((lat) => centreFiles.includes(lat)));
    const attempts = moveTheRest ? lanes : centreLanes;
    for (const lane of attempts) {
        if (!charger) continue;
        const plan = new Map<string, XY>();
        plan.set(charger.getId(), lane.anchor);
        const laneLats = new Set(lane.laterals);
        let occupied = r2OccupyPlan(board, plan, takenCells(board, movers));
        let screenLaterals = new Set<number>(laneLats);
        if (screen) {
            const spot = r2ScreenAnchor(board, screen, lane.laterals, occupied, bowLats);
            if (!spot && moveTheRest) continue;
            if (spot) {
                plan.set(screen.getId(), spot);
                const span = spanAt(screen, spot, board.geom);
                screenLaterals = new Set(span ? span.laterals : laneLats);
                occupied = r2OccupyPlan(board, plan, takenCells(board, movers));
            }
        }
        if (moveTheRest) {
            const forbidden = new Set<number>([...bowLats, ...screenLaterals, ...laneLats]);
            const rest = grounds.filter((unit) => unit.getId() !== screen?.getId());
            const packed = r2PackAroundStays(
                board,
                rest,
                occupied,
                forbidden,
                (span) => span.minFront === ranks.middle && span.maxFront === ranks.middle,
            );
            for (const [id, anchor] of packed) plan.set(id, anchor);
        }
        const allowed = new Set<string>();
        if (charger) allowed.add(charger.getId());
        if (screen && plan.has(screen.getId())) allowed.add(screen.getId());
        if (plan.size && r2AssignmentLegal(board, plan) && r2LaneHolds(board, plan, laneLats, allowed)) {
            return { plan, lane: laneLats };
        }
    }
    return empty;
};

const r2Commit = (board: IBoard, plan: ReadonlyMap<string, XY>): boolean => {
    if (!plan.size) return false;
    if (!r2AssignmentLegal(board, plan)) return false;
    commitAssignments(board, plan, false);
    return true;
};

const r2FrontTanks = (board: IBoard): Unit[] => {
    const ranks = r2Ranks(board);
    return board.units.filter(
        (unit) =>
            !unit.canFly() &&
            unit.getAttackType() !== RANGE &&
            board.footprint(unit).some((cell) => board.geom.frontness(cell) === ranks.front),
    );
};

const r2FrontLaterals = (board: IBoard, ignore: ReadonlySet<string>): Set<number> => {
    const ranks = r2Ranks(board);
    const laterals = new Set<number>();
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) {
            if (board.geom.frontness(cell) === ranks.front) laterals.add(board.geom.lateral(cell));
        }
    }
    return laterals;
};

const r2BowCorners = (board: IBoard, context: IPlacementContext, bows: readonly Unit[]): Set<number> => {
    const ranks = ranksOf(board);
    const corners = new Set([
        keyOf(cellAt(context, ranks.back, ranks.minLat)),
        keyOf(cellAt(context, ranks.back, ranks.maxLat)),
    ]);
    const banned = new Set<number>();
    for (const bow of bows) {
        for (const cell of board.footprint(bow)) {
            if (corners.has(keyOf(cell))) banned.add(keyOf(cell));
        }
    }
    return banned;
};

const r2BackCorners = (board: IBoard, context: IPlacementContext): Set<number> => {
    const ranks = ranksOf(board);
    return new Set([
        keyOf(cellAt(context, ranks.back, ranks.minLat)),
        keyOf(cellAt(context, ranks.back, ranks.maxLat)),
    ]);
};

const r2FlyerRank = (span: ISpan, ranks: { back: number; middle: number; front: number }, deep: boolean): boolean => {
    const depth = span.maxFront - span.minFront;
    if (!deep) return depth === 0 && span.maxFront === ranks.middle;
    if (depth === 0) return span.maxFront === ranks.middle;
    return depth === 1 && span.minFront === ranks.back && span.maxFront === ranks.middle && span.maxFront < ranks.front;
};

const r2EscortFlyers = (
    board: IBoard,
    context: IPlacementContext,
    flyers: readonly Unit[],
    lane: ReadonlySet<number>,
    bowLats: ReadonlySet<number>,
    filePierce: boolean,
): void => {
    const ranks = r2Ranks(board);
    const tanks = r2FrontTanks(board).sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const ordered = [...flyers].sort(byId);
    const usedTanks = new Set<string>();
    const placed: Unit[] = [];
    const corners = r2BowCorners(board, context, placedRange(board.units, board));
    ordered.forEach((flyer, index) => {
        const preferred = ordered.length === 1 ? undefined : index % 2 === 0 ? "low" : "high";
        const tankOrder = tanks.filter((tank) => !usedTanks.has(tank.getId()));
        const ranked = preferred
            ? [...tankOrder].sort((a, b) => {
                  const sign = preferred === "low" ? 1 : -1;
                  return sign * (medianLat(a, board) - medianLat(b, board)) || byId(a, b);
              })
            : tankOrder;
        let chosen: { tank: Unit; anchor: XY } | undefined;
        const halves: (typeof preferred)[] = preferred ? [preferred, undefined] : [undefined];
        for (const half of halves) {
            for (const tank of half ? ranked : tankOrder) {
                const tankLats = new Set(board.laterals(tank));
                const frontLats = r2FrontLaterals(board, new Set([flyer.getId()]));
                const occupied = takenCells(board, new Set([flyer.getId()]));
                const spots = r2Anchors(flyer, board, occupied, (span) => {
                    if (!r2FlyerRank(span, ranks, true)) return false;
                    if (span.laterals.some((lat) => tankLats.has(lat) || bowLats.has(lat) || lane.has(lat))) {
                        return false;
                    }
                    if (filePierce && span.laterals.some((lat) => frontLats.has(lat))) return false;
                    if (span.cells.some((cell) => corners.has(keyOf(cell)))) return false;
                    if (minChebyshev(span.cells, board.footprint(tank)) !== 1) return false;
                    if (half === "low" && medianNumber(span.laterals) > board.geom.centreLat) return false;
                    if (half === "high" && medianNumber(span.laterals) < board.geom.centreLat) return false;
                    if (
                        placed.some((other) => {
                            const gap = lateralDistance(span.laterals, board.laterals(other));
                            return gap < 2 || minChebyshev(span.cells, board.footprint(other)) <= 1;
                        })
                    ) {
                        return false;
                    }
                    return true;
                });
                if (!spots.length) continue;
                spots.sort((a, b) => {
                    const aSpan = spanAt(flyer, a, board.geom);
                    const bSpan = spanAt(flyer, b, board.geom);
                    const aDist = aSpan ? Math.abs(medianNumber(aSpan.laterals) - board.geom.centreLat) : 0;
                    const bDist = bSpan ? Math.abs(medianNumber(bSpan.laterals) - board.geom.centreLat) : 0;
                    return bDist - aDist || a.x - b.x || a.y - b.y;
                });
                chosen = { tank, anchor: spots[0] };
                break;
            }
            if (chosen) break;
        }
        if (!chosen) return;
        if (r2Commit(board, new Map([[flyer.getId(), chosen.anchor]]))) {
            usedTanks.add(chosen.tank.getId());
            placed.push(flyer);
        }
    });
};

const r2ShooterFlyers = (
    board: IBoard,
    context: IPlacementContext,
    flyers: readonly Unit[],
    lane: ReadonlySet<number>,
    bowLats: ReadonlySet<number>,
    filePierce: boolean,
): void => {
    const ranks = r2Ranks(board);
    const tank = r2FrontTanks(board)
        .filter((unit) => !board.laterals(unit).some((lat) => bowLats.has(lat)))
        .sort((a, b) => b.getArmor() - a.getArmor() || byId(a, b))[0];
    if (!tank) return;
    const tankLats = new Set(board.laterals(tank));
    const corners = r2BackCorners(board, context);
    const placed: Unit[] = [];
    for (const flyer of [...flyers].sort(byId)) {
        const frontLats = r2FrontLaterals(board, new Set([flyer.getId()]));
        const occupied = takenCells(board, new Set([flyer.getId()]));
        const spots = r2Anchors(flyer, board, occupied, (span) => {
            if (!r2FlyerRank(span, ranks, true)) return false;
            if (span.laterals.some((lat) => tankLats.has(lat) || bowLats.has(lat) || lane.has(lat))) return false;
            if (filePierce && span.laterals.some((lat) => frontLats.has(lat))) return false;
            if (span.cells.some((cell) => corners.has(keyOf(cell)))) return false;
            const beside = span.laterals.some((lat) => [...tankLats].some((tankLat) => Math.abs(lat - tankLat) === 1));
            if (!beside) return false;
            return placed.every((other) => minChebyshev(span.cells, board.footprint(other)) > 1);
        });
        spots.sort((a, b) => a.x - b.x || a.y - b.y);
        const spot = spots[0];
        if (!spot) continue;
        if (r2Commit(board, new Map([[flyer.getId(), spot]]))) placed.push(flyer);
    }
};

const r2ShiftFlyers = (
    board: IBoard,
    flyers: readonly Unit[],
    lane: ReadonlySet<number>,
    bowLats: ReadonlySet<number>,
): void => {
    const limits = zoneLimits(board.geom);
    for (const flyer of [...flyers].sort(byId)) {
        const shares = board.units.some(
            (unit) =>
                unit.getId() !== flyer.getId() &&
                !unit.canFly() &&
                board.laterals(unit).some((lat) => board.laterals(flyer).includes(lat)),
        );
        if (!shares) continue;
        const anchor = board.cells.get(flyer.getId());
        if (!anchor) continue;
        const median = medianLat(flyer, board);
        const towardHigh = Math.abs(limits.maxLat - median) < Math.abs(median - limits.minLat);
        const shifted = board.geom.shiftLateral(anchor, towardHigh ? 1 : -1);
        const span = spanAt(flyer, shifted, board.geom);
        if (!span || !spanIsLegal(span, board.geom, takenCells(board, new Set([flyer.getId()])))) continue;
        if (span.laterals.some((lat) => bowLats.has(lat) || lane.has(lat))) continue;
        r2Commit(board, new Map([[flyer.getId(), shifted]]));
    }
};

/**
 * r2c2 post-pass. Today's placeArmy has already run. File pierce is Fire Breath or Skewer Strike.
 * The fastest charger takes an empty back file, the other ground packs into one centred block, and
 * non-ranged flyers step off the pierced files. Area Throw and Large Caliber leave the map alone.
 */
export function placeArmyR2C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const filePierce = threats.fireBreath || threats.skewerStrike;
    const enemyFlyers = threats.flyers > 0;
    const enemyRanged = threats.rangeCreatures > 0;
    const locked = r2Locked(board);
    const ownRange = placedRange(units, board);
    const manyBows = ownRange.length >= 2;
    const bowLats = shooterLaterals(ownRange, board);
    const grounds = board.units.filter((unit) => r2Ground(unit, board, locked));
    const charger = r2FastestCharger(board, locked);
    let placed: IGroundPlan = { plan: new Map(), lane: new Set() };
    if (filePierce) {
        placed = r2PlanPierce(board, context, grounds, charger, bowLats);
    } else if (enemyFlyers && !manyBows) {
        placed = r2PlanCorners(board, grounds, charger, bowLats, true);
    } else if (enemyFlyers) {
        placed = r2PlanCorners(board, [], charger, bowLats, false);
    } else if (enemyRanged && !manyBows) {
        placed = r2PlanSponge(board, grounds, charger, bowLats, true);
    } else if (enemyRanged) {
        placed = r2PlanSponge(board, grounds, charger, bowLats, false);
    }
    r2Commit(board, placed.plan);
    const flyers = board.units.filter((unit) => r2Flyer(unit, board, locked));
    if (enemyFlyers) r2EscortFlyers(board, context, flyers, placed.lane, bowLats, filePierce);
    else if (enemyRanged) r2ShooterFlyers(board, context, flyers, placed.lane, bowLats, filePierce);
    else if (filePierce) r2ShiftFlyers(board, flyers, placed.lane, bowLats);
    return board.cells;
}

const r3HasAbility = (unit: Unit, needle: string): boolean => {
    if (unit.hasAbilityActive(needle) || unit.hasAbilityActive(`${needle} Aura`)) return true;
    return hasNamed(CATALOG.get(unit.getName())?.abilities, needle);
};

const r3SpellbookWard = (unit: Unit): boolean => isSpellbookUnit(unit) && !PROTECTORS.has(unit.getName());

const r3SupportBow = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE && (r3HasAbility(unit, "Guiding Winds") || r3HasAbility(unit, "Magic Shield"));

const r3SupportOrder = (unit: Unit): number => (unit.getName() === "Dryad" ? 0 : unit.getName() === "Monk" ? 1 : 2);

/** One-cell ground body. Pikeman (MELEE) and Troll (non-spellbook MELEE_MAGIC) both count. */
const r3Screen = (unit: Unit): boolean => {
    if (unit.canFly() || !unit.isSmallSize() || PROTECTORS.has(unit.getName()) || isSpellbookUnit(unit)) return false;
    const attack = unit.getAttackType();
    if (attack === MELEE) return true;
    return attack === MELEE_MAGIC && !isSpellbookUnit(unit);
};

const r3Cell = (board: IBoard, rank: number, lat: number): XY | undefined =>
    board.geom.baseCells.find((cell) => board.geom.frontness(cell) === rank && board.geom.lateral(cell) === lat);

const r3Legal = (footprint: readonly XY[], board: IBoard, taken: ReadonlySet<number>): boolean =>
    footprint.length > 0 &&
    footprint.every((cell) => board.geom.legal.has(keyOf(cell)) && !taken.has(keyOf(cell)) && !isBoardEdge(cell));

const r3Hits = (footprint: readonly XY[], keys: ReadonlySet<number>): boolean =>
    footprint.some((cell) => keys.has(keyOf(cell)));

const r3Depth = (footprint: readonly XY[], board: IBoard): number => {
    const fronts = footprint.map((cell) => board.geom.frontness(cell));
    return Math.max(...fronts) - Math.min(...fronts) + 1;
};

const r3Clump = (footprint: readonly XY[], board: IBoard): boolean => {
    const front = zoneLimits(board.geom).maxFront;
    return footprint.some(
        (cell) =>
            board.geom.frontness(cell) === front && Math.abs(board.geom.lateral(cell) - board.geom.centreLat) <= 1,
    );
};

const r3Gap = (footprint: readonly XY[], obstacles: readonly (readonly XY[])[], gap: number): boolean => {
    if (gap <= 0) return true;
    return obstacles.every((other) => !other.length || minChebyshev(footprint, other) >= gap);
};

const r3OnLat = (footprint: readonly XY[], lat: number, board: IBoard): boolean =>
    footprint.some((cell) => board.geom.lateral(cell) === lat);

const r3Choose = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    scoreOf: (footprint: readonly XY[], anchor: XY) => number | undefined,
): XY | undefined => {
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        const score = scoreOf(footprint, anchor);
        if (score === undefined || score > bestScore) continue;
        if (score === bestScore && best && (anchor.x > best.x || (anchor.x === best.x && anchor.y >= best.y))) {
            continue;
        }
        best = anchor;
        bestScore = score;
    }
    return best;
};

const r3AnchorOn = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    rank: number,
    lat: number,
    accept?: (footprint: readonly XY[]) => boolean,
): XY | undefined => {
    const cell = r3Cell(board, rank, lat);
    if (!cell) return undefined;
    return r3Choose(board, unit, taken, (footprint, anchor) => {
        if (!footprint.every((entry) => board.geom.frontness(entry) === rank)) return undefined;
        if (footprint.some((entry) => board.geom.lateral(entry) !== lat)) return undefined;
        if (!footprint.some((entry) => sameCell(entry, cell))) return undefined;
        if (accept && !accept(footprint)) return undefined;
        return (sameCell(anchor, cell) ? 0 : 10) + footprint.length;
    });
};

/** Mirrors the server back-corner reseat. Desired cells of ranged stacks do not matter. */
const r3ReseatCorners = (board: IBoard, units: readonly Unit[], corners: ReadonlySet<number>): Set<string> => {
    const ranged = units.filter((unit) => unit.getAttackType() === RANGE);
    const seated = new Set<string>();
    if (ranged.length < 2) return seated;
    const occupied = new Set<number>();
    for (const unit of units) {
        if (unit.getAttackType() === RANGE) continue;
        for (const cell of board.footprint(unit)) occupied.add(keyOf(cell));
    }
    const bases = [...board.geom.baseCells].sort(
        (a, b) => board.geom.frontness(a) - board.geom.frontness(b) || board.geom.edgeness(b) - board.geom.edgeness(a),
    );
    for (const unit of ranged) {
        const spot = bases.find((base) => r3Legal(footprintCellsForAnchor(unit, base), board, occupied));
        if (!spot) continue;
        const footprint = footprintCellsForAnchor(unit, spot);
        for (const cell of footprint) occupied.add(keyOf(cell));
        if (r3Hits(footprint, corners)) seated.add(unit.getId());
    }
    return seated;
};

const r3InsideProtector = (ward: Unit, board: IBoard): boolean => {
    const mine = board.footprint(ward);
    if (!mine.length) return false;
    return board.units.some((unit) => {
        if (unit.getId() === ward.getId() || !PROTECTORS.has(unit.getName())) return false;
        const cells = board.footprint(unit);
        return cells.length > 0 && minChebyshev(mine, cells) <= 2;
    });
};

const r3SelectWards = (board: IBoard, cornerLocked: ReadonlySet<string>): Unit[] => {
    const spell = board.units.filter((unit) => r3SpellbookWard(unit) && board.footprint(unit).length > 0).sort(byId);
    if (spell.length) return spell;
    return board.units
        .filter((unit) => r3SupportBow(unit) && board.footprint(unit).length > 0 && !cornerLocked.has(unit.getId()))
        .sort((a, b) => r3SupportOrder(a) - r3SupportOrder(b) || byId(a, b))
        .slice(0, 1);
};

const r3NearestScreen = (ward: Unit, screens: readonly Unit[], board: IBoard): Unit | undefined => {
    const mine = board.footprint(ward);
    const open = [...screens].sort((a, b) => {
        const left = board.footprint(a);
        const right = board.footprint(b);
        const distance = (footprint: readonly XY[]): number =>
            footprint.length ? minChebyshev(mine, footprint) : Infinity;
        return distance(left) - distance(right) || a.getName().localeCompare(b.getName()) || byId(a, b);
    });
    return open[0];
};

const r3CoversCornerBow = (screen: Unit, bows: readonly Unit[], board: IBoard): boolean => {
    const mine = board.footprint(screen);
    if (!mine.length) return false;
    return bows.some((bow) => {
        const cells = board.footprint(bow);
        return cells.length > 0 && minChebyshev(mine, cells) <= 1;
    });
};

interface IPlan {
    readonly assignment: Map<string, XY>;
    readonly taken: Set<number>;
    readonly obstacles: XY[][];
}

const r3Plan = (board: IBoard, fixed: ReadonlySet<string>): IPlan => {
    const taken = new Set<number>();
    const obstacles: XY[][] = [];
    for (const unit of board.units) {
        if (!fixed.has(unit.getId())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        obstacles.push(footprint);
        for (const cell of footprint) taken.add(keyOf(cell));
    }
    return { assignment: new Map(), taken, obstacles };
};

const r3Add = (plan: IPlan, unit: Unit, anchor: XY, board: IBoard): boolean => {
    const footprint = footprintCellsForAnchor(unit, anchor);
    if (!r3Legal(footprint, board, plan.taken)) return false;
    plan.assignment.set(unit.getId(), { x: anchor.x, y: anchor.y });
    plan.obstacles.push([...footprint]);
    for (const cell of footprint) plan.taken.add(keyOf(cell));
    return true;
};

const r3Hold = (plan: IPlan, footprint: readonly XY[]): void => {
    if (!footprint.length) return;
    plan.obstacles.push([...footprint]);
    for (const cell of footprint) plan.taken.add(keyOf(cell));
};

interface IResolve {
    readonly gap: number;
    readonly gapFrom?: readonly (readonly XY[])[];
    readonly preferBack: boolean;
    readonly avoidClump: boolean;
    readonly banLaterals?: ReadonlySet<number>;
    readonly spreadAll: boolean;
}

const r3Relocate = (board: IBoard, plan: IPlan, unit: Unit, options: IResolve): boolean => {
    const here = board.cells.get(unit.getId());
    const corners = backCornerKeys(board.geom);
    const gapFrom = options.gapFrom ?? plan.obstacles;
    const anchor = r3Choose(board, unit, plan.taken, (footprint) => {
        if (r3Hits(footprint, corners)) return undefined;
        if (options.avoidClump && r3Screen(unit) && r3Clump(footprint, board)) return undefined;
        if (options.banLaterals && footprint.some((cell) => options.banLaterals?.has(board.geom.lateral(cell)))) {
            return undefined;
        }
        if (!r3Gap(footprint, gapFrom, options.gap)) return undefined;
        const onBack = footprint.every((cell) => board.geom.frontness(cell) === board.geom.backFront);
        const backBias = options.preferBack
            ? onBack
                ? 0
                : 1000 + Math.min(...footprint.map((cell) => board.geom.frontness(cell)))
            : 0;
        const distance = here ? minChebyshev(footprint, [here]) : 0;
        return backBias + distance * 10;
    });
    if (!anchor) return false;
    return r3Add(plan, unit, anchor, board);
};

const r3Resolve = (board: IBoard, plan: IPlan, fixed: ReadonlySet<string>, options: IResolve): boolean => {
    const pending = board.units
        .filter(
            (unit) => !fixed.has(unit.getId()) && !plan.assignment.has(unit.getId()) && board.footprint(unit).length,
        )
        .sort(byId);
    const gapFrom = options.gapFrom ?? plan.obstacles;
    const hard: Unit[] = [];
    const soft: Unit[] = [];
    const stay: Unit[] = [];
    for (const unit of pending) {
        const footprint = board.footprint(unit);
        const banned =
            !!options.banLaterals && footprint.some((cell) => options.banLaterals?.has(board.geom.lateral(cell)));
        const hits = footprint.some((cell) => plan.taken.has(keyOf(cell)));
        const closeToPlan = !r3Gap(footprint, gapFrom, options.gap);
        const closeToPeer =
            options.spreadAll &&
            options.gap > 0 &&
            pending.some((other) => {
                if (other.getId() === unit.getId()) return false;
                const cells = board.footprint(other);
                return cells.length > 0 && minChebyshev(footprint, cells) < options.gap;
            });
        if (hits || banned) hard.push(unit);
        else if (closeToPlan || closeToPeer) soft.push(unit);
        else stay.push(unit);
    }
    for (const unit of stay) r3Hold(plan, board.footprint(unit));
    for (const unit of hard) {
        if (!r3Relocate(board, plan, unit, options)) return false;
    }
    for (const unit of soft) {
        if (r3Relocate(board, plan, unit, options)) continue;
        if (board.footprint(unit).some((cell) => plan.taken.has(keyOf(cell)))) return false;
        r3Hold(plan, board.footprint(unit));
    }
    return true;
};

const r3Commit = (board: IBoard, plan: IPlan): boolean =>
    plan.assignment.size === 0 || commitAssignments(board, plan.assignment, false);

const r3CornerLaterals = (board: IBoard, cornerIds: ReadonlySet<string>): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        if (!cornerIds.has(unit.getId())) continue;
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const r3BowForward = (board: IBoard, cornerIds: ReadonlySet<string>): Set<number> => {
    const keys = new Set<number>();
    for (const unit of board.units) {
        if (!cornerIds.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) keys.add(keyOf(board.geom.towardEnemy(cell, 1)));
    }
    return keys;
};

const r3BranchOf = (
    threats: IPublicPlacementThreats,
): "splash" | "breath" | "through" | "flyers" | "shooters" | undefined => {
    if (threats.areaThrow || threats.largeCaliber) return "splash";
    if (threats.fireBreath) return "breath";
    if (threats.throughShot) return "through";
    if (threats.flyers >= 2) return "flyers";
    if (threats.rangeCreatures >= 2 && threats.flyers < 2) return "shooters";
    return undefined;
};

const r3PlaceSplashPair = (
    board: IBoard,
    ward: Unit,
    screen: Unit | undefined,
    spare: Unit | undefined,
    fixed: ReadonlySet<string>,
    side: LateralHalf,
): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const centre = board.geom.centreLat;
    const dir = side === "low" ? 1 : -1;
    const laterals = lateralsNearestCentre(board).filter((lat) => {
        const cell = r3Cell(board, ranks.back, lat);
        return !!cell && !corners.has(keyOf(cell)) && halfOf(lat, centre) === side;
    });
    for (const lat of laterals) {
        const screenLat = lat + dir * 3;
        const spareLat = lat - dir * 3;
        if (halfOf(screenLat, centre) === side) continue;
        if (Math.abs(screenLat - centre) <= 1) continue;
        const plan = r3Plan(board, fixed);
        const wardAnchor = r3AnchorOn(
            ward,
            board,
            plan.taken,
            ranks.back,
            lat,
            (footprint) => !r3Hits(footprint, corners),
        );
        if (!wardAnchor) continue;
        const wardFootprint = footprintCellsForAnchor(ward, wardAnchor);
        if (!r3Gap(wardFootprint, plan.obstacles, 3) || !r3Add(plan, ward, wardAnchor, board)) continue;
        if (screen) {
            const screenAnchor = r3AnchorOn(
                screen,
                board,
                plan.taken,
                ranks.front,
                screenLat,
                (footprint) => !r3Clump(footprint, board),
            );
            if (!screenAnchor) continue;
            const screenFootprint = footprintCellsForAnchor(screen, screenAnchor);
            if (!r3Gap(screenFootprint, plan.obstacles, 3) || !r3Add(plan, screen, screenAnchor, board)) continue;
        }
        if (spare && r3Cell(board, ranks.front, spareLat) && Math.abs(spareLat - centre) > 1) {
            const spareAnchor = r3AnchorOn(
                spare,
                board,
                plan.taken,
                ranks.front,
                spareLat,
                (footprint) => !r3Clump(footprint, board),
            );
            if (spareAnchor && r3Gap(footprintCellsForAnchor(spare, spareAnchor), plan.obstacles, 3)) {
                r3Add(plan, spare, spareAnchor, board);
            }
        }
        if (
            !r3Resolve(board, plan, fixed, {
                gap: 3,
                preferBack: true,
                avoidClump: true,
                spreadAll: true,
            })
        ) {
            continue;
        }
        if (r3Commit(board, plan)) return true;
    }
    return false;
};

const r3Splash = (
    board: IBoard,
    wards: readonly Unit[],
    screens: readonly Unit[],
    fixed: ReadonlySet<string>,
): void => {
    const open = screens.filter((screen) => !fixed.has(screen.getId()));
    const used = new Set<string>();
    let spareBudget = Math.max(0, open.length - wards.length);
    let previous: LateralHalf | undefined;
    for (const ward of wards) {
        const screen = r3NearestScreen(
            ward,
            open.filter((candidate) => !used.has(candidate.getId())),
            board,
        );
        const spare =
            spareBudget > 0
                ? r3NearestScreen(
                      ward,
                      open.filter((candidate) => !used.has(candidate.getId()) && candidate.getId() !== screen?.getId()),
                      board,
                  )
                : undefined;
        const centreLat = lateralsNearestCentre(board).find((lat) => {
            const cell = r3Cell(board, board.geom.backFront, lat);
            return !!cell && !backCornerKeys(board.geom).has(keyOf(cell));
        });
        const centreHalf = halfOf(centreLat ?? board.geom.centreLat, board.geom.centreLat);
        const order = previous ? [otherHalf(previous)] : [centreHalf, otherHalf(centreHalf)];
        let placed = false;
        for (const side of order) {
            if (!r3PlaceSplashPair(board, ward, screen, spare, fixed, side)) continue;
            if (screen) used.add(screen.getId());
            if (spare) {
                used.add(spare.getId());
                spareBudget -= 1;
            }
            previous = side;
            placed = true;
            break;
        }
        if (!placed) continue;
    }
};

const r3FileBetween = (board: IBoard, lat: number): XY[] => {
    const back = board.geom.backFront;
    const front = zoneLimits(board.geom).maxFront;
    return board.geom.baseCells.filter(
        (cell) =>
            board.geom.lateral(cell) === lat && board.geom.frontness(cell) > back && board.geom.frontness(cell) < front,
    );
};

const r3PlaceBreath = (board: IBoard, ward: Unit, screen: Unit, fixed: ReadonlySet<string>, lat: number): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const plan = r3Plan(board, fixed);
    const wardAnchor = r3AnchorOn(
        ward,
        board,
        plan.taken,
        ranks.back,
        lat,
        (footprint) => r3Depth(footprint, board) === 1 && !r3Hits(footprint, corners),
    );
    if (!wardAnchor || !r3Add(plan, ward, wardAnchor, board)) return false;
    const screenAnchor = r3AnchorOn(
        screen,
        board,
        plan.taken,
        ranks.front,
        lat,
        (footprint) => r3Depth(footprint, board) === 1,
    );
    if (!screenAnchor || !r3Add(plan, screen, screenAnchor, board)) return false;
    for (const cell of r3FileBetween(board, lat)) plan.taken.add(keyOf(cell));
    if (
        !r3Resolve(board, plan, fixed, {
            gap: 0,
            preferBack: false,
            avoidClump: true,
            banLaterals: new Set([lat]),
            spreadAll: false,
        })
    ) {
        return false;
    }
    return r3Commit(board, plan);
};

const r3Breath = (
    board: IBoard,
    wards: readonly Unit[],
    screens: readonly Unit[],
    fixed: ReadonlySet<string>,
): void => {
    const used = new Set<string>();
    const bowLaterals = new Set<number>();
    const wardIds = new Set(wards.map((ward) => ward.getId()));
    for (const unit of board.units) {
        if (unit.getAttackType() !== RANGE || wardIds.has(unit.getId())) continue;
        for (const lat of board.laterals(unit)) bowLaterals.add(lat);
    }
    for (const ward of wards) {
        const screen = r3NearestScreen(
            ward,
            screens.filter((candidate) => !used.has(candidate.getId()) && !fixed.has(candidate.getId())),
            board,
        );
        if (!screen) continue;
        for (const lat of lateralsNearestCentre(board)) {
            if (bowLaterals.has(lat)) continue;
            if (fixedHasLat(board, fixed, lat)) continue;
            if (!r3PlaceBreath(board, ward, screen, fixed, lat)) continue;
            used.add(screen.getId());
            bowLaterals.add(lat);
            break;
        }
    }
};

const fixedHasLat = (board: IBoard, fixed: ReadonlySet<string>, lat: number): boolean =>
    board.units.some((unit) => fixed.has(unit.getId()) && board.laterals(unit).includes(lat));

const r3PlaceAlone = (board: IBoard, ward: Unit, fixed: ReadonlySet<string>, lat: number): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const plan = r3Plan(board, fixed);
    const wardAnchor = r3AnchorOn(
        ward,
        board,
        plan.taken,
        ranks.back,
        lat,
        (footprint) => r3Depth(footprint, board) === 1 && !r3Hits(footprint, corners),
    );
    if (!wardAnchor || !r3Add(plan, ward, wardAnchor, board)) return false;
    if (
        !r3Resolve(board, plan, fixed, {
            gap: 0,
            preferBack: false,
            avoidClump: true,
            banLaterals: new Set([lat]),
            spreadAll: false,
        })
    ) {
        return false;
    }
    const wardFootprint = footprintCellsForAnchor(ward, wardAnchor);
    const intruder = board.units.some((unit) => {
        if (unit.getId() === ward.getId() || plan.assignment.has(unit.getId())) return false;
        if (fixed.has(unit.getId())) return r3OnLat(board.footprint(unit), lat, board);
        return false;
    });
    if (intruder || r3OnLat(wardFootprint, lat, board) === false) return false;
    return r3Commit(board, plan);
};

const r3Through = (board: IBoard, wards: readonly Unit[], fixed: ReadonlySet<string>): void => {
    const used = new Set<number>();
    for (const ward of wards) {
        for (const lat of lateralsNearestCentre(board)) {
            if (used.has(lat) || fixedHasLat(board, fixed, lat)) continue;
            if (!r3PlaceAlone(board, ward, fixed, lat)) continue;
            used.add(lat);
            break;
        }
    }
};

const r3PlaceFlyer = (board: IBoard, ward: Unit, screen: Unit, fixed: ReadonlySet<string>, lat: number): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const forwardRank = ranks.back + 1;
    const plan = r3Plan(board, fixed);
    const wardAnchor = r3AnchorOn(
        ward,
        board,
        plan.taken,
        ranks.back,
        lat,
        (footprint) => r3Depth(footprint, board) === 1 && !r3Hits(footprint, corners),
    );
    if (!wardAnchor) return false;
    const wardFootprint = footprintCellsForAnchor(ward, wardAnchor);
    if (!r3Gap(wardFootprint, plan.obstacles, 3) || !r3Add(plan, ward, wardAnchor, board)) return false;
    const screenAnchor = r3AnchorOn(
        screen,
        board,
        plan.taken,
        forwardRank,
        lat,
        (footprint) => r3Depth(footprint, board) === 1 && !r3Hits(footprint, corners),
    );
    if (!screenAnchor || !r3Add(plan, screen, screenAnchor, board)) return false;
    if (
        !r3Resolve(board, plan, fixed, {
            gap: 3,
            gapFrom: [wardFootprint],
            preferBack: true,
            avoidClump: true,
            spreadAll: false,
        })
    ) {
        return false;
    }
    return r3Commit(board, plan);
};

const r3Flyers = (
    board: IBoard,
    wards: readonly Unit[],
    screens: readonly Unit[],
    fixed: ReadonlySet<string>,
    cornerIds: ReadonlySet<string>,
): void => {
    const used = new Set<string>();
    const takenLaterals = r3CornerLaterals(board, cornerIds);
    const corners = backCornerKeys(board.geom);
    for (const ward of wards) {
        const screen = r3NearestScreen(
            ward,
            screens.filter((candidate) => !used.has(candidate.getId()) && !fixed.has(candidate.getId())),
            board,
        );
        if (!screen) continue;
        for (const lat of lateralsNearestCentre(board)) {
            const back = r3Cell(board, board.geom.backFront, lat);
            if (!back || corners.has(keyOf(back)) || takenLaterals.has(lat)) continue;
            if (!r3PlaceFlyer(board, ward, screen, fixed, lat)) continue;
            used.add(screen.getId());
            takenLaterals.add(lat);
            break;
        }
    }
};

const r3BlastGap = (threats: IPublicPlacementThreats): number => {
    if (threats.meteorShower) return 3;
    if (threats.fireball || threats.ringOfFire) return 2;
    return 0;
};

const r3PlaceShooter = (
    board: IBoard,
    ward: Unit,
    screen: Unit,
    fixed: ReadonlySet<string>,
    lat: number,
    blast: number,
    forwardKeys: ReadonlySet<number>,
    bows: readonly Unit[],
): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const plan = r3Plan(board, fixed);
    const wardAnchor = r3AnchorOn(
        ward,
        board,
        plan.taken,
        ranks.back,
        lat,
        (footprint) => r3Depth(footprint, board) === 1 && !r3Hits(footprint, corners),
    );
    if (!wardAnchor) return false;
    const wardFootprint = footprintCellsForAnchor(ward, wardAnchor);
    if (bows.some((bow) => minChebyshev(wardFootprint, board.footprint(bow)) <= 1)) return false;
    if (!r3Add(plan, ward, wardAnchor, board)) return false;
    const screenRank = blast > 0 ? ranks.back + 1 : ranks.back + 1;
    const offsets = blast > 0 ? [blast, -blast] : [0];
    const ordered = [...offsets].sort((a, b) => {
        const aEdge = Math.abs(lat + a - board.geom.centreLat);
        const bEdge = Math.abs(lat + b - board.geom.centreLat);
        return aEdge - bEdge || a - b;
    });
    let screenAnchor: XY | undefined;
    for (const offset of ordered) {
        const screenLat = lat + offset;
        const anchor = r3AnchorOn(screen, board, plan.taken, screenRank, screenLat, (footprint) => {
            if (r3Hits(footprint, forwardKeys) || r3Hits(footprint, corners)) return false;
            const gap = minChebyshev(footprint, wardFootprint);
            if (blast > 0) return gap === blast && footprint.every((cell) => board.geom.lateral(cell) !== lat);
            return gap === 1 && footprint.every((cell) => board.geom.lateral(cell) === lat);
        });
        if (anchor) {
            screenAnchor = anchor;
            break;
        }
    }
    if (!screenAnchor || !r3Add(plan, screen, screenAnchor, board)) return false;
    if (
        !r3Resolve(board, plan, fixed, {
            gap: 0,
            preferBack: false,
            avoidClump: false,
            spreadAll: false,
        })
    ) {
        return false;
    }
    return r3Commit(board, plan);
};

const r3Shooters = (
    board: IBoard,
    wards: readonly Unit[],
    screens: readonly Unit[],
    fixed: Set<string>,
    cornerIds: ReadonlySet<string>,
    threats: IPublicPlacementThreats,
): void => {
    const bows = board.units.filter((unit) => cornerIds.has(unit.getId()));
    const covering = screens.filter((screen) => r3CoversCornerBow(screen, bows, board) && !fixed.has(screen.getId()));
    const free = screens.filter(
        (screen) => !fixed.has(screen.getId()) && !covering.some((cover) => cover.getId() === screen.getId()),
    );
    const reserved = new Set<string>();
    if (!free.length) {
        for (const ward of wards) {
            const keeper = r3NearestScreen(ward, covering, board);
            if (keeper) reserved.add(keeper.getId());
        }
    }
    for (const screen of covering) {
        if (!reserved.has(screen.getId())) fixed.add(screen.getId());
    }
    const blast = r3BlastGap(threats);
    const forwardKeys = r3BowForward(board, cornerIds);
    const banned = r3CornerLaterals(board, cornerIds);
    const used = new Set<string>();
    for (const ward of wards) {
        const screen = r3NearestScreen(
            ward,
            screens.filter((candidate) => !used.has(candidate.getId()) && !fixed.has(candidate.getId())),
            board,
        );
        if (!screen) continue;
        const preferFree =
            free.some((candidate) => candidate.getId() === screen.getId()) || !r3CoversCornerBow(screen, bows, board);
        if (!preferFree && free.length) continue;
        for (const lat of lateralsNearestCentre(board)) {
            const back = r3Cell(board, board.geom.backFront, lat);
            if (!back || backCornerKeys(board.geom).has(keyOf(back)) || banned.has(lat)) continue;
            if (!r3PlaceShooter(board, ward, screen, fixed, lat, blast, forwardKeys, bows)) continue;
            used.add(screen.getId());
            banned.add(lat);
            break;
        }
    }
};

const r3MovedToCorner = (
    board: IBoard,
    units: readonly Unit[],
    before: ReadonlyMap<string, XY>,
    wards: readonly Unit[],
    corners: ReadonlySet<number>,
): boolean => {
    const moved = wards.filter((ward) => {
        if (ward.getAttackType() !== RANGE) return false;
        const prior = before.get(ward.getId());
        const next = board.cells.get(ward.getId());
        return !!prior && !!next && !sameCell(prior, next);
    });
    if (!moved.length) return false;
    const seated = r3ReseatCorners(board, units, corners);
    return moved.some((ward) => seated.has(ward.getId()));
};

/**
 * r2c3 post-pass. Today's placeArmy has already run. An uncovered ward and its screen stand
 * where the public threat misses. Corner bows and named protectors stay. A ranged support bow
 * this pass moves is not one the server corner reseat assigns to a back corner.
 */
export function placeArmyR2C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const branch = r3BranchOf(threats);
    if (!branch) return new Map(board.cells);
    const corners = backCornerKeys(geom);
    const positionCorners = cornerBowIds(board);
    const reseatCorners = r3ReseatCorners(board, units, corners);
    const cornerLocked = new Set<string>([...positionCorners, ...reseatCorners]);
    const wards = r3SelectWards(board, cornerLocked);
    if (!wards.length) return new Map(board.cells);
    const fixed = new Set<string>(cornerLocked);
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (PROTECTORS.has(unit.getName())) fixed.add(unit.getId());
        if (unit.getAttackType() !== RANGE && r3Hits(board.footprint(unit), corners)) fixed.add(unit.getId());
    }
    const covered = new Set(wards.filter((ward) => r3InsideProtector(ward, board)).map((ward) => ward.getId()));
    const screens = board.units.filter((unit) => r3Screen(unit) && board.footprint(unit).length > 0);
    for (const ward of wards) {
        if (!covered.has(ward.getId())) continue;
        fixed.add(ward.getId());
        const screen = r3NearestScreen(ward, screens, board);
        const mine = board.footprint(ward);
        if (screen && minChebyshev(mine, board.footprint(screen)) <= 1) fixed.add(screen.getId());
    }
    const openWards = wards.filter((ward) => !fixed.has(ward.getId()));
    if (!openWards.length) return new Map(board.cells);
    if (branch === "flyers" && !openWards.some((ward) => r3SpellbookWard(ward) || r3SupportBow(ward))) {
        return new Map(board.cells);
    }
    const before = copyCells(board);
    const openScreens = screens.filter((screen) => !fixed.has(screen.getId()));
    if (branch === "splash") r3Splash(board, openWards, openScreens, fixed);
    else if (branch === "breath") r3Breath(board, openWards, openScreens, fixed);
    else if (branch === "through") r3Through(board, openWards, fixed);
    else if (branch === "flyers") r3Flyers(board, openWards, openScreens, fixed, positionCorners);
    else r3Shooters(board, openWards, screens, fixed, positionCorners, threats);
    if (r3MovedToCorner(board, units, before, openWards, corners)) restoreCells(board, before);
    return board.cells;
}

const c31Sniper = (unit: Unit): boolean => unit.hasAbilityActive("Sniper");

/** Sniper ability is already complete. Its floored catalog distance is not the far-corner overwrite. */
const c31Reach = (unit: Unit): number => (c31Sniper(unit) ? Number.POSITIVE_INFINITY : bowReach(unit));

const c31DamageMean = (unit: Unit): number => {
    const entry = CATALOG.get(unit.getName());
    if (entry && (entry.damageMin > 0 || entry.damageMax > 0)) return (entry.damageMin + entry.damageMax) / 2;
    return (unit.getAttackDamageMin() + unit.getAttackDamageMax()) / 2;
};

const c31EnemyHasSpell = (creatureIds: readonly number[] | undefined): boolean => {
    if (!creatureIds?.length) return false;
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        const spells = info ? CATALOG.get(info.name)?.spells : undefined;
        if (spells && spells.length > 0) return true;
    }
    return false;
};

const c31Screen = (unit: Unit): boolean =>
    !unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !PROTECTORS.has(unit.getName()) &&
    !isSpellbookUnit(unit) &&
    !isCasterUnit(unit);

const c31Fits = (unit: Unit, anchor: XY, geom: IGeom): XY[] | undefined => {
    const cells = footprintCellsForAnchor(unit, anchor);
    if (!cells.length || !cells.every((cell) => geom.legal.has(keyOf(cell)) && !isBoardEdge(cell))) return undefined;
    return cells;
};

const c31Laterals = (cells: readonly XY[], geom: IGeom): number[] => cells.map((cell) => geom.lateral(cell));

const c31HitsLat = (cells: readonly XY[], laterals: ReadonlySet<number>, geom: IGeom): boolean =>
    c31Laterals(cells, geom).some((lat) => laterals.has(lat));

const c31PlanFootprint = (board: IBoard, unit: Unit, moves: ReadonlyMap<string, XY>): XY[] => {
    const anchor = moves.get(unit.getId()) ?? board.cells.get(unit.getId());
    return anchor ? footprintCellsForAnchor(unit, anchor) : [];
};

/** Reflected enemy front rank. Straight distances on a side-oriented size-3 zone are 9 / 10 / 11. */
const c31EnemyFront = (geom: IGeom): XY[] => {
    const reflected = geom.baseCells.map((cell) => ({ x: GRID_SIZE - 1 - cell.x, y: GRID_SIZE - 1 - cell.y }));
    if (!reflected.length) return [];
    let nearest = Infinity;
    for (const cell of reflected) nearest = Math.min(nearest, geom.frontness(cell));
    return reflected.filter((cell) => geom.frontness(cell) === nearest);
};

const c31CoverDistance = (cell: XY, front: readonly XY[]): number => {
    if (!front.length) return Infinity;
    let worst = 0;
    for (const target of front) worst = Math.max(worst, chebyshev(cell, target));
    return worst;
};

const c31Complete = (cells: readonly XY[], reach: number, front: readonly XY[]): boolean =>
    cells.length > 0 && cells.every((cell) => c31CoverDistance(cell, front) <= reach);

const c31OnBack = (cells: readonly XY[], geom: IGeom): boolean =>
    cells.some((cell) => geom.frontness(cell) === geom.backFront);

const c31CornerCells = (cells: readonly XY[], corners: ReadonlySet<number>, geom: IGeom): XY[] =>
    cells
        .filter((cell) => corners.has(keyOf(cell)))
        .sort(
            (a, b) =>
                geom.edgeness(b) - geom.edgeness(a) || geom.lateral(a) - geom.lateral(b) || a.x - b.x || a.y - b.y,
        );

const c31ByReach = (a: Unit, b: Unit): number => {
    const aSniper = c31Sniper(a) ? 1 : 0;
    const bSniper = c31Sniper(b) ? 1 : 0;
    return bSniper - aSniper || bowReach(b) - bowReach(a) || byId(a, b);
};

const c31CommitMoves = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    if (!moves.size) return false;
    const occupied = takenCells(board, new Set(moves.keys()));
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const cells = unit ? c31Fits(unit, anchor, board.geom) : undefined;
        if (!unit || !cells) return false;
        for (const cell of cells) {
            const key = keyOf(cell);
            if (occupied.has(key)) return false;
            occupied.add(key);
        }
    }
    for (const [id, anchor] of moves) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const c31Blocked = (board: IBoard, ignore: ReadonlySet<string>, reserved: ReadonlySet<number>): Set<number> => {
    const blocked = takenCells(board, ignore);
    for (const key of reserved) blocked.add(key);
    return blocked;
};

const c31NearestAnchor = (
    board: IBoard,
    unit: Unit,
    blocked: ReadonlySet<number>,
    corners: ReadonlySet<number>,
    accept: (cells: readonly XY[]) => boolean,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const cells = c31Fits(unit, anchor, board.geom);
        if (!cells || !accept(cells)) continue;
        if (cells.some((cell) => corners.has(keyOf(cell)) || blocked.has(keyOf(cell)))) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => {
        const aDist = current ? chebyshev(a, current) : 0;
        const bDist = current ? chebyshev(b, current) : 0;
        return aDist - bDist || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const c31WideAnchors = (board: IBoard, wide: Unit, front: readonly XY[], corners: ReadonlySet<number>): XY[] => {
    const reach = c31Reach(wide);
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const cells = c31Fits(wide, anchor, board.geom);
        if (!cells || !c31OnBack(cells, board.geom) || !c31Complete(cells, reach, front)) continue;
        if (cells.some((cell) => corners.has(keyOf(cell)))) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => {
        const aLat = medianNumber(c31Laterals(footprintCellsForAnchor(wide, a), board.geom));
        const bLat = medianNumber(c31Laterals(footprintCellsForAnchor(wide, b), board.geom));
        return Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat) || a.x - b.x || a.y - b.y;
    });
    return spots;
};

const c31ClearLaterals = (
    board: IBoard,
    moves: Map<string, XY>,
    laterals: ReadonlySet<number>,
    corners: ReadonlySet<number>,
    locked: ReadonlySet<string>,
): boolean => {
    const sharers = board.units.filter((unit) => {
        if (moves.has(unit.getId())) return false;
        const cells = c31PlanFootprint(board, unit, moves);
        return cells.length > 0 && c31HitsLat(cells, laterals, board.geom);
    });
    const reserved = new Set<number>();
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit) return false;
        for (const cell of footprintCellsForAnchor(unit, anchor)) reserved.add(keyOf(cell));
    }
    const ignore = new Set<string>(moves.keys());
    for (const sharer of sharers.sort(byId)) {
        if (locked.has(sharer.getId()) || c31Sniper(sharer)) return false;
        const spot = c31NearestAnchor(
            board,
            sharer,
            c31Blocked(board, ignore, reserved),
            corners,
            (cells) => !c31HitsLat(cells, laterals, board.geom),
        );
        if (!spot) return false;
        moves.set(sharer.getId(), spot);
        ignore.add(sharer.getId());
        for (const cell of footprintCellsForAnchor(sharer, spot)) reserved.add(keyOf(cell));
    }
    return true;
};

const c31SeatScreens = (
    board: IBoard,
    moves: Map<string, XY>,
    bowCells: readonly XY[],
    diagonal: XY,
    corners: ReadonlySet<number>,
    forbidden: ReadonlySet<number> | undefined,
    locked: ReadonlySet<string>,
): boolean => {
    const adjacent = (unit: Unit): boolean => {
        const cells = c31PlanFootprint(board, unit, moves);
        return cells.length > 0 && minChebyshev(cells, bowCells) <= 1;
    };
    const onDiagonal = (unit: Unit): boolean =>
        c31PlanFootprint(board, unit, moves).some((cell) => sameCell(cell, diagonal));
    const screens = board.units
        .filter((unit) => c31Screen(unit) && adjacent(unit))
        .sort((a, b) => {
            const aOn = onDiagonal(a) ? 0 : 1;
            const bOn = onDiagonal(b) ? 0 : 1;
            const aDist = chebyshev(board.cells.get(a.getId()) ?? diagonal, diagonal);
            const bDist = chebyshev(board.cells.get(b.getId()) ?? diagonal, diagonal);
            return aOn - bOn || aDist - bDist || byId(a, b);
        });
    if (!screens.length) return true;
    const reserved = new Set<number>();
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit || unit.getId() === screens[0].getId()) continue;
        for (const cell of footprintCellsForAnchor(unit, anchor)) reserved.add(keyOf(cell));
    }
    const ignore = new Set<string>(moves.keys());
    const primary = screens[0];
    if (!onDiagonal(primary)) {
        if (locked.has(primary.getId()) || c31Sniper(primary)) return false;
        ignore.delete(primary.getId());
        const spot = c31NearestAnchor(board, primary, c31Blocked(board, ignore, reserved), corners, (cells) => {
            if (!cells.some((cell) => sameCell(cell, diagonal))) return false;
            return !forbidden || !c31HitsLat(cells, forbidden, board.geom);
        });
        if (!spot) return false;
        moves.set(primary.getId(), spot);
        for (const cell of footprintCellsForAnchor(primary, spot)) reserved.add(keyOf(cell));
    }
    ignore.add(primary.getId());
    for (const screen of screens.slice(1)) {
        if (!adjacent(screen) || onDiagonal(screen)) continue;
        if (locked.has(screen.getId()) || c31Sniper(screen)) return false;
        ignore.delete(screen.getId());
        const spot = c31NearestAnchor(board, screen, c31Blocked(board, ignore, reserved), corners, (cells) => {
            if (minChebyshev(cells, bowCells) <= 1) return false;
            return !forbidden || !c31HitsLat(cells, forbidden, board.geom);
        });
        if (!spot) return false;
        moves.set(screen.getId(), spot);
        ignore.add(screen.getId());
        for (const cell of footprintCellsForAnchor(screen, spot)) reserved.add(keyOf(cell));
    }
    return screens.every((screen) => !adjacent(screen) || onDiagonal(screen));
};

const c31TryWide = (
    board: IBoard,
    wide: Unit,
    threats: IPublicPlacementThreats,
    front: readonly XY[],
    locked: Set<string>,
): boolean => {
    const corners = backCornerKeys(board.geom);
    const wideCells = board.footprint(wide);
    const corner = c31CornerCells(wideCells, corners, board.geom)[0];
    if (!corner || new Set(c31Laterals(wideCells, board.geom)).size < 2) return false;
    const bows = placedRange(board.units, board)
        .filter((unit) => unit.getId() !== wide.getId() && !locked.has(unit.getId()) && unit.isSmallSize())
        .sort(c31ByReach);
    const bow = bows[0];
    if (!bow || (!c31Sniper(bow) && bowReach(bow) < bowReach(wide))) return false;
    const anchor = c31WideAnchors(board, wide, front, corners)[0];
    const seat = c31Fits(bow, corner, board.geom);
    if (!anchor || !seat) return false;
    const nextWide = footprintCellsForAnchor(wide, anchor);
    if (minChebyshev(nextWide, seat) === 0) return false;
    if (seat.some((cell) => takenCells(board, new Set([wide.getId(), bow.getId()])).has(keyOf(cell)))) return false;
    const wideLats = new Set(c31Laterals(nextWide, board.geom));
    if (threats.lineAttack && c31HitsLat(seat, wideLats, board.geom)) return false;
    const moves = new Map<string, XY>([
        [wide.getId(), anchor],
        [bow.getId(), { x: corner.x, y: corner.y }],
    ]);
    if (threats.lineAttack && !c31ClearLaterals(board, moves, wideLats, corners, locked)) return false;
    if (
        threats.rangeCreatures >= 2 &&
        !threats.throughShot &&
        !c31SeatScreens(
            board,
            moves,
            seat,
            board.geom.towardEnemy(board.geom.shiftLateral(corner, board.geom.inwardDelta(corner)), 1),
            corners,
            threats.lineAttack ? wideLats : undefined,
            locked,
        )
    ) {
        return false;
    }
    if (threats.flyers >= 2) {
        const beside = board.geom.shiftLateral(corner, board.geom.inwardDelta(corner));
        const occupied = board.units.some((unit) =>
            c31PlanFootprint(board, unit, moves).some((cell) => sameCell(cell, beside)),
        );
        if (!occupied || !c31OnBack(nextWide, board.geom) || !c31OnBack(seat, board.geom)) return false;
    }
    if (threats.areaThrow || threats.largeCaliber) {
        const others = board.units
            .filter((unit) => unit.getId() !== wide.getId())
            .map((unit) => c31PlanFootprint(board, unit, moves))
            .filter((cells) => cells.length > 0);
        if (others.length > 0 && gapToOthers(nextWide, others) < 2) return false;
    }
    for (const [id, spot] of moves) {
        if (id === bow.getId()) continue;
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const cells = unit ? footprintCellsForAnchor(unit, spot) : [];
        if (cells.some((cell) => corners.has(keyOf(cell)))) return false;
    }
    if (!c31CommitMoves(board, moves)) return false;
    for (const id of moves.keys()) locked.add(id);
    return true;
};

const c31HandoffWide = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    front: readonly XY[],
    locked: Set<string>,
): void => {
    const corners = backCornerKeys(board.geom);
    const wides = placedRange(board.units, board)
        .filter((unit) => {
            const cells = board.footprint(unit);
            return (
                !c31Sniper(unit) &&
                !locked.has(unit.getId()) &&
                new Set(c31Laterals(cells, board.geom)).size >= 2 &&
                c31CornerCells(cells, corners, board.geom).length > 0
            );
        })
        .sort((a, b) => backEdgeness(b, board) - backEdgeness(a, board) || byId(a, b));
    for (const wide of wides) {
        if (locked.has(wide.getId())) continue;
        c31TryWide(board, wide, threats, front, locked);
    }
};

const c31BackCell = (board: IBoard, context: IPlacementContext, lat: number): XY =>
    cellAt(context, board.geom.backFront, lat);

const c31InZone = (geom: IGeom, cell: XY): boolean => geom.legal.has(keyOf(cell)) && !isBoardEdge(cell);

const c31OtherCorner = (corner: XY, geom: IGeom): XY | undefined => {
    const cells = [...backCornerKeys(geom)].map((key) => ({ x: key >> 4, y: key & 0xf }));
    return cells.find((cell) => !sameCell(cell, corner));
};

const c31InnerComplete = (
    board: IBoard,
    context: IPlacementContext,
    other: XY,
    reach: number,
    front: readonly XY[],
): XY | undefined => {
    const delta = board.geom.inwardDelta(other);
    if (delta === 0) return undefined;
    const limits = zoneLimits(board.geom);
    for (let lat = board.geom.lateral(other) + delta; lat >= limits.minLat && lat <= limits.maxLat; lat += delta) {
        const cell = c31BackCell(board, context, lat);
        if (!c31InZone(board.geom, cell)) continue;
        if (c31Complete([cell], reach, front)) return cell;
    }
    return undefined;
};

const c31CenterAnchor = (
    board: IBoard,
    unit: Unit,
    blocked: ReadonlySet<number>,
    corners: ReadonlySet<number>,
    diagonal: XY | undefined,
): XY | undefined => {
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const cells = c31Fits(unit, anchor, board.geom);
        if (!cells || !c31OnBack(cells, board.geom)) continue;
        if (cells.some((cell) => corners.has(keyOf(cell)) || blocked.has(keyOf(cell)))) continue;
        if (diagonal && cells.some((cell) => sameCell(cell, diagonal))) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => {
        const aLat = medianNumber(c31Laterals(footprintCellsForAnchor(unit, a), board.geom));
        const bLat = medianNumber(c31Laterals(footprintCellsForAnchor(unit, b), board.geom));
        return Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat) || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const c31Relocation = (
    board: IBoard,
    context: IPlacementContext,
    unit: Unit,
    other: XY | undefined,
    heavyReach: number,
    front: readonly XY[],
    blocked: ReadonlySet<number>,
    corners: ReadonlySet<number>,
    diagonal: XY | undefined,
): XY | undefined => {
    if (other) {
        const reach = unit.getAttackType() === RANGE && !c31Sniper(unit) ? c31Reach(unit) : heavyReach;
        const inner = c31InnerComplete(board, context, other, reach, front);
        if (inner && !corners.has(keyOf(inner)) && !(diagonal && sameCell(inner, diagonal))) {
            const cells = c31Fits(unit, inner, board.geom);
            if (
                cells &&
                !cells.some((cell) => blocked.has(keyOf(cell)) || corners.has(keyOf(cell))) &&
                !(diagonal && cells.some((cell) => sameCell(cell, diagonal)))
            ) {
                return inner;
            }
        }
    }
    return c31CenterAnchor(board, unit, blocked, corners, diagonal);
};

const c31GapsShrink = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    const placed = board.units.filter((unit) => board.footprint(unit).length > 0);
    for (let left = 0; left < placed.length; left += 1) {
        for (let right = left + 1; right < placed.length; right += 1) {
            const before = minChebyshev(board.footprint(placed[left]), board.footprint(placed[right]));
            const after = minChebyshev(
                c31PlanFootprint(board, placed[left], moves),
                c31PlanFootprint(board, placed[right], moves),
            );
            if (after < 2 && after < before) return true;
        }
    }
    return false;
};

const c31TryAura = (
    board: IBoard,
    context: IPlacementContext,
    carrier: Unit,
    threats: IPublicPlacementThreats,
    front: readonly XY[],
    locked: ReadonlySet<string>,
): Map<string, XY> | undefined => {
    const corners = backCornerKeys(board.geom);
    const corner = c31CornerCells(board.footprint(carrier), corners, board.geom)[0];
    if (!corner) return undefined;
    const heavy = placedRange(board.units, board)
        .filter(
            (unit) =>
                unit.getId() !== carrier.getId() &&
                !locked.has(unit.getId()) &&
                unit.isSmallSize() &&
                !c31Sniper(unit) &&
                c31DamageMean(unit) > c31DamageMean(carrier),
        )
        .sort((a, b) => c31DamageMean(b) - c31DamageMean(a) || byId(a, b))[0];
    if (!heavy || !c31Fits(heavy, corner, board.geom)) return undefined;
    const delta = board.geom.inwardDelta(corner);
    if (delta === 0) return undefined;
    const steps = threats.chakram ? 1 : 2;
    const dest = c31BackCell(board, context, board.geom.lateral(corner) + delta * steps);
    const between = threats.chakram ? undefined : c31BackCell(board, context, board.geom.lateral(corner) + delta);
    if (!c31InZone(board.geom, dest) || !c31Fits(carrier, dest, board.geom)) return undefined;
    if (between && !c31InZone(board.geom, between)) return undefined;
    const diagonal =
        threats.flyers >= 2 ? board.geom.towardEnemy(board.geom.shiftLateral(corner, delta), 1) : undefined;
    const moves = new Map<string, XY>([
        [heavy.getId(), { x: corner.x, y: corner.y }],
        [carrier.getId(), dest],
    ]);
    const reserved = new Set<number>([keyOf(corner), keyOf(dest)]);
    if (between) reserved.add(keyOf(between));
    if (diagonal) reserved.add(keyOf(diagonal));
    const except = new Set<string>([heavy.getId(), carrier.getId()]);
    const displaced = board.units.filter((unit) => {
        if (except.has(unit.getId())) return false;
        return board.footprint(unit).some((cell) => {
            if (sameCell(cell, dest)) return true;
            return !!between && sameCell(cell, between);
        });
    });
    const other = c31OtherCorner(corner, board.geom);
    const ignore = new Set<string>(except);
    for (const unit of displaced.sort(byId)) {
        if (locked.has(unit.getId()) || c31Sniper(unit)) return undefined;
        const spot = c31Relocation(
            board,
            context,
            unit,
            other,
            c31Reach(heavy),
            front,
            c31Blocked(board, ignore, reserved),
            corners,
            diagonal,
        );
        if (!spot) return undefined;
        moves.set(unit.getId(), spot);
        ignore.add(unit.getId());
        for (const cell of footprintCellsForAnchor(unit, spot)) reserved.add(keyOf(cell));
    }
    const carrierLats = new Set(c31Laterals(footprintCellsForAnchor(carrier, dest), board.geom));
    if (threats.lineAttack && !c31ClearLaterals(board, moves, carrierLats, corners, locked)) return undefined;
    if (threats.flyers >= 2) {
        if (!c31OnBack(footprintCellsForAnchor(heavy, corner), board.geom)) return undefined;
        if (!c31OnBack(footprintCellsForAnchor(carrier, dest), board.geom)) return undefined;
        if (
            diagonal &&
            [...moves.entries()].some(([id, spot]) => {
                const unit = board.units.find((candidate) => candidate.getId() === id);
                return !!unit && footprintCellsForAnchor(unit, spot).some((cell) => sameCell(cell, diagonal));
            })
        ) {
            return undefined;
        }
    }
    if (!threats.chakram && (threats.areaThrow || threats.largeCaliber) && c31GapsShrink(board, moves)) {
        return undefined;
    }
    if (between) {
        const covered = board.units.some((unit) =>
            c31PlanFootprint(board, unit, moves).some((cell) => sameCell(cell, between)),
        );
        if (covered) return undefined;
    }
    const heavyFoot = footprintCellsForAnchor(heavy, corner);
    const carrierFoot = footprintCellsForAnchor(carrier, dest);
    const gap = minChebyshev(heavyFoot, carrierFoot);
    if (threats.chakram ? gap !== 1 : gap !== 2) return undefined;
    if (c31HitsLat(carrierFoot, new Set(c31Laterals(heavyFoot, board.geom)), board.geom)) return undefined;
    for (const [id, spot] of moves) {
        if (id === heavy.getId()) continue;
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const cells = unit ? footprintCellsForAnchor(unit, spot) : [];
        if (cells.some((cell) => corners.has(keyOf(cell)))) return undefined;
    }
    return moves;
};

const c31HandoffAura = (
    board: IBoard,
    context: IPlacementContext,
    threats: IPublicPlacementThreats,
    front: readonly XY[],
    locked: Set<string>,
): void => {
    const corners = backCornerKeys(board.geom);
    const carriers = board.units
        .filter(
            (unit) =>
                !locked.has(unit.getId()) &&
                !c31Sniper(unit) &&
                isAuraCarrier(unit) &&
                c31CornerCells(board.footprint(unit), corners, board.geom).length > 0,
        )
        .sort((a, b) => backEdgeness(b, board) - backEdgeness(a, board) || byId(a, b));
    for (const carrier of carriers) {
        if (locked.has(carrier.getId())) continue;
        const moves = c31TryAura(board, context, carrier, threats, front, locked);
        if (!moves || !c31CommitMoves(board, moves)) continue;
        for (const id of moves.keys()) locked.add(id);
    }
};

const c31BetweenEmpty = (board: IBoard, cells: readonly XY[], corners: readonly number[], self: Unit): boolean => {
    if (!corners.length) return false;
    const lats = c31Laterals(cells, board.geom);
    const lat = medianNumber(lats);
    let nearest = corners[0];
    for (const corner of corners) if (Math.abs(corner - lat) < Math.abs(nearest - lat)) nearest = corner;
    const own = new Set(lats);
    const occupied = board.occupiedLaterals(self);
    for (let cursor = Math.min(nearest, lat) + 1; cursor <= Math.max(nearest, lat) - 1; cursor += 1) {
        if (!own.has(cursor) && occupied.has(cursor)) return false;
    }
    return true;
};

const c31SlideExtras = (
    board: IBoard,
    threats: IPublicPlacementThreats,
    front: readonly XY[],
    locked: Set<string>,
): void => {
    const range = placedRange(board.units, board);
    if (range.length < 3) return;
    for (const bow of lockedBows(range, board)) locked.add(bow.getId());
    if (threats.flyers >= 2 && !threats.lineAttack) return;
    const corners = backCornerKeys(board.geom);
    const cornerLats = [...corners].map((key) => board.geom.lateral({ x: key >> 4, y: key & 0xf }));
    const extras = range
        .filter((unit) => {
            if (locked.has(unit.getId()) || c31Sniper(unit)) return false;
            const cells = board.footprint(unit);
            return c31OnBack(cells, board.geom) && !c31Complete(cells, c31Reach(unit), front);
        })
        .sort(byId);
    for (const extra of extras) {
        const current = board.cells.get(extra.getId());
        if (!current) continue;
        const currentLat = medianNumber(board.laterals(extra));
        const occupied = takenCells(board, new Set([extra.getId()]));
        const others = board.units
            .filter((unit) => unit.getId() !== extra.getId())
            .map((unit) => board.footprint(unit))
            .filter((foot) => foot.length > 0);
        const oldGap = gapToOthers(board.footprint(extra), others);
        const spots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            const cells = c31Fits(extra, anchor, board.geom);
            if (!cells || !c31OnBack(cells, board.geom) || !c31Complete(cells, c31Reach(extra), front)) continue;
            if (cells.some((cell) => corners.has(keyOf(cell)) || occupied.has(keyOf(cell)))) continue;
            const inset = Math.min(
                ...c31Laterals(cells, board.geom).map((lat) =>
                    Math.min(...cornerLats.map((corner) => Math.abs(lat - corner))),
                ),
            );
            if (inset < 2) continue;
            if (c31HitsLat(cells, board.occupiedLaterals(extra), board.geom)) continue;
            if (threats.lineAttack && !c31BetweenEmpty(board, cells, cornerLats, extra)) continue;
            const gap = gapToOthers(cells, others);
            if (threats.chakram && gap < 4) continue;
            if ((threats.areaThrow || threats.largeCaliber) && (gap < 2 || gap < oldGap)) continue;
            spots.push(anchor);
        }
        spots.sort((a, b) => {
            const aLat = medianNumber(c31Laterals(footprintCellsForAnchor(extra, a), board.geom));
            const bLat = medianNumber(c31Laterals(footprintCellsForAnchor(extra, b), board.geom));
            const near = Math.abs(aLat - currentLat) - Math.abs(bLat - currentLat);
            return (
                near ||
                Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat) ||
                a.x - b.x ||
                a.y - b.y
            );
        });
        const spot = spots[0];
        if (!spot || !c31CommitMoves(board, new Map([[extra.getId(), spot]]))) continue;
        locked.add(extra.getId());
    }
};

const c31StepFront = (
    board: IBoard,
    context: IPlacementContext,
    threats: IPublicPlacementThreats,
    locked: ReadonlySet<string>,
): void => {
    if (threats.flyers >= 2) return;
    if (threats.rangeCreatures === 0 && !c31EnemyHasSpell(context.publicOpponentCreatureIds)) return;
    const corners = backCornerKeys(board.geom);
    const ranks = ranksOf(board);
    const cornerLats = new Set([...corners].map((key) => board.geom.lateral({ x: key >> 4, y: key & 0xf })));
    const bows = placedRange(board.units, board)
        .filter((unit) => {
            if (locked.has(unit.getId()) || c31Sniper(unit) || bowReach(unit) !== 9) return false;
            return c31CornerCells(board.footprint(unit), corners, board.geom).length === 0;
        })
        .sort(
            (a, b) =>
                board.geom.frontness(board.cells.get(b.getId()) ?? { x: 0, y: 0 }) -
                    board.geom.frontness(board.cells.get(a.getId()) ?? { x: 0, y: 0 }) || byId(a, b),
        );
    for (const bow of bows) {
        const occupied = takenCells(board, new Set([bow.getId()]));
        const spots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            const cells = c31Fits(bow, anchor, board.geom);
            if (!cells || !cells.every((cell) => board.geom.frontness(cell) === ranks.front)) continue;
            if (cells.some((cell) => cornerLats.has(board.geom.lateral(cell)) || occupied.has(keyOf(cell)))) continue;
            const stayed = board.units
                .filter((unit) => unit.getId() !== bow.getId())
                .map((unit) => board.footprint(unit))
                .filter((foot) => foot.length > 0 && foot.some((cell) => board.geom.frontness(cell) < ranks.front));
            if (stayed.some((foot) => minChebyshev(cells, foot) <= 1)) continue;
            if (threats.lineAttack && c31HitsLat(cells, board.occupiedLaterals(bow), board.geom)) {
                continue;
            }
            if (threats.areaThrow || threats.largeCaliber) {
                const others = board.units
                    .filter((unit) => unit.getId() !== bow.getId())
                    .map((unit) => board.footprint(unit))
                    .filter((foot) => foot.length > 0);
                if (others.length > 0 && gapToOthers(cells, others) < 2) continue;
            }
            spots.push(anchor);
        }
        spots.sort((a, b) => {
            const aLat = medianNumber(c31Laterals(footprintCellsForAnchor(bow, a), board.geom));
            const bLat = medianNumber(c31Laterals(footprintCellsForAnchor(bow, b), board.geom));
            return (
                Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat) ||
                aLat - bLat ||
                a.x - b.x ||
                a.y - b.y
            );
        });
        const spot = spots[0];
        if (!spot || !c31CommitMoves(board, new Map([[bow.getId(), spot]]))) continue;
    }
};

/**
 * r3c1 post-pass. Today's placeArmy has already run. A one-cell bow keeps the back corner a wide
 * stack was holding, and a band-9 extra steps to the front. Sniper-ability bows are already complete.
 */
export function placeArmyR3C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (placedRange(units, board).length < 2) return new Map(board.cells);
    const front = c31EnemyFront(geom);
    if (!front.length) return new Map(board.cells);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const locked = new Set<string>();
    c31HandoffWide(board, threats, front, locked);
    c31HandoffAura(board, context, threats, front, locked);
    c31SlideExtras(board, threats, front, locked);
    c31StepFront(board, context, threats, locked);
    return board.cells;
}

const c32HitsRank = (unit: Unit, board: IBoard, rank: number): boolean =>
    board.footprint(unit).some((cell) => board.geom.frontness(cell) === rank);

const c32ScreenBody = (unit: Unit): boolean =>
    !unit.canFly() &&
    !isCharger(unit) &&
    !isSpellbookUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    !isCasterUnit(unit) &&
    unit.getAttackType() !== RANGE;

const c32Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    const bows: Unit[] = [];
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (unit.getAttackType() === RANGE || isSpellbookUnit(unit) || PROTECTORS.has(unit.getName())) {
            locked.add(unit.getId());
        }
        if (unit.getAttackType() === RANGE) bows.push(unit);
    }
    for (const unit of board.units) {
        if (locked.has(unit.getId()) || unit.canFly() || unit.getAttackType() === RANGE) continue;
        if (!board.footprint(unit).length) continue;
        if (bows.some((bow) => minChebyshev(board.footprint(unit), board.footprint(bow)) <= 1)) {
            locked.add(unit.getId());
        }
    }
    return locked;
};

const c32Ground = (unit: Unit, board: IBoard, locked: ReadonlySet<string>): boolean =>
    c32ScreenBody(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0;

const c32Flyer = (unit: Unit, board: IBoard, locked: ReadonlySet<string>): boolean =>
    unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !locked.has(unit.getId()) &&
    !isSpellbookUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    board.footprint(unit).length > 0;

const c32ByArmor = (a: Unit, b: Unit): number => b.getArmor() - a.getArmor() || byId(a, b);

const c32Shadowed = (unit: Unit, board: IBoard): boolean => {
    for (const cell of board.footprint(unit)) {
        const lat = board.geom.lateral(cell);
        const depth = board.geom.frontness(cell);
        for (const other of board.units) {
            if (other.getId() === unit.getId()) continue;
            for (const occupied of board.footprint(other)) {
                if (board.geom.lateral(occupied) === lat && board.geom.frontness(occupied) === depth + 1) return true;
            }
        }
    }
    return false;
};

const c32CentreLaterals = (geom: IGeom): number[] => {
    const limits = zoneLimits(geom);
    let best = Infinity;
    const found: number[] = [];
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        const distance = Math.abs(lat - geom.centreLat);
        if (distance < best - 1e-9) {
            best = distance;
            found.length = 0;
            found.push(lat);
        } else if (Math.abs(distance - best) <= 1e-9) found.push(lat);
    }
    return found;
};

const c32CentreContact = (cell: XY, board: IBoard, front: number): boolean =>
    board.geom.frontness(cell) === front && c32CentreLaterals(board.geom).includes(board.geom.lateral(cell));

const c32OneOffCentre = (lat: number, geom: IGeom): boolean => {
    const centre = c32CentreLaterals(geom);
    return !centre.includes(lat) && centre.some((value) => Math.abs(lat - value) === 1);
};

const c32EmptyDir = (unit: Unit, board: IBoard): number => {
    const mine = board.laterals(unit);
    if (!mine.length) return 0;
    const median = medianNumber(mine);
    const occupied = occupiedLateralsOf(board);
    const limits = zoneLimits(board.geom);
    let best = Infinity;
    let dir = 0;
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        if (occupied.has(lat)) continue;
        const distance = Math.min(...mine.map((value) => Math.abs(lat - value)));
        if (distance <= 0) continue;
        const next = lat < median ? -1 : 1;
        if (distance < best || (distance === best && next < dir)) {
            best = distance;
            dir = next;
        }
    }
    return dir;
};

const c32SameDepth = (unit: Unit, anchor: XY, board: IBoard): boolean => {
    const current = board.cells.get(unit.getId());
    if (!current) return false;
    const before = spanAt(unit, current, board.geom);
    const after = spanAt(unit, anchor, board.geom);
    return !!before && !!after && before.minFront === after.minFront && before.maxFront === after.maxFront;
};

const c32OpensFile = (unit: Unit, anchor: XY, board: IBoard): boolean => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span) return true;
    const others = board.occupiedLaterals(unit);
    const next = new Set(span.laterals);
    return board.laterals(unit).some((lat) => !next.has(lat) && !others.has(lat));
};

const c32ScreenAheadOf = (footprint: readonly XY[], charger: Unit, board: IBoard): boolean => {
    const other = board.footprint(charger);
    for (const cell of footprint) {
        for (const occupied of other) {
            if (
                board.geom.lateral(cell) === board.geom.lateral(occupied) &&
                board.geom.frontness(cell) === board.geom.frontness(occupied) + 1
            ) {
                return true;
            }
        }
    }
    return false;
};

const c32CornerFlyers = (board: IBoard): boolean => {
    const ranks = r2Ranks(board);
    const centre = new Set(c32CentreLaterals(board.geom));
    const chargerOnContact = board.units.some(
        (unit) =>
            isCharger(unit) &&
            board
                .footprint(unit)
                .some((cell) => board.geom.frontness(cell) === ranks.front && centre.has(board.geom.lateral(cell))),
    );
    if (!chargerOnContact) return false;
    const limits = zoneLimits(board.geom);
    const onCorner = (lat: number): boolean =>
        board.units.some(
            (unit) =>
                unit.canFly() &&
                board
                    .footprint(unit)
                    .some((cell) => board.geom.frontness(cell) === ranks.front && board.geom.lateral(cell) === lat),
        );
    return onCorner(limits.minLat) && onCorner(limits.maxLat);
};

const c32BranchA = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = r2Ranks(board);
    const movers = board.units
        .filter((unit) => {
            if (locked.has(unit.getId()) || !board.footprint(unit).length || !c32Shadowed(unit, board)) return false;
            if (isCharger(unit) && c32HitsRank(unit, board, ranks.front)) return false;
            if (unit.canFly() && !c32Shadowed(unit, board)) return false;
            return true;
        })
        .sort((a, b) => {
            const aDepth = Math.min(...board.footprint(a).map((cell) => board.geom.frontness(cell)));
            const bDepth = Math.min(...board.footprint(b).map((cell) => board.geom.frontness(cell)));
            return aDepth - bDepth || byId(a, b);
        });
    for (const unit of movers) {
        const anchor = board.cells.get(unit.getId());
        const dir = anchor ? c32EmptyDir(unit, board) : 0;
        if (!anchor || dir === 0) continue;
        const shifted = board.geom.shiftLateral(anchor, dir);
        if (!c32SameDepth(unit, shifted, board) || c32OpensFile(unit, shifted, board)) continue;
        const span = spanAt(unit, shifted, board.geom);
        if (!span || !spanIsLegal(span, board.geom, takenCells(board, new Set([unit.getId()])))) continue;
        if (isCharger(unit) && span.cells.some((cell) => board.geom.frontness(cell) === ranks.back)) continue;
        if (c32ScreenBody(unit) && span.cells.some((cell) => c32CentreContact(cell, board, ranks.front))) continue;
        if (unit.canFly() && span.laterals.some((lat) => c32OneOffCentre(lat, board.geom))) continue;
        if (board.units.some((charger) => isCharger(charger) && c32ScreenAheadOf(span.cells, charger, board))) {
            continue;
        }
        const previous = { x: anchor.x, y: anchor.y };
        if (!board.place(unit, shifted)) continue;
        if (c32CornerFlyers(board)) board.cells.set(unit.getId(), previous);
    }
};

const c32GapOf = (left: readonly number[], right: readonly number[]): number => {
    const leftMax = Math.max(...left);
    const rightMax = Math.max(...right);
    const leftMin = Math.min(...left);
    const rightMin = Math.min(...right);
    if (leftMax < rightMin) return rightMin - leftMax - 1;
    if (rightMax < leftMin) return leftMin - rightMax - 1;
    return -1;
};

const c32BranchB = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = r2Ranks(board);
    const bodies = board.units
        .filter(
            (unit) =>
                c32HitsRank(unit, board, ranks.front) &&
                (c32Ground(unit, board, locked) ||
                    (isCharger(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0) ||
                    c32Flyer(unit, board, locked)),
        )
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const groups: Unit[][] = [];
    for (const unit of bodies) {
        const previous = groups[groups.length - 1];
        const tail = previous?.[previous.length - 1];
        if (!previous || !tail || c32GapOf(board.laterals(tail), board.laterals(unit)) > 0) groups.push([unit]);
        else previous.push(unit);
    }
    const steps: { unit: Unit; dir: number }[] = [];
    for (const group of groups) {
        if (group.length < 2) continue;
        const ends = group.length === 2 ? [group[1]] : [group[0], group[group.length - 1]];
        if (group.length === 2) {
            const [left, right] = group;
            const leftEdge = Math.abs(medianLat(left, board) - board.geom.centreLat);
            const rightEdge = Math.abs(medianLat(right, board) - board.geom.centreLat);
            ends[0] = rightEdge > leftEdge ? right : leftEdge > rightEdge ? left : right;
        }
        const seen = new Set<string>();
        for (const unit of ends) {
            if (seen.has(unit.getId())) continue;
            seen.add(unit.getId());
            const partner = unit === group[0] ? group[1] : group[group.length - 2];
            const lat = medianLat(unit, board);
            const dir = lat < board.geom.centreLat ? -1 : lat > board.geom.centreLat ? 1 : 0;
            if (dir === 0 || !partner) continue;
            if (dir < 0 && lat > medianLat(partner, board)) continue;
            if (dir > 0 && lat < medianLat(partner, board)) continue;
            const shifted = board.laterals(unit).map((value) => value + dir);
            if (c32GapOf(shifted, board.laterals(partner)) !== 1) continue;
            steps.push({ unit, dir });
        }
    }
    steps.sort(
        (a, b) =>
            board.geom.edgeness(board.cells.get(b.unit.getId()) ?? { x: 0, y: 0 }) -
                board.geom.edgeness(board.cells.get(a.unit.getId()) ?? { x: 0, y: 0 }) || byId(a.unit, b.unit),
    );
    for (const step of steps) {
        const anchor = board.cells.get(step.unit.getId());
        if (!anchor) continue;
        const shifted = board.geom.shiftLateral(anchor, step.dir);
        if (!c32SameDepth(step.unit, shifted, board)) continue;
        const span = spanAt(step.unit, shifted, board.geom);
        if (!span || !spanIsLegal(span, board.geom, takenCells(board, new Set([step.unit.getId()])))) continue;
        if (!span.cells.some((cell) => board.geom.frontness(cell) === ranks.front)) continue;
        if (isCharger(step.unit) && span.cells.some((cell) => board.geom.frontness(cell) === ranks.back)) continue;
        board.place(step.unit, shifted);
    }
};

const c32Seat = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    rank: number,
    lo: number,
    hi: number,
): XY | undefined =>
    findWindow(unit, board, taken, lo, hi, (span) => span.minFront === rank && span.maxFront === rank, new Set());

const c32Take = (plan: Map<string, XY>, occupied: Set<number>, unit: Unit, anchor: XY): void => {
    plan.set(unit.getId(), anchor);
    for (const cell of footprintCellsForAnchor(unit, anchor)) occupied.add(keyOf(cell));
};

const c32Foot = (board: IBoard, unit: Unit, plan: ReadonlyMap<string, XY>): XY[] => {
    const anchor = plan.has(unit.getId()) ? plan.get(unit.getId()) : board.cells.get(unit.getId());
    return anchor ? footprintCellsForAnchor(unit, anchor) : [];
};

const c32FrontGrounds = (board: IBoard, plan: ReadonlyMap<string, XY>): number => {
    const front = r2Ranks(board).front;
    let count = 0;
    for (const unit of board.units) {
        if (unit.canFly() || unit.getAttackType() === RANGE) continue;
        if (c32Foot(board, unit, plan).some((cell) => board.geom.frontness(cell) === front)) count += 1;
    }
    return count;
};

const c32WasFront = (board: IBoard, unit: Unit): boolean => {
    const anchor = board.cells.get(unit.getId());
    const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
    return !!span && span.cells.some((cell) => board.geom.frontness(cell) === r2Ranks(board).front);
};

const c32PlanFits = (board: IBoard, plan: ReadonlyMap<string, XY>): boolean => {
    const occupied = takenCells(board, new Set(plan.keys()));
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!unit || !span || !spanIsLegal(span, board.geom, occupied)) return false;
        for (const cell of span.cells) occupied.add(keyOf(cell));
    }
    return true;
};

const c32FirstUnfit = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    const occupied = takenCells(board, new Set(plan.keys()));
    for (const [id, anchor] of plan) {
        const unit = r2Unit(board, id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!unit || !span || !spanIsLegal(span, board.geom, occupied)) return id;
        for (const cell of span.cells) occupied.add(keyOf(cell));
    }
    return undefined;
};

const c32DepthOffender = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    const ranks = r2Ranks(board);
    for (const charger of board.units) {
        if (!isCharger(charger) || !plan.has(charger.getId())) continue;
        const laterals = new Set(c32Foot(board, charger, plan).map((cell) => board.geom.lateral(cell)));
        for (const unit of board.units) {
            if (unit.getId() === charger.getId()) continue;
            for (const cell of c32Foot(board, unit, plan)) {
                const depth = board.geom.frontness(cell);
                if (!laterals.has(board.geom.lateral(cell)) || (depth !== ranks.middle && depth !== ranks.back)) {
                    continue;
                }
                if (plan.has(unit.getId())) return unit.getId();
                return charger.getId();
            }
        }
    }
    return undefined;
};

const c32AheadOffender = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    const chargers = board.units.filter((unit) => isCharger(unit));
    for (const unit of board.units) {
        if (!c32ScreenBody(unit)) continue;
        const footprint = c32Foot(board, unit, plan);
        for (const charger of chargers) {
            const other = c32Foot(board, charger, plan);
            for (const cell of footprint) {
                for (const occupied of other) {
                    if (
                        board.geom.lateral(cell) === board.geom.lateral(occupied) &&
                        board.geom.frontness(cell) === board.geom.frontness(occupied) + 1 &&
                        plan.has(unit.getId())
                    ) {
                        return unit.getId();
                    }
                }
            }
        }
    }
    return undefined;
};

const c32BackCharger = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    const back = r2Ranks(board).back;
    for (const unit of board.units) {
        if (!isCharger(unit) || !plan.has(unit.getId())) continue;
        if (c32Foot(board, unit, plan).some((cell) => board.geom.frontness(cell) === back)) return unit.getId();
    }
    return undefined;
};

const c32CornerOffender = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    const snapshot = copyCells(board);
    for (const [id, anchor] of plan) board.cells.set(id, { x: anchor.x, y: anchor.y });
    const bad = c32CornerFlyers(board);
    restoreCells(board, snapshot);
    if (!bad) return undefined;
    const limits = zoneLimits(board.geom);
    const front = r2Ranks(board).front;
    for (const unit of board.units) {
        if (!unit.canFly() || !plan.has(unit.getId())) continue;
        if (
            c32Foot(board, unit, plan).some(
                (cell) =>
                    board.geom.frontness(cell) === front &&
                    (board.geom.lateral(cell) === limits.minLat || board.geom.lateral(cell) === limits.maxLat),
            )
        ) {
            return unit.getId();
        }
    }
    return undefined;
};

const c32GroundOffender = (board: IBoard, plan: ReadonlyMap<string, XY>): string | undefined => {
    if (c32FrontGrounds(board, new Map()) === 0 || c32FrontGrounds(board, plan) > 0) return undefined;
    for (const unit of board.units) {
        if (!plan.has(unit.getId()) || unit.canFly() || unit.getAttackType() === RANGE) continue;
        const still = c32Foot(board, unit, plan).some((cell) => board.geom.frontness(cell) === r2Ranks(board).front);
        if (!still && c32WasFront(board, unit)) return unit.getId();
    }
    return undefined;
};

const c32Commit = (board: IBoard, plan: Map<string, XY>, emptyChargerDepth: boolean): boolean => {
    const before = c32FrontGrounds(board, new Map());
    for (let guard = plan.size + 2; guard >= 0 && plan.size; guard -= 1) {
        const offender =
            (emptyChargerDepth ? c32DepthOffender(board, plan) : undefined) ??
            c32GroundOffender(board, plan) ??
            c32BackCharger(board, plan) ??
            c32AheadOffender(board, plan) ??
            c32CornerOffender(board, plan) ??
            c32FirstUnfit(board, plan);
        if (!offender) break;
        plan.delete(offender);
    }
    if (!plan.size || !c32PlanFits(board, plan)) return false;
    if (before > 0 && c32FrontGrounds(board, plan) === 0) return false;
    const snapshot = copyCells(board);
    if (!commitAssignments(board, plan, false)) return false;
    if (c32CornerFlyers(board) || (before > 0 && c32FrontGrounds(board, new Map()) === 0)) {
        restoreCells(board, snapshot);
        return false;
    }
    return true;
};

const c32Window = (geom: IGeom, width: number): { lo: number; hi: number } | undefined => {
    const limits = zoneLimits(geom);
    if (width <= 0 || width > limits.maxLat - limits.minLat + 1) return undefined;
    const ideal = Math.round(geom.centreLat - (width - 1) / 2);
    const lo = Math.max(limits.minLat, Math.min(ideal, limits.maxLat - width + 1));
    return { lo, hi: lo + width - 1 };
};

const c32RunStart = (files: readonly number[], width: number, centre: number): number | undefined => {
    let best: number | undefined;
    let bestDist = Infinity;
    for (let index = 0; index + width <= files.length; index += 1) {
        const slice = files.slice(index, index + width);
        if (slice[slice.length - 1] - slice[0] !== width - 1) continue;
        const mid = (slice[0] + slice[slice.length - 1]) / 2;
        const distance = Math.abs(mid - centre);
        if (distance < bestDist || (distance === bestDist && (best === undefined || slice[0] < best))) {
            bestDist = distance;
            best = slice[0];
        }
    }
    return best;
};

const c32BranchC = (board: IBoard, locked: ReadonlySet<string>, threats: IPublicPlacementThreats): void => {
    const ranks = r2Ranks(board);
    const limits = zoneLimits(board.geom);
    const sideOriented = r2SideOriented(board.geom);
    const flyers = board.units.filter((unit) => c32Flyer(unit, board, locked)).sort(byId);
    const seatBack = threats.flyers >= 2 && flyers.length > 0;
    const eligible = board.units
        .filter((unit) => c32Ground(unit, board, locked))
        .filter((unit) => seatBack || !c32HitsRank(unit, board, ranks.back))
        .sort(c32ByArmor);
    const backN = seatBack ? Math.min(flyers.length, Math.max(0, eligible.length - flyers.length)) : 0;
    const frontScreens = eligible.slice(0, eligible.length - backN);
    const backScreens = eligible.slice(eligible.length - backN);
    const charger = r2FastestCharger(board, locked);
    const plan = new Map<string, XY>();
    const moving = new Set<string>([...frontScreens, ...backScreens, ...flyers].map((unit) => unit.getId()));
    if (charger) moving.add(charger.getId());
    const occupied = takenCells(board, moving);
    const widths = frontScreens.map((unit) => lateralSpanCount(unit, sideOriented));
    const total = widths.reduce((sum, width) => sum + width, 0);
    const window = c32Window(board.geom, total);
    const slots: { lo: number; hi: number }[] = [];
    if (window) {
        let cursor = window.lo;
        for (const width of widths) {
            slots.push({ lo: cursor, hi: cursor + width - 1 });
            cursor += width;
        }
    }
    const pool = [...frontScreens];
    const slotOrder = slots
        .map((slot, index) => ({ index, mid: (slot.lo + slot.hi) / 2 }))
        .sort(
            (a, b) => Math.abs(a.mid - board.geom.centreLat) - Math.abs(b.mid - board.geom.centreLat) || a.mid - b.mid,
        );
    for (const slot of slotOrder) {
        const bounds = slots[slot.index];
        const index = pool.findIndex(
            (unit) => c32Seat(unit, board, occupied, ranks.front, bounds.lo, bounds.hi) !== undefined,
        );
        if (index < 0) continue;
        const unit = pool[index];
        const anchor = c32Seat(unit, board, occupied, ranks.front, bounds.lo, bounds.hi);
        if (!anchor) continue;
        pool.splice(index, 1);
        c32Take(plan, occupied, unit, anchor);
    }
    const block = [
        ...new Set(
            [...plan.entries()].flatMap(([id, anchor]) => {
                const unit = r2Unit(board, id);
                const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
                return span?.laterals ?? [];
            }),
        ),
    ].sort((a, b) => a - b);
    let chargerLaterals = new Set<number>();
    if (charger && block.length) {
        const width = lateralSpanCount(charger, sideOriented);
        const sides = [
            { lo: block[0] - width, hi: block[0] - 1 },
            { lo: block[block.length - 1] + 1, hi: block[block.length - 1] + width },
        ];
        for (const side of sides) {
            if (side.lo < limits.minLat || side.hi > limits.maxLat) continue;
            let busy = false;
            for (let lat = side.lo; lat <= side.hi; lat += 1) {
                for (const rank of [ranks.middle, ranks.back]) {
                    const cell = r3Cell(board, rank, lat);
                    if (cell && occupied.has(keyOf(cell))) busy = true;
                }
            }
            if (busy) continue;
            const anchor = c32Seat(charger, board, occupied, ranks.front, side.lo, side.hi);
            if (!anchor) continue;
            c32Take(plan, occupied, charger, anchor);
            const span = spanAt(charger, anchor, board.geom);
            chargerLaterals = new Set(span?.laterals ?? []);
            break;
        }
    }
    const flyerFiles = block.filter((lat) => !chargerLaterals.has(lat));
    const flying = [...flyers];
    while (
        flying.length &&
        flying.reduce((sum, unit) => sum + lateralSpanCount(unit, sideOriented), 0) > flyerFiles.length
    ) {
        flying.pop();
    }
    const flyerWidth = flying.reduce((sum, unit) => sum + lateralSpanCount(unit, sideOriented), 0);
    const flyerStart = flyerWidth > 0 ? c32RunStart(flyerFiles, flyerWidth, board.geom.centreLat) : undefined;
    if (flyerStart !== undefined) {
        let cursor = flyerStart;
        for (const flyer of flying) {
            const width = lateralSpanCount(flyer, sideOriented);
            const anchor = c32Seat(flyer, board, occupied, ranks.middle, cursor, cursor + width - 1);
            if (!anchor) break;
            c32Take(plan, occupied, flyer, anchor);
            cursor += width;
        }
    }
    if (seatBack) {
        const flyerLats = [
            ...new Set(
                flyers.flatMap((flyer) => {
                    const anchor = plan.get(flyer.getId());
                    const span = anchor ? spanAt(flyer, anchor, board.geom) : undefined;
                    return span?.laterals ?? [];
                }),
            ),
        ].sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
        let cursor = 0;
        for (const lat of flyerLats) {
            if (cursor >= backScreens.length || chargerLaterals.has(lat)) continue;
            const screen = backScreens[cursor];
            if (lateralSpanCount(screen, sideOriented) !== 1) {
                cursor += 1;
                continue;
            }
            const cell = r3Cell(board, ranks.back, lat);
            if (!cell || occupied.has(keyOf(cell))) continue;
            const anchor = c32Seat(screen, board, occupied, ranks.back, lat, lat);
            if (!anchor) continue;
            c32Take(plan, occupied, screen, anchor);
            cursor += 1;
        }
    }
    c32Commit(board, plan, true);
};

const c32Touches = (board: IBoard, rank: number, lo: number, hi: number, grounds: readonly Unit[]): boolean => {
    const cells: XY[] = [];
    for (let lat = lo; lat <= hi; lat += 1) {
        const found = r3Cell(board, rank, lat);
        if (found) cells.push(found);
    }
    if (!cells.length) return false;
    return grounds.some((unit) => {
        const footprint = board.footprint(unit);
        return footprint.length > 0 && minChebyshev(cells, footprint) <= 1;
    });
};

const c32BackTargets = (board: IBoard): XY[] => {
    const back = r2Ranks(board).back;
    const cells = board.geom.baseCells.filter((cell) => board.geom.frontness(cell) === back);
    const centre = [...cells].sort(
        (a, b) =>
            Math.abs(board.geom.lateral(a) - board.geom.centreLat) -
                Math.abs(board.geom.lateral(b) - board.geom.centreLat) || board.geom.lateral(a) - board.geom.lateral(b),
    )[0];
    const low = [...cells]
        .filter((cell) => board.geom.lateral(cell) <= board.geom.centreLat)
        .sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b))[0];
    const high = [...cells]
        .filter((cell) => board.geom.lateral(cell) > board.geom.centreLat)
        .sort((a, b) => board.geom.lateral(b) - board.geom.lateral(a))[0];
    const seen = new Set<number>();
    const targets: XY[] = [];
    for (const cell of [centre, low, high]) {
        if (!cell || seen.has(keyOf(cell))) continue;
        seen.add(keyOf(cell));
        targets.push(cell);
    }
    return targets;
};

const c32BranchD = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = r2Ranks(board);
    const limits = zoneLimits(board.geom);
    const lowMax = Math.floor(board.geom.centreLat);
    const sideOriented = r2SideOriented(board.geom);
    const flyers = board.units.filter((unit) => c32Flyer(unit, board, locked)).sort(byId);
    const screens = board.units.filter((unit) => c32Ground(unit, board, locked)).sort(c32ByArmor);
    const charger = r2FastestCharger(board, locked);
    const grounds = board.units.filter(
        (unit) => !unit.canFly() && unit.getAttackType() !== RANGE && board.footprint(unit).length > 0,
    );
    const plan = new Map<string, XY>();
    const moving = new Set<string>([...flyers, ...screens].map((unit) => unit.getId()));
    if (charger) moving.add(charger.getId());
    const occupied = takenCells(board, moving);
    const packWidth = flyers.reduce((sum, unit) => sum + lateralSpanCount(unit, sideOriented), 0);
    let packLo: number | undefined;
    let packHi: number | undefined;
    if (packWidth > 0 && packWidth <= lowMax - limits.minLat + 1) {
        const maxStart = lowMax - packWidth + 1;
        let chosen: number | undefined;
        for (let start = limits.minLat; start <= maxStart; start += 1) {
            let cursor = start;
            let fits = true;
            const trial = new Set(occupied);
            for (const flyer of flyers) {
                const width = lateralSpanCount(flyer, sideOriented);
                const anchor = c32Seat(flyer, board, trial, ranks.front, cursor, cursor + width - 1);
                if (!anchor) {
                    fits = false;
                    break;
                }
                for (const cell of footprintCellsForAnchor(flyer, anchor)) trial.add(keyOf(cell));
                cursor += width;
            }
            if (!fits) continue;
            chosen = start;
            if (c32Touches(board, ranks.front, start, start + packWidth - 1, grounds)) break;
        }
        if (chosen !== undefined) {
            packLo = chosen;
            packHi = chosen + packWidth - 1;
            let cursor = chosen;
            for (const flyer of flyers) {
                const width = lateralSpanCount(flyer, sideOriented);
                const anchor = c32Seat(flyer, board, occupied, ranks.front, cursor, cursor + width - 1);
                if (!anchor) {
                    packLo = undefined;
                    packHi = undefined;
                    break;
                }
                c32Take(plan, occupied, flyer, anchor);
                cursor += width;
            }
        }
    }
    if (charger && packHi !== undefined) {
        const width = lateralSpanCount(charger, sideOriented);
        const sides = [
            { lo: packHi + 1, hi: packHi + width },
            ...(packLo !== undefined && packLo - width >= limits.minLat
                ? [{ lo: packLo - width, hi: packLo - 1 }]
                : []),
        ];
        for (const side of sides) {
            if (side.lo < limits.minLat || side.hi > limits.maxLat) continue;
            const anchor = c32Seat(charger, board, occupied, ranks.front, side.lo, side.hi);
            if (!anchor) continue;
            c32Take(plan, occupied, charger, anchor);
            break;
        }
    }
    let index = 0;
    for (const target of c32BackTargets(board)) {
        if (index >= screens.length) break;
        if (occupied.has(keyOf(target))) continue;
        const lat = board.geom.lateral(target);
        const screen = screens[index];
        if (lateralSpanCount(screen, sideOriented) !== 1) {
            index += 1;
            continue;
        }
        const anchor = c32Seat(screen, board, occupied, ranks.back, lat, lat);
        if (!anchor) continue;
        c32Take(plan, occupied, screen, anchor);
        index += 1;
    }
    c32Commit(board, plan, false);
};

const c32BranchE = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = r2Ranks(board);
    const limits = zoneLimits(board.geom);
    const lowMax = Math.floor(board.geom.centreLat);
    const sideOriented = r2SideOriented(board.geom);
    const capacity = lowMax - limits.minLat + 1;
    const screens = board.units.filter((unit) => c32Ground(unit, board, locked)).sort(c32ByArmor);
    const flyers = board.units.filter((unit) => c32Flyer(unit, board, locked)).sort(byId);
    const charger = r2FastestCharger(board, locked);
    const widthOf = (units: readonly Unit[]): number =>
        units.reduce((sum, unit) => sum + lateralSpanCount(unit, sideOriented), 0);
    const keptScreens = [...screens];
    const chargerWidth = charger ? lateralSpanCount(charger, sideOriented) : 0;
    while (keptScreens.length && widthOf(keptScreens) + chargerWidth > capacity) keptScreens.pop();
    const keptFlyers = [...flyers];
    while (keptFlyers.length && widthOf(keptFlyers) + widthOf(keptScreens) + chargerWidth > capacity) {
        keptFlyers.pop();
    }
    const line = [...keptFlyers, ...keptScreens, ...(charger && chargerWidth > 0 ? [charger] : [])];
    const plan = new Map<string, XY>();
    const occupied = takenCells(board, new Set(line.map((unit) => unit.getId())));
    let cursor = limits.minLat;
    for (const unit of line) {
        const width = lateralSpanCount(unit, sideOriented);
        if (cursor + width - 1 > lowMax) break;
        const anchor = c32Seat(unit, board, occupied, ranks.front, cursor, cursor + width - 1);
        if (!anchor) break;
        c32Take(plan, occupied, unit, anchor);
        cursor += width;
    }
    c32Commit(board, plan, false);
};

/**
 * r3c2 post-pass. Today's placeArmy has already run. Pierce steps the shadowed body one file
 * off the breath; every other public roster keeps one front pack beside the charger.
 * Area Throw and Large Caliber leave the map alone.
 */
export function placeArmyR3C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const locked = c32Locked(board);
    if (threats.fireBreath || threats.skewerStrike) c32BranchA(board, locked);
    else if (threats.lightningSpin) c32BranchB(board, locked);
    else if (threats.rangeCreatures > 0 && !threats.throughShot) c32BranchC(board, locked, threats);
    else if (threats.flyers >= 2 && threats.rangeCreatures === 0) c32BranchD(board, locked);
    else if (threats.rangeCreatures === 0 && threats.flyers < 2 && !threats.lightningSpin && !threats.rapidCharge) {
        c32BranchE(board, locked);
    }
    return board.cells;
}

/** Exact melee, or melee-magic that does not carry a spellbook. Not a flyer, charger, or protector. */
const c33IsScreen = (unit: Unit): boolean => {
    if (unit.canFly() || isCharger(unit) || PROTECTORS.has(unit.getName()) || CASTER_STAYS.has(unit.getName())) {
        return false;
    }
    if (isCasterUnit(unit)) return false;
    const attack = unit.getAttackType();
    if (attack === MELEE) return true;
    return attack === MELEE_MAGIC && !isSpellbookUnit(unit);
};

const c33ScreenUnits = (board: IBoard, skip: ReadonlySet<string>): Unit[] =>
    board.units.filter((unit) => c33IsScreen(unit) && board.footprint(unit).length > 0 && !skip.has(unit.getId()));

const c33Nearest = (origin: Unit, units: readonly Unit[], board: IBoard): Unit | undefined => {
    const mine = board.footprint(origin);
    if (!mine.length) return undefined;
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const unit of units) {
        const cells = board.footprint(unit);
        if (!cells.length) continue;
        const dist = minChebyshev(mine, cells);
        if (!best || dist < bestDist || (dist === bestDist && byId(unit, best) < 0)) {
            best = unit;
            bestDist = dist;
        }
    }
    return best;
};

const c33OthersHold = (board: IBoard, cell: XY, ignore: ReadonlySet<string>): boolean =>
    board.units.some(
        (unit) => !ignore.has(unit.getId()) && board.footprint(unit).some((entry) => sameCell(entry, cell)),
    );

const c33RankShape = (unit: Unit, board: IBoard, rank: number): boolean =>
    board.geom.baseCells.some((anchor) => {
        const cells = footprintCellsForAnchor(unit, anchor);
        return (
            cells.length > 0 &&
            cells.every(
                (cell) =>
                    board.geom.frontness(cell) === rank && board.geom.legal.has(keyOf(cell)) && !isBoardEdge(cell),
            )
        );
    });

const c33CornerLaterals = (board: IBoard): Set<number> => {
    const laterals = new Set<number>();
    for (const key of backCornerKeys(board.geom)) laterals.add(board.geom.lateral({ x: key >> 4, y: key & 0xf }));
    return laterals;
};

/** Low-half centre lateral, then the high-half match, then the next pair outward. Back corners are absent. */
const c33CentreLaterals = (board: IBoard): number[] => {
    const ranks = ranksOf(board);
    const corners = c33CornerLaterals(board);
    const low: number[] = [];
    const high: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (corners.has(lat) || !r3Cell(board, ranks.back, lat)) continue;
        if (lat <= board.geom.centreLat) low.push(lat);
        else high.push(lat);
    }
    const nearer = (a: number, b: number): number =>
        Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b;
    low.sort(nearer);
    high.sort(nearer);
    const order: number[] = [];
    const count = Math.max(low.length, high.length);
    for (let index = 0; index < count; index += 1) {
        if (index < low.length) order.push(low[index]);
        if (index < high.length) order.push(high[index]);
    }
    return order;
};

const c33Apply = (board: IBoard, moves: ReadonlyMap<string, XY>, locked: ReadonlySet<string>): boolean => {
    if (!moves.size) return false;
    for (const id of moves.keys()) {
        if (locked.has(id)) return false;
    }
    let changed = false;
    for (const [id, anchor] of moves) {
        const prior = board.cells.get(id);
        if (!prior || !sameCell(prior, anchor)) changed = true;
    }
    if (!changed) return true;
    const occupied = takenCells(board, new Set(moves.keys()));
    const resolved: { id: string; anchor: XY }[] = [];
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const cells = unit ? footprintCellsForAnchor(unit, anchor) : [];
        if (!unit || !r3Legal(cells, board, occupied)) return false;
        for (const cell of cells) occupied.add(keyOf(cell));
        resolved.push({ id, anchor });
    }
    for (const move of resolved) board.cells.set(move.id, { x: move.anchor.x, y: move.anchor.y });
    return true;
};

const c33Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    const corners = backCornerKeys(board.geom);
    const cornerBows: Unit[] = [];
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (unit.getAttackType() === RANGE || CASTER_STAYS.has(unit.getName()) || PROTECTORS.has(unit.getName())) {
            locked.add(unit.getId());
        }
        if (isCasterUnit(unit) && coveringProtectors(unit, board).length > 0) locked.add(unit.getId());
        if (unit.getAttackType() === RANGE && board.footprint(unit).some((cell) => corners.has(keyOf(cell)))) {
            cornerBows.push(unit);
        }
    }
    for (const bow of cornerBows) {
        const bowFront = new Map<number, number>();
        for (const cell of board.footprint(bow)) {
            const lat = board.geom.lateral(cell);
            bowFront.set(lat, Math.max(bowFront.get(lat) ?? -1, board.geom.frontness(cell)));
        }
        for (const [lat, front] of bowFront) {
            const guards = board.units.filter((unit) => {
                if (unit.getId() === bow.getId()) return false;
                return board
                    .footprint(unit)
                    .some((cell) => board.geom.lateral(cell) === lat && board.geom.frontness(cell) > front);
            });
            guards.sort((a, b) => {
                const ahead = (unit: Unit): number =>
                    Math.min(
                        ...board
                            .footprint(unit)
                            .filter((cell) => board.geom.lateral(cell) === lat)
                            .map((cell) => board.geom.frontness(cell)),
                    );
                return ahead(a) - ahead(b) || byId(a, b);
            });
            if (guards[0]) locked.add(guards[0].getId());
        }
    }
    return locked;
};

const c33Casters = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units
        .filter((unit) => isCasterUnit(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));

const c33SplashPair = (
    board: IBoard,
    caster: Unit,
    screen: Unit,
    lat: number,
    corners: ReadonlySet<number>,
): Map<string, XY> | undefined => {
    const ranks = ranksOf(board);
    if (ranks.front !== ranks.back + 2 || ranks.middle !== ranks.back + 1) return undefined;
    const middle = r3Cell(board, ranks.middle, lat);
    const back = r3Cell(board, ranks.back, lat);
    if (!middle || !back || corners.has(keyOf(back))) return undefined;
    const ignore = new Set([caster.getId(), screen.getId()]);
    if (c33OthersHold(board, middle, ignore)) return undefined;
    const taken = takenCells(board, ignore);
    const casterAnchor = r3AnchorOn(caster, board, taken, ranks.back, lat, (footprint) => !r3Hits(footprint, corners));
    const screenAnchor = r3AnchorOn(screen, board, taken, ranks.front, lat);
    if (!casterAnchor || !screenAnchor) return undefined;
    const casterCells = footprintCellsForAnchor(caster, casterAnchor);
    const screenCells = footprintCellsForAnchor(screen, screenAnchor);
    if (minChebyshev(casterCells, screenCells) !== 2) return undefined;
    if (r3Hits(casterCells, corners) || r3Hits(screenCells, corners)) return undefined;
    return new Map<string, XY>([
        [caster.getId(), casterAnchor],
        [screen.getId(), screenAnchor],
    ]);
};

const c33BranchSplash = (board: IBoard, locked: ReadonlySet<string>): void => {
    const corners = backCornerKeys(board.geom);
    const laterals = c33CentreLaterals(board);
    const usedLats = new Set<number>();
    const usedScreens = new Set<string>();
    for (const caster of c33Casters(board, locked)) {
        if (!c33RankShape(caster, board, ranksOf(board).back)) continue;
        const screen = c33Nearest(
            caster,
            c33ScreenUnits(board, locked).filter((unit) => !usedScreens.has(unit.getId())),
            board,
        );
        if (!screen) continue;
        for (const lat of laterals) {
            if (usedLats.has(lat)) continue;
            const moves = c33SplashPair(board, caster, screen, lat, corners);
            if (!moves || !c33Apply(board, moves, locked)) continue;
            usedScreens.add(screen.getId());
            for (const [id, anchor] of moves) {
                const unit = id === caster.getId() ? caster : screen;
                for (const cell of footprintCellsForAnchor(unit, anchor)) usedLats.add(board.geom.lateral(cell));
            }
            break;
        }
    }
};

const c33ForwardAlly = (caster: Unit, board: IBoard): Unit | undefined => {
    const mine = board.footprint(caster);
    if (!mine.length) return undefined;
    const myLats = new Set(mine.map((cell) => board.geom.lateral(cell)));
    const myFront = Math.max(...mine.map((cell) => board.geom.frontness(cell)));
    const frontOf = (unit: Unit): number => {
        let best = -1;
        for (const cell of board.footprint(unit)) {
            if (!myLats.has(board.geom.lateral(cell)) || board.geom.frontness(cell) <= myFront) continue;
            best = Math.max(best, board.geom.frontness(cell));
        }
        return best;
    };
    const allies = board.units.filter((unit) => unit.getId() !== caster.getId() && frontOf(unit) >= 0);
    allies.sort((a, b) => frontOf(b) - frontOf(a) || byId(a, b));
    return allies[0];
};

const c33ShoulderGeometry = (
    caster: Unit,
    ally: Unit,
    lat: number,
    board: IBoard,
    corners: ReadonlySet<number>,
): XY | undefined => {
    const ranks = ranksOf(board);
    const limits = zoneLimits(board.geom);
    const cell = r3Cell(board, ranks.back, lat);
    if (!cell || lat < limits.minLat || lat > limits.maxLat || corners.has(keyOf(cell))) return undefined;
    const anchor = r3AnchorOn(caster, board, new Set(), ranks.back, lat, (footprint) => !r3Hits(footprint, corners));
    if (!anchor) return undefined;
    if (minChebyshev(footprintCellsForAnchor(caster, anchor), board.footprint(ally)) !== 2) return undefined;
    return anchor;
};

const c33CellsFree = (board: IBoard, cells: readonly XY[], selfId: string): boolean =>
    !board.units.some(
        (unit) =>
            unit.getId() !== selfId &&
            board.footprint(unit).some((cell) => cells.some((entry) => sameCell(entry, cell))),
    );

const c33BranchLine = (board: IBoard, locked: ReadonlySet<string>): void => {
    const corners = backCornerKeys(board.geom);
    const used = new Set<string>();
    for (const caster of c33Casters(board, locked)) {
        if (caster.canFly()) continue;
        const ally = c33ForwardAlly(caster, board);
        const laterals = ally ? board.laterals(ally) : [];
        if (!ally || !laterals.length) continue;
        const span = { min: Math.min(...laterals), max: Math.max(...laterals) };
        const current = medianLat(caster, board);
        const shoulders: { lat: number; anchor: XY }[] = [];
        for (const lat of [span.min - 1, span.max + 1]) {
            const anchor = c33ShoulderGeometry(caster, ally, lat, board, corners);
            if (anchor) shoulders.push({ lat, anchor });
        }
        shoulders.sort((a, b) => Math.abs(a.lat - current) - Math.abs(b.lat - current) || a.lat - b.lat);
        const preferred = shoulders[0];
        if (!preferred) continue;
        const preferredKey = `${ally.getId()}:${preferred.lat}`;
        let chosen = preferred;
        if (used.has(preferredKey)) {
            const opposite = shoulders.find((entry) => entry.lat !== preferred.lat);
            if (!opposite || used.has(`${ally.getId()}:${opposite.lat}`)) continue;
            chosen = opposite;
        }
        const cells = footprintCellsForAnchor(caster, chosen.anchor);
        if (!c33CellsFree(board, cells, caster.getId())) continue;
        if (!c33Apply(board, new Map([[caster.getId(), chosen.anchor]]), locked)) continue;
        used.add(`${ally.getId()}:${chosen.lat}`);
    }
};

const c33OnlyLateral = (unit: Unit, board: IBoard): number | undefined => {
    const laterals = [...new Set(board.laterals(unit))];
    return laterals.length === 1 ? laterals[0] : undefined;
};

const c33SoleBowNeighbors = (board: IBoard): Set<string> => {
    const sole = new Set<string>();
    for (const bow of board.units) {
        if (bow.getAttackType() !== RANGE) continue;
        const cells = board.footprint(bow);
        if (!cells.length) continue;
        const neighbors = board.units.filter((unit) => {
            if (unit.getId() === bow.getId()) return false;
            const footprint = board.footprint(unit);
            return footprint.length > 0 && minChebyshev(footprint, cells) <= 1;
        });
        if (neighbors.length === 1) sole.add(neighbors[0].getId());
    }
    return sole;
};

const c33BranchFlyers = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = ranksOf(board);
    const cornerLats = c33CornerLaterals(board);
    const corners = backCornerKeys(board.geom);
    const sole = c33SoleBowNeighbors(board);
    const ownRange = board.units.filter((unit) => unit.getAttackType() === RANGE).length;
    const used = new Set<string>();
    for (const caster of c33Casters(board, locked)) {
        const origin = c33OnlyLateral(caster, board);
        if (origin === undefined) continue;
        let lat = origin;
        if (ownRange >= 2 && cornerLats.has(lat)) {
            if (lat < board.geom.centreLat) lat += 1;
            else if (lat > board.geom.centreLat) lat -= 1;
        }
        const screens = c33ScreenUnits(board, locked).filter(
            (unit) => unit.isSmallSize() && !used.has(unit.getId()) && !sole.has(unit.getId()),
        );
        const screen = c33Nearest(caster, screens, board);
        if (!screen) continue;
        const back = r3Cell(board, ranks.back, lat);
        const middle = r3Cell(board, ranks.middle, lat);
        if (!back || !middle) continue;
        const ignore = new Set([caster.getId(), screen.getId()]);
        if (c33OthersHold(board, back, ignore) || c33OthersHold(board, middle, ignore)) continue;
        const taken = takenCells(board, ignore);
        const casterAnchor = r3AnchorOn(caster, board, taken, ranks.middle, lat);
        const screenAnchor = r3AnchorOn(screen, board, taken, ranks.back, lat);
        if (!casterAnchor || !screenAnchor) continue;
        const casterCells = footprintCellsForAnchor(caster, casterAnchor);
        const screenCells = footprintCellsForAnchor(screen, screenAnchor);
        const screenFront = Math.max(...screenCells.map((cell) => board.geom.frontness(cell)));
        const casterBack = Math.min(...casterCells.map((cell) => board.geom.frontness(cell)));
        if (minChebyshev(casterCells, screenCells) !== 1 || screenFront >= casterBack) continue;
        if (ownRange >= 2 && (r3Hits(casterCells, corners) || r3Hits(screenCells, corners))) continue;
        const moves = new Map<string, XY>([
            [caster.getId(), casterAnchor],
            [screen.getId(), screenAnchor],
        ]);
        if (!c33Apply(board, moves, locked)) continue;
        used.add(screen.getId());
    }
};

const c33OnFront = (unit: Unit, board: IBoard, front: number): boolean => {
    const cells = board.footprint(unit);
    return cells.length > 0 && cells.every((cell) => board.geom.frontness(cell) === front);
};

const c33AlreadyShadowed = (caster: Unit, screen: Unit, board: IBoard, ranks: IRanks): boolean => {
    const mine = board.footprint(caster);
    const wall = board.footprint(screen);
    if (!c33OnFront(screen, board, ranks.front) || !mine.length) return false;
    if (!mine.every((cell) => board.geom.frontness(cell) === ranks.middle)) return false;
    if (minChebyshev(mine, wall) !== 1) return false;
    return mine.some((cell) =>
        wall.some(
            (other) =>
                board.geom.lateral(other) === board.geom.lateral(cell) &&
                board.geom.frontness(other) === board.geom.frontness(cell) + 1,
        ),
    );
};

const c33ShadowAnchor = (caster: Unit, screen: Unit, board: IBoard, ranks: IRanks): XY | undefined => {
    const wall = board.footprint(screen);
    if (!c33OnFront(screen, board, ranks.front)) return undefined;
    const taken = takenCells(board, new Set([caster.getId()]));
    const current = board.cells.get(caster.getId());
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const cell of wall) {
        const shadow = board.geom.towardEnemy(cell, -1);
        if (board.geom.frontness(shadow) !== ranks.middle || board.geom.lateral(shadow) !== board.geom.lateral(cell)) {
            continue;
        }
        if (!board.geom.legal.has(keyOf(shadow)) || isBoardEdge(shadow) || c33OthersHold(board, shadow, new Set())) {
            continue;
        }
        const anchor = r3AnchorOn(caster, board, taken, ranks.middle, board.geom.lateral(shadow), (footprint) => {
            if (!footprint.some((entry) => sameCell(entry, shadow))) return false;
            return minChebyshev(footprint, wall) === 1;
        });
        if (!anchor) continue;
        const dist = current ? chebyshev(anchor, current) : 0;
        if (
            !best ||
            dist < bestDist ||
            (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestDist = dist;
        }
    }
    return best;
};

const c33BranchShooters = (board: IBoard, locked: ReadonlySet<string>): void => {
    const ranks = ranksOf(board);
    const used = new Set<string>();
    for (const caster of c33Casters(board, locked)) {
        const screens = c33ScreenUnits(board, new Set()).filter((unit) => !used.has(unit.getId()));
        const current = c33Nearest(
            caster,
            screens.filter((screen) => c33AlreadyShadowed(caster, screen, board, ranks)),
            board,
        );
        if (current) {
            used.add(current.getId());
            continue;
        }
        const screen = c33Nearest(
            caster,
            screens.filter((candidate) => c33ShadowAnchor(caster, candidate, board, ranks) !== undefined),
            board,
        );
        if (!screen) continue;
        const anchor = c33ShadowAnchor(caster, screen, board, ranks);
        if (!anchor || !c33Apply(board, new Map([[caster.getId(), anchor]]), locked)) continue;
        used.add(screen.getId());
    }
};

const c33Branch = (threats: IPublicPlacementThreats): "splash" | "line" | "flyers" | "shooters" | undefined => {
    if (threats.areaThrow || threats.largeCaliber) return "splash";
    if (threats.fireBreath || threats.skewerStrike || threats.throughShot) return "line";
    if (threats.flyers >= 2) return "flyers";
    if (
        threats.rangeCreatures >= 2 &&
        threats.flyers < 2 &&
        !threats.fireball &&
        !threats.ringOfFire &&
        !threats.meteorShower
    ) {
        return "shooters";
    }
    return undefined;
};

/**
 * r3c3 post-pass. Today's placeArmy has already run. A non-range caster and one screen stand
 * where that public threat misses. The size-3 zone, the augment spend, and every other stack stay.
 */
export function placeArmyR3C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const branch = c33Branch(publicPlacementThreats(context.publicOpponentCreatureIds));
    if (!branch) return new Map(board.cells);
    const locked = c33Locked(board);
    if (branch === "splash") c33BranchSplash(board, locked);
    else if (branch === "line") c33BranchLine(board, locked);
    else if (branch === "flyers") c33BranchFlyers(board, locked);
    else c33BranchShooters(board, locked);
    return board.cells;
}

const c41Hp = (unit: Unit): number => unit.getCumulativeHp();

const c41Damage = (unit: Unit): number => (unit.getAttackDamageMin() + unit.getAttackDamageMax()) / 2;

const c41Splash = (unit: Unit): boolean => r3HasAbility(unit, "Area Throw") || r3HasAbility(unit, "Large Caliber");

const c41Leather = (unit: Unit): boolean => r3HasAbility(unit, "Leather Armor");

const c41Aura = (unit: Unit): boolean => r3HasAbility(unit, "Guiding Winds");

const c41Blast = (threats: IPublicPlacementThreats): boolean =>
    threats.fireball || threats.ringOfFire || threats.meteorShower;

const c41MeleeScreen = (unit: Unit): boolean =>
    !unit.canFly() &&
    !isCharger(unit) &&
    !isSpellbookUnit(unit) &&
    !isCasterUnit(unit) &&
    !PROTECTORS.has(unit.getName()) &&
    (unit.getAttackType() === MELEE || unit.getAttackType() === MELEE_MAGIC);

const c41Distance = (left: Unit, right: Unit, board: IBoard): number => {
    const a = board.footprint(left);
    const b = board.footprint(right);
    if (!a.length || !b.length) return Infinity;
    return minChebyshev(a, b);
};

const c41Ordered = (left: Unit, right: Unit): [Unit, Unit] => (byId(left, right) <= 0 ? [left, right] : [right, left]);

const c41Pairs = (board: IBoard, bows: readonly Unit[]): [Unit, Unit][] => {
    const placed = board.units.filter((unit) => board.footprint(unit).length > 0);
    const all: [Unit, Unit][] = [];
    for (let i = 0; i < placed.length; i += 1) {
        for (let j = i + 1; j < placed.length; j += 1) {
            if (c41Distance(placed[i], placed[j], board) === 2) all.push(c41Ordered(placed[i], placed[j]));
        }
    }
    all.sort((a, b) => byId(a[0], b[0]) || byId(a[1], b[1]));
    if (bows.length >= 3) return all;
    if (bows.length === 2 && c41Distance(bows[0], bows[1], board) === 2) return [[bows[0], bows[1]]];
    const mixed = all.filter(
        ([left, right]) =>
            (c41MeleeScreen(left) && right.getAttackType() === RANGE) ||
            (c41MeleeScreen(right) && left.getAttackType() === RANGE),
    );
    if (mixed.length) return [mixed[0]];
    return all.slice(0, 1);
};

const c41Steps = (unit: Unit, board: IBoard): XY[] => {
    const anchor = board.cells.get(unit.getId());
    if (!anchor) return [];
    const steps = [board.geom.shiftLateral(anchor, 1), board.geom.shiftLateral(anchor, -1)];
    if (unit.getAttackType() !== RANGE) {
        steps.push(board.geom.towardEnemy(anchor, 1), board.geom.towardEnemy(anchor, -1));
    }
    const touched = board.footprint(unit).some((cell) => board.geom.frontness(cell) === board.geom.backFront);
    return steps.filter((spot) => {
        if (sameCell(spot, anchor) || !board.free(unit, spot)) return false;
        if (unit.getAttackType() !== RANGE) return true;
        if (!touched) return false;
        return footprintCellsForAnchor(unit, spot).some((cell) => board.geom.frontness(cell) === board.geom.backFront);
    });
};

const c41KeepsGaps = (unit: Unit, anchor: XY, partner: Unit, board: IBoard): boolean => {
    const next = footprintCellsForAnchor(unit, anchor);
    const current = board.footprint(unit);
    if (!next.length || minChebyshev(next, board.footprint(partner)) < 3) return false;
    for (const other of board.units) {
        if (other.getId() === unit.getId()) continue;
        const cells = board.footprint(other);
        if (!cells.length) continue;
        const dist = minChebyshev(next, cells);
        const old = minChebyshev(current, cells);
        if (old >= 2 && dist < 2) return false;
        if (old < 2 && dist < old) return false;
    }
    return true;
};

const c41NudgeSpot = (unit: Unit, partner: Unit, board: IBoard): XY | undefined => {
    const origin = board.cells.get(unit.getId());
    if (!origin) return undefined;
    const partnerCells = board.footprint(partner);
    const spots = c41Steps(unit, board).filter((spot) => c41KeepsGaps(unit, spot, partner, board));
    spots.sort((a, b) => {
        const sep =
            minChebyshev(footprintCellsForAnchor(unit, a), partnerCells) -
            minChebyshev(footprintCellsForAnchor(unit, b), partnerCells);
        return sep || chebyshev(a, origin) - chebyshev(b, origin) || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const c41Preferred = (left: Unit, right: Unit): Unit => {
    const leftScreen = c41MeleeScreen(left) && right.getAttackType() === RANGE;
    const rightScreen = c41MeleeScreen(right) && left.getAttackType() === RANGE;
    if (leftScreen !== rightScreen) return leftScreen ? left : right;
    const hp = c41Hp(left) - c41Hp(right);
    if (hp !== 0) return hp < 0 ? left : right;
    return byId(left, right) <= 0 ? left : right;
};

/** One step only. Two bows nudge their own pair; three or more nudge every distance-2 pair. */
const c41BranchA = (board: IBoard, bows: readonly Unit[]): void => {
    const moved = new Set<string>();
    for (const [left, right] of c41Pairs(board, bows)) {
        if (c41Distance(left, right, board) !== 2) continue;
        const mover = c41Preferred(left, right);
        if (moved.has(mover.getId())) continue;
        const partner = mover === left ? right : left;
        const spot = c41NudgeSpot(mover, partner, board);
        if (!spot || !board.place(mover, spot)) continue;
        moved.add(mover.getId());
    }
};

const c41ThirdTargets = (board: IBoard): [number, number] => {
    const limits = zoneLimits(board.geom);
    const span = limits.maxLat - limits.minLat;
    return [limits.minLat + span / 3, limits.minLat + (2 * span) / 3];
};

const c41InwardLat = (lat: number, board: IBoard): boolean => {
    const limits = zoneLimits(board.geom);
    return (
        lat === limits.minLat + 1 || lat === limits.minLat + 2 || lat === limits.maxLat - 1 || lat === limits.maxLat - 2
    );
};

const c41CornerBows = (bows: readonly Unit[], board: IBoard): Unit[] => {
    const corners = backCornerKeys(board.geom);
    const touching = bows.filter((bow) => board.footprint(bow).some((cell) => corners.has(keyOf(cell))));
    return touching.length <= 2 ? touching : lockedBows(touching, board);
};

const c41BetterSlide = (
    score: number,
    near: number,
    bow: Unit,
    anchor: XY,
    best: { bow: Unit; anchor: XY; score: number; near: number },
): boolean => {
    if (score < best.score - 1e-9) return true;
    if (score > best.score + 1e-9) return false;
    if (near < best.near - 1e-9) return true;
    if (near > best.near + 1e-9) return false;
    const order = byId(bow, best.bow);
    if (order !== 0) return order < 0;
    return anchor.x < best.anchor.x || (anchor.x === best.anchor.x && anchor.y < best.anchor.y);
};

/**
 * Back-rank slide to a third. Gap is 4, or 5 under Range Null Field — not the old deepest-gap cell.
 * Corner laterals stay with the incumbent corner bows.
 */
const c41SlideThirds = (
    board: IBoard,
    bows: readonly Unit[],
    threats: IPublicPlacementThreats,
    avoidInwardAura: boolean,
): void => {
    const gap = threats.rangeNullField ? 5 : 4;
    const [oneThird, twoThirds] = c41ThirdTargets(board);
    const corners = backCornerKeys(board.geom);
    const cornerBows = c41CornerBows(bows, board);
    const cornerIds = new Set(cornerBows.map((bow) => bow.getId()));
    const pending = bows.filter(
        (bow) =>
            !cornerIds.has(bow.getId()) &&
            board.footprint(bow).some((cell) => board.geom.frontness(cell) === board.geom.backFront),
    );
    const reseated: Unit[] = [];
    const done = new Set<string>();
    const distToThird = (lat: number): number => Math.min(Math.abs(lat - oneThird), Math.abs(lat - twoThirds));
    while (pending.some((bow) => !done.has(bow.getId()))) {
        let best: { bow: Unit; anchor: XY; score: number; near: number } | undefined;
        for (const bow of pending) {
            if (done.has(bow.getId())) continue;
            const current = board.cells.get(bow.getId());
            if (!current) continue;
            const currentLat = medianNumber(board.laterals(bow));
            const used = new Set<number>();
            for (const other of board.units) {
                if (other.getId() === bow.getId()) continue;
                for (const lat of board.laterals(other)) used.add(lat);
            }
            const obstacles = [...cornerBows, ...reseated]
                .filter((other) => other.getId() !== bow.getId())
                .map((other) => board.footprint(other))
                .filter((cells) => cells.length > 0);
            for (const anchor of board.geom.baseCells) {
                if (board.geom.frontness(anchor) !== board.geom.frontness(current)) continue;
                if (!board.free(bow, anchor)) continue;
                const footprint = footprintCellsForAnchor(bow, anchor);
                if (!footprint.length || !footprint.every((cell) => board.geom.legal.has(keyOf(cell)))) continue;
                const laterals = footprint.map((cell) => board.geom.lateral(cell));
                if (laterals.some((lat) => used.has(lat))) continue;
                if (footprint.some((cell) => corners.has(keyOf(cell)))) continue;
                if (avoidInwardAura && c41Aura(bow) && laterals.some((lat) => c41InwardLat(lat, board))) continue;
                if (obstacles.some((cells) => minChebyshev(footprint, cells) < gap)) continue;
                const score = Math.min(...laterals.map(distToThird));
                const near = Math.abs(medianNumber(laterals) - currentLat);
                if (!best || c41BetterSlide(score, near, bow, anchor, best)) best = { bow, anchor, score, near };
            }
        }
        if (!best) break;
        done.add(best.bow.getId());
        const current = board.cells.get(best.bow.getId());
        if (current && !sameCell(current, best.anchor) && !board.place(best.bow, best.anchor)) continue;
        reseated.push(best.bow);
    }
};

const c41ClearFiles = (board: IBoard, bows: readonly Unit[], needGap: boolean): void => {
    const blocked = new Set<number>();
    for (const bow of bows) {
        for (const lat of board.laterals(bow)) blocked.add(lat);
    }
    const movers = board.units
        .filter(
            (unit) =>
                unit.getAttackType() !== RANGE &&
                board.footprint(unit).length > 0 &&
                board.laterals(unit).some((lat) => blocked.has(lat)),
        )
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    const moved: Unit[] = [];
    const front = zoneLimits(board.geom).maxFront;
    for (const unit of movers) {
        const current = board.cells.get(unit.getId());
        if (!current) continue;
        const currentLat = medianNumber(board.laterals(unit));
        const bowFeet = bows.map((bow) => board.footprint(bow)).filter((cells) => cells.length > 0);
        const spots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            if (!board.free(unit, anchor)) continue;
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!footprint.length || Math.max(...footprint.map((cell) => board.geom.frontness(cell))) !== front) {
                continue;
            }
            if (footprint.some((cell) => blocked.has(board.geom.lateral(cell)))) continue;
            if (needGap && bowFeet.some((cells) => minChebyshev(footprint, cells) < 2)) continue;
            if (needGap && moved.some((other) => minChebyshev(footprint, board.footprint(other)) < 2)) continue;
            spots.push(anchor);
        }
        spots.sort((a, b) => {
            const aLat = medianNumber(lateralsOfAnchor(unit, a, board.geom));
            const bLat = medianNumber(lateralsOfAnchor(unit, b, board.geom));
            const near = Math.abs(aLat - currentLat) - Math.abs(bLat - currentLat);
            const centre = Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat);
            return near || centre || chebyshev(a, current) - chebyshev(b, current) || a.x - b.x || a.y - b.y;
        });
        const spot = spots[0];
        if (!spot || sameCell(spot, current) || !board.place(unit, spot)) continue;
        moved.push(unit);
    }
};

const c41BranchB = (board: IBoard, threats: IPublicPlacementThreats, bows: readonly Unit[]): void => {
    if (bows.length >= 3 && c41Blast(threats)) c41SlideThirds(board, bows, threats, false);
    c41ClearFiles(board, bows, c41Blast(threats));
};

const c41BranchC = (board: IBoard, threats: IPublicPlacementThreats, bows: readonly Unit[]): void => {
    if (bows.length < 3) return;
    c41SlideThirds(board, bows, threats, true);
};

const c41CornerCells = (board: IBoard): XY[] => {
    const cells = [...backCornerKeys(board.geom)].map((key) => ({ x: key >> 4, y: key & 0xf }));
    cells.sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b) || a.x - b.x || a.y - b.y);
    const picked: XY[] = [];
    const seen = new Set<number>();
    for (const cell of cells) {
        const lat = board.geom.lateral(cell);
        if (seen.has(lat)) continue;
        seen.add(lat);
        picked.push(cell);
    }
    return picked;
};

const c41Covers = (unit: Unit, target: XY, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => sameCell(cell, target));

const c41FitsAt = (unit: Unit, anchor: XY, board: IBoard, ignore: ReadonlySet<string>): boolean => {
    const footprint = footprintCellsForAnchor(unit, anchor);
    if (!footprint.length) return false;
    const taken = takenCells(board, ignore);
    return footprint.every((cell) => board.geom.legal.has(keyOf(cell)) && !taken.has(keyOf(cell)));
};

const c41Commit = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    if (!moves.size) return false;
    const ignore = new Set(moves.keys());
    const occupied = new Set<number>();
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit || !c41FitsAt(unit, anchor, board, ignore)) return false;
        for (const cell of footprintCellsForAnchor(unit, anchor)) {
            const key = keyOf(cell);
            if (occupied.has(key)) return false;
            occupied.add(key);
        }
    }
    for (const [id, anchor] of moves) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const c41AnchorCovering = (unit: Unit, target: XY, board: IBoard, ignore: ReadonlySet<string>): XY | undefined => {
    const spots = board.geom.baseCells.filter((anchor) => {
        const footprint = footprintCellsForAnchor(unit, anchor);
        return footprint.some((cell) => sameCell(cell, target)) && c41FitsAt(unit, anchor, board, ignore);
    });
    spots.sort((a, b) => (sameCell(a, target) ? 0 : 1) - (sameCell(b, target) ? 0 : 1) || a.x - b.x || a.y - b.y);
    return spots[0];
};

const c41BackSpots = (unit: Unit, board: IBoard, ignore: ReadonlySet<string>): XY[] => {
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.length) continue;
        if (Math.min(...footprint.map((cell) => board.geom.frontness(cell))) !== board.geom.backFront) continue;
        if (!c41FitsAt(unit, anchor, board, ignore)) continue;
        spots.push(anchor);
    }
    return spots;
};

const c41GapAtLeast = (footprint: readonly XY[], others: readonly (readonly XY[])[], gap: number): boolean =>
    others.every((cells) => !cells.length || minChebyshev(footprint, cells) >= gap);

const c41MoveOnto = (board: IBoard, unit: Unit, target: XY, hold: ReadonlySet<string>): boolean => {
    if (c41Covers(unit, target, board)) return true;
    const occupant = board.units.find((other) => other.getId() !== unit.getId() && c41Covers(other, target, board));
    if (occupant && (occupant.getAttackType() !== RANGE || hold.has(occupant.getId()))) return false;
    // A splash bow's corner can be refilled only by a one-cell non-splash bow.
    if (occupant && c41Splash(occupant) && !unit.isSmallSize()) return false;
    const ignore = new Set<string>([unit.getId()]);
    if (occupant) ignore.add(occupant.getId());
    const anchor = c41AnchorCovering(unit, target, board, ignore);
    if (!anchor) return false;
    if (!occupant) return c41Commit(board, new Map([[unit.getId(), anchor]]));
    const origin = board.cells.get(unit.getId());
    if (!origin) return false;
    if (
        c41Commit(
            board,
            new Map([
                [unit.getId(), anchor],
                [occupant.getId(), origin],
            ]),
        )
    ) {
        return true;
    }
    const current = board.cells.get(occupant.getId());
    const leftovers = c41BackSpots(occupant, board, ignore).filter((spot) => {
        const foot = footprintCellsForAnchor(occupant, spot);
        return (
            !foot.some((cell) => sameCell(cell, target)) &&
            minChebyshev(foot, footprintCellsForAnchor(unit, anchor)) > 0
        );
    });
    leftovers.sort((a, b) => {
        const aDist = current ? chebyshev(a, current) : 0;
        const bDist = current ? chebyshev(b, current) : 0;
        return aDist - bDist || a.x - b.x || a.y - b.y;
    });
    const spot = leftovers[0];
    if (!spot) return false;
    return c41Commit(
        board,
        new Map([
            [unit.getId(), anchor],
            [occupant.getId(), spot],
        ]),
    );
};

const c41SeatCorners = (board: IBoard, recipients: readonly Unit[]): void => {
    const corners = c41CornerCells(board);
    const seated = new Set<string>();
    const used = new Set<number>();
    for (const bow of recipients) {
        for (const corner of corners) {
            if (!c41Covers(bow, corner, board)) continue;
            seated.add(bow.getId());
            used.add(keyOf(corner));
            break;
        }
    }
    const hold = new Set<string>(seated);
    for (const bow of recipients) {
        if (seated.has(bow.getId())) continue;
        const anchor = board.cells.get(bow.getId());
        const options = corners.filter((corner) => !used.has(keyOf(corner)));
        options.sort((a, b) => {
            const aDist = anchor ? chebyshev(anchor, a) : 0;
            const bDist = anchor ? chebyshev(anchor, b) : 0;
            return aDist - bDist || board.geom.lateral(a) - board.geom.lateral(b);
        });
        for (const corner of options) {
            if (!c41MoveOnto(board, bow, corner, hold)) continue;
            seated.add(bow.getId());
            used.add(keyOf(corner));
            hold.add(bow.getId());
            break;
        }
    }
};

const c41SeatSplash = (board: IBoard, splash: Unit): boolean => {
    const ignore = new Set([splash.getId()]);
    const others = board.units
        .filter((unit) => unit.getId() !== splash.getId() && board.footprint(unit).length > 0)
        .map((unit) => board.footprint(unit));
    const current = board.cells.get(splash.getId());
    const spots = c41BackSpots(splash, board, ignore).filter((anchor) =>
        c41GapAtLeast(footprintCellsForAnchor(splash, anchor), others, 2),
    );
    spots.sort((a, b) => {
        const aLat = medianNumber(lateralsOfAnchor(splash, a, board.geom));
        const bLat = medianNumber(lateralsOfAnchor(splash, b, board.geom));
        return Math.abs(aLat - board.geom.centreLat) - Math.abs(bLat - board.geom.centreLat) || a.x - b.x || a.y - b.y;
    });
    const spot = spots[0];
    if (!spot) return false;
    if (current && sameCell(current, spot)) return true;
    return c41Commit(board, new Map([[splash.getId(), spot]]));
};

const c41CoveredCorners = (unit: Unit, board: IBoard): XY[] =>
    c41CornerCells(board).filter((corner) => c41Covers(unit, corner, board));

const c41Refill = (board: IBoard, splash: Unit, before: readonly XY[]): void => {
    const after = board.footprint(splash);
    const vacated = before.filter((corner) => !after.some((cell) => sameCell(cell, corner)));
    const corners = c41CornerCells(board);
    for (const corner of vacated) {
        if (board.units.some((unit) => c41Covers(unit, corner, board))) continue;
        const candidates = placedRange(board.units, board)
            .filter(
                (unit) =>
                    unit.getId() !== splash.getId() &&
                    unit.isSmallSize() &&
                    !c41Splash(unit) &&
                    !c41Leather(unit) &&
                    !corners.some((cell) => c41Covers(unit, cell, board)),
            )
            .sort((a, b) => {
                const aAnchor = board.cells.get(a.getId());
                const bAnchor = board.cells.get(b.getId());
                const aDist = aAnchor ? chebyshev(aAnchor, corner) : 0;
                const bDist = bAnchor ? chebyshev(bAnchor, corner) : 0;
                return aDist - bDist || c41Hp(b) - c41Hp(a) || byId(a, b);
            });
        for (const bow of candidates) {
            const ignore = new Set([bow.getId()]);
            const anchor = c41AnchorCovering(bow, corner, board, ignore);
            if (!anchor || minChebyshev(footprintCellsForAnchor(bow, anchor), after) < 2) continue;
            if (c41Commit(board, new Map([[bow.getId(), anchor]]))) break;
        }
    }
};

const c41HigherDamageCorner = (board: IBoard, corners: readonly XY[]): Unit | undefined => {
    const seated = placedRange(board.units, board).filter((bow) =>
        corners.some((corner) => c41Covers(bow, corner, board)),
    );
    seated.sort((a, b) => c41Damage(b) - c41Damage(a) || c41Hp(b) - c41Hp(a) || byId(a, b));
    return seated[0];
};

const c41SeatAura = (board: IBoard, threats: IPublicPlacementThreats): void => {
    if (!threats.chakram) return;
    const corners = c41CornerCells(board);
    const carriers = placedRange(board.units, board)
        .filter((bow) => c41Aura(bow) && !c41Splash(bow) && !corners.some((corner) => c41Covers(bow, corner, board)))
        .sort(byId);
    for (const carrier of carriers) {
        const ignore = new Set([carrier.getId()]);
        const current = board.cells.get(carrier.getId());
        let spots = c41BackSpots(carrier, board, ignore);
        if (!c41Blast(threats)) {
            const focus = c41HigherDamageCorner(board, corners);
            if (!focus) continue;
            const focusCells = board.footprint(focus);
            spots = spots.filter((anchor) => minChebyshev(footprintCellsForAnchor(carrier, anchor), focusCells) === 1);
            spots.sort((a, b) => {
                const aDist = current ? chebyshev(a, current) : 0;
                const bDist = current ? chebyshev(b, current) : 0;
                return aDist - bDist || a.x - b.x || a.y - b.y;
            });
        } else {
            const bowFeet = placedRange(board.units, board)
                .filter((bow) => bow.getId() !== carrier.getId())
                .map((bow) => board.footprint(bow));
            spots = spots.filter((anchor) => c41GapAtLeast(footprintCellsForAnchor(carrier, anchor), bowFeet, 4));
            spots.sort((a, b) => {
                const aLat = medianNumber(lateralsOfAnchor(carrier, a, board.geom));
                const bLat = medianNumber(lateralsOfAnchor(carrier, b, board.geom));
                const aNear = current ? Math.abs(aLat - board.geom.lateral(current)) : 0;
                const bNear = current ? Math.abs(bLat - board.geom.lateral(current)) : 0;
                return aNear - bNear || a.x - b.x || a.y - b.y;
            });
        }
        const spot = spots[0];
        if (!spot || (current && sameCell(current, spot))) continue;
        c41Commit(board, new Map([[carrier.getId(), spot]]));
    }
};

const c41SeatLeather = (board: IBoard): void => {
    const corners = c41CornerCells(board);
    for (const leather of placedRange(board.units, board).filter(c41Leather).sort(byId)) {
        const onCorner = corners.some((corner) => c41Covers(leather, corner, board));
        const onBack = board.footprint(leather).some((cell) => board.geom.frontness(cell) === board.geom.backFront);
        if (!onCorner && onBack) continue;
        const ignore = new Set([leather.getId()]);
        const current = board.cells.get(leather.getId());
        const spots = c41BackSpots(leather, board, ignore).filter((anchor) => {
            const footprint = footprintCellsForAnchor(leather, anchor);
            return !footprint.some((cell) => corners.some((corner) => sameCell(cell, corner)));
        });
        spots.sort((a, b) => {
            const aDist = current ? chebyshev(a, current) : 0;
            const bDist = current ? chebyshev(b, current) : 0;
            return aDist - bDist || a.x - b.x || a.y - b.y;
        });
        const spot = spots[0];
        if (!spot || (current && sameCell(current, spot))) continue;
        c41Commit(board, new Map([[leather.getId(), spot]]));
    }
};

const c41BranchD = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const bows = placedRange(board.units, board);
    if (bows.length < 2) return;
    // Sniper bows are claimants. Leather and our own splash never take a corner.
    const recipients = bows
        .filter((bow) => !c41Leather(bow) && !c41Splash(bow))
        .sort((a, b) => c41Hp(b) - c41Hp(a) || byId(a, b))
        .slice(0, 2);
    c41SeatCorners(board, recipients);
    if (bows.length === 2) return;
    c41SeatAura(board, threats);
    c41SeatLeather(board);
    c41SeatCorners(board, recipients);
    for (const splash of bows.filter(c41Splash).sort(byId)) {
        const before = c41CoveredCorners(splash, board);
        if (!c41SeatSplash(board, splash)) continue;
        c41Refill(board, splash, before);
    }
};

const c41BranchE = (board: IBoard): void => {
    for (const splash of placedRange(board.units, board).filter(c41Splash).sort(byId)) {
        const before = c41CoveredCorners(splash, board);
        if (!c41SeatSplash(board, splash)) continue;
        c41Refill(board, splash, before);
    }
};

/**
 * r4c1 post-pass. Today's placeArmy has already run. Pierce clears the bow file, blasts slide
 * extra bows along the back rank to the thirds, and the highest-HP bows hold the corners.
 * The size-3 zone and the augment spend stay.
 */
export function placeArmyR4C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const bows = placedRange(units, board);
    if (bows.length < 2) return new Map(board.cells);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) c41BranchA(board, bows);
    else if (threats.fireBreath || threats.skewerStrike || threats.throughShot) c41BranchB(board, threats, bows);
    else if (c41Blast(threats)) c41BranchC(board, threats, bows);
    else if (threats.rangeCreatures >= 2 && threats.flyers === 0) c41BranchD(board, threats);
    else if (bows.some(c41Splash)) c41BranchE(board);
    return board.cells;
}

const c42Ranged = (unit: Unit): boolean => unit.getAttackType() === RANGE;

const c42Flyer = (unit: Unit): boolean => unit.canFly() && !c42Ranged(unit);

const c42FastCharger = (board: IBoard): Unit | undefined =>
    board.units
        .filter((unit) => isCharger(unit) && !c42Ranged(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => b.getSteps() - a.getSteps() || byId(a, b))[0];

const c42IsWing = (unit: Unit, charger: Unit | undefined): boolean => c42Flyer(unit) && unit !== charger;

const c42LatSpan = (unit: Unit, geom: IGeom): number =>
    r2SideOriented(geom) ? Math.max(1, unit.getFootprintHeight()) : Math.max(1, unit.getFootprintWidth());

const c42DepthSpan = (unit: Unit, geom: IGeom): number =>
    r2SideOriented(geom) ? Math.max(1, unit.getFootprintWidth()) : Math.max(1, unit.getFootprintHeight());

const c42Copy = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c42TakenOf = (board: IBoard, units: readonly Unit[]): Set<number> => {
    const taken = new Set<number>();
    for (const unit of units) {
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    return taken;
};

const c42AddSpan = (taken: Set<number>, span: ISpan): void => {
    for (const cell of span.cells) taken.add(keyOf(cell));
};

const c42LateralsNow = (board: IBoard): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const c42OneStepBehind = (unit: Unit, others: readonly Unit[], board: IBoard): boolean => {
    for (const cell of board.footprint(unit)) {
        const lat = board.geom.lateral(cell);
        const depth = board.geom.frontness(cell);
        for (const other of others) {
            if (other === unit) continue;
            for (const occupied of board.footprint(other)) {
                if (board.geom.lateral(occupied) === lat && board.geom.frontness(occupied) === depth + 1) return true;
            }
        }
    }
    return false;
};

const c42OnFileBehind = (ahead: Unit, other: Unit, board: IBoard): boolean => {
    const aheadCells = board.footprint(ahead);
    for (const cell of board.footprint(other)) {
        const lat = board.geom.lateral(cell);
        const depth = board.geom.frontness(cell);
        if (
            aheadCells.some(
                (occupied) => board.geom.lateral(occupied) === lat && board.geom.frontness(occupied) > depth,
            )
        ) {
            return true;
        }
    }
    return false;
};

/** Same rank, one lateral over: the pierce step this arm does not repeat. */
const c42OneStepAside = (before: ISpan, after: ISpan): boolean => {
    if (before.minFront !== before.maxFront || after.minFront !== after.maxFront) return false;
    if (before.minFront !== after.minFront) return false;
    let best = Infinity;
    for (const left of before.laterals) {
        for (const right of after.laterals) best = Math.min(best, Math.abs(left - right));
    }
    return best === 1;
};

const c42Keeps = (board: IBoard, unit: Unit, span: ISpan, covered: ReadonlySet<number>): boolean => {
    for (const lat of board.laterals(unit)) {
        if (!span.laterals.includes(lat) && !covered.has(lat)) return false;
    }
    return true;
};

const c42AheadClear = (span: ISpan, board: IBoard, taken: ReadonlySet<number>): boolean => {
    const laterals = new Set(span.laterals);
    for (const cell of board.geom.baseCells) {
        if (!laterals.has(board.geom.lateral(cell))) continue;
        if (board.geom.frontness(cell) <= span.maxFront) continue;
        if (taken.has(keyOf(cell))) return false;
    }
    return true;
};

const c42BehindClear = (span: ISpan, board: IBoard, taken: ReadonlySet<number>): boolean => {
    const laterals = new Set(span.laterals);
    for (const cell of board.geom.baseCells) {
        if (!laterals.has(board.geom.lateral(cell))) continue;
        if (board.geom.frontness(cell) >= span.minFront) continue;
        if (taken.has(keyOf(cell))) return false;
    }
    return true;
};

const c42WingLegal = (unit: Unit, live: readonly Unit[], board: IBoard): boolean => {
    const cells = board.footprint(unit);
    const back = r2Ranks(board).back;
    if (!cells.length || cells.some((cell) => board.geom.frontness(cell) !== back)) return false;
    const front = r2Ranks(board).front;
    for (const lat of new Set(cells.map((cell) => board.geom.lateral(cell)))) {
        const cell = r3Cell(board, front, lat);
        if (!cell || live.some((other) => other !== unit && coversCell(other, cell, board))) return false;
    }
    return !c42OneStepBehind(unit, live, board);
};

const c42ChargerMustLeave = (charger: Unit, live: readonly Unit[], board: IBoard): boolean => {
    const front = r2Ranks(board).front;
    if (!board.footprint(charger).some((cell) => board.geom.frontness(cell) === front)) return true;
    return live.some((other) => other !== charger && c42Ranged(other) && c42OnFileBehind(charger, other, board));
};

const c42ChargerSettled = (charger: Unit, live: readonly Unit[], board: IBoard): boolean => {
    const front = r2Ranks(board).front;
    if (!board.footprint(charger).some((cell) => board.geom.frontness(cell) === front)) return false;
    return !live.some((other) => other !== charger && c42OnFileBehind(charger, other, board));
};

const c42CoversMiddle = (unit: Unit, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => board.geom.frontness(cell) === r2Ranks(board).middle);

const c42PickKeeper = (group: readonly Unit[], board: IBoard, charger: Unit | undefined): Unit =>
    [...group].sort((a, b) => {
        const middle = Number(c42CoversMiddle(b, board)) - Number(c42CoversMiddle(a, board));
        if (middle) return middle;
        const lead = Number(charger === b) - Number(charger === a);
        if (lead) return lead;
        return b.getArmor() - a.getArmor() || byId(a, b);
    })[0];

const c42CollectMovers = (board: IBoard, charger: Unit | undefined): Set<string> => {
    const front = r2Ranks(board).front;
    const placed = board.units.filter((unit) => board.footprint(unit).length > 0);
    const movers = new Set<string>();
    const mark = (unit: Unit): boolean => {
        if (c42Ranged(unit) || movers.has(unit.getId())) return false;
        movers.add(unit.getId());
        return true;
    };
    for (let guard = placed.length + 2; guard >= 0; guard -= 1) {
        let changed = false;
        const stayers = placed.filter((unit) => !movers.has(unit.getId()));
        const fronts = new Map<number, Unit[]>();
        for (const unit of stayers) {
            if (c42Ranged(unit) || c42IsWing(unit, charger)) continue;
            for (const cell of board.footprint(unit)) {
                if (board.geom.frontness(cell) !== front) continue;
                const lat = board.geom.lateral(cell);
                const group = fronts.get(lat);
                if (group) {
                    if (!group.includes(unit)) group.push(unit);
                } else fronts.set(lat, [unit]);
            }
        }
        for (const group of fronts.values()) {
            if (group.length < 2) continue;
            const keeper = c42PickKeeper(group, board, charger);
            for (const unit of group) {
                if (unit !== keeper && mark(unit)) changed = true;
            }
        }
        const live = placed.filter((unit) => !movers.has(unit.getId()));
        for (const unit of live) {
            if (c42Ranged(unit)) continue;
            if (c42IsWing(unit, charger)) {
                if (!c42WingLegal(unit, live, board) && mark(unit)) changed = true;
                continue;
            }
            if (charger && unit === charger) {
                if (c42ChargerMustLeave(unit, live, board)) {
                    if (mark(unit)) changed = true;
                } else {
                    for (const other of live) {
                        if (other === unit || c42Ranged(other)) continue;
                        if (c42OnFileBehind(unit, other, board) && mark(other)) changed = true;
                    }
                }
                continue;
            }
            if (c42OneStepBehind(unit, live, board) && mark(unit)) changed = true;
        }
        if (!changed) break;
    }
    return movers;
};

const c42FrontLaterals = (board: IBoard, units: readonly Unit[]): Set<number> => {
    const front = r2Ranks(board).front;
    const laterals = new Set<number>();
    for (const unit of units) {
        for (const cell of board.footprint(unit)) {
            if (board.geom.frontness(cell) === front) laterals.add(board.geom.lateral(cell));
        }
    }
    return laterals;
};

const c42Better = (
    best: XY | undefined,
    bestDist: number,
    bestLat: number,
    anchor: XY,
    dist: number,
    destLat: number,
): boolean =>
    !best ||
    dist < bestDist ||
    (dist === bestDist &&
        (destLat < bestLat ||
            (destLat === bestLat && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))));

const c42SearchBack = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    frontLaterals: ReadonlySet<number>,
    covered: ReadonlySet<number>,
): XY | undefined => {
    const back = r2Ranks(board).back;
    const current = board.cells.get(unit.getId());
    const before = current ? spanAt(unit, current, board.geom) : undefined;
    const prefer = before ? medianNumber(before.laterals) : medianLat(unit, board);
    let best: XY | undefined;
    let bestDist = Infinity;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (span.minFront !== back || span.maxFront !== back) continue;
        if (before && c42OneStepAside(before, span)) continue;
        if (!c42Keeps(board, unit, span, covered)) continue;
        if (!c42AheadClear(span, board, taken)) continue;
        if (span.laterals.some((lat) => frontLaterals.has(lat))) continue;
        const destLat = medianNumber(span.laterals);
        const dist = Math.abs(destLat - prefer);
        if (!c42Better(best, bestDist, bestLat, anchor, dist, destLat)) continue;
        best = anchor;
        bestDist = dist;
        bestLat = destLat;
    }
    return best ? c42Copy(best) : undefined;
};

const c42SearchFront = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    covered: ReadonlySet<number>,
): XY | undefined => {
    const front = r2Ranks(board).front;
    const current = board.cells.get(unit.getId());
    const before = current ? spanAt(unit, current, board.geom) : undefined;
    const prefer = before ? medianNumber(before.laterals) : medianLat(unit, board);
    let best: XY | undefined;
    let bestDist = Infinity;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (span.maxFront !== front) continue;
        if (!c42BehindClear(span, board, taken) || !c42Keeps(board, unit, span, covered)) continue;
        const destLat = medianNumber(span.laterals);
        const dist = Math.abs(destLat - prefer);
        if (!c42Better(best, bestDist, bestLat, anchor, dist, destLat)) continue;
        best = anchor;
        bestDist = dist;
        bestLat = destLat;
    }
    return best ? c42Copy(best) : undefined;
};

const c42Order = (units: readonly Unit[], board: IBoard, charger: Unit | undefined): Unit[] =>
    [...units].sort((a, b) => {
        const lead = Number(charger !== a) - Number(charger !== b);
        if (lead) return lead;
        return medianLat(a, board) - medianLat(b, board) || byId(a, b);
    });

const c42Assign = (board: IBoard, movers: readonly Unit[], charger: Unit | undefined): Map<string, XY> => {
    const placed = board.units.filter((unit) => board.footprint(unit).length > 0);
    let pending = [...movers];
    const pinned = placed.filter((unit) => !pending.some((mover) => mover.getId() === unit.getId()));
    for (let guard = pending.length + 1; guard >= 0 && pending.length; guard -= 1) {
        const plan = new Map<string, XY>();
        const holding = pinned.slice();
        const taken = c42TakenOf(board, holding);
        const covered = new Set<number>();
        for (const unit of holding) {
            for (const lat of board.laterals(unit)) covered.add(lat);
        }
        const frontLaterals = c42FrontLaterals(board, holding);
        const failed: Unit[] = [];
        for (const unit of c42Order(pending, board, charger)) {
            const spot =
                charger && unit === charger
                    ? c42SearchFront(unit, board, taken, covered)
                    : c42SearchBack(unit, board, taken, frontLaterals, covered);
            const span = spot ? spanAt(unit, spot, board.geom) : undefined;
            if (!spot || !span) {
                failed.push(unit);
                continue;
            }
            plan.set(unit.getId(), spot);
            c42AddSpan(taken, span);
            for (const lat of span.laterals) covered.add(lat);
            if (span.maxFront === r2Ranks(board).front) {
                for (const lat of span.laterals) frontLaterals.add(lat);
            }
        }
        if (!failed.length) return plan;
        if (failed.length === pending.length) return new Map();
        const failedIds = new Set(failed.map((unit) => unit.getId()));
        for (const unit of failed) pinned.push(unit);
        pending = pending.filter((unit) => !failedIds.has(unit.getId()));
    }
    return new Map();
};

const c42BranchABad = (
    board: IBoard,
    plan: ReadonlyMap<string, XY>,
    charger: Unit | undefined,
    before: ReadonlySet<number>,
): boolean => {
    const after = c42LateralsNow(board);
    for (const lat of before) {
        if (!after.has(lat)) return true;
    }
    const live = board.units.filter((unit) => board.footprint(unit).length > 0);
    for (const id of plan.keys()) {
        const unit = live.find((candidate) => candidate.getId() === id);
        if (!unit || c42Ranged(unit)) return true;
        if (c42OneStepBehind(unit, live, board)) return true;
        if (c42IsWing(unit, charger) && !c42WingLegal(unit, live, board)) return true;
        if (charger && unit === charger && !c42ChargerSettled(unit, live, board)) return true;
    }
    return false;
};

const c42BranchA = (board: IBoard): void => {
    const snapshot = copyCells(board);
    const before = c42LateralsNow(board);
    const charger = c42FastCharger(board);
    const moverIds = c42CollectMovers(board, charger);
    const movers = board.units.filter((unit) => moverIds.has(unit.getId()));
    const plan = c42Assign(board, movers, charger);
    if (!plan.size || !commitAssignments(board, plan, false)) return;
    if (c42BranchABad(board, plan, charger, before)) restoreCells(board, snapshot);
};

const c42AnyBack = (unit: Unit, board: IBoard, taken: ReadonlySet<number>): XY | undefined => {
    const back = r2Ranks(board).back;
    const prefer = medianLat(unit, board);
    let best: XY | undefined;
    let bestDist = Infinity;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (span.minFront !== back || span.maxFront !== back) continue;
        const destLat = medianNumber(span.laterals);
        const dist = Math.abs(destLat - prefer);
        if (!c42Better(best, bestDist, bestLat, anchor, dist, destLat)) continue;
        best = anchor;
        bestDist = dist;
        bestLat = destLat;
    }
    return best ? c42Copy(best) : undefined;
};

const c42FrontTouch = (board: IBoard): number[][] => {
    const front = r2Ranks(board).front;
    const bodies: number[][] = [];
    for (const unit of board.units) {
        const laterals = board
            .footprint(unit)
            .filter((cell) => board.geom.frontness(cell) === front)
            .map((cell) => board.geom.lateral(cell));
        if (laterals.length) bodies.push(laterals);
    }
    return bodies;
};

const c42HasFrontGap = (board: IBoard): boolean => {
    const bodies = c42FrontTouch(board);
    for (let left = 0; left < bodies.length; left += 1) {
        for (let right = left + 1; right < bodies.length; right += 1) {
            if (c32GapOf(bodies[left], bodies[right]) === 1) return true;
        }
    }
    return false;
};

const c42MiddleBusy = (board: IBoard): boolean => {
    const ranks = r2Ranks(board);
    return board.units.some((unit) =>
        board.footprint(unit).some((cell) => {
            const depth = board.geom.frontness(cell);
            return depth !== ranks.front && depth !== ranks.back;
        }),
    );
};

const c42BranchB = (board: IBoard): void => {
    const screens = board.units
        .filter(
            (unit) =>
                board.footprint(unit).length > 0 &&
                unit.isSmallSize() &&
                !c42Ranged(unit) &&
                !unit.canFly() &&
                !isCharger(unit),
        )
        .sort((a, b) => b.getArmor() - a.getArmor() || byId(a, b));
    if (!screens.length) return;
    const chosen = screens[0];
    const ranks = r2Ranks(board);
    const centreCell = r3Cell(board, ranks.front, Math.round(board.geom.centreLat));
    if (!centreCell) return;
    const others = board.units.filter(
        (unit) => unit !== chosen && !c42Ranged(unit) && board.footprint(unit).length > 0,
    );
    if (others.some((unit) => c42DepthSpan(unit, board.geom) > 1)) return;
    if (
        board.units.some(
            (unit) =>
                c42Ranged(unit) &&
                (coversCell(unit, centreCell, board) ||
                    board.footprint(unit).some((cell) => board.geom.frontness(cell) === ranks.middle)),
        )
    ) {
        return;
    }
    const taken = c42TakenOf(
        board,
        board.units.filter((unit) => c42Ranged(unit)),
    );
    const chosenSpan = spanAt(chosen, centreCell, board.geom);
    if (!chosenSpan || !spanIsLegal(chosenSpan, board.geom, taken)) return;
    const plan = new Map<string, XY>([[chosen.getId(), c42Copy(centreCell)]]);
    c42AddSpan(taken, chosenSpan);
    const ordered = [...others].sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    for (const unit of ordered) {
        const spot = c42AnyBack(unit, board, taken);
        const span = spot ? spanAt(unit, spot, board.geom) : undefined;
        if (!spot || !span) return;
        plan.set(unit.getId(), spot);
        c42AddSpan(taken, span);
    }
    const snapshot = copyCells(board);
    if (!commitAssignments(board, plan, false)) return;
    if (c42HasFrontGap(board) || c42MiddleBusy(board)) restoreCells(board, snapshot);
};

const c42RosterC = (threats: IPublicPlacementThreats): boolean =>
    threats.flyers >= 1 &&
    threats.rangeCreatures === 0 &&
    !threats.fireBreath &&
    !threats.skewerStrike &&
    !threats.lightningSpin &&
    !threats.throughShot &&
    !threats.chakram;

const c42AnchorForCells = (
    unit: Unit,
    board: IBoard,
    cells: readonly XY[],
    taken: ReadonlySet<number>,
): XY | undefined => {
    const wanted = new Set(cells.map((cell) => keyOf(cell)));
    let best: XY | undefined;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || span.cells.length !== wanted.size || !spanIsLegal(span, board.geom, taken)) continue;
        if (!span.cells.every((cell) => wanted.has(keyOf(cell)))) continue;
        if (!best || anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)) best = anchor;
    }
    return best ? c42Copy(best) : undefined;
};

const c42TouchPairs = (units: readonly Unit[], feet: (unit: Unit) => readonly XY[]): Set<string> => {
    const pairs = new Set<string>();
    for (let left = 0; left < units.length; left += 1) {
        for (let right = left + 1; right < units.length; right += 1) {
            const a = feet(units[left]);
            const b = feet(units[right]);
            if (!a.length || !b.length || minChebyshev(a, b) > 1) continue;
            const leftId = units[left].getId();
            const rightId = units[right].getId();
            pairs.add(leftId < rightId ? `${leftId}|${rightId}` : `${rightId}|${leftId}`);
        }
    }
    return pairs;
};

const c42PlanC = (board: IBoard, threats: IPublicPlacementThreats): Map<string, XY> | undefined => {
    const charger = c42FastCharger(board);
    const wings = board.units.filter((unit) => c42IsWing(unit, charger));
    const stack = [...(charger ? [charger] : []), ...wings];
    const screens = board.units
        .filter((unit) => unit !== charger && !c42Flyer(unit) && !c42Ranged(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => b.getArmor() - a.getArmor() || byId(a, b));
    if (stack.some((unit) => c42LatSpan(unit, board.geom) !== 1)) return undefined;
    if (screens.some((unit) => !unit.isSmallSize())) return undefined;
    const ranks = r2Ranks(board);
    const limits = zoneLimits(board.geom);
    const high = limits.maxLat;
    const order = [ranks.front, ranks.middle, ranks.back];
    const moving = new Set([...stack, ...screens].map((unit) => unit.getId()));
    const taken = c42TakenOf(
        board,
        board.units.filter((unit) => !moving.has(unit.getId())),
    );
    const plan = new Map<string, XY>();
    let cursor = 0;
    for (const unit of stack) {
        const depth = c42DepthSpan(unit, board.geom);
        const need = order.slice(cursor, cursor + depth);
        if (need.length < depth) return undefined;
        const cells: XY[] = [];
        for (const rank of need) {
            const cell = r3Cell(board, rank, high);
            if (!cell) return undefined;
            cells.push(cell);
        }
        const anchor = c42AnchorForCells(unit, board, cells, taken);
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!anchor || !span) return undefined;
        plan.set(unit.getId(), anchor);
        c42AddSpan(taken, span);
        cursor += depth;
    }
    const centre = Math.round(board.geom.centreLat);
    const slotSpecs: readonly [number, number][] = [
        [ranks.front, limits.minLat],
        [ranks.front, centre],
        [ranks.middle, limits.minLat],
        [ranks.back, limits.minLat],
    ];
    const slots: XY[] = [];
    for (const [rank, lat] of slotSpecs) {
        const cell = r3Cell(board, rank, lat);
        if (cell) slots.push(cell);
    }
    const blast = threats.fireball || threats.ringOfFire || threats.chainLightning || threats.meteorShower;
    const seated: XY[] = [];
    let slot = 0;
    for (const screen of screens) {
        let anchor: XY | undefined;
        while (slot < slots.length) {
            const candidate = slots[slot];
            slot += 1;
            if (taken.has(keyOf(candidate))) continue;
            if (blast && seated.some((cell) => chebyshev(cell, candidate) <= 1)) continue;
            anchor = candidate;
            break;
        }
        if (!anchor) return undefined;
        plan.set(screen.getId(), c42Copy(anchor));
        taken.add(keyOf(anchor));
        seated.push(anchor);
    }
    return plan;
};

const c42BranchC = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const charger = c42FastCharger(board);
    const stack = [...(charger ? [charger] : []), ...board.units.filter((unit) => c42IsWing(unit, charger))];
    const screens = board.units.filter(
        (unit) => unit !== charger && !c42Flyer(unit) && !c42Ranged(unit) && board.footprint(unit).length > 0,
    );
    const plan = c42PlanC(board, threats);
    if (!plan?.size) return;
    const blast = threats.fireball || threats.ringOfFire || threats.chainLightning || threats.meteorShower;
    const beforePairs = blast ? c42TouchPairs(screens, (unit) => board.footprint(unit)) : undefined;
    const high = zoneLimits(board.geom).maxLat;
    const snapshot = copyCells(board);
    if (!commitAssignments(board, plan, false)) return;
    const spilled =
        stack.some((unit) => board.laterals(unit).some((lat) => lat !== high)) ||
        screens.some((unit) => board.laterals(unit).includes(high));
    let paired = false;
    if (beforePairs) {
        const after = c42TouchPairs(screens, (unit) => board.footprint(unit));
        for (const pair of after) {
            if (!beforePairs.has(pair)) paired = true;
        }
    }
    if (spilled || paired) restoreCells(board, snapshot);
};

/**
 * r4c2 post-pass. Today's placeArmy has already run. Pierce clears the cell behind a strike
 * inside the current zone. Lightning Spin keeps one screen. Flyers stack on the high file.
 * Placement augment spend stays.
 */
export function placeArmyR4C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (threats.fireBreath || threats.skewerStrike) c42BranchA(board);
    else if (threats.lightningSpin) c42BranchB(board);
    else if (c42RosterC(threats)) c42BranchC(board, threats);
    return board.cells;
}

const c43IsCaster = (unit: Unit): boolean => isCasterUnit(unit) && unit.isSmallSize();

/** Non-flying, non-charging ground melee. Casters, stays, and named protectors are not screens. */
const c43IsScreen = (unit: Unit): boolean => {
    if (unit.canFly() || isCharger(unit)) return false;
    if (PROTECTORS.has(unit.getName()) || CASTER_STAYS.has(unit.getName()) || isCasterUnit(unit)) return false;
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

/** Small ground melee, including a Rapid Charge body. Still not a caster, stay, or protector. */
const c43IsSmallMelee = (unit: Unit): boolean => {
    if (!unit.isSmallSize() || unit.canFly() || unit.getAttackType() === RANGE) return false;
    if (PROTECTORS.has(unit.getName()) || CASTER_STAYS.has(unit.getName()) || isCasterUnit(unit)) return false;
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

/** Non-flying body that is not a bow, a caster, a stay, or a named protector. */
const c43IsGroundBody = (unit: Unit): boolean => {
    if (unit.canFly() || unit.getAttackType() === RANGE) return false;
    if (PROTECTORS.has(unit.getName()) || CASTER_STAYS.has(unit.getName()) || isCasterUnit(unit)) return false;
    return true;
};

const c43HasMeteorite = (creatureIds: readonly number[] | undefined): boolean => {
    if (!creatureIds?.length) return false;
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        if (!info) continue;
        if (hasNamed(CATALOG.get(info.name)?.spells, "Meteorite")) return true;
    }
    return false;
};

/** The one body touching a back-corner bow. Taking it would open that corner. */
const c43CornerSole = (board: IBoard): Set<string> => {
    const corners = backCornerKeys(board.geom);
    const sole = new Set<string>();
    for (const bow of board.units) {
        if (bow.getAttackType() !== RANGE) continue;
        const cells = board.footprint(bow);
        if (!cells.some((cell) => corners.has(keyOf(cell)))) continue;
        const neighbors = board.units.filter((unit) => {
            if (unit.getId() === bow.getId()) return false;
            const footprint = board.footprint(unit);
            return footprint.length > 0 && minChebyshev(footprint, cells) <= 1;
        });
        if (neighbors.length === 1) sole.add(neighbors[0].getId());
    }
    return sole;
};

const c43Locked = (board: IBoard): Set<string> => {
    const locked = c43CornerSole(board);
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (unit.getAttackType() === RANGE || CASTER_STAYS.has(unit.getName()) || PROTECTORS.has(unit.getName())) {
            locked.add(unit.getId());
        }
        if (isCasterUnit(unit) && coveringProtectors(unit, board).length > 0) locked.add(unit.getId());
    }
    return locked;
};

const c43Casters = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units
        .filter((unit) => c43IsCaster(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));

const c43Screens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units.filter((unit) => c43IsScreen(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0);

const c43At = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c43ByNear = (origin: Unit, units: readonly Unit[], board: IBoard): Unit[] => {
    const mine = board.footprint(origin);
    const dist = (unit: Unit): number => {
        const cells = board.footprint(unit);
        return mine.length && cells.length ? minChebyshev(mine, cells) : Infinity;
    };
    return [...units].sort((a, b) => dist(a) - dist(b) || byId(a, b));
};

const c43Occupant = (board: IBoard, cell: XY, ignore: ReadonlySet<string>): Unit | undefined =>
    board.units.find(
        (unit) => !ignore.has(unit.getId()) && board.footprint(unit).some((entry) => sameCell(entry, cell)),
    );

const c43Fits = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    if (!moves.size) return false;
    const occupied = takenCells(board, new Set(moves.keys()));
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, occupied)) return false;
        for (const cell of footprint) occupied.add(keyOf(cell));
    }
    return true;
};

const c43Commit = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    if (!c43Fits(board, moves)) return false;
    for (const [id, anchor] of moves) board.cells.set(id, c43At(anchor));
    return true;
};

const c43Planned = (board: IBoard, unit: Unit, moves: ReadonlyMap<string, XY>): XY[] => {
    const anchor = moves.get(unit.getId()) ?? board.cells.get(unit.getId());
    return anchor ? footprintCellsForAnchor(unit, anchor) : [];
};

const c43Isolated = (board: IBoard, casters: readonly Unit[], moves: ReadonlyMap<string, XY>, gap: number): boolean => {
    for (const caster of casters) {
        const mine = c43Planned(board, caster, moves);
        if (!mine.length) return false;
        for (const unit of board.units) {
            if (unit.getId() === caster.getId()) continue;
            const theirs = c43Planned(board, unit, moves);
            if (theirs.length && minChebyshev(mine, theirs) < gap) return false;
        }
    }
    return true;
};

const c43HalfLats = (board: IBoard, half: LateralHalf): number[] => {
    const ranks = ranksOf(board);
    const corners = c33CornerLaterals(board);
    const centre = board.geom.centreLat;
    const lats: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (corners.has(lat) || halfOf(lat, centre) !== half) continue;
        if (!r3Cell(board, ranks.back, lat)) continue;
        lats.push(lat);
    }
    return lats;
};

const c43HalvesFor = (board: IBoard, casters: readonly Unit[]): { caster: Unit; half: LateralHalf }[] => {
    const centre = board.geom.centreLat;
    const used = new Set<LateralHalf>();
    const plan: { caster: Unit; half: LateralHalf }[] = [];
    const claim = (caster: Unit, half: LateralHalf): void => {
        if (used.has(half)) return;
        used.add(half);
        plan.push({ caster, half });
    };
    for (const caster of casters) claim(caster, halfOf(medianLat(caster, board), centre));
    for (const caster of casters) {
        if (plan.some((seat) => seat.caster.getId() === caster.getId())) continue;
        const free = (["low", "high"] as const).find((half) => !used.has(half));
        if (free) claim(caster, free);
    }
    return plan;
};

/** Front or middle cell, `steps` laterals toward the nearer edge, still on the caster's half. */
const c43AimCell = (board: IBoard, lat: number, rank: number, steps: number): XY | undefined => {
    const centre = board.geom.centreLat;
    const screenLat = lat + (lat <= centre ? -steps : steps);
    if (halfOf(screenLat, centre) !== halfOf(lat, centre)) return undefined;
    return r3Cell(board, rank, screenLat);
};

const c43Prefer = (score: number, anchor: XY, bestScore: number, best: XY | undefined): boolean => {
    if (!best || score < bestScore) return true;
    if (score > bestScore) return false;
    return anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y);
};

const c43Covering = (
    board: IBoard,
    unit: Unit,
    target: XY,
    blocked: ReadonlySet<number>,
    accept: (footprint: readonly XY[], anchor: XY) => number | undefined,
): XY | undefined => {
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, blocked)) continue;
        if (!footprint.some((cell) => sameCell(cell, target))) continue;
        const score = accept(footprint, anchor);
        if (score === undefined || !c43Prefer(score, anchor, bestScore, best)) continue;
        best = anchor;
        bestScore = score;
    }
    return best ? c43At(best) : undefined;
};

interface IC43OffAim {
    readonly gap: number;
    readonly rank: "front" | "middle";
    readonly steps: number;
    readonly evict: boolean;
}

interface IC43Seat {
    readonly caster: Unit;
    readonly half: LateralHalf;
    readonly lat: number;
    readonly screen: Unit;
}

const c43OffAimOptions = (
    board: IBoard,
    seat: { caster: Unit; half: LateralHalf },
    screens: readonly Unit[],
    opt: IC43OffAim,
): IC43Seat[] => {
    const rank = ranksOf(board)[opt.rank];
    const current = medianLat(seat.caster, board);
    const lats = c43HalfLats(board, seat.half)
        .filter((lat) => c43AimCell(board, lat, rank, opt.steps) !== undefined)
        .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
    const ordered = c43ByNear(seat.caster, screens, board);
    const options: IC43Seat[] = [];
    for (const lat of lats) {
        for (const screen of ordered) options.push({ caster: seat.caster, half: seat.half, lat, screen });
    }
    return options;
};

const c43ScreenOnAim = (
    board: IBoard,
    seat: IC43Seat,
    casterFoot: readonly XY[],
    blocked: ReadonlySet<number>,
    opt: IC43OffAim,
): XY | undefined => {
    const target = c43AimCell(board, seat.lat, ranksOf(board)[opt.rank], opt.steps);
    if (!target) return undefined;
    const casterLats = new Set(casterFoot.map((cell) => board.geom.lateral(cell)));
    const targetLat = board.geom.lateral(target);
    return c43Covering(board, seat.screen, target, blocked, (footprint) => {
        const lats = footprint.map((cell) => board.geom.lateral(cell));
        if (lats.some((lat) => halfOf(lat, board.geom.centreLat) !== seat.half)) return undefined;
        if (lats.some((lat) => casterLats.has(lat))) return undefined;
        if (minChebyshev(footprint, casterFoot) < opt.gap) return undefined;
        const extra = lats.filter((lat) => lat !== targetLat).length;
        return extra * 100 + footprint.length;
    });
};

/** Unlocked bodies inside the caster gap, packed on the opposite front wing. */
const c43PackWing = (
    board: IBoard,
    units: readonly Unit[],
    half: LateralHalf,
    reserved: Set<number>,
    casterFeet: readonly (readonly XY[])[],
    gap: number,
): Map<string, XY> | undefined => {
    if (!units.length) return new Map();
    const plan = new Map<string, XY>();
    const placed: XY[][] = [];
    const ranks = ranksOf(board);
    const limits = zoneLimits(board.geom);
    const centre = board.geom.centreLat;
    const sorted = [...units].sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of sorted) {
        const blocked = new Set(reserved);
        for (const footprint of placed) {
            for (const cell of footprint) blocked.add(keyOf(cell));
        }
        let best: XY | undefined;
        let bestScore = Infinity;
        for (const anchor of board.geom.baseCells) {
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!r3Legal(footprint, board, blocked)) continue;
            const lats = footprint.map((cell) => board.geom.lateral(cell));
            if (lats.some((lat) => halfOf(lat, centre) !== half)) continue;
            if (Math.max(...footprint.map((cell) => board.geom.frontness(cell))) !== ranks.front) continue;
            if (casterFeet.some((feet) => minChebyshev(footprint, feet) < gap)) continue;
            if (placed.length > 0 && Math.min(...placed.map((feet) => minChebyshev(footprint, feet))) > 1) continue;
            const edge = half === "low" ? Math.min(...lats) - limits.minLat : limits.maxLat - Math.max(...lats);
            const score = edge * 1000 + (Math.max(...lats) - Math.min(...lats)) * 10 + footprint.length;
            if (!c43Prefer(score, anchor, bestScore, best)) continue;
            best = anchor;
            bestScore = score;
        }
        if (!best) return undefined;
        plan.set(unit.getId(), c43At(best));
        placed.push(footprintCellsForAnchor(unit, best));
    }
    return plan;
};

const c43TryOffAim = (
    board: IBoard,
    seats: readonly IC43Seat[],
    opt: IC43OffAim,
    locked: ReadonlySet<string>,
): Map<string, XY> | undefined => {
    if (!seats.length) return undefined;
    const ranks = ranksOf(board);
    const moves = new Map<string, XY>();
    const casterFeet: XY[][] = [];
    for (const seat of seats) {
        const anchor = r3Cell(board, ranks.back, seat.lat);
        if (!anchor) return undefined;
        const footprint = footprintCellsForAnchor(seat.caster, anchor);
        if (!footprint.length) return undefined;
        moves.set(seat.caster.getId(), c43At(anchor));
        casterFeet.push(footprint);
    }
    const protectedIds = new Set(seats.flatMap((seat) => [seat.caster.getId(), seat.screen.getId()]));
    const evictees: Unit[] = [];
    if (opt.evict) {
        for (const unit of board.units) {
            if (protectedIds.has(unit.getId())) continue;
            const cells = board.footprint(unit);
            if (!cells.length || !casterFeet.some((feet) => minChebyshev(cells, feet) < opt.gap)) continue;
            if (locked.has(unit.getId())) return undefined;
            evictees.push(unit);
        }
    }
    const ignore = new Set([...protectedIds, ...evictees.map((unit) => unit.getId())]);
    const blocked = takenCells(board, ignore);
    for (const footprint of casterFeet) {
        for (const cell of footprint) blocked.add(keyOf(cell));
    }
    for (let index = 0; index < seats.length; index += 1) {
        const anchor = c43ScreenOnAim(board, seats[index], casterFeet[index], blocked, opt);
        if (!anchor) return undefined;
        moves.set(seats[index].screen.getId(), anchor);
        for (const cell of footprintCellsForAnchor(seats[index].screen, anchor)) blocked.add(keyOf(cell));
    }
    if (opt.evict && evictees.length) {
        const groups = new Map<LateralHalf, Unit[]>();
        for (const unit of evictees) {
            const cells = board.footprint(unit);
            let bestHalf: LateralHalf | undefined;
            let bestDist = Infinity;
            for (let index = 0; index < seats.length; index += 1) {
                const dist = minChebyshev(cells, casterFeet[index]);
                if (dist >= opt.gap || dist >= bestDist) continue;
                bestDist = dist;
                bestHalf = otherHalf(seats[index].half);
            }
            if (!bestHalf) return undefined;
            const list = groups.get(bestHalf) ?? [];
            list.push(unit);
            groups.set(bestHalf, list);
        }
        for (const half of ["low", "high"] as const) {
            const group = groups.get(half);
            if (!group?.length) continue;
            const packed = c43PackWing(board, group, half, blocked, casterFeet, opt.gap);
            if (!packed) return undefined;
            for (const [id, anchor] of packed) {
                moves.set(id, anchor);
                const unit = group.find((candidate) => candidate.getId() === id);
                if (!unit) return undefined;
                for (const cell of footprintCellsForAnchor(unit, anchor)) blocked.add(keyOf(cell));
            }
        }
    }
    if (
        !c43Isolated(
            board,
            seats.map((seat) => seat.caster),
            moves,
            opt.gap,
        )
    )
        return undefined;
    if (!c43Fits(board, moves)) return undefined;
    return moves;
};

const c43OffAim = (board: IBoard, locked: ReadonlySet<string>, opt: IC43OffAim): void => {
    const casters = c43Casters(board, locked);
    const screens = c43Screens(board, locked);
    if (!casters.length || !screens.length) return;
    const plan = c43HalvesFor(board, casters);
    if (plan.length >= 2) {
        const first = c43OffAimOptions(board, plan[0], screens, opt);
        const second = c43OffAimOptions(board, plan[1], screens, opt);
        for (const left of first) {
            for (const right of second) {
                if (left.screen.getId() === right.screen.getId()) continue;
                const moves = c43TryOffAim(board, [left, right], opt, locked);
                if (moves && c43Commit(board, moves)) return;
            }
        }
    }
    const usedHalves = new Set<LateralHalf>();
    const usedScreens = new Set<string>();
    const held = new Set(locked);
    for (const seat of plan) {
        let placed = false;
        for (const half of [seat.half, otherHalf(seat.half)] as const) {
            if (usedHalves.has(half)) continue;
            const open = screens.filter((unit) => !usedScreens.has(unit.getId()));
            for (const option of c43OffAimOptions(board, { caster: seat.caster, half }, open, opt)) {
                const moves = c43TryOffAim(board, [option], opt, held);
                if (!moves || !c43Commit(board, moves)) continue;
                usedHalves.add(half);
                usedScreens.add(option.screen.getId());
                held.add(option.caster.getId());
                held.add(option.screen.getId());
                placed = true;
                break;
            }
            if (placed) break;
        }
    }
};

const c43AheadClear = (board: IBoard, lat: number, ignore: ReadonlySet<string>): boolean => {
    for (const cell of board.geom.baseCells) {
        if (board.geom.lateral(cell) !== lat || board.geom.frontness(cell) <= board.geom.backFront) continue;
        if (c43Occupant(board, cell, ignore)) return false;
    }
    return true;
};

/** Shoulder file on the front. A wider screen keeps that file and shifts off the caster's file. */
const c43LineScreen = (
    board: IBoard,
    screen: Unit,
    casterLat: number,
    shoulder: number,
    blocked: ReadonlySet<number>,
): XY | undefined => {
    const ranks = ranksOf(board);
    const toward = shoulder - casterLat;
    if (toward === 0) return undefined;
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(screen, anchor);
        if (!r3Legal(footprint, board, blocked)) continue;
        if (Math.max(...footprint.map((cell) => board.geom.frontness(cell))) !== ranks.front) continue;
        const steps = footprint.map((cell) => (board.geom.lateral(cell) - casterLat) * toward);
        if (Math.min(...steps) !== 1) continue;
        const onShoulder = footprint.some(
            (cell) => board.geom.lateral(cell) === shoulder && board.geom.frontness(cell) === ranks.front,
        );
        if (!onShoulder) continue;
        const score = (Math.max(...steps) - 1) * 100 + footprint.length;
        if (!c43Prefer(score, anchor, bestScore, best)) continue;
        best = anchor;
        bestScore = score;
    }
    return best ? c43At(best) : undefined;
};

const c43Line = (board: IBoard, locked: ReadonlySet<string>): void => {
    const casters = c43Casters(board, locked).filter((unit) => !unit.canFly());
    const screens = c43Screens(board, locked);
    if (!casters.length || !screens.length) return;
    const ranks = ranksOf(board);
    const usedScreens = new Set<string>();
    const usedHalves = new Set<LateralHalf>();
    for (const seat of c43HalvesFor(board, casters)) {
        let placed = false;
        for (const half of [seat.half, otherHalf(seat.half)] as const) {
            if (usedHalves.has(half)) continue;
            const current = medianLat(seat.caster, board);
            const lats = c43HalfLats(board, half).sort(
                (a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b,
            );
            for (const lat of lats) {
                const toward = lat < board.geom.centreLat ? 1 : lat > board.geom.centreLat ? -1 : 0;
                if (toward === 0) continue;
                const shoulder = lat + toward;
                if (!r3Cell(board, ranks.front, shoulder)) continue;
                const ordered = c43ByNear(
                    seat.caster,
                    screens.filter((unit) => !usedScreens.has(unit.getId())),
                    board,
                );
                for (const screen of ordered) {
                    const ignore = new Set([seat.caster.getId(), screen.getId()]);
                    if (!c43AheadClear(board, lat, ignore)) continue;
                    const casterCell = r3Cell(board, ranks.back, lat);
                    if (!casterCell) continue;
                    const blocked = takenCells(board, ignore);
                    const casterFoot = footprintCellsForAnchor(seat.caster, casterCell);
                    if (!r3Legal(casterFoot, board, blocked)) continue;
                    for (const cell of casterFoot) blocked.add(keyOf(cell));
                    const screenAnchor = c43LineScreen(board, screen, lat, shoulder, blocked);
                    if (!screenAnchor) continue;
                    const moves = new Map<string, XY>([
                        [seat.caster.getId(), c43At(casterCell)],
                        [screen.getId(), screenAnchor],
                    ]);
                    if (!c43Commit(board, moves)) continue;
                    usedScreens.add(screen.getId());
                    usedHalves.add(half);
                    placed = true;
                    break;
                }
                if (placed) break;
            }
            if (placed) break;
        }
    }
};

const c43SmallScreens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    c43Screens(board, locked).filter((unit) => unit.isSmallSize());

const c43SmallMelee = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units.filter(
        (unit) => c43IsSmallMelee(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0,
    );

/** One back caster and the three middle cells a flyer would land on to touch it. */
const c43CapMoves = (
    board: IBoard,
    caster: Unit,
    lat: number,
    locked: ReadonlySet<string>,
    banned: ReadonlySet<string>,
): Map<string, XY> | undefined => {
    const ranks = ranksOf(board);
    const casterCell = r3Cell(board, ranks.back, lat);
    const middle = r3Cell(board, ranks.middle, lat);
    const left = r3Cell(board, ranks.middle, lat - 1);
    const right = r3Cell(board, ranks.middle, lat + 1);
    if (!casterCell || !middle || !left || !right) return undefined;
    const targets = [casterCell, middle, left, right];
    const foreigners: Unit[] = [];
    for (const cell of targets) {
        const occupant = c43Occupant(board, cell, new Set([caster.getId()]));
        if (!occupant || foreigners.some((unit) => unit.getId() === occupant.getId())) continue;
        foreigners.push(occupant);
    }
    if (foreigners.some((unit) => banned.has(unit.getId()) || locked.has(unit.getId()))) return undefined;
    const screens = c43ByNear(
        caster,
        c43SmallScreens(board, locked).filter((unit) => !banned.has(unit.getId())),
        board,
    );
    const screen = screens[0];
    if (!screen || foreigners.some((unit) => unit.getId() !== screen.getId() && !c43IsSmallMelee(unit))) {
        return undefined;
    }
    const required = foreigners.filter((unit) => unit.getId() !== screen.getId());
    if (required.length > 2) return undefined;
    const pool = c43ByNear(
        caster,
        c43SmallMelee(board, locked).filter((unit) => unit.getId() !== screen.getId() && !banned.has(unit.getId())),
        board,
    );
    const wings: Unit[] = [...required];
    for (const unit of pool) {
        if (wings.length >= 2) break;
        if (wings.some((picked) => picked.getId() === unit.getId())) continue;
        wings.push(unit);
    }
    if (wings.length < 2) return undefined;
    const orders =
        wings[0].getId() === wings[1].getId()
            ? []
            : [
                  [wings[0], wings[1]],
                  [wings[1], wings[0]],
              ];
    let best: Map<string, XY> | undefined;
    let bestScore = Infinity;
    for (const [leftUnit, rightUnit] of orders) {
        const moves = new Map<string, XY>([
            [caster.getId(), c43At(casterCell)],
            [screen.getId(), c43At(middle)],
            [leftUnit.getId(), c43At(left)],
            [rightUnit.getId(), c43At(right)],
        ]);
        if (!c43Fits(board, moves)) continue;
        const travel =
            (board.cells.get(leftUnit.getId()) ? chebyshev(board.cells.get(leftUnit.getId())!, left) : 0) +
            (board.cells.get(rightUnit.getId()) ? chebyshev(board.cells.get(rightUnit.getId())!, right) : 0);
        if (travel < bestScore) {
            best = moves;
            bestScore = travel;
        }
    }
    return best;
};

const c43CentreLats = (board: IBoard): number[] => {
    const ranks = ranksOf(board);
    const corners = c33CornerLaterals(board);
    const centre = board.geom.centreLat;
    const lats: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (corners.has(lat)) continue;
        if (!r3Cell(board, ranks.back, lat) || !r3Cell(board, ranks.middle, lat)) continue;
        if (!r3Cell(board, ranks.middle, lat - 1) || !r3Cell(board, ranks.middle, lat + 1)) continue;
        lats.push(lat);
    }
    lats.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    return lats;
};

const c43Flyers = (board: IBoard, locked: ReadonlySet<string>): void => {
    const casters = c43Casters(board, locked);
    const lats = c43CentreLats(board);
    if (!casters.length || !lats.length) return;
    const centre = board.geom.centreLat;
    const bestDist = Math.abs(lats[0] - centre);
    const tier = lats.filter((lat) => Math.abs(lat - centre) === bestDist);
    const primary = [...casters].sort((a, b) => {
        const dist = (unit: Unit): number => Math.min(...tier.map((lat) => Math.abs(medianLat(unit, board) - lat)));
        return dist(a) - dist(b) || byId(a, b);
    })[0];
    const prefer = halfOf(medianLat(primary, board), centre);
    tier.sort((a, b) => (halfOf(a, centre) === prefer ? 0 : 1) - (halfOf(b, centre) === prefer ? 0 : 1) || a - b);
    let placedLat: number | undefined;
    let used = new Set<string>();
    for (const lat of tier) {
        const moves = c43CapMoves(board, primary, lat, locked, new Set());
        if (!moves || !c43Commit(board, moves)) continue;
        placedLat = lat;
        used = new Set(moves.keys());
        break;
    }
    if (placedLat === undefined) return;
    const second = c43Casters(board, locked).find((unit) => unit.getId() !== primary.getId());
    if (!second) return;
    const remaining = c43SmallScreens(board, locked).filter((unit) => !used.has(unit.getId()));
    const ranks = ranksOf(board);
    if (remaining.length < 3) {
        const neighbours = [placedLat - 1, placedLat + 1]
            .filter((lat) => r3Cell(board, ranks.back, lat) !== undefined)
            .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
        for (const lat of neighbours) {
            const cell = r3Cell(board, ranks.back, lat);
            if (!cell || c43Occupant(board, cell, new Set([second.getId()]))) continue;
            if (c43Commit(board, new Map([[second.getId(), c43At(cell)]]))) return;
        }
        return;
    }
    const capLats = lats.filter((lat) => lat !== placedLat);
    for (const lat of capLats) {
        const moves = c43CapMoves(board, second, lat, locked, used);
        if (moves && c43Commit(board, moves)) return;
    }
};

const c43Combinations = <T>(items: readonly T[], count: number): T[][] => {
    if (count <= 0) return [[]];
    if (items.length < count) return [];
    const out: T[][] = [];
    for (let index = 0; index <= items.length - count; index += 1) {
        for (const tail of c43Combinations(items.slice(index + 1), count - 1)) out.push([items[index], ...tail]);
    }
    return out;
};

const C43_TRIOS: readonly (readonly [number, number, number])[] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
];

const c43AnchorOn = (
    board: IBoard,
    unit: Unit,
    target: XY,
    blocked: ReadonlySet<number>,
    forbid: readonly XY[],
): XY | undefined =>
    c43Covering(board, unit, target, blocked, (footprint) => {
        if (footprint.some((cell) => forbid.some((ban) => sameCell(cell, ban)))) return undefined;
        const extra = footprint.length - 1;
        return (sameCell(footprint[0], target) ? 0 : 10) + extra;
    });

const c43BoxMoves = (
    board: IBoard,
    caster: Unit,
    lat: number,
    locked: ReadonlySet<string>,
): Map<string, XY> | undefined => {
    const ranks = ranksOf(board);
    const casterCell = r3Cell(board, ranks.back, lat);
    const left = r3Cell(board, ranks.back, lat - 1);
    const right = r3Cell(board, ranks.back, lat + 1);
    const front = r3Cell(board, ranks.middle, lat);
    if (!casterCell || !left || !right || !front) return undefined;
    const cells = [casterCell, left, right, front];
    for (const unit of board.units) {
        if (unit.getAttackType() !== RANGE) continue;
        if (board.footprint(unit).some((cell) => cells.some((target) => sameCell(cell, target)))) return undefined;
    }
    const pool = c43ByNear(
        caster,
        board.units.filter(
            (unit) =>
                unit.getId() !== caster.getId() &&
                c43IsGroundBody(unit) &&
                !locked.has(unit.getId()) &&
                board.footprint(unit).length > 0,
        ),
        board,
    );
    if (pool.length < 3) return undefined;
    const foreigners: Unit[] = [];
    for (const cell of cells) {
        const occupant = c43Occupant(board, cell, new Set([caster.getId()]));
        if (!occupant || foreigners.some((unit) => unit.getId() === occupant.getId())) continue;
        foreigners.push(occupant);
    }
    if (foreigners.length > 3) return undefined;
    if (foreigners.some((unit) => !pool.some((body) => body.getId() === unit.getId()))) return undefined;
    const wanted = [left, right, front];
    for (const combo of c43Combinations(pool, 3)) {
        if (!foreigners.every((unit) => combo.some((body) => body.getId() === unit.getId()))) continue;
        let best: Map<string, XY> | undefined;
        let bestScore = Infinity;
        for (const order of C43_TRIOS) {
            const ignore = new Set([caster.getId(), ...combo.map((unit) => unit.getId())]);
            const blocked = takenCells(board, ignore);
            const moves = new Map<string, XY>([[caster.getId(), c43At(casterCell)]]);
            let score = 0;
            let ok = true;
            for (let index = 0; index < 3; index += 1) {
                const unit = combo[order[index]];
                const target = wanted[index];
                const forbid = [casterCell, ...wanted.filter((cell) => cell !== target)];
                const anchor = c43AnchorOn(board, unit, target, blocked, forbid);
                if (!anchor) {
                    ok = false;
                    break;
                }
                for (const cell of footprintCellsForAnchor(unit, anchor)) blocked.add(keyOf(cell));
                moves.set(unit.getId(), anchor);
                const from = board.cells.get(unit.getId());
                score += from ? chebyshev(from, target) : 0;
            }
            if (!ok || !c43Fits(board, moves) || score >= bestScore) continue;
            best = moves;
            bestScore = score;
        }
        if (best) return best;
    }
    return undefined;
};

const c43Box = (board: IBoard, locked: ReadonlySet<string>): void => {
    const casters = c43Casters(board, locked);
    if (!casters.length) return;
    const ranks = ranksOf(board);
    const corners = c33CornerLaterals(board);
    const centre = board.geom.centreLat;
    for (const caster of casters) {
        const current = medianLat(caster, board);
        const lats: number[] = [];
        for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
            if (corners.has(lat)) continue;
            if (!r3Cell(board, ranks.back, lat) || !r3Cell(board, ranks.back, lat - 1)) continue;
            if (!r3Cell(board, ranks.back, lat + 1) || !r3Cell(board, ranks.middle, lat)) continue;
            lats.push(lat);
        }
        lats.sort(
            (a, b) =>
                Math.abs(a - current) - Math.abs(b - current) || Math.abs(a - centre) - Math.abs(b - centre) || a - b,
        );
        for (const lat of lats) {
            const moves = c43BoxMoves(board, caster, lat, locked);
            if (moves && c43Commit(board, moves)) return;
        }
    }
};

/**
 * r4c3 post-pass. Today's placeArmy has already run. One caster sits outside the public aim and
 * one screen takes the cell that aim hits first. The zone, the augment spend, and locked stacks stay.
 */
export function placeArmyR4C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const locked = c43Locked(board);
    if (!c43Casters(board, locked).length) return board.cells;
    if (threats.areaThrow || threats.meteorShower) {
        c43OffAim(board, locked, { gap: 3, rank: "front", steps: 3, evict: true });
    } else if (threats.largeCaliber) {
        c43OffAim(board, locked, { gap: 2, rank: "middle", steps: 2, evict: false });
    } else if (threats.fireball || threats.ringOfFire || c43HasMeteorite(context.publicOpponentCreatureIds)) {
        c43OffAim(board, locked, { gap: 2, rank: "middle", steps: 2, evict: false });
    } else if (threats.fireBreath || threats.skewerStrike || threats.throughShot) {
        c43Line(board, locked);
    } else if (threats.flyers >= 2) {
        c43Flyers(board, locked);
    } else if (threats.rangeCreatures >= 2 && threats.flyers < 2) {
        c43Box(board, locked);
    }
    return board.cells;
}

const c51Far = (footprint: readonly XY[], obstacles: readonly (readonly XY[])[], gap: number): boolean => {
    for (const obstacle of obstacles) {
        if (obstacle.length && minChebyshev(footprint, obstacle) < gap) return false;
    }
    return true;
};

const c51Touches = (footprint: readonly XY[], pack: readonly (readonly XY[])[]): boolean =>
    pack.some((cells) => cells.length > 0 && minChebyshev(footprint, cells) === 1);

const c51Mark = (taken: Set<number>, footprint: readonly XY[]): void => {
    for (const cell of footprint) taken.add(keyOf(cell));
};

const c51Qualifies = (unit: Unit): boolean => unit.hasAbilityActive("Sniper") || bowReach(unit) >= 11;

const c51ByClaim = (a: Unit, b: Unit): number => {
    const aClaim = c51Qualifies(a) ? 1 : 0;
    const bClaim = c51Qualifies(b) ? 1 : 0;
    return bClaim - aClaim || bowReach(b) - bowReach(a) || byId(a, b);
};

const c51Bodies = (board: IBoard, bows: readonly Unit[]): Unit[] => {
    const ids = new Set(bows.map((bow) => bow.getId()));
    return board.units.filter((unit) => !ids.has(unit.getId()) && board.footprint(unit).length > 0);
};

const c51Apply = (board: IBoard, assignments: ReadonlyMap<string, XY>): boolean => {
    const changed = new Map<string, XY>();
    for (const [id, anchor] of assignments) {
        const previous = board.cells.get(id);
        if (previous && sameCell(previous, anchor)) continue;
        changed.set(id, { x: anchor.x, y: anchor.y });
    }
    if (!changed.size) return true;
    return commitAssignments(board, changed, false);
};

const c51CornerCells = (board: IBoard): XY[] => {
    const ranks = ranksOf(board);
    const cells: XY[] = [];
    for (const lat of [ranks.minLat, ranks.maxLat]) {
        const cell = r3Cell(board, ranks.back, lat);
        if (cell) cells.push(cell);
    }
    return cells;
};

const c51NearerCorner = (board: IBoard, unit: Unit): XY | undefined => {
    const corners = c51CornerCells(board);
    const lat = medianLat(unit, board);
    corners.sort(
        (a, b) =>
            Math.abs(board.geom.lateral(a) - lat) - Math.abs(board.geom.lateral(b) - lat) ||
            board.geom.lateral(a) - board.geom.lateral(b),
    );
    return corners[0];
};

const c51BackAnchor = (unit: Unit, board: IBoard, lat: number, taken: ReadonlySet<number>): XY | undefined => {
    const back = ranksOf(board).back;
    const spots = r2Anchors(
        unit,
        board,
        taken,
        (span) => span.minFront === back && span.maxFront === back && span.laterals.includes(lat),
    );
    const spot = spots[0];
    return spot ? { x: spot.x, y: spot.y } : undefined;
};

const c51FrontAnchor = (unit: Unit, board: IBoard, lat: number, taken: ReadonlySet<number>): XY | undefined => {
    const front = ranksOf(board).front;
    const spots = r2Anchors(
        unit,
        board,
        taken,
        (span) => span.minFront === front && span.maxFront === front && span.laterals.includes(lat),
    );
    const spot = spots[0];
    return spot ? { x: spot.x, y: spot.y } : undefined;
};

const c51InwardLats = (lat: number, minLat: number, maxLat: number, centre: number): number[] => {
    const step = lat < centre ? 1 : lat > centre ? -1 : 0;
    const laterals = [lat];
    if (step === 0) {
        for (let cursor = minLat; cursor <= maxLat; cursor += 1) {
            if (cursor !== lat) laterals.push(cursor);
        }
        return laterals;
    }
    for (let cursor = lat + step; cursor >= minLat && cursor <= maxLat; cursor += step) laterals.push(cursor);
    return laterals;
};

const c51PickBack = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    chosen: readonly (readonly XY[])[],
): XY | undefined => {
    const back = ranksOf(board).back;
    let best: XY | undefined;
    let bestGap = -1;
    let bestEdge = -1;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (span.minFront !== back || span.maxFront !== back) continue;
        let gap = 99;
        for (const other of chosen) gap = Math.min(gap, minChebyshev(span.cells, other));
        if (chosen.length && gap < 3) continue;
        const edge = Math.max(...span.cells.map((cell) => board.geom.edgeness(cell)));
        const lat = Math.min(...span.laterals);
        const better =
            !best ||
            gap > bestGap ||
            (gap === bestGap && edge > bestEdge) ||
            (gap === bestGap && edge === bestEdge && lat < bestLat);
        if (!better) continue;
        best = anchor;
        bestGap = gap;
        bestEdge = edge;
        bestLat = lat;
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c51PickFront = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    obstacles: readonly (readonly XY[])[],
): XY | undefined => {
    const front = ranksOf(board).front;
    let best: XY | undefined;
    let bestEdge = -1;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (span.minFront !== front || span.maxFront !== front) continue;
        if (!c51Far(span.cells, obstacles, 3)) continue;
        const edge = Math.max(...span.cells.map((cell) => board.geom.edgeness(cell)));
        const lat = Math.min(...span.laterals);
        const better = !best || edge > bestEdge || (edge === bestEdge && lat < bestLat);
        if (!better) continue;
        best = anchor;
        bestEdge = edge;
        bestLat = lat;
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c51FrontSeed = (
    board: IBoard,
    taken: ReadonlySet<number>,
    obstacles: readonly (readonly XY[])[],
    gap: number,
): XY | undefined => {
    const ranks = ranksOf(board);
    let best: XY | undefined;
    let bestDist = Infinity;
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        const cell = r3Cell(board, ranks.front, lat);
        if (!cell || taken.has(keyOf(cell)) || !c51Far([cell], obstacles, gap)) continue;
        const dist = Math.abs(lat - board.geom.centreLat);
        if (!best || dist < bestDist || (dist === bestDist && lat < board.geom.lateral(best))) {
            best = cell;
            bestDist = dist;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c51PickPacked = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    obstacles: readonly (readonly XY[])[],
    pack: readonly (readonly XY[])[],
    gap: number,
    seed: XY | undefined,
): XY | undefined => {
    const front = ranksOf(board).front;
    let best: XY | undefined;
    let bestFront = -1;
    let bestCentre = Infinity;
    let bestLat = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) continue;
        if (!c51Far(span.cells, obstacles, gap)) continue;
        if (pack.length === 0) {
            if (seed && !span.cells.some((cell) => sameCell(cell, seed))) continue;
        } else if (!c51Touches(span.cells, pack)) continue;
        const onFront = span.cells.filter((cell) => board.geom.frontness(cell) === front).length;
        const centre = Math.abs(medianNumber(span.laterals) - board.geom.centreLat);
        const lat = Math.min(...span.laterals);
        const better =
            !best ||
            onFront > bestFront ||
            (onFront === bestFront && (centre < bestCentre || (centre === bestCentre && lat < bestLat)));
        if (!better) continue;
        best = anchor;
        bestFront = onFront;
        bestCentre = centre;
        bestLat = lat;
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c51Pack = (
    board: IBoard,
    units: readonly Unit[],
    taken: Set<number>,
    obstacles: readonly (readonly XY[])[],
    gap: number,
    seed: XY | undefined,
): Map<string, XY> => {
    const assignments = new Map<string, XY>();
    const pack: XY[][] = [];
    const ordered = [...units].sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of ordered) {
        const anchor = c51PickPacked(unit, board, taken, obstacles, pack, gap, seed);
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(unit, anchor);
        assignments.set(unit.getId(), anchor);
        pack.push(footprint);
        c51Mark(taken, footprint);
    }
    return assignments;
};

const c51WingPack = (
    board: IBoard,
    corner: XY,
    bowFootprint: readonly XY[],
    others: readonly Unit[],
    taken: Set<number>,
    assignments: Map<string, XY>,
): void => {
    const ranks = ranksOf(board);
    const towardHigh = board.geom.lateral(corner) <= board.geom.centreLat;
    const step = towardHigh ? -1 : 1;
    let cursor = towardHigh ? ranks.maxLat : ranks.minLat;
    const pack: XY[][] = [];
    const ordered = [...others].sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of ordered) {
        for (let lat = cursor; lat >= ranks.minLat && lat <= ranks.maxLat; lat += step) {
            const anchor = c51FrontAnchor(unit, board, lat, taken);
            if (!anchor) continue;
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!c51Far(footprint, [bowFootprint], 3)) continue;
            if (pack.length && !c51Touches(footprint, pack)) continue;
            assignments.set(unit.getId(), anchor);
            pack.push(footprint);
            c51Mark(taken, footprint);
            const edge = towardHigh
                ? Math.min(...footprint.map((cell) => board.geom.lateral(cell)))
                : Math.max(...footprint.map((cell) => board.geom.lateral(cell)));
            cursor = edge + step;
            break;
        }
    }
};

const c51AreaOne = (board: IBoard, bow: Unit, others: readonly Unit[]): void => {
    const corner = c51NearerCorner(board, bow);
    if (!corner) return;
    const taken = new Set<number>();
    const anchor = c51BackAnchor(bow, board, board.geom.lateral(corner), taken);
    if (!anchor) return;
    const bowFootprint = footprintCellsForAnchor(bow, anchor);
    const assignments = new Map<string, XY>([[bow.getId(), anchor]]);
    c51Mark(taken, bowFootprint);
    c51WingPack(board, anchor, bowFootprint, others, taken, assignments);
    c51Apply(board, assignments);
};

const c51AreaMany = (board: IBoard, bows: readonly Unit[], others: readonly Unit[]): void => {
    const taken = new Set<number>();
    const shooterFootprints: XY[][] = [];
    const assignments = new Map<string, XY>();
    const seated = new Set<string>();
    for (const bow of [...bows].filter(c51Qualifies).sort(c51ByClaim)) {
        const anchor = c51PickBack(bow, board, taken, shooterFootprints);
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(bow, anchor);
        assignments.set(bow.getId(), anchor);
        shooterFootprints.push(footprint);
        c51Mark(taken, footprint);
        seated.add(bow.getId());
    }
    const overflow = bows.filter((bow) => !seated.has(bow.getId())).sort(byReachAsc);
    for (const bow of overflow) {
        const anchor = c51PickFront(bow, board, taken, shooterFootprints);
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(bow, anchor);
        assignments.set(bow.getId(), anchor);
        shooterFootprints.push(footprint);
        c51Mark(taken, footprint);
    }
    const seed = c51FrontSeed(board, taken, shooterFootprints, 3);
    for (const [id, anchor] of c51Pack(board, others, taken, shooterFootprints, 3, seed)) {
        assignments.set(id, anchor);
    }
    c51Apply(board, assignments);
};

const c51Area = (board: IBoard, bows: readonly Unit[]): void => {
    const others = c51Bodies(board, bows);
    if (bows.length === 1) c51AreaOne(board, bows[0], others);
    else c51AreaMany(board, bows, others);
};

const c51SeatCaliber = (
    bow: Unit,
    board: IBoard,
    laterals: readonly number[],
    taken: Set<number>,
    obstacles: XY[][],
    assignments: Map<string, XY>,
): void => {
    for (const lat of laterals) {
        const anchor = c51BackAnchor(bow, board, lat, taken);
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(bow, anchor);
        if (!c51Far(footprint, obstacles, 2)) continue;
        assignments.set(bow.getId(), anchor);
        obstacles.push(footprint);
        c51Mark(taken, footprint);
        return;
    }
};

const c51Caliber = (board: IBoard, bows: readonly Unit[]): void => {
    const others = c51Bodies(board, bows);
    const taken = new Set<number>();
    const seed = c51FrontSeed(board, taken, [], 2);
    const assignments = c51Pack(board, others, taken, [], 2, seed);
    const obstacles: XY[][] = [];
    for (const [id, anchor] of assignments) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (unit) obstacles.push(footprintCellsForAnchor(unit, anchor));
    }
    const ranks = ranksOf(board);
    const ordered = [...bows].sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    if (ordered.length === 1) {
        const nearer = c51NearerCorner(board, ordered[0]);
        const start = nearer ? board.geom.lateral(nearer) : ranks.minLat;
        c51SeatCaliber(
            ordered[0],
            board,
            c51InwardLats(start, ranks.minLat, ranks.maxLat, board.geom.centreLat),
            taken,
            obstacles,
            assignments,
        );
    } else {
        c51SeatCaliber(
            ordered[0],
            board,
            c51InwardLats(ranks.minLat, ranks.minLat, ranks.maxLat, board.geom.centreLat),
            taken,
            obstacles,
            assignments,
        );
        c51SeatCaliber(
            ordered[ordered.length - 1],
            board,
            c51InwardLats(ranks.maxLat, ranks.minLat, ranks.maxLat, board.geom.centreLat),
            taken,
            obstacles,
            assignments,
        );
        for (const bow of ordered.slice(1, -1)) {
            c51SeatCaliber(bow, board, lateralsNearestCentre(board), taken, obstacles, assignments);
        }
    }
    c51Apply(board, assignments);
};

const c51CannonSeats = (board: IBoard): { forbidden: Set<number>; seats: number[] } => {
    const ranks = ranksOf(board);
    const forbidden = new Set<number>([ranks.minLat, ranks.minLat + 1, ranks.maxLat - 1, ranks.maxLat]);
    const seats: number[] = [];
    const seen = new Set<number>();
    const push = (lat: number): void => {
        if (lat < ranks.minLat || lat > ranks.maxLat || forbidden.has(lat) || seen.has(lat)) return;
        if (!r3Cell(board, ranks.back, lat)) return;
        seen.add(lat);
        seats.push(lat);
    };
    push(ranks.minLat + 2);
    push(ranks.maxLat - 2);
    for (let step = 3; ; step += 1) {
        const low = ranks.minLat + step;
        const high = ranks.maxLat - step;
        if (low > high) break;
        push(low);
        if (low !== high) push(high);
        else break;
    }
    return { forbidden, seats };
};

const c51Through = (board: IBoard, bows: readonly Unit[]): void => {
    const { forbidden, seats } = c51CannonSeats(board);
    const busy = new Set<number>();
    const bowIds = new Set(bows.map((bow) => bow.getId()));
    for (const unit of board.units) {
        if (bowIds.has(unit.getId())) continue;
        for (const lat of board.laterals(unit)) busy.add(lat);
    }
    const ranks = ranksOf(board);
    const assignments = new Map<string, XY>();
    if (bows.length === 1) {
        const latNow = medianLat(bows[0], board);
        const seat =
            Math.abs(latNow - ranks.minLat) <= Math.abs(latNow - ranks.maxLat) ? ranks.minLat + 2 : ranks.maxLat - 2;
        const anchor = busy.has(seat) ? undefined : r3Cell(board, ranks.back, seat);
        if (anchor && c51BackAnchor(bows[0], board, seat, new Set())) assignments.set(bows[0].getId(), anchor);
        c51Apply(board, assignments);
        return;
    }
    const free = seats.filter((lat) => !busy.has(lat));
    const wing = [...bows].sort(c51ByClaim).slice(0, Math.min(2, free.length));
    const wingIds = new Set(wing.map((bow) => bow.getId()));
    const rest = bows
        .filter((bow) => !wingIds.has(bow.getId()))
        .sort((a, b) => {
            const aForbidden = board.laterals(a).some((lat) => forbidden.has(lat)) ? 0 : 1;
            const bForbidden = board.laterals(b).some((lat) => forbidden.has(lat)) ? 0 : 1;
            return aForbidden - bForbidden || byReachAsc(a, b);
        });
    const ordered = [...wing].sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b)).concat(rest);
    for (let index = 0; index < ordered.length && index < free.length; index += 1) {
        const anchor = r3Cell(board, ranks.back, free[index]);
        if (anchor) assignments.set(ordered[index].getId(), anchor);
    }
    c51Apply(board, assignments);
};

const c51Holds = (board: IBoard, bows: readonly Unit[]): { lat: number; cell: XY; bow?: Unit }[] => {
    const ranks = ranksOf(board);
    const holds: { lat: number; cell: XY; bow?: Unit }[] = [];
    for (const lat of [ranks.minLat, ranks.maxLat]) {
        const cell = r3Cell(board, ranks.back, lat);
        if (!cell) continue;
        const bow = bows.find((candidate) => board.footprint(candidate).some((occupied) => sameCell(occupied, cell)));
        holds.push({ lat, cell, bow });
    }
    return holds;
};

const c51DisplacedRank = (bow: Unit, threats: IPublicPlacementThreats, ranks: IRanks): number => {
    if (threats.flyers >= 2) return ranks.middle;
    if (threats.rangeCreatures >= 1) {
        const reach = bowReach(bow);
        if (reach >= 10) return ranks.middle;
        if (reach === 9) return ranks.front;
        return ranks.middle;
    }
    return ranks.middle;
};

const c51FullDamage = (
    board: IBoard,
    context: IPlacementContext,
    bows: readonly Unit[],
    threats: IPublicPlacementThreats,
): void => {
    const holds = c51Holds(board, bows);
    const shorts = holds.filter((hold) => hold.bow && !c51Qualifies(hold.bow));
    const displaced = shorts.map((hold) => hold.bow).filter((bow): bow is Unit => bow !== undefined);
    const cornerIds = new Set(holds.map((hold) => hold.bow?.getId()).filter((id): id is string => id !== undefined));
    const off = bows.filter((bow) => c51Qualifies(bow) && !cornerIds.has(bow.getId())).sort(c51ByClaim);
    const lifted = new Set<string>([...displaced.map((bow) => bow.getId()), ...off.map((bow) => bow.getId())]);
    const taken = takenCells(board, lifted);
    const assignments = new Map<string, XY>();
    const open = [...shorts];
    for (const bow of off) {
        open.sort(
            (a, b) =>
                Math.abs(medianLat(bow, board) - a.lat) - Math.abs(medianLat(bow, board) - b.lat) || a.lat - b.lat,
        );
        const hold = open[0];
        if (!hold) break;
        const anchor = c51BackAnchor(bow, board, hold.lat, taken);
        if (!anchor) continue;
        assignments.set(bow.getId(), anchor);
        c51Mark(taken, footprintCellsForAnchor(bow, anchor));
        open.shift();
    }
    const banned = new Set<number>();
    for (const bow of bows) {
        if (!c51Qualifies(bow)) continue;
        const anchor = assignments.get(bow.getId()) ?? board.cells.get(bow.getId());
        if (!anchor) continue;
        for (const cell of footprintCellsForAnchor(bow, anchor)) banned.add(board.geom.lateral(cell));
    }
    const ranks = ranksOf(board);
    for (const bow of [...displaced].sort(byReachAsc)) {
        const rank = c51DisplacedRank(bow, threats, ranks);
        for (const lat of lateralsNearestCentre(board)) {
            if (banned.has(lat)) continue;
            const anchor = anchorOnRankAt(bow, rank, lat, board, context);
            if (!anchor) continue;
            const footprint = footprintCellsForAnchor(bow, anchor);
            const span = spanAt(bow, anchor, board.geom);
            if (!span || !spanIsLegal(span, board.geom, taken)) continue;
            if (footprint.some((cell) => board.geom.frontness(cell) === ranks.back)) continue;
            if (footprint.some((cell) => banned.has(board.geom.lateral(cell)))) continue;
            assignments.set(bow.getId(), anchor);
            c51Mark(taken, footprint);
            break;
        }
    }
    c51Apply(board, assignments);
};

const c51Guard = (unit: Unit, board: IBoard): boolean => {
    if (!board.footprint(unit).length || unit.canFly() || isCharger(unit) || PROTECTORS.has(unit.getName())) {
        return false;
    }
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

const c51OnCorner = (unit: Unit, board: IBoard): boolean => {
    const corners = backCornerKeys(board.geom);
    return board.footprint(unit).some((cell) => corners.has(keyOf(cell)));
};

const c51Forward = (board: IBoard, bow: Unit): XY | undefined => {
    const anchor = board.cells.get(bow.getId());
    if (!anchor) return undefined;
    const dest = board.geom.towardEnemy(anchor, 1);
    if (!board.geom.legal.has(keyOf(dest))) return undefined;
    if (board.geom.lateral(dest) !== board.geom.lateral(anchor)) return undefined;
    if (board.geom.frontness(dest) <= board.geom.frontness(anchor)) return undefined;
    return dest;
};

const c51Screens = (
    board: IBoard,
    units: readonly Unit[],
    threats: IPublicPlacementThreats,
    throughAlone: boolean,
): void => {
    if (throughAlone || threats.areaThrow || threats.largeCaliber || threats.rangeCreatures >= 2) return;
    if (units.filter((unit) => unit.canFly()).length < 2) return;
    const bows = placedRange(board.units, board);
    if (!bows.length) return;
    const targets = bows.length >= 2 ? bows.filter((bow) => c51OnCorner(bow, board)).sort(byReachDesc) : bows;
    const guards = board.units
        .filter((unit) => c51Guard(unit, board))
        .sort((a, b) => a.getHp() - b.getHp() || byId(a, b));
    const locked = new Set<string>(bows.map((bow) => bow.getId()));
    let guardIndex = 0;
    for (const bow of targets) {
        while (guardIndex < guards.length && locked.has(guards[guardIndex].getId())) guardIndex += 1;
        const guard = guards[guardIndex];
        if (!guard) return;
        const dest = c51Forward(board, bow);
        if (!dest || !placeUnitAt(board, guard, dest, new Set(), locked)) continue;
        locked.add(guard.getId());
        guardIndex += 1;
    }
};

/**
 * r5c1 post-pass. Today's placeArmy has already run. Area Throw keeps a Chebyshev-3 empty ring,
 * Large Caliber keeps only the 3x3 impact empty, Through Shot leaves the two cannon files on each
 * wing, and any other short bow leaves a back corner it is not allowed to hold. The zone stays.
 */
export function placeArmyR5C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (!units.some((unit) => unit.getAttackType() === RANGE)) return new Map(board.cells);
    const bows = placedRange(units, board);
    if (!bows.length) return new Map(board.cells);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    let throughAlone = false;
    if (threats.areaThrow) c51Area(board, bows);
    else if (threats.largeCaliber) c51Caliber(board, bows);
    else if (threats.throughShot) {
        c51Through(board, bows);
        throughAlone = true;
    } else if (bows.length >= 2) c51FullDamage(board, context, bows, threats);
    c51Screens(board, units, threats, throughAlone);
    return board.cells;
}

const C52_LINES = ["Fire Breath", "Skewer Strike", "Lightning Spin", "Through Shot", "Chakram"] as const;

const c52Has = (unit: Unit, needle: string): boolean =>
    unit.hasAbilityActive(needle) || hasNamed(CATALOG.get(unit.getName())?.abilities, needle);

const c52Line = (unit: Unit): boolean => C52_LINES.some((name) => c52Has(unit, name));

const c52Charge = (unit: Unit): boolean => c52Has(unit, "Rapid Charge");

const c52Warded = (unit: Unit, board: IBoard): boolean => PROTECTORS.has(unit.getName()) && touchesAlly(unit, board);

const c52Copy = (cell: XY): XY => ({ x: cell.x, y: cell.y });

interface IC52Ranks {
    readonly back: number;
    readonly middle: number;
    readonly front: number;
    readonly minLat: number;
    readonly maxLat: number;
}

/** Middle is the cell directly behind the front face, so a size-3 zone still has one middle rank. */
const c52Ranks = (board: IBoard): IC52Ranks => {
    const ranks = ranksOf(board);
    return {
        back: ranks.back,
        middle: ranks.front - 1,
        front: ranks.front,
        minLat: ranks.minLat,
        maxLat: ranks.maxLat,
    };
};

const c52Laterals = (board: IBoard): number[] => {
    const ranks = c52Ranks(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (r3Cell(board, ranks.front, lat)) laterals.push(lat);
    }
    return laterals;
};

const c52CentreFile = (board: IBoard): number => {
    const centre = board.geom.centreLat;
    const laterals = c52Laterals(board).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    return laterals[0] ?? Math.round(centre);
};

const c52CentrePair = (board: IBoard): number[] => {
    const centre = board.geom.centreLat;
    const laterals = c52Laterals(board).sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    if (!laterals.length) return [];
    const best = Math.abs(laterals[0] - centre);
    return laterals.filter((lat) => Math.abs(lat - centre) === best);
};

const c52ArmorDesc = (a: Unit, b: Unit): number => b.getArmor() - a.getArmor() || byId(a, b);

const c52ArmorAsc = (a: Unit, b: Unit): number => a.getArmor() - b.getArmor() || byId(a, b);

const c52Screen = (unit: Unit, board: IBoard): boolean =>
    board.footprint(unit).length > 0 &&
    !unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !c52Charge(unit) &&
    !c52Warded(unit, board);

const c52ScreensOf = (board: IBoard): Unit[] => board.units.filter((unit) => c52Screen(unit, board));

const c52Occupant = (board: IBoard, cell: XY): Unit | undefined =>
    board.units.find((unit) => board.footprint(unit).some((entry) => sameCell(entry, cell)));

const c52Fastest = (board: IBoard): Unit | undefined =>
    board.units
        .filter(
            (unit) =>
                c52Charge(unit) &&
                unit.getAttackType() !== RANGE &&
                !c52Warded(unit, board) &&
                board.footprint(unit).length > 0,
        )
        .sort((a, b) => b.getSteps() - a.getSteps() || a.getArmor() - b.getArmor() || byId(a, b))[0];

/** Cells one step toward the enemy from the charger's face. A screen must not be placed there. */
const c52BannedAhead = (board: IBoard): Set<number> => {
    const banned = new Set<number>();
    const charger = c52Fastest(board);
    if (!charger) return banned;
    const cells = board.footprint(charger);
    if (!cells.length) return banned;
    const face = Math.max(...cells.map((cell) => board.geom.frontness(cell)));
    for (const cell of cells) {
        if (board.geom.frontness(cell) !== face) continue;
        const ahead = r3Cell(board, face + 1, board.geom.lateral(cell));
        if (ahead) banned.add(keyOf(ahead));
    }
    return banned;
};

const c52Attempt = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    const planned = new Map<string, XY>();
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit || unit.getAttackType() === RANGE || c52Warded(unit, board)) continue;
        const current = board.cells.get(id);
        if (!current || sameCell(current, anchor)) continue;
        planned.set(id, c52Copy(anchor));
    }
    return planned.size > 0 && c43Commit(board, planned);
};

const c52Taken = (board: IBoard, away: ReadonlySet<string>, moves: ReadonlyMap<string, XY>): Set<number> => {
    const taken = takenCells(board, away);
    for (const [id, anchor] of moves) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit) continue;
        for (const cell of footprintCellsForAnchor(unit, anchor)) taken.add(keyOf(cell));
    }
    return taken;
};

const c52Nearest = (
    board: IBoard,
    unit: Unit,
    moves: ReadonlyMap<string, XY>,
    accept: (span: ISpan) => boolean,
): XY | undefined => {
    const away = new Set<string>([unit.getId(), ...moves.keys()]);
    const taken = c52Taken(board, away, moves);
    const current = board.cells.get(unit.getId());
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken) || !accept(span)) continue;
        const score = (current ? chebyshev(anchor, current) : 0) * 100 + span.cells.length;
        if (
            !best ||
            score < bestScore ||
            (score === bestScore && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestScore = score;
        }
    }
    return best ? c52Copy(best) : undefined;
};

const c52OnFront = (unit: Unit, board: IBoard): boolean => {
    const cells = board.footprint(unit);
    const front = c52Ranks(board).front;
    return cells.length > 0 && cells.every((cell) => board.geom.frontness(cell) === front);
};

const c52FrontScreens = (board: IBoard): Unit[] =>
    c52ScreensOf(board).filter((unit) => unit.isSmallSize() && c52OnFront(unit, board));

const c52SortFront = (board: IBoard): void => {
    const banned = c52BannedAhead(board);
    const pool = c52FrontScreens(board).filter(
        (unit) => !board.footprint(unit).some((cell) => banned.has(keyOf(cell))),
    );
    if (pool.length < 2) return;
    const centre = c52CentreFile(board);
    const slots: XY[] = [];
    for (const unit of pool) {
        const anchor = board.cells.get(unit.getId());
        if (anchor) slots.push(c52Copy(anchor));
    }
    if (slots.length !== pool.length) return;
    slots.sort(
        (a, b) =>
            Math.abs(board.geom.lateral(a) - centre) - Math.abs(board.geom.lateral(b) - centre) ||
            board.geom.lateral(a) - board.geom.lateral(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    const moves = new Map<string, XY>();
    [...pool].sort(c52ArmorDesc).forEach((unit, index) => moves.set(unit.getId(), slots[index]));
    c52Attempt(board, moves);
};

const c52Stagger = (board: IBoard): void => {
    const ranks = c52Ranks(board);
    const banned = c52BannedAhead(board);
    const screens = c52FrontScreens(board).sort(c52ArmorDesc);
    if (screens.length < 2) return;
    const stayers = screens.slice(0, Math.ceil(screens.length / 2));
    const movers = screens.slice(stayers.length);
    const moves = new Map<string, XY>();
    const used = new Set<string>();
    for (const mover of movers) {
        const options = [...stayers].sort(
            (a, b) =>
                Math.abs(medianLat(a, board) - medianLat(mover, board)) -
                    Math.abs(medianLat(b, board) - medianLat(mover, board)) || byId(a, b),
        );
        for (const stayer of options) {
            if (used.has(stayer.getId())) continue;
            const lat = medianLat(stayer, board);
            const middle = r3Cell(board, ranks.middle, lat);
            const front = r3Cell(board, ranks.front, lat);
            if (!middle || !front || banned.has(keyOf(middle)) || banned.has(keyOf(front))) continue;
            const frontUnit = c52Occupant(board, front);
            if (!frontUnit || frontUnit.getId() !== stayer.getId()) continue;
            const occupant = c52Occupant(board, middle);
            if (occupant && occupant.getId() !== mover.getId()) continue;
            moves.set(mover.getId(), c52Copy(middle));
            used.add(stayer.getId());
            break;
        }
    }
    c52Attempt(board, moves);
};

const c52FrontKept = (board: IBoard, front: XY, moves: ReadonlyMap<string, XY>): boolean => {
    const occupant = c52Occupant(board, front);
    if (!occupant) return moves.size > 0 && [...moves.entries()].some(([, anchor]) => sameCell(anchor, front));
    const next = moves.get(occupant.getId());
    if (!next) return true;
    return sameCell(next, front) || [...moves.values()].some((anchor) => sameCell(anchor, front));
};

const c52Cap = (board: IBoard): void => {
    const screens = c52ScreensOf(board).filter((unit) => unit.isSmallSize());
    if (!screens.length) return;
    const ranks = c52Ranks(board);
    const lat = c52CentreFile(board);
    const front = r3Cell(board, ranks.front, lat);
    const middle = r3Cell(board, ranks.middle, lat);
    const back = r3Cell(board, ranks.back, lat);
    if (!front || !middle || !back) return;
    const banned = c52BannedAhead(board);
    const highest = [...screens].sort(c52ArmorDesc)[0];
    const lowest = [...screens].sort(c52ArmorAsc).filter((unit) => unit.getId() !== highest.getId());
    const attempts: Map<string, XY>[] = [];
    const seat = (pairs: readonly (readonly [Unit, XY])[]): Map<string, XY> => {
        const moves = new Map<string, XY>();
        for (const [unit, cell] of pairs) {
            if (banned.has(keyOf(cell))) continue;
            moves.set(unit.getId(), c52Copy(cell));
        }
        return moves;
    };
    if (screens.length >= 3 && lowest.length >= 2) {
        attempts.push(
            seat([
                [highest, front],
                [lowest[1], middle],
                [lowest[0], back],
            ]),
        );
        attempts.push(
            seat([
                [highest, front],
                [lowest[1], middle],
            ]),
        );
        attempts.push(seat([[highest, front]]));
    } else {
        const occupant = c52Occupant(board, front);
        const pool = [...screens].sort(c52ArmorAsc).filter((unit) => !occupant || occupant.getId() !== unit.getId());
        if (pool[0] && pool[1]) {
            attempts.push(
                seat([
                    [pool[1], middle],
                    [pool[0], back],
                ]),
            );
        }
        if (pool[0]) attempts.push(seat([[pool[0], middle]]));
    }
    const occupied = !!c52Occupant(board, front);
    for (const moves of attempts) {
        if (moves.size > 0 && [...moves].every(([id, anchor]) => sameCell(board.cells.get(id) ?? anchor, anchor))) {
            return;
        }
        if (occupied && !c52FrontKept(board, front, moves)) continue;
        const snapshot = copyCells(board);
        if (!c52Attempt(board, moves)) continue;
        if (occupied && !c52Occupant(board, front)) {
            restoreCells(board, snapshot);
            continue;
        }
        return;
    }
};

const c52ClearFiles = (board: IBoard): void => {
    const ranks = c52Ranks(board);
    const fronts = c52FrontScreens(board);
    const files = new Set<number>();
    for (const screen of fronts) {
        for (const lat of board.laterals(screen)) files.add(lat);
    }
    if (!files.size) return;
    const forbidden = new Set<number>();
    for (const lat of files) {
        const middle = r3Cell(board, ranks.middle, lat);
        const back = r3Cell(board, ranks.back, lat);
        if (middle) forbidden.add(keyOf(middle));
        if (back) forbidden.add(keyOf(back));
    }
    const banned = c52BannedAhead(board);
    const intruders = c52ScreensOf(board)
        .filter(
            (unit) =>
                !fronts.some((screen) => screen.getId() === unit.getId()) &&
                board.footprint(unit).some((cell) => forbidden.has(keyOf(cell))),
        )
        .sort(byId);
    const moves = new Map<string, XY>();
    for (const unit of intruders) {
        const dest = c52Nearest(
            board,
            unit,
            moves,
            (span) => !span.cells.some((cell) => forbidden.has(keyOf(cell)) || banned.has(keyOf(cell))),
        );
        if (dest) moves.set(unit.getId(), dest);
    }
    c52Attempt(board, moves);
};

const c52Spin = (board: IBoard): void => {
    const screens = c52ScreensOf(board)
        .filter((unit) => unit.isSmallSize())
        .sort(c52ArmorAsc);
    if (!screens.length) return;
    const ranks = c52Ranks(board);
    const pair = c52CentrePair(board);
    const primary = pair[0];
    if (primary === undefined) return;
    const moves = new Map<string, XY>();
    const backPrimary = r3Cell(board, ranks.back, primary);
    const backOther = pair[1] === undefined ? undefined : r3Cell(board, ranks.back, pair[1]);
    if (backPrimary) moves.set(screens[0].getId(), c52Copy(backPrimary));
    if (screens[1] && backOther) moves.set(screens[1].getId(), c52Copy(backOther));
    const middle = r3Cell(board, ranks.middle, primary);
    let relocated: string | undefined;
    if (middle) {
        const occupant = c52Occupant(board, middle);
        if (occupant && c52Screen(occupant, board) && !moves.has(occupant.getId())) {
            const banned = c52BannedAhead(board);
            const open = (span: ISpan, allowFront: boolean): boolean =>
                !span.cells.some((cell) => {
                    if (sameCell(cell, middle) || banned.has(keyOf(cell))) return true;
                    const depth = board.geom.frontness(cell);
                    return depth === ranks.back || (!allowFront && depth === ranks.front);
                });
            const dest =
                c52Nearest(board, occupant, moves, (span) => open(span, false)) ??
                c52Nearest(board, occupant, moves, (span) => open(span, true));
            if (dest) {
                moves.set(occupant.getId(), dest);
                relocated = occupant.getId();
            }
        }
    }
    if (c52Attempt(board, moves) || !relocated) return;
    moves.delete(relocated);
    c52Attempt(board, moves);
};

const c52Screens = (board: IBoard, units: readonly Unit[], threats: IPublicPlacementThreats): void => {
    const ownFlyer = units.some((unit) => unit.canFly());
    const ownLine = units.some((unit) => c52Line(unit));
    const ownCharge = units.some((unit) => c52Charge(unit));
    // The centre column is the shot cover when the enemy also shoots and lacks Through Shot.
    // No enemy flyers: do not build that cap. A line or an enemy charger falls through instead.
    if (ownFlyer && !ownLine && !ownCharge && threats.flyers > 0 && !threats.lineAttack && !threats.rapidCharge) {
        c52Cap(board);
        return;
    }
    if (!threats.lineAttack && threats.rangeCreatures === 0 && threats.flyers === 0) {
        c52SortFront(board);
        return;
    }
    if (threats.rangeCreatures > 0 && !threats.lineAttack && !threats.throughShot && threats.flyers === 0) {
        c52Stagger(board);
        return;
    }
    if (threats.fireBreath || threats.skewerStrike) {
        c52SortFront(board);
        return;
    }
    if ((threats.throughShot || threats.chakram) && !threats.fireBreath && !threats.skewerStrike) {
        c52SortFront(board);
        c52ClearFiles(board);
        return;
    }
    if (
        threats.lightningSpin &&
        !threats.fireBreath &&
        !threats.skewerStrike &&
        !threats.throughShot &&
        !threats.chakram
    ) {
        c52Spin(board);
    }
};

const c52FileClear = (board: IBoard, lat: number, ignore: ReadonlySet<string>): boolean =>
    !board.units.some((unit) => !ignore.has(unit.getId()) && board.laterals(unit).includes(lat));

const c52SeatCharger = (board: IBoard, charger: Unit): XY | undefined => {
    const ranks = c52Ranks(board);
    const ignore = new Set([charger.getId()]);
    const taken = takenCells(board, ignore);
    const current = medianLat(charger, board);
    const edges = [ranks.minLat, ranks.maxLat].sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
    const consider = (lat: number, strict: boolean): XY | undefined => {
        const middleCell = r3Cell(board, ranks.middle, lat);
        if (!middleCell || !c52FileClear(board, lat, ignore)) return undefined;
        let best: XY | undefined;
        let bestScore = Infinity;
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(charger, anchor, board.geom);
            if (!span || !spanIsLegal(span, board.geom, taken)) continue;
            if (!span.cells.some((cell) => sameCell(cell, middleCell))) continue;
            // The face stays on the middle rank, never on the back rank or a front corner.
            if (span.maxFront !== ranks.middle) continue;
            if (strict && span.minFront !== ranks.middle) continue;
            if (span.laterals.some((file) => !c52FileClear(board, file, ignore))) continue;
            const backCell = r3Cell(board, ranks.back, lat);
            const coversBack = !!backCell && span.cells.some((cell) => sameCell(cell, backCell));
            const score =
                (coversBack ? 1000 : 0) + Math.abs(medianNumber(span.laterals) - lat) * 10 + span.cells.length;
            if (
                !best ||
                score < bestScore ||
                (score === bestScore && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
            ) {
                best = anchor;
                bestScore = score;
            }
        }
        return best ? c52Copy(best) : undefined;
    };
    for (const edge of edges) {
        const step = edge === ranks.minLat ? 1 : -1;
        for (let lat = edge; lat >= ranks.minLat && lat <= ranks.maxLat; lat += step) {
            const strict = consider(lat, true);
            if (strict) return strict;
            // Shipped chargers are two deep, so the face takes the middle and the tail covers the back cell.
            const relaxed = consider(lat, false);
            if (relaxed) return relaxed;
        }
    }
    return undefined;
};

const c52PlaceCharger = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const charger = c52Fastest(board);
    if (!charger || threats.rapidCharge) return;
    if (threats.flyers > 0 && threats.rangeCreatures === 0 && !threats.lineAttack) return;
    const spot = c52SeatCharger(board, charger);
    if (!spot) return;
    c52Attempt(board, new Map([[charger.getId(), spot]]));
};

const c52Gap = (laterals: readonly number[], blocked: ReadonlySet<number>): boolean => {
    for (const lat of laterals) {
        for (const other of blocked) {
            if (Math.abs(lat - other) < 2) return false;
        }
    }
    return true;
};

const c52SplitFlyers = (board: IBoard, flyers: readonly Unit[]): void => {
    const ranks = c52Ranks(board);
    const centre = board.geom.centreLat;
    const movers = new Set(flyers.map((unit) => unit.getId()));
    const nonFlyer = new Set<number>();
    const parkedFlyer = new Set<number>();
    for (const unit of board.units) {
        if (movers.has(unit.getId()) || !board.footprint(unit).length) continue;
        const target = unit.canFly() ? parkedFlyer : nonFlyer;
        for (const lat of board.laterals(unit)) target.add(lat);
    }
    const charger = c52Fastest(board);
    const chargerLats = new Set<number>(charger ? board.laterals(charger) : []);
    const placed: number[] = [];
    const moves = new Map<string, XY>();
    for (const flyer of flyers) {
        let chosen: XY | undefined;
        const chosenLats: number[] = [];
        for (let lat = ranks.maxLat; lat > centre; lat -= 1) {
            const away = new Set<string>([flyer.getId(), ...moves.keys()]);
            const taken = c52Taken(board, away, moves);
            let anchor: XY | undefined;
            let span: ISpan | undefined;
            for (const candidate of board.geom.baseCells) {
                const seated = spanAt(flyer, candidate, board.geom);
                if (!seated || !spanIsLegal(seated, board.geom, taken)) continue;
                if (seated.cells.some((cell) => board.geom.frontness(cell) !== ranks.front)) continue;
                if (Math.max(...seated.laterals) !== lat) continue;
                anchor = candidate;
                span = seated;
                break;
            }
            if (!anchor || !span) continue;
            if (span.cells.some((cell) => board.geom.frontness(cell) !== ranks.front)) continue;
            if (span.laterals.some((file) => file <= centre || chargerLats.has(file))) continue;
            if (!c52Gap(span.laterals, nonFlyer) || !c52Gap(span.laterals, parkedFlyer)) continue;
            if (placed.some((file) => span.laterals.some((value) => Math.abs(value - file) < 2))) continue;
            const depthBusy = span.laterals.some((file) => {
                const middle = r3Cell(board, ranks.middle, file);
                const back = r3Cell(board, ranks.back, file);
                const blocked = (cell: XY | undefined): boolean => {
                    if (!cell) return false;
                    const occupant = c52Occupant(board, cell);
                    return !!occupant && !away.has(occupant.getId());
                };
                return blocked(middle) || blocked(back);
            });
            if (depthBusy) continue;
            const frontBusy = span.cells.some((cell) => {
                const occupant = c52Occupant(board, cell);
                return !!occupant && !away.has(occupant.getId());
            });
            if (frontBusy) continue;
            chosen = c52Copy(anchor);
            chosenLats.push(...span.laterals);
            break;
        }
        if (!chosen) continue;
        moves.set(flyer.getId(), chosen);
        placed.push(...chosenLats);
    }
    c52Attempt(board, moves);
};

const c52BackFlyers = (board: IBoard, flyers: readonly Unit[]): void => {
    const ranks = c52Ranks(board);
    const centre = board.geom.centreLat;
    const files: number[] = [];
    const ground = (unit: Unit | undefined): boolean => !!unit && !unit.canFly() && unit.getAttackType() !== RANGE;
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        const front = r3Cell(board, ranks.front, lat);
        const middle = r3Cell(board, ranks.middle, lat);
        if (!front || !middle || !r3Cell(board, ranks.back, lat)) continue;
        if (ground(c52Occupant(board, front)) && ground(c52Occupant(board, middle))) files.push(lat);
    }
    files.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    const moves = new Map<string, XY>();
    const used = new Set<number>();
    for (const flyer of flyers) {
        if (!flyer.isSmallSize()) continue;
        for (const lat of files) {
            if (used.has(lat)) continue;
            const back = r3Cell(board, ranks.back, lat);
            if (!back) continue;
            const occupant = c52Occupant(board, back);
            if (occupant && occupant.getId() !== flyer.getId()) continue;
            moves.set(flyer.getId(), c52Copy(back));
            used.add(lat);
            break;
        }
    }
    c52Attempt(board, moves);
};

const c52PlaceFlyers = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const flyers = board.units
        .filter(
            (unit) =>
                unit.canFly() &&
                unit.getAttackType() !== RANGE &&
                !c52Warded(unit, board) &&
                board.footprint(unit).length > 0,
        )
        .sort(byId);
    if (!flyers.length || threats.rapidCharge) return;
    if (threats.lineAttack || threats.flyers > 0) {
        c52SplitFlyers(board, flyers);
        return;
    }
    if (threats.rangeCreatures > 0) c52BackFlyers(board, flyers);
};

/**
 * r5c2 post-pass. Today's placeArmy has already run. Higher armor keeps the front face, the fastest
 * charger takes the middle of an empty wing, and non-range flyers split on the high side. Area Throw
 * and Large Caliber leave the map alone. The zone and the augment spend stay.
 */
export function placeArmyR5C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    c52Screens(board, units, threats);
    c52PlaceCharger(board, threats);
    c52PlaceFlyers(board, threats);
    return board.cells;
}

const c53Locked = (board: IBoard): Set<string> => {
    const locked = c43CornerSole(board);
    for (const unit of board.units) {
        if (unit.getAttackType() === RANGE && board.footprint(unit).length) locked.add(unit.getId());
    }
    return locked;
};

const c53Casters = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units
        .filter(
            (unit) =>
                isCasterUnit(unit) &&
                !locked.has(unit.getId()) &&
                board.footprint(unit).length > 0 &&
                coveringProtectors(unit, board).length === 0,
        )
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));

const c53Screens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units.filter((unit) => c43IsScreen(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0);

const c53Commit = (board: IBoard, locked: ReadonlySet<string>, moves: ReadonlyMap<string, XY>): boolean => {
    if (!moves.size) return false;
    for (const id of moves.keys()) {
        if (locked.has(id)) return false;
    }
    return c43Commit(board, moves);
};

const c53HitsKeys = (footprint: readonly XY[], keys: ReadonlySet<number>): boolean =>
    footprint.some((cell) => keys.has(keyOf(cell)));

const c53OnFile = (board: IBoard, footprint: readonly XY[], lat: number): boolean =>
    footprint.every((cell) => board.geom.lateral(cell) === lat);

const c53Lat = (footprint: readonly XY[], geom: IGeom): number =>
    medianNumber(footprint.map((cell) => geom.lateral(cell)));

const c53Overlaps = (left: readonly XY[], right: readonly XY[]): boolean =>
    left.some((cell) => right.some((other) => sameCell(cell, other)));

const c53Closer = (dist: number, anchor: XY, bestDist: number, best: XY | undefined): boolean => {
    if (!best || dist < bestDist) return true;
    if (dist > bestDist) return false;
    return anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y);
};

const c53OnRank = (
    board: IBoard,
    unit: Unit,
    rank: number,
    taken: ReadonlySet<number>,
    covers: XY,
    accept?: (footprint: readonly XY[]) => boolean,
): XY | undefined => {
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        if (!footprint.every((cell) => board.geom.frontness(cell) === rank)) continue;
        if (!footprint.some((cell) => sameCell(cell, covers))) continue;
        if (accept && !accept(footprint)) continue;
        const score = (sameCell(anchor, covers) ? 0 : 100) + footprint.length;
        if (
            score < bestScore ||
            (score === bestScore && !!best && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestScore = score;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c53RingEmpty = (footprint: readonly XY[], board: IBoard, ignore: ReadonlySet<string>): boolean => {
    const own = new Set(footprint.map((cell) => keyOf(cell)));
    for (const cell of footprint) {
        for (let dx = -1; dx <= 1; dx += 1) {
            for (let dy = -1; dy <= 1; dy += 1) {
                if (dx === 0 && dy === 0) continue;
                const neighbor = { x: cell.x + dx, y: cell.y + dy };
                if (own.has(keyOf(neighbor))) continue;
                if (c43Occupant(board, neighbor, ignore)) return false;
            }
        }
    }
    return true;
};

const c53BaitCell = (board: IBoard): XY | undefined => {
    const ranks = ranksOf(board);
    const cells = board.geom.baseCells.filter((cell) => board.geom.frontness(cell) === ranks.front);
    cells.sort(
        (a, b) =>
            Math.abs(board.geom.lateral(a) - board.geom.centreLat) -
                Math.abs(board.geom.lateral(b) - board.geom.centreLat) ||
            board.geom.lateral(a) - board.geom.lateral(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    const cell = cells[0];
    return cell ? { x: cell.x, y: cell.y } : undefined;
};

const c53DistToCell = (board: IBoard, unit: Unit, cell: XY): number => {
    const footprint = board.footprint(unit);
    if (!footprint.length) return Infinity;
    let best = Infinity;
    for (const entry of footprint) best = Math.min(best, chebyshev(entry, cell));
    return best;
};

const c53NearCaster = (board: IBoard, unit: Unit, casters: readonly Unit[]): boolean => {
    const footprint = board.footprint(unit);
    if (!footprint.length) return false;
    return casters.some((caster) => {
        const theirs = board.footprint(caster);
        return theirs.length > 0 && minChebyshev(footprint, theirs) <= 3;
    });
};

const c53FrontTouch = (
    board: IBoard,
    unit: Unit,
    rank: number,
    taken: ReadonlySet<number>,
    bait: readonly XY[],
): XY | undefined => {
    const origin = medianLat(unit, board);
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        if (!footprint.every((cell) => board.geom.frontness(cell) === rank)) continue;
        if (minChebyshev(footprint, bait) !== 1) continue;
        const dist = Math.abs(c53Lat(footprint, board.geom) - origin);
        if (!c53Closer(dist, anchor, bestDist, best)) continue;
        best = anchor;
        bestDist = dist;
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c53PlanArea = (board: IBoard, bait: Unit, bodies: readonly Unit[], baitCell: XY): Map<string, XY> | undefined => {
    const ranks = ranksOf(board);
    const frozen = new Set<string>();
    const ordered = [...bodies].sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    while (frozen.size <= ordered.length) {
        const movers = new Set<string>([bait.getId()]);
        for (const body of ordered) {
            if (!frozen.has(body.getId())) movers.add(body.getId());
        }
        const taken = takenCells(board, movers);
        const baitAnchor = c53OnRank(board, bait, ranks.front, taken, baitCell);
        if (!baitAnchor) return undefined;
        const plan = new Map<string, XY>([[bait.getId(), baitAnchor]]);
        const used = new Set<number>(taken);
        for (const cell of footprintCellsForAnchor(bait, baitAnchor)) used.add(keyOf(cell));
        const baitFootprint = footprintCellsForAnchor(bait, baitAnchor);
        const failed: Unit[] = [];
        for (const body of ordered) {
            if (frozen.has(body.getId())) continue;
            const spot = c53FrontTouch(board, body, ranks.front, used, baitFootprint);
            if (!spot) {
                failed.push(body);
                continue;
            }
            plan.set(body.getId(), spot);
            for (const cell of footprintCellsForAnchor(body, spot)) used.add(keyOf(cell));
        }
        if (!failed.length) return plan;
        let grew = false;
        for (const body of failed) {
            if (frozen.has(body.getId())) continue;
            frozen.add(body.getId());
            grew = true;
        }
        if (!grew) return undefined;
    }
    return undefined;
};

const c53BackSeat = (
    board: IBoard,
    caster: Unit,
    casters: readonly Unit[],
    baitFootprint: readonly XY[],
    origin: number,
    corners: ReadonlySet<number>,
): XY | undefined => {
    const ranks = ranksOf(board);
    const taken = takenCells(board, new Set([caster.getId()]));
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(caster, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        if (!footprint.every((cell) => board.geom.frontness(cell) === ranks.back)) continue;
        if (c53HitsKeys(footprint, corners)) continue;
        if (!baitFootprint.length || minChebyshev(footprint, baitFootprint) < 3) continue;
        let separated = true;
        for (const other of casters) {
            if (other.getId() === caster.getId()) continue;
            const theirs = board.footprint(other);
            if (theirs.length && minChebyshev(footprint, theirs) < 3) separated = false;
        }
        if (!separated || !c53RingEmpty(footprint, board, new Set([caster.getId()]))) continue;
        const dist = Math.abs(c53Lat(footprint, board.geom) - origin);
        if (!c53Closer(dist, anchor, bestDist, best)) continue;
        best = anchor;
        bestDist = dist;
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c53SeatCasters = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[], bait: Unit): void => {
    const corners = backCornerKeys(board.geom);
    const origins = new Map(casters.map((caster) => [caster.getId(), medianLat(caster, board)]));
    const done = new Set<string>();
    let progress = true;
    while (progress) {
        progress = false;
        for (const caster of casters) {
            if (done.has(caster.getId())) continue;
            const baitFootprint = board.footprint(bait);
            const seat = c53BackSeat(board, caster, casters, baitFootprint, origins.get(caster.getId()) ?? 0, corners);
            const current = board.cells.get(caster.getId());
            if (!seat) continue;
            if (current && sameCell(current, seat)) {
                done.add(caster.getId());
                continue;
            }
            if (!c53Commit(board, locked, new Map([[caster.getId(), seat]]))) continue;
            done.add(caster.getId());
            progress = true;
        }
    }
};

const c53Area = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const baitCell = c53BaitCell(board);
    if (!baitCell) return;
    const screens = c53Screens(board, locked).sort(
        (a, b) =>
            c53DistToCell(board, a, baitCell) - c53DistToCell(board, b, baitCell) ||
            footprintArea(a) - footprintArea(b) ||
            byId(a, b),
    );
    for (const bait of screens) {
        const bodies = board.units.filter(
            (unit) =>
                unit.getId() !== bait.getId() &&
                !locked.has(unit.getId()) &&
                !isCasterUnit(unit) &&
                board.footprint(unit).length > 0 &&
                c53NearCaster(board, unit, casters),
        );
        const plan = c53PlanArea(board, bait, bodies, baitCell);
        if (!plan || !c53Commit(board, locked, plan)) continue;
        c53SeatCasters(board, locked, casters, bait);
        return;
    }
};

const c53Clearance = (footprint: readonly XY[], obstacles: readonly (readonly XY[])[]): number => {
    if (!obstacles.length) return Infinity;
    let best = Infinity;
    for (const obstacle of obstacles) best = Math.min(best, minChebyshev(footprint, obstacle));
    return best;
};

const c53Caliber = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const claimed = new Set<string>();
    const pairs: { caster: Unit; screen: Unit }[] = [];
    for (const caster of casters) {
        const mine = board.footprint(caster);
        const screens = c53Screens(board, locked)
            .filter((screen) => !claimed.has(screen.getId()) && minChebyshev(mine, board.footprint(screen)) === 1)
            .sort(byId);
        const screen = screens[0];
        if (!screen) continue;
        claimed.add(screen.getId());
        pairs.push({ caster, screen });
    }
    for (const caster of casters) {
        const origin = medianLat(caster, board);
        const taken = takenCells(board, new Set([caster.getId()]));
        const obstacles = board.units
            .filter((unit) => unit.getId() !== caster.getId() && board.footprint(unit).length > 0)
            .map((unit) => board.footprint(unit));
        let best: XY | undefined;
        let bestClear = -1;
        let bestLat = Infinity;
        for (const anchor of board.geom.baseCells) {
            const footprint = footprintCellsForAnchor(caster, anchor);
            if (!r3Legal(footprint, board, taken)) continue;
            if (!footprint.every((cell) => board.geom.frontness(cell) === ranks.back)) continue;
            if (c53HitsKeys(footprint, corners)) continue;
            const clearance = c53Clearance(footprint, obstacles);
            const latDist = Math.abs(c53Lat(footprint, board.geom) - origin);
            const better =
                !best ||
                clearance > bestClear ||
                (clearance === bestClear &&
                    (latDist < bestLat ||
                        (latDist === bestLat && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))));
            if (!better) continue;
            best = anchor;
            bestClear = clearance;
            bestLat = latDist;
        }
        if (!best || bestClear < 3) continue;
        const current = board.cells.get(caster.getId());
        if (current && sameCell(current, best)) continue;
        c53Commit(board, locked, new Map([[caster.getId(), { x: best.x, y: best.y }]]));
    }
    const stepped = new Set<string>();
    for (const pair of pairs) {
        if (stepped.has(pair.screen.getId())) continue;
        const anchor = board.cells.get(pair.screen.getId());
        if (!anchor) continue;
        const med = medianLat(pair.screen, board);
        const delta = med > board.geom.centreLat ? -1 : med < board.geom.centreLat ? 1 : 0;
        if (delta === 0) continue;
        const next = board.geom.shiftLateral(anchor, delta);
        const taken = takenCells(board, new Set([pair.screen.getId()]));
        const footprint = footprintCellsForAnchor(pair.screen, next);
        if (!r3Legal(footprint, board, taken) || c53HitsKeys(footprint, corners)) continue;
        const casterLats = new Set(board.laterals(pair.caster));
        if (footprint.some((cell) => casterLats.has(board.geom.lateral(cell)))) continue;
        if (c53Commit(board, locked, new Map([[pair.screen.getId(), { x: next.x, y: next.y }]]))) {
            stepped.add(pair.screen.getId());
        }
    }
};

const c53Away = (lat: number, ranks: IRanks): number => {
    const low = lat - ranks.minLat;
    const high = ranks.maxLat - lat;
    return high < low ? -1 : 1;
};

const c53PlugOf = (board: IBoard, caster: Unit): { unit: Unit; lat: number } | undefined => {
    const ranks = ranksOf(board);
    const laterals = [...new Set(board.laterals(caster))].sort((a, b) => a - b);
    for (const lat of laterals) {
        const front = r3Cell(board, ranks.front, lat);
        if (!front) continue;
        const occupant = c43Occupant(board, front, new Set([caster.getId()]));
        if (!occupant || isCasterUnit(occupant)) continue;
        return { unit: occupant, lat };
    }
    return undefined;
};

const c53LineDest = (
    board: IBoard,
    unit: Unit,
    destLat: number,
    taken: ReadonlySet<number>,
    corners: ReadonlySet<number>,
): XY | undefined => {
    const ranks = ranksOf(board);
    const onDest = (footprint: readonly XY[]): boolean =>
        c53OnFile(board, footprint, destLat) && !c53HitsKeys(footprint, corners);
    const back = r3Cell(board, ranks.back, destLat);
    if (back && !corners.has(keyOf(back))) {
        const anchor = c53OnRank(board, unit, ranks.back, taken, back, onDest);
        if (anchor) return anchor;
    }
    const middle = r3Cell(board, ranks.middle, destLat);
    if (!middle) return undefined;
    return c53OnRank(board, unit, ranks.middle, taken, middle, onDest);
};

const c53TryPlug = (
    board: IBoard,
    locked: ReadonlySet<string>,
    caster: Unit,
    plug: { unit: Unit; lat: number },
    screen: Unit | undefined,
): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const dir = c53Away(plug.lat, ranks);
    const destLat = plug.lat + 2 * dir;
    const midLat = plug.lat + dir;
    const gap = r3Cell(board, ranks.back, midLat);
    const shoulder = r3Cell(board, ranks.middle, midLat);
    const ignore = new Set<string>([caster.getId()]);
    if (screen) ignore.add(screen.getId());
    if (gap && c43Occupant(board, gap, ignore)) return false;
    if (screen && !shoulder) return false;
    const taken = takenCells(board, ignore);
    const casterAnchor = c53LineDest(board, caster, destLat, taken, corners);
    if (!casterAnchor) return false;
    const casterFootprint = footprintCellsForAnchor(caster, casterAnchor);
    if (gap && casterFootprint.some((cell) => sameCell(cell, gap))) return false;
    if (c53Overlaps(casterFootprint, board.footprint(plug.unit))) return false;
    const moves = new Map<string, XY>([[caster.getId(), casterAnchor]]);
    if (screen && shoulder) {
        const blocked = new Set<number>(taken);
        for (const cell of casterFootprint) blocked.add(keyOf(cell));
        const plugFootprint = board.footprint(plug.unit);
        const screenAnchor = c53OnRank(board, screen, ranks.middle, blocked, shoulder, (footprint) => {
            if (!c53OnFile(board, footprint, midLat)) return false;
            if (gap && footprint.some((cell) => sameCell(cell, gap))) return false;
            return !c53Overlaps(footprint, plugFootprint) && !c53Overlaps(footprint, casterFootprint);
        });
        if (!screenAnchor) return false;
        moves.set(screen.getId(), screenAnchor);
    }
    return c53Commit(board, locked, moves);
};

const c53Plug = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const used = new Set<string>();
    for (const caster of casters) {
        const plug = c53PlugOf(board, caster);
        if (!plug) continue;
        const ranks = ranksOf(board);
        const shoulder = r3Cell(board, ranks.middle, plug.lat + c53Away(plug.lat, ranks));
        const screens = c53Screens(board, locked)
            .filter((screen) => screen.getId() !== plug.unit.getId() && !used.has(screen.getId()))
            .sort(
                (a, b) =>
                    (shoulder ? c53DistToCell(board, a, shoulder) - c53DistToCell(board, b, shoulder) : 0) ||
                    byId(a, b),
            );
        let moved = false;
        for (const screen of screens) {
            if (!c53TryPlug(board, locked, caster, plug, screen)) continue;
            used.add(screen.getId());
            moved = true;
            break;
        }
        if (!moved) c53TryPlug(board, locked, caster, plug, undefined);
    }
};

const c53HalfAnchors = (
    board: IBoard,
    unit: Unit,
    rank: number,
    half: LateralHalf,
    taken: ReadonlySet<number>,
    corners: ReadonlySet<number> | undefined,
): XY[] => {
    const anchors: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        if (!footprint.every((cell) => board.geom.frontness(cell) === rank)) continue;
        if (!footprint.every((cell) => halfOf(board.geom.lateral(cell), board.geom.centreLat) === half)) continue;
        if (corners && c53HitsKeys(footprint, corners)) continue;
        anchors.push({ x: anchor.x, y: anchor.y });
    }
    return anchors;
};

const c53Split = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const used = new Set<string>();
    for (const caster of casters) {
        const origin = medianLat(caster, board);
        const half = halfOf(origin, board.geom.centreLat);
        const opposite = otherHalf(half);
        const screens = c53Screens(board, locked).filter((screen) => !used.has(screen.getId()));
        let best: { casterAnchor: XY; screen: Unit; screenAnchor: XY; score: number } | undefined;
        for (const screen of screens) {
            const screenOrigin = medianLat(screen, board);
            const ignore = new Set([caster.getId(), screen.getId()]);
            const taken = takenCells(board, ignore);
            for (const casterAnchor of c53HalfAnchors(board, caster, ranks.back, half, taken, corners)) {
                const casterFootprint = footprintCellsForAnchor(caster, casterAnchor);
                const blocked = new Set<number>(taken);
                for (const cell of casterFootprint) blocked.add(keyOf(cell));
                for (const screenAnchor of c53HalfAnchors(board, screen, ranks.front, opposite, blocked, undefined)) {
                    const screenFootprint = footprintCellsForAnchor(screen, screenAnchor);
                    if (minChebyshev(casterFootprint, screenFootprint) < 4) continue;
                    if (!c53RingEmpty(casterFootprint, board, ignore)) continue;
                    const score =
                        Math.abs(c53Lat(casterFootprint, board.geom) - origin) * 1000 +
                        Math.abs(c53Lat(screenFootprint, board.geom) - screenOrigin);
                    const idOrder = best ? byId(screen, best.screen) : -1;
                    const closerAnchor =
                        !best ||
                        casterAnchor.x < best.casterAnchor.x ||
                        (casterAnchor.x === best.casterAnchor.x && casterAnchor.y < best.casterAnchor.y) ||
                        (casterAnchor.x === best.casterAnchor.x &&
                            casterAnchor.y === best.casterAnchor.y &&
                            (screenAnchor.x < best.screenAnchor.x ||
                                (screenAnchor.x === best.screenAnchor.x && screenAnchor.y < best.screenAnchor.y)));
                    if (
                        !best ||
                        score < best.score ||
                        (score === best.score && (idOrder < 0 || (idOrder === 0 && closerAnchor)))
                    ) {
                        best = { casterAnchor, screen, screenAnchor, score };
                    }
                }
            }
        }
        if (!best) continue;
        if (
            c53Commit(
                board,
                locked,
                new Map([
                    [caster.getId(), best.casterAnchor],
                    [best.screen.getId(), best.screenAnchor],
                ]),
            )
        ) {
            used.add(best.screen.getId());
        }
    }
};

const c53ZoneCorners = (board: IBoard): Set<number> => {
    const ranks = ranksOf(board);
    const keys = new Set<number>(backCornerKeys(board.geom));
    for (const lat of [ranks.minLat, ranks.maxLat]) {
        const front = r3Cell(board, ranks.front, lat);
        if (front) keys.add(keyOf(front));
    }
    return keys;
};

const c53SameCells = (left: readonly XY[], right: readonly XY[]): boolean => {
    if (left.length !== right.length) return false;
    const keys = new Set(left.map((cell) => keyOf(cell)));
    return right.every((cell) => keys.has(keyOf(cell)));
};

const c53BehindCaster = (casterFootprint: readonly XY[], screenFootprint: readonly XY[], geom: IGeom): boolean =>
    screenFootprint.some((cell) =>
        casterFootprint.some(
            (other) => geom.lateral(cell) === geom.lateral(other) && geom.frontness(cell) === geom.frontness(other) - 1,
        ),
    );

const c53Flyers = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const ranks = ranksOf(board);
    const steps = ranks.front - ranks.back;
    if (steps < 1) return;
    const zoneCorners = c53ZoneCorners(board);
    const backCorners = backCornerKeys(board.geom);
    const used = new Set<string>();
    for (const caster of casters) {
        if (caster.canFly()) continue;
        const old = board.footprint(caster);
        const anchor0 = board.cells.get(caster.getId());
        if (!anchor0 || !old.length || !old.every((cell) => board.geom.frontness(cell) === ranks.back)) continue;
        const anchor = board.geom.towardEnemy(anchor0, steps);
        const footprint = footprintCellsForAnchor(caster, anchor);
        const shifted = old.map((cell) => board.geom.towardEnemy(cell, steps));
        if (!c53SameCells(footprint, shifted) || c53HitsKeys(footprint, zoneCorners)) continue;
        const vacated = [...old].sort(
            (a, b) =>
                Math.abs(board.geom.lateral(a) - board.geom.centreLat) -
                    Math.abs(board.geom.lateral(b) - board.geom.centreLat) ||
                board.geom.lateral(a) - board.geom.lateral(b) ||
                a.x - b.x ||
                a.y - b.y,
        )[0];
        if (!vacated || backCorners.has(keyOf(vacated))) continue;
        const laterals = [...new Set(old.map((cell) => board.geom.lateral(cell)))];
        const screens = c53Screens(board, locked)
            .filter((screen) => screen.isSmallSize() && !used.has(screen.getId()))
            .sort((a, b) => c53DistToCell(board, a, vacated) - c53DistToCell(board, b, vacated) || byId(a, b));
        for (const screen of screens) {
            const ignore = new Set([caster.getId(), screen.getId()]);
            if (
                laterals.some((lat) => {
                    const middle = r3Cell(board, ranks.middle, lat);
                    return !!middle && !!c43Occupant(board, middle, ignore);
                })
            ) {
                continue;
            }
            if (footprint.some((cell) => c43Occupant(board, cell, ignore))) continue;
            if (c43Occupant(board, vacated, ignore)) continue;
            const screenFootprint = footprintCellsForAnchor(screen, vacated);
            if (screenFootprint.length !== 1 || !sameCell(screenFootprint[0], vacated)) continue;
            if (c53BehindCaster(footprint, screenFootprint, board.geom)) continue;
            const taken = takenCells(board, ignore);
            if (!r3Legal(footprint, board, taken)) continue;
            const blocked = new Set<number>(taken);
            for (const cell of footprint) blocked.add(keyOf(cell));
            if (!r3Legal(screenFootprint, board, blocked)) continue;
            const middle = r3Cell(board, ranks.middle, board.geom.lateral(vacated));
            if (
                middle &&
                (footprint.some((cell) => sameCell(cell, middle)) ||
                    screenFootprint.some((cell) => sameCell(cell, middle)))
            ) {
                continue;
            }
            if (
                c53Commit(
                    board,
                    locked,
                    new Map([
                        [caster.getId(), { x: anchor.x, y: anchor.y }],
                        [screen.getId(), { x: vacated.x, y: vacated.y }],
                    ]),
                )
            ) {
                used.add(screen.getId());
                break;
            }
        }
    }
};

const c53SitsOnRank = (board: IBoard, unit: Unit, rank: number): boolean =>
    board.geom.baseCells.some((anchor) => {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.length || !footprint.every((cell) => board.geom.legal.has(keyOf(cell)) && !isBoardEdge(cell))) {
            return false;
        }
        if (!footprint.every((cell) => board.geom.frontness(cell) === rank)) return false;
        return new Set(footprint.map((cell) => board.geom.lateral(cell))).size === 1;
    });

const c53CornerBowLaterals = (board: IBoard): Set<number> => {
    const corners = backCornerKeys(board.geom);
    const laterals = new Set<number>();
    for (const unit of board.units) {
        if (unit.getAttackType() !== RANGE) continue;
        const footprint = board.footprint(unit);
        if (!footprint.some((cell) => corners.has(keyOf(cell)))) continue;
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const c53ShieldAt = (
    board: IBoard,
    locked: ReadonlySet<string>,
    caster: Unit,
    bodies: readonly [Unit, Unit, Unit],
    lat: number,
): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const [centreBody, left, right] = bodies;
    const back = r3Cell(board, ranks.back, lat);
    const backLeft = r3Cell(board, ranks.back, lat - 1);
    const backRight = r3Cell(board, ranks.back, lat + 1);
    const middle = r3Cell(board, ranks.middle, lat);
    const middleLeft = r3Cell(board, ranks.middle, lat - 1);
    const middleRight = r3Cell(board, ranks.middle, lat + 1);
    if (!back || !backLeft || !backRight || !middle || !middleLeft || !middleRight) return false;
    if (corners.has(keyOf(back)) || c53CornerBowLaterals(board).has(lat)) return false;
    const ignore = new Set([caster.getId(), centreBody.getId(), left.getId(), right.getId()]);
    if (c43Occupant(board, backLeft, ignore) || c43Occupant(board, backRight, ignore)) return false;
    const taken = takenCells(board, ignore);
    const casterAnchor = c53OnRank(board, caster, ranks.back, taken, back, (footprint) => {
        if (!c53OnFile(board, footprint, lat) || c53HitsKeys(footprint, corners)) return false;
        return !footprint.some((cell) => sameCell(cell, backLeft) || sameCell(cell, backRight));
    });
    if (!casterAnchor) return false;
    const casterFootprint = footprintCellsForAnchor(caster, casterAnchor);
    const used = new Set<number>(taken);
    for (const cell of casterFootprint) used.add(keyOf(cell));
    const centreAnchor = c53OnRank(board, centreBody, ranks.middle, used, middle, (footprint) =>
        c53OnFile(board, footprint, lat),
    );
    if (!centreAnchor) return false;
    for (const cell of footprintCellsForAnchor(centreBody, centreAnchor)) used.add(keyOf(cell));
    const leftAnchor = c53OnRank(board, left, ranks.middle, used, middleLeft, (footprint) =>
        c53OnFile(board, footprint, lat - 1),
    );
    if (!leftAnchor) return false;
    for (const cell of footprintCellsForAnchor(left, leftAnchor)) used.add(keyOf(cell));
    const rightAnchor = c53OnRank(board, right, ranks.middle, used, middleRight, (footprint) =>
        c53OnFile(board, footprint, lat + 1),
    );
    if (!rightAnchor) return false;
    return c53Commit(
        board,
        locked,
        new Map([
            [caster.getId(), casterAnchor],
            [centreBody.getId(), centreAnchor],
            [left.getId(), leftAnchor],
            [right.getId(), rightAnchor],
        ]),
    );
};

const c53Shield = (board: IBoard, locked: ReadonlySet<string>, casters: readonly Unit[]): void => {
    const ranks = ranksOf(board);
    const bodies = board.units
        .filter(
            (unit) =>
                !unit.canFly() &&
                unit.getAttackType() !== RANGE &&
                !isCasterUnit(unit) &&
                !locked.has(unit.getId()) &&
                board.footprint(unit).length > 0 &&
                c53SitsOnRank(board, unit, ranks.middle),
        )
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    if (bodies.length < 3) return;
    const chosen = bodies.slice(0, 3);
    const centreBody = chosen[0];
    const wings = chosen.slice(1).sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    if (!centreBody || !wings[0] || !wings[1]) return;
    const triple: [Unit, Unit, Unit] = [centreBody, wings[0], wings[1]];
    const ordered = [...casters].sort(
        (a, b) =>
            Math.abs(medianLat(a, board) - board.geom.centreLat) -
                Math.abs(medianLat(b, board) - board.geom.centreLat) || byId(a, b),
    );
    for (const caster of ordered) {
        const origin = medianLat(caster, board);
        const laterals: number[] = [];
        for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) laterals.push(lat);
        laterals.sort(
            (a, b) =>
                Math.abs(a - origin) - Math.abs(b - origin) ||
                Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) ||
                a - b,
        );
        for (const lat of laterals) {
            if (c53ShieldAt(board, locked, caster, triple, lat)) return;
        }
    }
};

const c53Shooters = (threats: IPublicPlacementThreats): boolean =>
    threats.rangeCreatures >= 2 &&
    threats.flyers < 2 &&
    !threats.fireBreath &&
    !threats.skewerStrike &&
    !threats.throughShot &&
    !threats.fireball &&
    !threats.ringOfFire &&
    !threats.meteorShower;

/**
 * r5c3 post-pass. Today's placeArmy has already run. Area Throw baits the front centre, Large
 * Caliber slides casters apart, a plug shifts a caster two files off, and shooters get a
 * three-wide shield. The zone and the augment spend stay.
 */
export function placeArmyR5C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const locked = c53Locked(board);
    const casters = c53Casters(board, locked);
    if (!casters.length) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow) c53Area(board, locked, casters);
    else if (threats.largeCaliber) c53Caliber(board, locked, casters);
    else if (threats.lineAttack || threats.chainLightning) {
        if (threats.fireBreath || threats.skewerStrike || threats.throughShot) c53Plug(board, locked, casters);
        else c53Split(board, locked, casters);
    } else if (threats.flyers >= 2) c53Flyers(board, locked, casters);
    else if (c53Shooters(threats)) c53Shield(board, locked, casters);
    return board.cells;
}

const c61ArmyRange = (units: readonly Unit[]): Unit[] => units.filter((unit) => unit.getAttackType() === RANGE);

const c61ThrowEnemy = (threats: IPublicPlacementThreats): boolean =>
    !threats.areaThrow &&
    !threats.largeCaliber &&
    threats.rangeCreatures >= 2 &&
    threats.flyers < 2 &&
    !threats.fireBreath;

const c61WindsEnemy = (threats: IPublicPlacementThreats): boolean =>
    !threats.areaThrow &&
    !threats.largeCaliber &&
    !threats.meteorShower &&
    !threats.fireball &&
    !threats.ringOfFire &&
    threats.flyers === 0 &&
    threats.rangeCreatures >= 2;

const c61ReachEnemy = (threats: IPublicPlacementThreats): boolean =>
    threats.rangeCreatures >= 2 &&
    threats.flyers < 2 &&
    !threats.areaThrow &&
    !threats.largeCaliber &&
    !threats.fireBreath &&
    !threats.skewerStrike &&
    !threats.throughShot &&
    !threats.lightningSpin &&
    !threats.rapidCharge;

const c61GroundEnemy = (threats: IPublicPlacementThreats): boolean =>
    threats.rangeCreatures === 0 &&
    threats.flyers === 0 &&
    !threats.areaThrow &&
    !threats.largeCaliber &&
    !threats.fireBreath &&
    !threats.skewerStrike &&
    !threats.throughShot &&
    !threats.lightningSpin;

const c61OnCorner = (unit: Unit, board: IBoard): boolean => {
    const corners = backCornerKeys(board.geom);
    return board.footprint(unit).some((cell) => corners.has(keyOf(cell)));
};

const c61Far = (footprint: readonly XY[], board: IBoard, selfId: string, gap: number): boolean => {
    for (const other of board.units) {
        if (other.getId() === selfId) continue;
        const cells = board.footprint(other);
        if (cells.length > 0 && minChebyshev(footprint, cells) < gap) return false;
    }
    return true;
};

/** Zone cells on the bow's new laterals, behind its forward face, and outside its own footprint. */
const c61Behind = (footprint: readonly XY[], board: IBoard, selfId: string): boolean => {
    if (!footprint.length) return false;
    const face = Math.max(...footprint.map((cell) => board.geom.frontness(cell)));
    const laterals = new Set(footprint.map((cell) => board.geom.lateral(cell)));
    const own = new Set(footprint.map((cell) => keyOf(cell)));
    for (const cell of board.geom.baseCells) {
        if (!laterals.has(board.geom.lateral(cell)) || board.geom.frontness(cell) >= face || own.has(keyOf(cell))) {
            continue;
        }
        for (const other of board.units) {
            if (other.getId() === selfId) continue;
            if (board.footprint(other).some((entry) => sameCell(entry, cell))) return false;
        }
    }
    return true;
};

const c61OtherBowLaterals = (board: IBoard, bow: Unit): Set<number> => {
    const laterals = new Set<number>();
    for (const other of board.units) {
        if (other.getId() === bow.getId() || other.getAttackType() !== RANGE) continue;
        for (const lat of board.laterals(other)) laterals.add(lat);
    }
    return laterals;
};

const c61NearestThrowLat = (board: IBoard, bow: Unit): number | undefined => {
    const banned = c61OtherBowLaterals(board, bow);
    const corners = c33CornerLaterals(board);
    const ranks = ranksOf(board);
    let best: number | undefined;
    let bestDist = Infinity;
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (!r3Cell(board, ranks.front, lat) || corners.has(lat) || banned.has(lat)) continue;
        const dist = Math.abs(lat - board.geom.centreLat);
        if (best === undefined || dist < bestDist || (dist === bestDist && lat < best)) {
            best = lat;
            bestDist = dist;
        }
    }
    return best;
};

const c61ThrowAnchor = (board: IBoard, bow: Unit): XY | undefined => {
    const nearest = c61NearestThrowLat(board, bow);
    if (nearest === undefined) return undefined;
    const ranks = ranksOf(board);
    const corners = c33CornerLaterals(board);
    const banned = c61OtherBowLaterals(board, bow);
    let best: XY | undefined;
    let bestMedian = Infinity;
    for (const anchor of board.geom.baseCells) {
        if (!board.free(bow, anchor)) continue;
        const span = spanAt(bow, anchor, board.geom);
        if (!span || span.maxFront !== ranks.front) continue;
        const faceLaterals = new Set<number>();
        for (const cell of span.cells) {
            if (board.geom.frontness(cell) === ranks.front) faceLaterals.add(board.geom.lateral(cell));
        }
        if (!faceLaterals.has(nearest) || !span.laterals.every((lat) => faceLaterals.has(lat))) continue;
        if (span.laterals.some((lat) => corners.has(lat) || banned.has(lat))) continue;
        if (!c61Behind(span.cells, board, bow.getId()) || !c61Far(span.cells, board, bow.getId(), 3)) continue;
        const median = Math.abs(medianNumber(span.laterals) - board.geom.centreLat);
        if (
            !best ||
            median < bestMedian ||
            (median === bestMedian && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestMedian = median;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

/** True when the Area Throw bow is on the front face, or was moved there. A refusal is not settled. */
const c61Throw = (board: IBoard, range: readonly Unit[]): boolean => {
    const bows = range
        .filter(
            (unit) =>
                r3HasAbility(unit, "Area Throw") &&
                !r3HasAbility(unit, "Large Caliber") &&
                board.footprint(unit).length > 0,
        )
        .sort(byId);
    const bow = bows[0];
    if (!bow) return false;
    const anchor = c61ThrowAnchor(board, bow);
    if (!anchor) return false;
    const current = board.cells.get(bow.getId());
    if (current && sameCell(current, anchor)) return true;
    return board.place(bow, anchor);
};

const c61WindUnits = (units: readonly Unit[]): Unit[] => units.filter((unit) => r3HasAbility(unit, "Guiding Winds"));

const c61Between = (left: readonly XY[], right: readonly XY[]): XY[] => {
    const found = new Map<number, XY>();
    for (const a of left) {
        for (const b of right) {
            const dist = chebyshev(a, b);
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            const minY = Math.min(a.y, b.y);
            const maxY = Math.max(a.y, b.y);
            for (let x = minX; x <= maxX; x += 1) {
                for (let y = minY; y <= maxY; y += 1) {
                    const cell = { x, y };
                    if (sameCell(cell, a) || sameCell(cell, b)) continue;
                    if (chebyshev(a, cell) + chebyshev(cell, b) !== dist) continue;
                    found.set(keyOf(cell), cell);
                }
            }
        }
    }
    return [...found.values()];
};

const c61Blocked = (board: IBoard, cell: XY, ignore: ReadonlySet<string>): boolean =>
    board.units.some(
        (unit) => !ignore.has(unit.getId()) && board.footprint(unit).some((entry) => sameCell(entry, cell)),
    );

const c61ClearAhead = (footprint: readonly XY[], board: IBoard, selfId: string): boolean => {
    if (!footprint.length) return false;
    const face = Math.max(...footprint.map((cell) => board.geom.frontness(cell)));
    const laterals = new Set(footprint.map((cell) => board.geom.lateral(cell)));
    for (const other of board.units) {
        if (other.getId() === selfId) continue;
        for (const cell of board.footprint(other)) {
            if (laterals.has(board.geom.lateral(cell)) && board.geom.frontness(cell) > face) return false;
        }
    }
    return true;
};

const c61Partner = (board: IBoard, range: readonly Unit[], carrier: Unit): Unit | undefined => {
    const partners = range.filter(
        (unit) =>
            unit.getId() !== carrier.getId() &&
            board.footprint(unit).length > 0 &&
            !r3HasAbility(unit, "Sniper") &&
            !r3HasAbility(unit, "Area Throw") &&
            !r3HasAbility(unit, "Large Caliber") &&
            bowReach(unit) <= 11 &&
            (range.length < 3 || !c61OnCorner(unit, board)),
    );
    partners.sort((left, right) => bowReach(left) - bowReach(right) || byId(left, right));
    return partners[0];
};

const c61WindAnchor = (board: IBoard, carrier: Unit, partner: Unit): XY | undefined => {
    const carrierCells = board.footprint(carrier);
    const corners = backCornerKeys(board.geom);
    const touched = carrierCells.filter((cell) => corners.has(keyOf(cell)));
    if (!touched.length) return undefined;
    touched.sort(
        (left, right) =>
            board.geom.edgeness(right) - board.geom.edgeness(left) ||
            board.geom.lateral(left) - board.geom.lateral(right) ||
            left.x - right.x ||
            left.y - right.y,
    );
    const cornerLat = board.geom.lateral(touched[0]);
    const inward = cornerLat < board.geom.centreLat ? 1 : cornerLat > board.geom.centreLat ? -1 : 0;
    if (inward === 0) return undefined;
    const ranks = ranksOf(board);
    const middle = ranks.front - 1;
    if (middle <= ranks.back) return undefined;
    const target = r3Cell(board, middle, cornerLat + inward * 2);
    if (!target) return undefined;
    const ignore = new Set([partner.getId()]);
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const anchor of board.geom.baseCells) {
        if (!board.free(partner, anchor)) continue;
        const footprint = footprintCellsForAnchor(partner, anchor);
        if (!footprint.length || !footprint.every((cell) => board.geom.frontness(cell) === middle)) continue;
        if (!footprint.some((cell) => sameCell(cell, target))) continue;
        if (minChebyshev(footprint, carrierCells) !== 2) continue;
        const between = c61Between(carrierCells, footprint);
        if (
            !between.length ||
            !between.every(
                (cell) =>
                    board.geom.legal.has(keyOf(cell)) &&
                    !footprint.some((entry) => sameCell(entry, cell)) &&
                    !carrierCells.some((entry) => sameCell(entry, cell)) &&
                    !c61Blocked(board, cell, ignore),
            )
        ) {
            continue;
        }
        if (!c61ClearAhead(footprint, board, partner.getId())) continue;
        const dist = chebyshev(anchor, target);
        if (
            !best ||
            dist < bestDist ||
            (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestDist = dist;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

/** True when the partner is seated, or already was. Keeps the carrier on its back corner. */
const c61Winds = (board: IBoard, range: readonly Unit[], units: readonly Unit[]): boolean => {
    const carriers = c61WindUnits(units).filter((unit) => board.footprint(unit).length > 0);
    if (carriers.length !== 1) return false;
    const carrier = carriers[0];
    if (!carrier || !c61OnCorner(carrier, board)) return false;
    const partner = c61Partner(board, range, carrier);
    if (!partner) return false;
    const anchor = c61WindAnchor(board, carrier, partner);
    if (!anchor) return false;
    const current = board.cells.get(partner.getId());
    if (current && sameCell(current, anchor)) return true;
    return board.place(partner, anchor);
};

const c61ReachOwn = (range: readonly Unit[]): boolean =>
    range.length >= 2 &&
    range.every((unit) => !r3HasAbility(unit, "Sniper") && bowReach(unit) < 13 && !r3HasAbility(unit, "Guiding Winds"));

const c61FileClear = (board: IBoard, lat: number, selfId: string): boolean =>
    !board.units.some((unit) => unit.getId() !== selfId && board.laterals(unit).includes(lat));

const c61ReachCells = (board: IBoard, candidate: Unit, range: readonly Unit[]): XY[] => {
    const covered = new Set<number>();
    for (const bow of range) {
        if (bow.getId() === candidate.getId()) continue;
        for (const lat of board.laterals(bow)) covered.add(lat);
    }
    const mine = board.laterals(candidate);
    const ranks = ranksOf(board);
    const corners = [...c33CornerLaterals(board)];
    corners.sort((left, right) => {
        const leftOwn = mine.includes(left) ? 0 : 1;
        const rightOwn = mine.includes(right) ? 0 : 1;
        const leftDist = mine.length ? Math.min(...mine.map((lat) => Math.abs(lat - left))) : 0;
        const rightDist = mine.length ? Math.min(...mine.map((lat) => Math.abs(lat - right))) : 0;
        return leftOwn - rightOwn || leftDist - rightDist || left - right;
    });
    const cells: XY[] = [];
    for (const lat of corners) {
        if (covered.has(lat) || !c61FileClear(board, lat, candidate.getId())) continue;
        const dest = r3Cell(board, ranks.front, lat);
        if (!dest || !board.free(candidate, dest)) continue;
        if (!c61Far(footprintCellsForAnchor(candidate, dest), board, candidate.getId(), 3)) continue;
        cells.push({ x: dest.x, y: dest.y });
    }
    return cells;
};

const c61Reach = (board: IBoard, range: readonly Unit[]): boolean => {
    const pool = range
        .filter(
            (unit) =>
                unit.isSmallSize() &&
                board.footprint(unit).length > 0 &&
                bowReach(unit) === 11 &&
                !r3HasAbility(unit, "Area Throw") &&
                !r3HasAbility(unit, "Large Caliber") &&
                !r3HasAbility(unit, "Through Shot") &&
                !r3HasAbility(unit, "No Melee"),
        )
        .sort(
            (left, right) =>
                right.getCumulativeHp() - left.getCumulativeHp() ||
                Number(c61OnCorner(left, board)) - Number(c61OnCorner(right, board)) ||
                byId(left, right),
        );
    const candidate = pool[0];
    if (!candidate) return false;
    const choices = c61ReachCells(board, candidate, range);
    if (!choices.length) return false;
    const current = board.cells.get(candidate.getId());
    if (current && choices.some((cell) => sameCell(cell, current))) return true;
    return board.place(candidate, choices[0]);
};

const c61CapCell = (board: IBoard, bow: Unit, lat: number): XY | undefined => {
    const cells = board.footprint(bow).filter((cell) => board.geom.lateral(cell) === lat);
    if (!cells.length) return undefined;
    const face = Math.max(...cells.map((cell) => board.geom.frontness(cell)));
    const cap = r3Cell(board, face + 1, lat);
    if (!cap || board.footprint(bow).some((cell) => sameCell(cell, cap))) return undefined;
    return cap;
};

const c61SoleOwners = (board: IBoard, bows: readonly Unit[]): Map<string, Set<string>> => {
    const owners = new Map<string, Set<string>>();
    for (const bow of bows) {
        const footprint = board.footprint(bow);
        if (!footprint.length) continue;
        const neighbors = board.units.filter((unit) => {
            if (unit.getId() === bow.getId()) return false;
            const cells = board.footprint(unit);
            return cells.length > 0 && minChebyshev(cells, footprint) === 1;
        });
        if (neighbors.length !== 1) continue;
        const neighbor = neighbors[0];
        if (!neighbor) continue;
        const held = owners.get(neighbor.getId()) ?? new Set<string>();
        held.add(bow.getId());
        owners.set(neighbor.getId(), held);
    }
    return owners;
};

const c61Stolen = (owners: ReadonlyMap<string, ReadonlySet<string>>, body: Unit, bow: Unit): boolean => {
    const held = owners.get(body.getId());
    if (!held) return false;
    for (const owner of held) {
        if (owner !== bow.getId()) return true;
    }
    return false;
};

const c61BodyAnchor = (board: IBoard, body: Unit, cap: XY, bow: Unit): XY | undefined => {
    const banned = c61OtherBowLaterals(board, bow);
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(body, anchor);
        if (!footprint.some((cell) => sameCell(cell, cap))) continue;
        if (footprint.some((cell) => banned.has(board.geom.lateral(cell)))) continue;
        if (!board.free(body, anchor)) continue;
        const score = (sameCell(anchor, cap) ? 0 : 1000) + chebyshev(anchor, cap);
        if (
            !best ||
            score < bestScore ||
            (score === bestScore && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestScore = score;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c61Ground = (board: IBoard, range: readonly Unit[]): void => {
    const bows = range.filter((unit) => onBackRank(unit, board));
    const owners = c61SoleOwners(
        board,
        range.filter((unit) => board.footprint(unit).length > 0),
    );
    const slots: { bow: Unit; cell: XY; lat: number }[] = [];
    for (const bow of bows) {
        const banned = c61OtherBowLaterals(board, bow);
        for (const lat of new Set(board.laterals(bow))) {
            if (banned.has(lat)) continue;
            const cap = c61CapCell(board, bow, lat);
            if (!cap) continue;
            slots.push({ bow, cell: cap, lat });
        }
    }
    const centre = board.geom.centreLat;
    slots.sort(
        (left, right) =>
            left.bow.getCumulativeHp() - right.bow.getCumulativeHp() ||
            byId(left.bow, right.bow) ||
            Math.abs(left.lat - centre) - Math.abs(right.lat - centre) ||
            left.lat - right.lat,
    );
    const capKeys = new Set(slots.map((slot) => keyOf(slot.cell)));
    const bodies = board.units
        .filter(
            (unit) =>
                !unit.canFly() &&
                unit.getAttackType() !== RANGE &&
                !isSpellbookUnit(unit) &&
                !r3HasAbility(unit, "Rapid Charge") &&
                board.footprint(unit).length > 0 &&
                !board.footprint(unit).some((cell) => capKeys.has(keyOf(cell))),
        )
        .sort((left, right) => right.getArmor() - left.getArmor() || byId(left, right));
    const used = new Set<string>();
    const occupied = (cell: XY): boolean =>
        board.units.some((unit) => board.footprint(unit).some((entry) => sameCell(entry, cell)));
    for (const slot of slots) {
        if (occupied(slot.cell)) continue;
        for (const body of bodies) {
            if (used.has(body.getId()) || c61Stolen(owners, body, slot.bow)) continue;
            const anchor = c61BodyAnchor(board, body, slot.cell, slot.bow);
            if (!anchor || !board.place(body, anchor)) continue;
            used.add(body.getId());
            break;
        }
    }
};

/**
 * r6c1 post-pass. Today's placeArmy has already run. Area Throw takes the front face, a Guiding
 * Winds partner sits two laterals inward, a floor-11 bow takes an empty corner file, or pure ground
 * caps each back-rank bow. The first branch that settles is the only one. The zone stays.
 */
export function placeArmyR6C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const range = c61ArmyRange(units);
    if (range.length < 2) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (range.some((unit) => r3HasAbility(unit, "Area Throw"))) {
        // Enemy splash keeps the Area Throw bow on the back rank and does not build a gap-3 ring.
        if (threats.areaThrow || threats.largeCaliber) return board.cells;
        if (c61ThrowEnemy(threats) && c61Throw(board, range)) return board.cells;
    }
    if (c61WindUnits(units).length === 1 && c61WindsEnemy(threats) && c61Winds(board, range, units)) {
        return board.cells;
    }
    if (c61ReachOwn(range) && c61ReachEnemy(threats) && c61Reach(board, range)) return board.cells;
    if (c61GroundEnemy(threats)) c61Ground(board, range);
    return board.cells;
}

const MAGIC = PBTypes.AttackVals.MAGIC;

interface C62Ranks {
    readonly back: number;
    readonly middle: number;
    readonly front: number;
    readonly minLat: number;
    readonly maxLat: number;
}

interface C62Row {
    readonly plan: Map<string, XY>;
    readonly taken: Set<number>;
    readonly next: number;
}

const c62Ranks = (board: IBoard): C62Ranks => {
    const limits = zoneLimits(board.geom);
    return {
        back: board.geom.backFront,
        middle: limits.maxFront - 1,
        front: limits.maxFront,
        minLat: limits.minLat,
        maxLat: limits.maxLat,
    };
};

const c62ByLargest = (a: Unit, b: Unit): number =>
    footprintArea(b) - footprintArea(a) || b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b);

const c62ByArmor = (a: Unit, b: Unit): number => b.getArmor() - a.getArmor() || byId(a, b);

const c62BySpeed = (a: Unit, b: Unit): number => b.getSteps() - a.getSteps() || byId(a, b);

const c62Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (!PROTECTORS.has(unit.getName())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        const wards = board.units.filter((other) => {
            if (other.getId() === unit.getId()) return false;
            const cells = board.footprint(other);
            return cells.length > 0 && minChebyshev(footprint, cells) <= 1;
        });
        if (!wards.length) continue;
        locked.add(unit.getId());
        for (const ward of wards) locked.add(ward.getId());
    }
    return locked;
};

const c62Movable = (board: IBoard, locked: ReadonlySet<string>, unit: Unit): boolean =>
    !locked.has(unit.getId()) && board.cells.has(unit.getId());

const c62IsScreen = (unit: Unit): boolean => {
    if (unit.canFly() || isCharger(unit)) return false;
    if (PROTECTORS.has(unit.getName()) || CASTER_STAYS.has(unit.getName()) || isCasterUnit(unit)) return false;
    if (isSpellbookUnit(unit) || unit.getAttackType() === RANGE || unit.getAttackType() === MAGIC) return false;
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

const c62IsFlyer = (unit: Unit): boolean =>
    unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !isCasterUnit(unit) &&
    !isSpellbookUnit(unit) &&
    !CASTER_STAYS.has(unit.getName());

/** Ground body a skewer can strike. Protectors stay with a ward they already touch, so they are not the plug. */
const c62IsGround = (unit: Unit): boolean => {
    if (unit.canFly() || PROTECTORS.has(unit.getName())) return false;
    if (unit.getAttackType() === RANGE || unit.getAttackType() === MAGIC) return false;
    if (CASTER_STAYS.has(unit.getName()) || isCasterUnit(unit) || isSpellbookUnit(unit)) return false;
    return true;
};

const c62Elements = (units: readonly Unit[]): Unit[] =>
    units.filter((unit) => r3HasAbility(unit, "Fire Element")).sort(c62ByLargest);

const c62Fastest = (board: IBoard, locked: ReadonlySet<string>): Unit | undefined =>
    board.units.filter((unit) => isCharger(unit) && c62Movable(board, locked, unit)).sort(c62BySpeed)[0];

const c62Taken = (board: IBoard, hold: ReadonlySet<string>, extra: ReadonlyMap<string, XY>): Set<number> => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        const anchor = extra.get(unit.getId()) ?? (hold.has(unit.getId()) ? board.cells.get(unit.getId()) : undefined);
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) taken.add(keyOf(cell));
    }
    return taken;
};

const c62Stamp = (taken: Set<number>, unit: Unit, anchor: XY, board: IBoard): ISpan | undefined => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span) return undefined;
    for (const cell of span.cells) taken.add(keyOf(cell));
    return span;
};

const c62Keys = (cells: readonly XY[]): Set<number> => new Set(cells.map((cell) => keyOf(cell)));

const c62Union = (...sets: readonly (ReadonlySet<number> | undefined)[]): Set<number> => {
    const out = new Set<number>();
    for (const set of sets) {
        if (!set) continue;
        for (const key of set) out.add(key);
    }
    return out;
};

const c62LatGap = (laterals: readonly number[], other: ReadonlySet<number>): number => {
    if (!laterals.length || !other.size) return Infinity;
    let best = Infinity;
    for (const lat of laterals) {
        for (const value of other) best = Math.min(best, Math.abs(lat - value));
    }
    return best;
};

const c62Interval = (laterals: readonly number[]): boolean => {
    if (!laterals.length) return true;
    const unique = [...new Set(laterals)].sort((a, b) => a - b);
    return unique[unique.length - 1] - unique[0] + 1 === unique.length;
};

const c62ZoneKeys = (board: IBoard, accept: (cell: XY) => boolean, except: ReadonlySet<number>): Set<number> => {
    const keys = new Set<number>();
    for (const cell of board.geom.baseCells) {
        if (!accept(cell)) continue;
        const key = keyOf(cell);
        if (except.has(key)) continue;
        keys.add(key);
    }
    return keys;
};

const c62Centre = (span: ISpan): XY => ({
    x: medianNumber(span.cells.map((cell) => cell.x)),
    y: medianNumber(span.cells.map((cell) => cell.y)),
});

const c62Covers = (span: ISpan, cell: XY): boolean => span.cells.some((entry) => sameCell(entry, cell));

const c62FrontEdge = (span: ISpan, front: number, back: number): boolean =>
    span.maxFront === front && span.minFront > back;

const c62CentreCell = (board: IBoard): XY | undefined => {
    const ranks = c62Ranks(board);
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const cell of board.geom.baseCells) {
        if (board.geom.frontness(cell) !== ranks.front) continue;
        const lat = board.geom.lateral(cell);
        const dist = Math.abs(lat - board.geom.centreLat);
        if (
            !best ||
            dist < bestDist ||
            (dist === bestDist &&
                (lat < board.geom.lateral(best) ||
                    (lat === board.geom.lateral(best) && (cell.x < best.x || (cell.x === best.x && cell.y < best.y)))))
        ) {
            best = cell;
            bestDist = dist;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c62Pick = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
    score: (span: ISpan) => number,
): XY | undefined => {
    let bestAnchor: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken) || !accept(span)) continue;
        const value = score(span);
        if (
            !bestAnchor ||
            value < bestScore ||
            (value === bestScore && (anchor.x < bestAnchor.x || (anchor.x === bestAnchor.x && anchor.y < bestAnchor.y)))
        ) {
            bestAnchor = anchor;
            bestScore = value;
        }
    }
    return bestAnchor ? { x: bestAnchor.x, y: bestAnchor.y } : undefined;
};

const c62SeatCentre = (unit: Unit, board: IBoard, taken: ReadonlySet<number>, hold: boolean): XY | undefined => {
    const target = c62CentreCell(board);
    const ranks = c62Ranks(board);
    if (!target) return undefined;
    if (hold) {
        const current = board.cells.get(unit.getId());
        const span = current ? spanAt(unit, current, board.geom) : undefined;
        if (!current || !span || span.maxFront !== ranks.front || !c62Covers(span, target)) return undefined;
        return { x: current.x, y: current.y };
    }
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.maxFront === ranks.front && c62Covers(span, target),
        (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
    );
};

const c62SpanOf = (board: IBoard, assignments: ReadonlyMap<string, XY>, unit: Unit): ISpan | undefined => {
    const anchor = assignments.get(unit.getId()) ?? board.cells.get(unit.getId());
    return anchor ? spanAt(unit, anchor, board.geom) : undefined;
};

const c62Row = (
    units: readonly Unit[],
    board: IBoard,
    taken: Set<number>,
    start: number,
    step: 1 | -1,
    plan: Map<string, XY>,
    accept: (span: ISpan) => boolean,
): number | undefined => {
    let cursor = start;
    for (const unit of units) {
        const anchor = c62Pick(
            unit,
            board,
            taken,
            (span) => (step > 0 ? span.minLat === cursor : span.maxLat === cursor) && accept(span),
            () => 0,
        );
        if (!anchor) return undefined;
        const span = c62Stamp(taken, unit, anchor, board);
        if (!span) return undefined;
        plan.set(unit.getId(), anchor);
        cursor = step > 0 ? span.maxLat + 1 : span.minLat - 1;
    }
    return cursor;
};

const c62TryRow = (
    units: readonly Unit[],
    board: IBoard,
    occupied: ReadonlySet<number>,
    start: number,
    step: 1 | -1,
    accept: (span: ISpan) => boolean,
): C62Row | undefined => {
    const taken = new Set(occupied);
    const plan = new Map<string, XY>();
    const next = c62Row(units, board, taken, start, step, plan, accept);
    if (next === undefined) return undefined;
    return { plan, taken, next };
};

const c62Lowest = (
    units: readonly Unit[],
    board: IBoard,
    occupied: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): C62Row | undefined => {
    const limits = zoneLimits(board.geom);
    if (!units.length) return { plan: new Map(), taken: new Set(occupied), next: limits.minLat };
    for (let start = limits.minLat; start <= limits.maxLat; start += 1) {
        const placed = c62TryRow(units, board, occupied, start, 1, accept);
        if (placed) return placed;
    }
    return undefined;
};

const c62Centred = (
    units: readonly Unit[],
    board: IBoard,
    occupied: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): C62Row | undefined => {
    if (!units.length) return { plan: new Map(), taken: new Set(occupied), next: 0 };
    const limits = zoneLimits(board.geom);
    const width = units.reduce((sum, unit) => sum + lateralSpanCount(unit, r2SideOriented(board.geom)), 0);
    const starts: number[] = [];
    for (let start = limits.minLat; start <= limits.maxLat; start += 1) starts.push(start);
    starts.sort(
        (a, b) =>
            Math.abs(a + (width - 1) / 2 - board.geom.centreLat) -
                Math.abs(b + (width - 1) / 2 - board.geom.centreLat) || a - b,
    );
    for (const start of starts) {
        const placed = c62TryRow(units, board, occupied, start, 1, accept);
        if (placed) return placed;
    }
    return undefined;
};

const c62Shoulder = (
    units: readonly Unit[],
    board: IBoard,
    plug: ISpan,
    occupied: ReadonlySet<number>,
    accept: (span: ISpan) => boolean,
): C62Row | undefined => {
    if (!units.length) return { plan: new Map(), taken: new Set(occupied), next: 0 };
    const limits = zoneLimits(board.geom);
    const lowRoom = plug.minLat - limits.minLat;
    const highRoom = limits.maxLat - plug.maxLat;
    const sides: Array<"low" | "high"> = highRoom > lowRoom ? ["high", "low"] : ["low", "high"];
    for (const side of sides) {
        const start = side === "low" ? plug.minLat - 1 : plug.maxLat + 1;
        const placed = c62TryRow(units, board, occupied, start, side === "low" ? -1 : 1, accept);
        if (placed) return placed;
    }
    return undefined;
};

const c62BehindCells = (board: IBoard, span: ISpan): XY[] => {
    const rank = span.minFront - 1;
    const lats = new Set(span.laterals);
    return board.geom.baseCells.filter(
        (cell) => board.geom.frontness(cell) === rank && lats.has(board.geom.lateral(cell)),
    );
};

const c62Ring = (board: IBoard, span: ISpan): Set<number> => {
    const own = c62Keys(span.cells);
    return c62ZoneKeys(
        board,
        (cell) => !own.has(keyOf(cell)) && span.cells.some((entry) => chebyshev(entry, cell) <= 1),
        new Set(),
    );
};

const c62MiddleKeys = (board: IBoard, laterals: ReadonlySet<number>, except: ReadonlySet<number>): Set<number> => {
    const ranks = c62Ranks(board);
    return c62ZoneKeys(
        board,
        (cell) => board.geom.frontness(cell) === ranks.middle && laterals.has(board.geom.lateral(cell)),
        except,
    );
};

const c62Corridor = (board: IBoard, laterals: ReadonlySet<number>, except: ReadonlySet<number>): Set<number> => {
    const ranks = c62Ranks(board);
    return c62ZoneKeys(
        board,
        (cell) => {
            const front = board.geom.frontness(cell);
            return front > ranks.back && front < ranks.front && laterals.has(board.geom.lateral(cell));
        },
        except,
    );
};

const c62FileKeys = (board: IBoard, laterals: ReadonlySet<number>, except: ReadonlySet<number>): Set<number> =>
    c62ZoneKeys(board, (cell) => laterals.has(board.geom.lateral(cell)), except);

const c62LockedFit = (
    board: IBoard,
    locked: ReadonlySet<string>,
    forbidden: ReadonlySet<number>,
    stay: (unit: Unit, span: ISpan) => boolean,
): boolean => {
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        const span = c62SpanOf(board, new Map(), unit);
        if (!span || !stay(unit, span)) return false;
        if (span.cells.some((cell) => forbidden.has(keyOf(cell)))) return false;
    }
    return true;
};

const c62Displace = (
    board: IBoard,
    assignments: Map<string, XY>,
    locked: ReadonlySet<string>,
    forbidden: ReadonlySet<number>,
    stay: (unit: Unit, span: ISpan) => boolean,
): boolean => {
    const taken = c62Taken(board, locked, assignments);
    const pending: Unit[] = [];
    for (const unit of board.units) {
        if (locked.has(unit.getId()) || assignments.has(unit.getId()) || !board.cells.has(unit.getId())) continue;
        const span = c62SpanOf(board, assignments, unit);
        const legal =
            !!span &&
            stay(unit, span) &&
            span.cells.every((cell) => {
                const key = keyOf(cell);
                return board.geom.legal.has(key) && !isBoardEdge(cell) && !taken.has(key) && !forbidden.has(key);
            });
        if (legal && span) {
            for (const cell of span.cells) taken.add(keyOf(cell));
            continue;
        }
        pending.push(unit);
    }
    pending.sort(byId);
    for (const unit of pending) {
        const old = c62SpanOf(board, new Map(), unit);
        const oldCentre = old ? c62Centre(old) : undefined;
        const anchor = c62Pick(
            unit,
            board,
            taken,
            (span) => stay(unit, span) && span.cells.every((cell) => !forbidden.has(keyOf(cell))),
            (span) => {
                const shifted = old && span.maxFront !== old.maxFront ? 40 : 0;
                return shifted + (oldCentre ? chebyshev(c62Centre(span), oldCentre) : 0);
            },
        );
        if (!anchor) return false;
        const span = c62Stamp(taken, unit, anchor, board);
        if (!span) return false;
        assignments.set(unit.getId(), anchor);
    }
    return true;
};

const c62Resolve = (
    board: IBoard,
    assignments: ReadonlyMap<string, XY>,
    locked: ReadonlySet<string>,
    forbidden: ReadonlySet<number>,
    stay: (unit: Unit, span: ISpan) => boolean,
): Map<string, XY> | undefined => {
    const resolved = new Map<string, XY>();
    const occupied = new Set<number>();
    let placed = 0;
    for (const unit of board.units) {
        if (!board.cells.has(unit.getId())) continue;
        placed += 1;
        const current = board.cells.get(unit.getId());
        const anchor = assignments.get(unit.getId()) ?? current;
        if (!anchor || !current) return undefined;
        if (locked.has(unit.getId()) && !sameCell(anchor, current)) return undefined;
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !stay(unit, span)) return undefined;
        for (const cell of span.cells) {
            const key = keyOf(cell);
            if (!board.geom.legal.has(key) || isBoardEdge(cell) || occupied.has(key) || forbidden.has(key)) {
                return undefined;
            }
            occupied.add(key);
        }
        resolved.set(unit.getId(), { x: anchor.x, y: anchor.y });
    }
    return resolved.size === placed ? resolved : undefined;
};

const c62Commit = (
    board: IBoard,
    locked: ReadonlySet<string>,
    assignments: Map<string, XY>,
    forbidden: ReadonlySet<number>,
    stay: (unit: Unit, span: ISpan) => boolean,
): boolean => {
    if (!c62LockedFit(board, locked, forbidden, stay)) return false;
    if (!c62Displace(board, assignments, locked, forbidden, stay)) return false;
    const resolved = c62Resolve(board, assignments, locked, forbidden, stay);
    if (!resolved) return false;
    for (const [id, anchor] of resolved) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const c62Stay = (_unit: Unit, _span: ISpan): boolean => true;

const c62Merge = (into: Map<string, XY>, extra: ReadonlyMap<string, XY>): void => {
    for (const [id, anchor] of extra) into.set(id, { x: anchor.x, y: anchor.y });
};

/** One empty file between the immune body and every other front body. */
const c62Aside = (
    units: readonly Unit[],
    board: IBoard,
    taken: Set<number>,
    immune: ReadonlySet<number>,
    plan: Map<string, XY>,
): boolean => {
    const ranks = c62Ranks(board);
    if (!immune.size) return false;
    const immuneMin = Math.min(...immune);
    const immuneMax = Math.max(...immune);
    let lowCap = immuneMin - 2;
    let highCap = immuneMax + 2;
    for (const unit of units) {
        const low = c62Pick(
            unit,
            board,
            taken,
            (span) =>
                c62FrontEdge(span, ranks.front, ranks.back) &&
                span.maxLat <= lowCap &&
                c62LatGap(span.laterals, immune) >= 2,
            (span) => (lowCap - span.maxLat) * 100 + (ranks.front - span.minFront),
        );
        const anchor =
            low ??
            c62Pick(
                unit,
                board,
                taken,
                (span) =>
                    c62FrontEdge(span, ranks.front, ranks.back) &&
                    span.minLat >= highCap &&
                    c62LatGap(span.laterals, immune) >= 2,
                (span) => (span.minLat - highCap) * 100 + (ranks.front - span.minFront),
            );
        if (!anchor) return false;
        const span = c62Stamp(taken, unit, anchor, board);
        if (!span) return false;
        plan.set(unit.getId(), anchor);
        if (low && sameCell(low, anchor)) lowCap = span.minLat - 1;
        else highCap = span.maxLat + 1;
    }
    return true;
};

const c62Fire = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const elements = c62Elements(board.units).filter((unit) => board.cells.has(unit.getId()));
    if (!elements.length) return false;
    const taken = c62Taken(board, locked, new Map());
    const movable = elements.filter((unit) => !locked.has(unit.getId()));
    let primary: Unit | undefined;
    let primaryAnchor: XY | undefined;
    for (const unit of movable) {
        const anchor = c62SeatCentre(unit, board, taken, false);
        if (!anchor) continue;
        primary = unit;
        primaryAnchor = anchor;
        break;
    }
    if (!primary || !primaryAnchor) {
        for (const unit of elements) {
            if (!locked.has(unit.getId())) continue;
            const anchor = c62SeatCentre(unit, board, taken, true);
            if (!anchor) continue;
            primary = unit;
            primaryAnchor = anchor;
            break;
        }
    }
    if (!primary || !primaryAnchor) return false;
    const assignments = new Map<string, XY>();
    if (!locked.has(primary.getId())) {
        assignments.set(primary.getId(), primaryAnchor);
        if (!c62Stamp(taken, primary, primaryAnchor, board)) return false;
    }
    const primarySpan = c62SpanOf(board, assignments, primary);
    if (!primarySpan) return false;
    const immune = new Set(primarySpan.laterals);
    const behind = c62BehindCells(board, primarySpan);
    const onBehind = (span: ISpan): boolean =>
        span.laterals.every((lat) => immune.has(lat)) &&
        span.cells.some((cell) => behind.some((entry) => sameCell(entry, cell)));
    const seated = new Set<string>([primary.getId()]);
    let behindSeated = false;
    for (const extra of elements) {
        if (extra.getId() === primary.getId()) continue;
        const current = c62SpanOf(board, assignments, extra);
        if (locked.has(extra.getId())) {
            if (current && onBehind(current)) {
                seated.add(extra.getId());
                behindSeated = true;
            }
            continue;
        }
        if (behindSeated) continue;
        const anchor = c62Pick(extra, board, taken, onBehind, (span) => {
            const extraCells = span.cells.filter((cell) => !behind.some((entry) => sameCell(entry, cell))).length;
            return extraCells * 100 + Math.abs(medianNumber(span.laterals) - board.geom.centreLat);
        });
        if (!anchor) continue;
        const span = c62Stamp(taken, extra, anchor, board);
        if (!span) continue;
        assignments.set(extra.getId(), anchor);
        seated.add(extra.getId());
        behindSeated = true;
    }
    const ordered: Unit[] = [];
    const seen = new Set<string>(seated);
    const push = (unit: Unit): void => {
        if (seen.has(unit.getId()) || !c62Movable(board, locked, unit)) return;
        seen.add(unit.getId());
        ordered.push(unit);
    };
    for (const unit of board.units.filter(isCharger).sort(c62BySpeed)) push(unit);
    for (const unit of board.units.filter(c62IsScreen).sort(c62ByArmor)) push(unit);
    for (const unit of board.units.filter(c62IsFlyer).sort(byId)) push(unit);
    if (!c62Aside(ordered, board, taken, immune, assignments)) return false;
    const allowed = new Set<number>();
    for (const id of seated) {
        const unit = board.units.find((entry) => entry.getId() === id);
        const span = unit ? c62SpanOf(board, assignments, unit) : undefined;
        if (span) for (const cell of span.cells) allowed.add(keyOf(cell));
    }
    const forbidden = c62FileKeys(board, immune, allowed);
    for (const unit of ordered.filter(isCharger)) {
        const span = c62SpanOf(board, assignments, unit);
        if (!span) continue;
        for (const key of c62MiddleKeys(board, new Set(span.laterals), c62Keys(span.cells))) forbidden.add(key);
    }
    return c62Commit(board, locked, assignments, forbidden, c62Stay);
};

const c62CellOf = (key: number): XY => ({ x: key >> 4, y: key & 0xf });

const c62SeatPocket = (
    units: readonly Unit[],
    board: IBoard,
    taken: Set<number>,
    cells: readonly XY[],
    fileLats: ReadonlySet<number>,
    plan: Map<string, XY>,
): Set<number> => {
    const open = cells.map((cell) => keyOf(cell));
    const used = new Set<number>();
    for (const unit of units) {
        for (const key of open) {
            if (used.has(key)) continue;
            const cell = c62CellOf(key);
            const anchor = c62Pick(
                unit,
                board,
                taken,
                (span) => c62Covers(span, cell) && span.laterals.every((lat) => fileLats.has(lat)),
                (span) => span.cells.length,
            );
            if (!anchor) continue;
            const span = c62Stamp(taken, unit, anchor, board);
            if (!span) continue;
            plan.set(unit.getId(), anchor);
            for (const entry of span.cells) {
                const entryKey = keyOf(entry);
                if (open.includes(entryKey)) used.add(entryKey);
            }
            used.add(key);
            break;
        }
    }
    return used;
};

const c62Skewer = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const plugs = board.units.filter((unit) => c62IsGround(unit) && c62Movable(board, locked, unit)).sort(c62ByLargest);
    const plug = plugs[0];
    const centre = c62CentreCell(board);
    if (!plug || !centre) return false;
    const taken = c62Taken(board, locked, new Map());
    const plugAnchor = c62SeatCentre(plug, board, taken, false);
    if (!plugAnchor) return false;
    const plugSpan = spanAt(plug, plugAnchor, board.geom);
    if (!plugSpan || plugSpan.maxFront !== c62Ranks(board).front || !c62Covers(plugSpan, centre)) return false;
    if (!c62Stamp(taken, plug, plugAnchor, board)) return false;
    const assignments = new Map<string, XY>([[plug.getId(), plugAnchor]]);
    const ranks = c62Ranks(board);
    const charger = c62Fastest(board, locked);
    const flyers = board.units
        .filter(
            (unit) =>
                c62IsFlyer(unit) &&
                c62Movable(board, locked, unit) &&
                unit.getId() !== plug.getId() &&
                (plug.isSmallSize() || unit.getId() !== charger?.getId()),
        )
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const packed = c62Shoulder(flyers, board, plugSpan, taken, (span) => c62FrontEdge(span, ranks.front, ranks.back));
    if (!packed || !c62OneShoulder(board, plugSpan, flyers, packed.plan)) return false;
    c62Merge(assignments, packed.plan);
    const nextTaken = packed.taken;
    const fileLats = new Set(plugSpan.laterals);
    const pocket = c62BehindCells(board, plugSpan).filter((cell) => !c62Covers(plugSpan, cell));
    pocket.sort((a, b) => {
        const aDist = Math.abs(board.geom.lateral(a) - board.geom.centreLat);
        const bDist = Math.abs(board.geom.lateral(b) - board.geom.centreLat);
        return aDist - bDist || board.geom.lateral(a) - board.geom.lateral(b) || a.x - b.x || a.y - b.y;
    });
    const covered = new Set<number>();
    if (!plug.isSmallSize()) {
        const queue: Unit[] = [];
        if (charger && charger.getId() !== plug.getId()) queue.push(charger);
        for (const screen of board.units
            .filter(c62IsScreen)
            .filter((unit) => unit.isSmallSize())
            .sort(c62ByArmor)) {
            if (!c62Movable(board, locked, screen) || screen.getId() === plug.getId()) continue;
            if (charger && screen.getId() === charger.getId()) continue;
            queue.push(screen);
        }
        for (const key of c62SeatPocket(queue, board, nextTaken, pocket, fileLats, assignments)) covered.add(key);
    }
    const forbidden = new Set<number>();
    for (const cell of pocket) {
        const key = keyOf(cell);
        if (!covered.has(key)) forbidden.add(key);
    }
    if (!c62OneShoulder(board, plugSpan, flyers, assignments)) return false;
    return c62Commit(board, locked, assignments, forbidden, c62Stay);
};

const c62OneShoulder = (
    board: IBoard,
    plug: ISpan,
    flyers: readonly Unit[],
    plan: ReadonlyMap<string, XY>,
): boolean => {
    if (!flyers.length) return true;
    const ranks = c62Ranks(board);
    const laterals: number[] = [];
    for (const flyer of flyers) {
        const anchor = plan.get(flyer.getId());
        const span = anchor ? spanAt(flyer, anchor, board.geom) : undefined;
        if (!span || !c62FrontEdge(span, ranks.front, ranks.back)) return false;
        laterals.push(...span.laterals);
    }
    const unique = [...new Set(laterals)];
    if (!c62Interval(unique)) return false;
    const below = unique.every((lat) => lat < plug.minLat);
    const above = unique.every((lat) => lat > plug.maxLat);
    if (!below && !above) return false;
    return c62LatGap(unique, new Set(plug.laterals)) === 1;
};

const c62BackAnchor = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    bait: ReadonlySet<number>,
    blocked: ReadonlySet<number>,
    ring: ReadonlySet<number>,
): XY | undefined => {
    const ranks = c62Ranks(board);
    const legal = (span: ISpan): boolean =>
        c62LatGap(span.laterals, bait) >= 2 &&
        span.laterals.every((lat) => !blocked.has(lat)) &&
        span.cells.every((cell) => !ring.has(keyOf(cell)));
    return (
        c62Pick(
            unit,
            board,
            taken,
            (span) => span.minFront === ranks.back && span.maxFront === ranks.back && legal(span),
            (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
        ) ??
        c62Pick(
            unit,
            board,
            taken,
            (span) => span.minFront === ranks.back && span.maxFront < ranks.front && legal(span),
            (span) => (span.maxFront - ranks.back) * 100 + Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
        )
    );
};

const c62Spin = (board: IBoard, locked: ReadonlySet<string>, enemyFlyers: boolean): boolean => {
    const bait = board.units
        .filter((unit) => c62IsScreen(unit) && unit.isSmallSize() && c62Movable(board, locked, unit))
        .sort(c62ByArmor)[0];
    const centre = c62CentreCell(board);
    if (!bait || !centre) return false;
    const taken = c62Taken(board, locked, new Map());
    const baitAnchor = c62SeatCentre(bait, board, taken, false);
    const baitSpan = baitAnchor ? spanAt(bait, baitAnchor, board.geom) : undefined;
    if (!baitAnchor || !baitSpan || !c62Covers(baitSpan, centre)) return false;
    if (!c62Stamp(taken, bait, baitAnchor, board)) return false;
    const assignments = new Map<string, XY>([[bait.getId(), baitAnchor]]);
    const ranks = c62Ranks(board);
    const baitLats = new Set(baitSpan.laterals);
    const charger = c62Fastest(board, locked);
    const flyers = board.units
        .filter(
            (unit) =>
                c62IsFlyer(unit) &&
                c62Movable(board, locked, unit) &&
                unit.getId() !== bait.getId() &&
                unit.getId() !== charger?.getId(),
        )
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const block = [...flyers];
    if (enemyFlyers && charger) block.push(charger);
    const packed = c62Lowest(block, board, taken, (span) => {
        if (!c62FrontEdge(span, ranks.front, ranks.back)) return false;
        return c62LatGap(span.laterals, baitLats) >= 3 && span.maxLat < Math.min(...baitLats);
    });
    if (!packed) return false;
    c62Merge(assignments, packed.plan);
    const flyerLats = new Set<number>();
    for (const unit of block) {
        const span = c62SpanOf(board, assignments, unit);
        if (!span) return false;
        for (const lat of span.laterals) flyerLats.add(lat);
    }
    const ring = c62Ring(board, baitSpan);
    const backs = board.units.filter((unit) => {
        if (!c62Movable(board, locked, unit) || unit.getId() === bait.getId()) return false;
        if (block.some((entry) => entry.getId() === unit.getId())) return false;
        return c62IsScreen(unit) || (!enemyFlyers && charger?.getId() === unit.getId());
    });
    backs.sort(c62ByArmor);
    const screenCells = new Set<number>();
    const screenLats = new Set<number>();
    for (const unit of backs) {
        const anchor = c62BackAnchor(unit, board, packed.taken, baitLats, flyerLats, ring);
        if (!anchor) return false;
        const span = c62Stamp(packed.taken, unit, anchor, board);
        if (!span) return false;
        assignments.set(unit.getId(), anchor);
        for (const cell of span.cells) screenCells.add(keyOf(cell));
        for (const lat of span.laterals) screenLats.add(lat);
    }
    const forbidden = c62Union(ring, c62Corridor(board, screenLats, screenCells));
    return c62Commit(board, locked, assignments, forbidden, c62Stay);
};

const c62FrontLaterals = (
    board: IBoard,
    assignments: ReadonlyMap<string, XY>,
    locked: ReadonlySet<string>,
    front: number,
): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        const anchor =
            assignments.get(unit.getId()) ?? (locked.has(unit.getId()) ? board.cells.get(unit.getId()) : undefined);
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) {
            if (board.geom.frontness(cell) === front) laterals.add(board.geom.lateral(cell));
        }
    }
    return laterals;
};

const c62CanFillRank = (unit: Unit, board: IBoard, rank: number): boolean =>
    c62Pick(
        unit,
        board,
        new Set(),
        (span) => span.minFront === rank && span.maxFront === rank,
        () => 0,
    ) !== undefined;

const c62Wing = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const offBack = (_unit: Unit, span: ISpan): boolean => span.minFront > ranks.back;
    if (!c62LockedFit(board, locked, new Set(), offBack)) return false;
    const flyers = board.units
        .filter((unit) => c62IsFlyer(unit) && c62Movable(board, locked, unit))
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const screens = board.units.filter((unit) => c62IsScreen(unit) && c62Movable(board, locked, unit)).sort(c62ByArmor);
    const charger = c62Fastest(board, locked);
    const core: Unit[] = [...flyers, ...screens];
    if (charger && !core.some((unit) => unit.getId() === charger.getId())) core.push(charger);
    const rest = board.units.filter(
        (unit) => c62Movable(board, locked, unit) && !core.some((entry) => entry.getId() === unit.getId()),
    );
    if (!core.length) {
        core.push(...rest.sort(byId));
        rest.length = 0;
    }
    const occupied = c62Taken(board, locked, new Map());
    const packed = c62Lowest(core, board, occupied, (span) => c62FrontEdge(span, ranks.front, ranks.back));
    if (!packed) return false;
    const assignments = new Map(packed.plan);
    const middleUnits = rest.filter((unit) => c62CanFillRank(unit, board, ranks.middle)).sort(byId);
    const frontUnits = rest.filter((unit) => !middleUnits.some((entry) => entry.getId() === unit.getId()));
    const frontLats = c62FrontLaterals(board, assignments, locked, ranks.front);
    const overflow: Unit[] = [];
    for (const unit of middleUnits) {
        const old = medianLat(unit, board);
        const anchor = c62Pick(
            unit,
            board,
            packed.taken,
            (span) =>
                span.minFront === ranks.middle &&
                span.maxFront === ranks.middle &&
                span.laterals.every((lat) => frontLats.has(lat)),
            (span) => Math.abs(medianNumber(span.laterals) - old),
        );
        if (!anchor) {
            overflow.push(unit);
            continue;
        }
        if (!c62Stamp(packed.taken, unit, anchor, board)) return false;
        assignments.set(unit.getId(), anchor);
    }
    const extended = [...frontUnits, ...overflow].sort(byId);
    if (extended.length) {
        const continued = c62TryRow(extended, board, packed.taken, packed.next, 1, (span) =>
            c62FrontEdge(span, ranks.front, ranks.back),
        );
        if (!continued) return false;
        c62Merge(assignments, continued.plan);
    }
    return c62Commit(board, locked, assignments, new Set(), offBack);
};

const c62SeatFiles = (
    screens: readonly Unit[],
    board: IBoard,
    taken: Set<number>,
    blockLats: ReadonlySet<number>,
    plan: Map<string, XY>,
): Set<number> => {
    const ranks = c62Ranks(board);
    const files = [...blockLats].sort(
        (a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b,
    );
    const used = new Set<number>();
    const seated = new Set<number>();
    for (const screen of screens) {
        for (const lat of files) {
            if (used.has(lat)) continue;
            const anchor = c62Pick(
                screen,
                board,
                taken,
                (span) => {
                    const covers = span.cells.some(
                        (cell) => board.geom.frontness(cell) === ranks.front && board.geom.lateral(cell) === lat,
                    );
                    return (
                        covers &&
                        span.minFront === ranks.front &&
                        span.maxFront === ranks.front &&
                        span.laterals.every((value) => blockLats.has(value) && !used.has(value))
                    );
                },
                (span) => span.laterals.length,
            );
            if (!anchor) continue;
            const span = c62Stamp(taken, screen, anchor, board);
            if (!span) continue;
            plan.set(screen.getId(), anchor);
            for (const value of span.laterals) {
                used.add(value);
                seated.add(value);
            }
            break;
        }
    }
    return seated;
};

const c62Ranged = (board: IBoard, locked: ReadonlySet<string>, line: boolean): boolean => {
    const ranks = c62Ranks(board);
    const screens = board.units.filter((unit) => c62IsScreen(unit) && c62Movable(board, locked, unit)).sort(c62ByArmor);
    const charger = c62Fastest(board, locked);
    const flyers = board.units
        .filter((unit) => c62IsFlyer(unit) && c62Movable(board, locked, unit) && unit.getId() !== charger?.getId())
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const occupied = c62Taken(board, locked, new Map());
    const accept = line
        ? (span: ISpan): boolean => span.minFront === ranks.back && span.maxFront === ranks.back
        : (span: ISpan): boolean => span.maxFront === ranks.middle && span.minFront >= ranks.back;
    const packed = c62Centred(flyers, board, occupied, accept);
    if (!packed) return false;
    const assignments = new Map(packed.plan);
    const blockLats = new Set<number>();
    for (const flyer of flyers) {
        const span = c62SpanOf(board, assignments, flyer);
        if (!span) return false;
        for (const lat of span.laterals) blockLats.add(lat);
    }
    const taken = packed.taken;
    if (blockLats.size) c62SeatFiles(screens, board, taken, blockLats, assignments);
    else if (!line && screens[0]) {
        const anchor = c62SeatCentre(screens[0], board, taken, false);
        if (anchor) {
            if (!c62Stamp(taken, screens[0], anchor, board)) return false;
            assignments.set(screens[0].getId(), anchor);
        }
    }
    // A block file is a flyer file. Screens on that block are already banned with it. With no block, the
    // charger is allowed on the screen's own file so it can sit behind that screen.
    const banned = new Set(blockLats);
    if (charger) {
        const seated = screens.find((unit) => assignments.has(unit.getId()));
        const screenSpan = seated ? c62SpanOf(board, assignments, seated) : undefined;
        const target = screenSpan ? medianNumber(screenSpan.laterals) : board.geom.centreLat;
        const anchor = line
            ? (c62Pick(
                  charger,
                  board,
                  taken,
                  (span) =>
                      span.minFront === ranks.front &&
                      span.maxFront === ranks.front &&
                      span.laterals.every((lat) => !banned.has(lat)),
                  (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
              ) ??
              c62Pick(
                  charger,
                  board,
                  taken,
                  (span) =>
                      c62FrontEdge(span, ranks.front, ranks.back) && span.laterals.every((lat) => !banned.has(lat)),
                  (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
              ))
            : (c62Pick(
                  charger,
                  board,
                  taken,
                  (span) =>
                      span.minFront === ranks.middle &&
                      span.maxFront === ranks.middle &&
                      span.laterals.every((lat) => !banned.has(lat)),
                  (span) => Math.abs(medianNumber(span.laterals) - target),
              ) ??
              c62Pick(
                  charger,
                  board,
                  taken,
                  (span) =>
                      span.maxFront === ranks.middle &&
                      span.minFront >= ranks.back &&
                      span.laterals.every((lat) => !banned.has(lat)),
                  (span) => Math.abs(medianNumber(span.laterals) - target),
              ));
        if (!anchor) return false;
        const span = c62Stamp(taken, charger, anchor, board);
        if (!span) return false;
        assignments.set(charger.getId(), anchor);
    }
    const forbidden = new Set<number>();
    if (line && blockLats.size) {
        for (const key of c62Corridor(board, blockLats, new Set())) forbidden.add(key);
    }
    if (line && charger) {
        const span = c62SpanOf(board, assignments, charger);
        if (span) {
            for (const key of c62MiddleKeys(board, new Set(span.laterals), c62Keys(span.cells))) forbidden.add(key);
        }
    }
    return c62Commit(board, locked, assignments, forbidden, c62Stay);
};

/**
 * r6c2 post-pass. Today's placeArmy has already run. A Fire Element holds the breath file, a plug stops
 * a skewer, one screen meets a spin, or a wing leaves the back rank. The current zone stays. Area Throw
 * and Large Caliber leave the map alone. The first branch that matches is the only one.
 */
export function placeArmyR6C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const locked = c62Locked(board);
    const original = copyCells(board);
    // Enemy shooters do not cancel the breath or skewer branches.
    if (threats.fireBreath && c62Elements(units).some((unit) => board.cells.has(unit.getId()))) {
        return c62Fire(board, locked) ? board.cells : original;
    }
    if (threats.skewerStrike && !threats.fireBreath && !threats.throughShot) {
        const plugs = board.units.filter((unit) => c62IsGround(unit) && c62Movable(board, locked, unit));
        if (plugs.length) return c62Skewer(board, locked) ? board.cells : original;
    }
    if (
        threats.lightningSpin &&
        !threats.fireBreath &&
        !threats.skewerStrike &&
        threats.rangeCreatures === 0 &&
        board.units.some((unit) => c62IsScreen(unit) && unit.isSmallSize() && c62Movable(board, locked, unit))
    ) {
        return c62Spin(board, locked, threats.flyers > 0) ? board.cells : original;
    }
    if (threats.flyers > 0 && threats.rangeCreatures === 0 && !threats.lineAttack) {
        return c62Wing(board, locked) ? board.cells : original;
    }
    if (threats.rangeCreatures > 0 && !threats.throughShot) {
        return c62Ranged(board, locked, threats.lineAttack) ? board.cells : original;
    }
    return original;
}

const c63ByHp = (a: Unit, b: Unit): number => b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b);

/** Monk, or a small non-flying caster. Dryad, bows, flyers, and named protectors are not wards. */
const c63IsWard = (unit: Unit): boolean => {
    if (unit.canFly() || PROTECTORS.has(unit.getName())) return false;
    if (unit.getName() === "Monk") return true;
    return unit.isSmallSize() && isCasterUnit(unit);
};

/** Non-flying melee body. Casters, chargers, protectors, and stays are not screens. */
const c63IsScreen = (unit: Unit): boolean => {
    if (unit.canFly() || isCharger(unit) || PROTECTORS.has(unit.getName()) || isCasterUnit(unit)) return false;
    if (unit.getName() === "Dryad" || unit.getName() === "Monk") return false;
    const attack = unit.getAttackType();
    if (attack === MELEE) return true;
    return attack === MELEE_MAGIC && !isSpellbookUnit(unit);
};

const c63Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (unit.getName() === "Dryad" || PROTECTORS.has(unit.getName())) locked.add(unit.getId());
        else if (unit.getAttackType() === RANGE && !c63IsWard(unit)) locked.add(unit.getId());
    }
    return locked;
};

const c63Wards = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units
        .filter((unit) => c63IsWard(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort(c63ByHp);

const c63Screens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units
        .filter((unit) => c63IsScreen(unit) && !locked.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort(c63ByHp);

const c63At = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c63Add = (taken: Set<number>, cells: readonly XY[]): void => {
    for (const cell of cells) taken.add(keyOf(cell));
};

const c63Hits = (cells: readonly XY[], keys: ReadonlySet<number>): boolean =>
    cells.some((cell) => keys.has(keyOf(cell)));

const c63Depth3 = (board: IBoard): boolean => {
    const ranks = ranksOf(board);
    return ranks.front - ranks.back === 2;
};

const c63CornerLat = (board: IBoard, lat: number): boolean => {
    const ranks = ranksOf(board);
    return lat === ranks.minLat || lat === ranks.maxLat;
};

const c63LatsNear = (board: IBoard, unit: Unit): number[] => {
    const ranks = ranksOf(board);
    const current = medianLat(unit, board);
    const lats: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) lats.push(lat);
    lats.sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
    return lats;
};

const c63LatsOf = (cells: readonly XY[], geom: IGeom): Set<number> => {
    const lats = new Set<number>();
    for (const cell of cells) lats.add(geom.lateral(cell));
    return lats;
};

const c63LatGap = (left: ReadonlySet<number>, right: ReadonlySet<number>): number => {
    if (!left.size || !right.size) return Infinity;
    let best = Infinity;
    for (const a of left) {
        for (const b of right) best = Math.min(best, Math.abs(a - b));
    }
    return best;
};

const c63LockedCells = (board: IBoard, locked: ReadonlySet<string>): Set<number> => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        c63Add(taken, board.footprint(unit));
    }
    return taken;
};

const c63Between = (board: IBoard, lat: number): XY[] => {
    const ranks = ranksOf(board);
    return board.geom.baseCells.filter(
        (cell) =>
            board.geom.lateral(cell) === lat &&
            board.geom.frontness(cell) > ranks.back &&
            board.geom.frontness(cell) < ranks.front,
    );
};

const c63TouchesRank = (board: IBoard, footprint: readonly XY[], rank: number): boolean =>
    footprint.some((cell) => board.geom.frontness(cell) === rank);

const c63TooClose = (lat: number, away: ReadonlySet<number>, gap: number): boolean => {
    if (!away.size || gap <= 0) return false;
    for (const other of away) {
        if (Math.abs(lat - other) < gap) return true;
    }
    return false;
};

const c63Best = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    accept: (footprint: readonly XY[], anchor: XY) => number | undefined,
): XY | undefined => {
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        const score = accept(footprint, anchor);
        if (score === undefined || score > bestScore) continue;
        if (score === bestScore && best && (anchor.x > best.x || (anchor.x === best.x && anchor.y >= best.y))) {
            continue;
        }
        best = anchor;
        bestScore = score;
    }
    return best ? c63At(best) : undefined;
};

const c63Nearest = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    allow: (footprint: readonly XY[]) => boolean,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    return c63Best(board, unit, taken, (footprint, anchor) => {
        if (!allow(footprint)) return undefined;
        return current ? chebyshev(anchor, current) : 0;
    });
};

const c63Cover = (
    board: IBoard,
    unit: Unit,
    target: XY,
    taken: ReadonlySet<number>,
    accept: (footprint: readonly XY[]) => boolean,
): XY | undefined =>
    c63Best(board, unit, taken, (footprint, anchor) => {
        if (!footprint.some((cell) => sameCell(cell, target)) || !accept(footprint)) return undefined;
        return (sameCell(anchor, target) ? 0 : 10) + footprint.length;
    });

const c63FrontDist = (board: IBoard, footprint: readonly XY[], origin: XY | undefined): number | undefined => {
    const front = ranksOf(board).front;
    const cells = footprint.filter((cell) => board.geom.frontness(cell) === front);
    if (!cells.length || !origin) return cells.length ? 0 : undefined;
    return Math.min(...cells.map((cell) => chebyshev(origin, cell)));
};

interface C63Plan {
    readonly wanted: Map<string, XY>;
    readonly empty: Set<number>;
    readonly lats: Set<number>;
    readonly used: Set<string>;
    readonly screenFps: readonly (readonly XY[])[];
    readonly wardLat: number;
}

const c63FinalOk = (board: IBoard, moves: ReadonlyMap<string, XY>, empty: ReadonlySet<number>): boolean => {
    const occupied = new Set<number>(empty);
    for (const unit of board.units) {
        const anchor = moves.get(unit.getId()) ?? board.cells.get(unit.getId());
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, occupied)) return false;
        c63Add(occupied, footprint);
    }
    return true;
};

const c63Commit = (board: IBoard, moves: ReadonlyMap<string, XY> | undefined, empty: ReadonlySet<number>): boolean => {
    if (!moves || !c63FinalOk(board, moves, empty)) return false;
    for (const [id, anchor] of moves) board.cells.set(id, c63At(anchor));
    return true;
};

const c63Pack = (
    board: IBoard,
    wanted: ReadonlyMap<string, XY>,
    empty: ReadonlySet<number>,
    locked: ReadonlySet<string>,
    allow: (footprint: readonly XY[]) => boolean,
): Map<string, XY> | undefined => {
    for (const id of wanted.keys()) {
        if (locked.has(id)) return undefined;
    }
    const reserved = new Set<number>(empty);
    for (const [id, anchor] of wanted) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit) return undefined;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, reserved)) return undefined;
        c63Add(reserved, footprint);
    }
    const moving = new Set(wanted.keys());
    const relocators: Unit[] = [];
    const taken = new Set(reserved);
    for (const unit of board.units) {
        if (moving.has(unit.getId()) || !board.cells.has(unit.getId())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        if (c63Hits(footprint, reserved)) {
            if (locked.has(unit.getId())) return undefined;
            relocators.push(unit);
            continue;
        }
        c63Add(taken, footprint);
    }
    const moves = new Map<string, XY>();
    for (const [id, anchor] of wanted) moves.set(id, c63At(anchor));
    relocators.sort(byId);
    for (const unit of relocators) {
        const spot = c63Nearest(board, unit, taken, allow);
        if (!spot) return undefined;
        moves.set(unit.getId(), spot);
        c63Add(taken, footprintCellsForAnchor(unit, spot));
    }
    return moves;
};

const c63ScreenLats = (footprints: readonly (readonly XY[])[], geom: IGeom): Set<number> => {
    const lats = new Set<number>();
    for (const footprint of footprints) {
        for (const lat of c63LatsOf(footprint, geom)) lats.add(lat);
    }
    return lats;
};

/** Spare screens take a front cell at least 3 laterals from every chosen screen, outside its ring. */
const c63SeatSpares = (
    board: IBoard,
    spares: readonly Unit[],
    screenFps: readonly (readonly XY[])[],
    wanted: Map<string, XY>,
    empty: ReadonlySet<number>,
    locked: ReadonlySet<string>,
): boolean => {
    const taken = c63LockedCells(board, locked);
    for (const key of empty) taken.add(key);
    for (const [id, anchor] of wanted) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        if (!unit) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) return false;
        c63Add(taken, footprint);
    }
    const screenLats = c63ScreenLats(screenFps, board.geom);
    for (const spare of spares) {
        const origin = board.cells.get(spare.getId());
        const seat = c63Best(board, spare, taken, (footprint) => {
            const dist = c63FrontDist(board, footprint, origin);
            if (dist === undefined) return undefined;
            if (c63LatGap(c63LatsOf(footprint, board.geom), screenLats) < 3) return undefined;
            if (screenFps.some((other) => other.length > 0 && minChebyshev(footprint, other) < 2)) return undefined;
            return dist;
        });
        if (!seat) return false;
        wanted.set(spare.getId(), seat);
        c63Add(taken, footprintCellsForAnchor(spare, seat));
    }
    return true;
};

const c63Finish = (
    board: IBoard,
    plans: readonly C63Plan[],
    screens: readonly Unit[],
    locked: ReadonlySet<string>,
    avoidMiddle: boolean,
): { moves: Map<string, XY>; empty: Set<number> } | undefined => {
    const wanted = new Map<string, XY>();
    const empty = new Set<number>();
    const used = new Set<string>();
    const screenFps: XY[][] = [];
    for (const plan of plans) {
        for (const [id, cell] of plan.wanted) wanted.set(id, c63At(cell));
        for (const key of plan.empty) empty.add(key);
        for (const id of plan.used) used.add(id);
        for (const footprint of plan.screenFps) screenFps.push(footprint.map(c63At));
    }
    const spares = screens.filter((unit) => !used.has(unit.getId()));
    if (!c63SeatSpares(board, spares, screenFps, wanted, empty, locked)) return undefined;
    const middle = ranksOf(board).middle;
    const moves = c63Pack(
        board,
        wanted,
        empty,
        locked,
        (footprint) => !avoidMiddle || !c63TouchesRank(board, footprint, middle),
    );
    return moves ? { moves, empty } : undefined;
};

/** Same file: screen on the front cell, ward on the back cell, the cells between them empty. */
const c63RayPair = (
    board: IBoard,
    ward: Unit,
    screens: readonly Unit[],
    locked: ReadonlySet<string>,
    away: ReadonlySet<number>,
    minGap: number,
    allowCorner: boolean,
): C63Plan | undefined => {
    const ranks = ranksOf(board);
    const blocked = c63LockedCells(board, locked);
    for (const lat of c63LatsNear(board, ward)) {
        if (!allowCorner && c63CornerLat(board, lat)) continue;
        if (c63TooClose(lat, away, minGap)) continue;
        const back = r3Cell(board, ranks.back, lat);
        const front = r3Cell(board, ranks.front, lat);
        const between = c63Between(board, lat);
        if (!back || !front || !between.length) continue;
        if (between.some((cell) => blocked.has(keyOf(cell)))) continue;
        const taken = new Set(blocked);
        const wardAnchor = r3AnchorOn(ward, board, taken, ranks.back, lat);
        if (!wardAnchor) continue;
        const wardFp = footprintCellsForAnchor(ward, wardAnchor);
        if (between.some((cell) => wardFp.some((entry) => sameCell(entry, cell)))) continue;
        c63Add(taken, wardFp);
        const empty = new Set<number>();
        for (const cell of between) {
            empty.add(keyOf(cell));
            taken.add(keyOf(cell));
        }
        for (const screen of screens) {
            const screenAnchor = c63Cover(
                board,
                screen,
                front,
                taken,
                (footprint) => minChebyshev(footprint, wardFp) === 2,
            );
            if (!screenAnchor) continue;
            const screenFp = footprintCellsForAnchor(screen, screenAnchor);
            const lats = new Set<number>([
                ...c63LatsOf(wardFp, board.geom),
                ...c63LatsOf(screenFp, board.geom),
                ...between.map((cell) => board.geom.lateral(cell)),
            ]);
            if (away.size && c63LatGap(lats, away) < minGap) continue;
            return {
                wanted: new Map([
                    [ward.getId(), c63At(wardAnchor)],
                    [screen.getId(), c63At(screenAnchor)],
                ]),
                empty,
                lats,
                used: new Set([screen.getId()]),
                screenFps: [screenFp],
                wardLat: lat,
            };
        }
    }
    return undefined;
};

const c63Area = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    if (!c63Depth3(board) || !wards.length || !screens.length) return false;
    for (const ward of wards) {
        const first = c63RayPair(board, ward, screens, locked, new Set(), 0, true);
        if (!first) continue;
        const restScreens = screens.filter((unit) => !first.used.has(unit.getId()));
        const other = wards.find((unit) => unit.getId() !== ward.getId());
        const second =
            other && restScreens.length
                ? c63RayPair(board, other, restScreens, locked, first.lats, 4, true)
                : undefined;
        const packed = c63Finish(board, second ? [first, second] : [first], screens, locked, false);
        if (packed && c63Commit(board, packed.moves, packed.empty)) return true;
        if (!second) continue;
        const alone = c63Finish(board, [first], screens, locked, false);
        if (alone && c63Commit(board, alone.moves, alone.empty)) return true;
    }
    return false;
};

const c63Corners = (board: IBoard): XY[] => {
    const ranks = ranksOf(board);
    return [r3Cell(board, ranks.front, ranks.minLat), r3Cell(board, ranks.front, ranks.maxLat)].filter(
        (cell): cell is XY => cell !== undefined,
    );
};

const c63WardDist = (board: IBoard, unit: Unit, cell: XY): number =>
    Math.abs(medianLat(unit, board) - board.geom.lateral(cell));

const c63CaliberPlan = (
    board: IBoard,
    assignment: readonly { ward: Unit; cell: XY }[],
    screens: readonly Unit[],
    locked: ReadonlySet<string>,
): { moves: Map<string, XY>; empty: Set<number> } | undefined => {
    const ranks = ranksOf(board);
    const blocked = c63LockedCells(board, locked);
    const taken = new Set(blocked);
    const wanted = new Map<string, XY>();
    const empty = new Set<number>();
    const wardFps: XY[][] = [];
    for (const seat of assignment) {
        const anchor = r3AnchorOn(seat.ward, board, taken, ranks.front, board.geom.lateral(seat.cell));
        if (!anchor) return undefined;
        const footprint = footprintCellsForAnchor(seat.ward, anchor);
        for (const cell of board.geom.baseCells) {
            if (minChebyshev([cell], footprint) !== 1) continue;
            const key = keyOf(cell);
            if (blocked.has(key)) return undefined;
            empty.add(key);
        }
        if (c63Hits(footprint, empty)) return undefined;
        c63Add(taken, footprint);
        wanted.set(seat.ward.getId(), c63At(anchor));
        wardFps.push(footprint.map(c63At));
    }
    const wardKeys = new Set<number>();
    for (const footprint of wardFps) c63Add(wardKeys, footprint);
    const movers = screens.filter((unit) => {
        const footprint = board.footprint(unit);
        return c63Hits(footprint, empty) || c63Hits(footprint, wardKeys);
    });
    const seatTaken = new Set<number>([...taken, ...empty]);
    for (const screen of movers) {
        const origin = board.cells.get(screen.getId());
        const seat = c63Best(board, screen, seatTaken, (footprint) => {
            const dist = c63FrontDist(board, footprint, origin);
            if (dist === undefined) return undefined;
            if (wardFps.some((wardFp) => minChebyshev(footprint, wardFp) < 3)) return undefined;
            if (c63Hits(footprint, empty)) return undefined;
            return dist;
        });
        if (!seat) return undefined;
        wanted.set(screen.getId(), seat);
        c63Add(seatTaken, footprintCellsForAnchor(screen, seat));
    }
    const moves = c63Pack(board, wanted, empty, locked, () => true);
    return moves ? { moves, empty } : undefined;
};

const c63Caliber = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    const corners = c63Corners(board);
    if (!wards.length || corners.length < 2) return false;
    const byLat = (left: Unit, right: Unit): number =>
        medianLat(left, board) - medianLat(right, board) || byId(left, right);
    const cornerByLat = corners.slice().sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b));
    const candidates: { ward: Unit; cell: XY }[][] = [];
    for (let i = 0; i < wards.length; i += 1) {
        for (let j = i + 1; j < wards.length; j += 1) {
            const pair = [wards[i], wards[j]].sort(byLat);
            candidates.push([
                { ward: pair[0], cell: cornerByLat[0] },
                { ward: pair[1], cell: cornerByLat[1] },
            ]);
            candidates.push([
                { ward: pair[0], cell: cornerByLat[1] },
                { ward: pair[1], cell: cornerByLat[0] },
            ]);
        }
    }
    for (const ward of wards) {
        const ordered = corners
            .slice()
            .sort(
                (a, b) =>
                    c63WardDist(board, ward, a) - c63WardDist(board, ward, b) ||
                    board.geom.lateral(a) - board.geom.lateral(b),
            );
        for (const cell of ordered) candidates.push([{ ward, cell }]);
    }
    for (const assignment of candidates) {
        const plan = c63CaliberPlan(board, assignment, screens, locked);
        if (plan && c63Commit(board, plan.moves, plan.empty)) return true;
    }
    return false;
};

const c63NearerSign = (board: IBoard, lat: number): number => {
    const ranks = ranksOf(board);
    const toLow = Math.abs(lat - ranks.minLat);
    const toHigh = Math.abs(ranks.maxLat - lat);
    if (toLow < toHigh) return -1;
    if (toHigh < toLow) return 1;
    return lat <= board.geom.centreLat ? -1 : 1;
};

/** Ward on a clear back file. Its screen is two laterals toward the nearer edge, breath cell empty. */
const c63LinePair = (
    board: IBoard,
    ward: Unit,
    screens: readonly Unit[],
    locked: ReadonlySet<string>,
    half: LateralHalf | undefined,
    banned: ReadonlySet<number>,
): C63Plan | undefined => {
    const ranks = ranksOf(board);
    const blocked = c63LockedCells(board, locked);
    const centre = board.geom.centreLat;
    for (const lat of c63LatsNear(board, ward)) {
        if (c63CornerLat(board, lat)) continue;
        if (half && halfOf(lat, centre) !== half) continue;
        const sign = c63NearerSign(board, lat);
        const screenLat = lat + sign * 2;
        const betweenLat = lat + sign;
        if (screenLat < ranks.minLat || screenLat > ranks.maxLat) continue;
        if (banned.has(lat) || banned.has(screenLat) || banned.has(betweenLat)) continue;
        const back = r3Cell(board, ranks.back, lat);
        const front = r3Cell(board, ranks.front, screenLat);
        const breath = r3Cell(board, ranks.middle, screenLat);
        if (!back || !front || !breath) continue;
        const taken = new Set(blocked);
        const wardAnchor = r3AnchorOn(ward, board, taken, ranks.back, lat);
        if (!wardAnchor) continue;
        const wardFp = footprintCellsForAnchor(ward, wardAnchor);
        c63Add(taken, wardFp);
        const empty = new Set<number>();
        let blockedFile = false;
        for (const cell of board.geom.baseCells) {
            if (board.geom.lateral(cell) !== lat || wardFp.some((entry) => sameCell(entry, cell))) continue;
            const key = keyOf(cell);
            if (blocked.has(key)) {
                blockedFile = true;
                break;
            }
            empty.add(key);
            taken.add(key);
        }
        if (blockedFile) continue;
        const breathKey = keyOf(breath);
        if (blocked.has(breathKey) || empty.has(breathKey)) continue;
        empty.add(breathKey);
        taken.add(breathKey);
        for (const screen of screens) {
            const screenAnchor = c63Cover(board, screen, front, taken, (footprint) => {
                if (minChebyshev(footprint, wardFp) !== 2) return false;
                return footprint.every(
                    (cell) => !banned.has(board.geom.lateral(cell)) && board.geom.lateral(cell) !== lat,
                );
            });
            if (!screenAnchor) continue;
            const screenFp = footprintCellsForAnchor(screen, screenAnchor);
            const lats = new Set<number>([lat, screenLat, betweenLat]);
            for (const cell of [...wardFp, ...screenFp]) lats.add(board.geom.lateral(cell));
            return {
                wanted: new Map([
                    [ward.getId(), c63At(wardAnchor)],
                    [screen.getId(), c63At(screenAnchor)],
                ]),
                empty,
                lats,
                used: new Set([screen.getId()]),
                screenFps: [screenFp],
                wardLat: lat,
            };
        }
    }
    return undefined;
};

const c63Line = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    if (!c63Depth3(board) || !wards.length || !screens.length) return false;
    for (const ward of wards) {
        const first = c63LinePair(board, ward, screens, locked, undefined, new Set());
        if (!first) continue;
        const restScreens = screens.filter((unit) => !first.used.has(unit.getId()));
        const half = otherHalf(halfOf(first.wardLat, board.geom.centreLat));
        for (const other of wards) {
            if (other.getId() === ward.getId() || !restScreens.length) continue;
            const second = c63LinePair(board, other, restScreens, locked, half, first.lats);
            if (!second) continue;
            const wanted = new Map(first.wanted);
            for (const [id, cell] of second.wanted) wanted.set(id, c63At(cell));
            const empty = new Set<number>([...first.empty, ...second.empty]);
            const moves = c63Pack(board, wanted, empty, locked, () => true);
            if (moves && c63Commit(board, moves, empty)) return true;
        }
        const alone = c63Pack(board, first.wanted, first.empty, locked, () => true);
        if (alone && c63Commit(board, alone, first.empty)) return true;
    }
    return false;
};

const c63BowLats = (board: IBoard, locked: ReadonlySet<string>): Set<number> => {
    const lats = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId()) || unit.getAttackType() !== RANGE) continue;
        for (const lat of board.laterals(unit)) lats.add(lat);
    }
    return lats;
};

const c63CornerBows = (board: IBoard, locked: ReadonlySet<string>): Unit[] => {
    const corners = backCornerKeys(board.geom);
    return board.units.filter(
        (unit) =>
            locked.has(unit.getId()) &&
            unit.getAttackType() === RANGE &&
            board.footprint(unit).some((cell) => corners.has(keyOf(cell))),
    );
};

const c63SoleCorner = (board: IBoard, locked: ReadonlySet<string>): Set<string> => {
    const sole = new Set<string>();
    for (const bow of c63CornerBows(board, locked)) {
        const cells = board.footprint(bow);
        const neighbors = board.units.filter((unit) => {
            if (unit.getId() === bow.getId()) return false;
            const footprint = board.footprint(unit);
            return footprint.length > 0 && minChebyshev(footprint, cells) <= 1;
        });
        if (neighbors.length === 1) sole.add(neighbors[0].getId());
    }
    return sole;
};

const c63SideRank = (board: IBoard, cell: XY, bows: readonly Unit[], ignore: ReadonlySet<string>): number => {
    let rank = 0;
    for (const bow of bows) {
        const bowFp = board.footprint(bow);
        if (!bowFp.length || minChebyshev([cell], bowFp) > 1) continue;
        const others = board.units.filter((unit) => {
            if (unit.getId() === bow.getId() || ignore.has(unit.getId())) return false;
            const footprint = board.footprint(unit);
            if (!footprint.length || minChebyshev(footprint, bowFp) > 1) return false;
            return footprint.every((entry) => !sameCell(entry, cell));
        });
        if (others.length === 0) return 2;
        rank = 1;
    }
    return rank;
};

const c63Pocket = (
    board: IBoard,
    ward: Unit,
    rear: Unit,
    screens: readonly Unit[],
    locked: ReadonlySet<string>,
    banned: ReadonlySet<number>,
    requireSide: boolean,
): C63Plan | undefined => {
    if (!rear.isSmallSize()) return undefined;
    const ranks = ranksOf(board);
    const bowLats = c63BowLats(board, locked);
    const bows = c63CornerBows(board, locked);
    const sole = c63SoleCorner(board, locked);
    const blocked = c63LockedCells(board, locked);
    const sidePool = screens.filter((unit) => unit.getId() !== rear.getId() && !sole.has(unit.getId()));
    for (const lat of c63LatsNear(board, ward)) {
        if (c63CornerLat(board, lat) || bowLats.has(lat) || banned.has(lat)) continue;
        const back = r3Cell(board, ranks.back, lat);
        const middle = r3Cell(board, ranks.middle, lat);
        if (!back || !middle) continue;
        const taken = new Set(blocked);
        const wardAnchor = r3AnchorOn(ward, board, taken, ranks.middle, lat);
        if (!wardAnchor) continue;
        const wardFp = footprintCellsForAnchor(ward, wardAnchor);
        c63Add(taken, wardFp);
        const rearAnchor = r3AnchorOn(rear, board, taken, ranks.back, lat);
        if (!rearAnchor) continue;
        const rearFp = footprintCellsForAnchor(rear, rearAnchor);
        const rearFront = Math.max(...rearFp.map((cell) => board.geom.frontness(cell)));
        const wardBack = Math.min(...wardFp.map((cell) => board.geom.frontness(cell)));
        if (minChebyshev(rearFp, wardFp) !== 1 || rearFront >= wardBack) continue;
        c63Add(taken, rearFp);
        const ignore = new Set<string>([ward.getId(), rear.getId()]);
        const openSides = [lat - 1, lat + 1]
            .map((side) => {
                const cell = r3Cell(board, ranks.middle, side);
                return cell ? { side, cell } : undefined;
            })
            .filter((entry): entry is { side: number; cell: XY } => entry !== undefined)
            .filter(
                (entry) =>
                    !banned.has(entry.side) &&
                    !bowLats.has(entry.side) &&
                    c63SideRank(board, entry.cell, bows, ignore) < 2,
            );
        let sideUnit: Unit | undefined;
        let sideAnchor: XY | undefined;
        let sideLat: number | undefined;
        for (const candidate of sidePool) {
            const origin = board.cells.get(candidate.getId());
            const ordered = openSides.slice().sort((a, b) => {
                const rank = c63SideRank(board, a.cell, bows, ignore) - c63SideRank(board, b.cell, bows, ignore);
                if (rank) return rank;
                const aDist = origin ? chebyshev(origin, a.cell) : 0;
                const bDist = origin ? chebyshev(origin, b.cell) : 0;
                return aDist - bDist || a.side - b.side;
            });
            for (const entry of ordered) {
                const anchor = r3AnchorOn(candidate, board, taken, ranks.middle, entry.side);
                if (!anchor) continue;
                const footprint = footprintCellsForAnchor(candidate, anchor);
                if (minChebyshev(footprint, wardFp) !== 1) continue;
                sideUnit = candidate;
                sideAnchor = c63At(anchor);
                sideLat = entry.side;
                break;
            }
            if (sideAnchor) break;
        }
        if (requireSide && !sideAnchor) continue;
        const wanted = new Map<string, XY>([
            [ward.getId(), c63At(wardAnchor)],
            [rear.getId(), c63At(rearAnchor)],
        ]);
        const used = new Set<string>([rear.getId()]);
        const lats = new Set<number>([lat]);
        if (sideUnit && sideAnchor && sideLat !== undefined) {
            wanted.set(sideUnit.getId(), sideAnchor);
            used.add(sideUnit.getId());
            lats.add(sideLat);
        }
        return { wanted, empty: new Set(), lats, used, screenFps: [], wardLat: lat };
    }
    return undefined;
};

const c63Flyers = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    if (!c63Depth3(board)) return false;
    const backWards = wards.filter((unit) => onBackRank(unit, board));
    const rear = screens.find((unit) => unit.isSmallSize());
    if (!backWards.length || !rear) return false;
    for (const ward of backWards) {
        const first = c63Pocket(board, ward, rear, screens, locked, new Set(), false);
        if (!first) continue;
        const remaining = screens.filter((unit) => !first.used.has(unit.getId()));
        if (remaining.length >= 2) {
            const rear2 = remaining.find((unit) => unit.isSmallSize());
            if (rear2) {
                for (const other of backWards) {
                    if (other.getId() === ward.getId()) continue;
                    const second = c63Pocket(board, other, rear2, remaining, locked, first.lats, true);
                    if (!second) continue;
                    const wanted = new Map(first.wanted);
                    for (const [id, cell] of second.wanted) wanted.set(id, c63At(cell));
                    const moves = c63Pack(board, wanted, new Set(), locked, () => true);
                    if (moves && c63Commit(board, moves, new Set())) return true;
                }
            }
        }
        const moves = c63Pack(board, first.wanted, first.empty, locked, () => true);
        if (moves && c63Commit(board, moves, first.empty)) return true;
    }
    return false;
};

const c63Chakram = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    if (!c63Depth3(board) || !wards.length || !screens.length) return false;
    const ranks = ranksOf(board);
    const blocked = c63LockedCells(board, locked);
    for (const ward of wards) {
        for (const wardLat of c63LatsNear(board, ward)) {
            if (c63CornerLat(board, wardLat)) continue;
            const taken = new Set(blocked);
            const wardAnchor = r3AnchorOn(ward, board, taken, ranks.back, wardLat);
            if (!wardAnchor) continue;
            const wardFp = footprintCellsForAnchor(ward, wardAnchor);
            c63Add(taken, wardFp);
            const wardLats = c63LatsOf(wardFp, board.geom);
            for (const screen of screens) {
                for (const screenLat of c63LatsNear(board, screen)) {
                    if (screenLat === wardLat || c63CornerLat(board, screenLat) || Math.abs(screenLat - wardLat) < 4) {
                        continue;
                    }
                    const front = r3Cell(board, ranks.front, screenLat);
                    if (!front) continue;
                    const screenAnchor = c63Cover(board, screen, front, taken, (footprint) => {
                        const lats = c63LatsOf(footprint, board.geom);
                        if ([...wardLats].some((lat) => lats.has(lat))) return false;
                        return minChebyshev(footprint, wardFp) >= 4;
                    });
                    if (!screenAnchor) continue;
                    const screenFp = footprintCellsForAnchor(screen, screenAnchor);
                    if (minChebyshev(screenFp, wardFp) < 4) continue;
                    const plan: C63Plan = {
                        wanted: new Map([
                            [ward.getId(), c63At(wardAnchor)],
                            [screen.getId(), c63At(screenAnchor)],
                        ]),
                        empty: new Set(),
                        lats: new Set([...wardLats, ...c63LatsOf(screenFp, board.geom)]),
                        used: new Set([screen.getId()]),
                        screenFps: [screenFp],
                        wardLat,
                    };
                    const packed = c63Finish(board, [plan], screens, locked, true);
                    if (packed && c63Commit(board, packed.moves, packed.empty)) return true;
                }
            }
        }
    }
    return false;
};

const c63Shoot = (
    board: IBoard,
    locked: ReadonlySet<string>,
    wards: readonly Unit[],
    screens: readonly Unit[],
): boolean => {
    if (!c63Depth3(board) || !wards.length || !screens.length) return false;
    for (const ward of wards) {
        const pair = c63RayPair(board, ward, screens, locked, new Set(), 0, false);
        if (!pair) continue;
        const packed = c63Finish(board, [pair], screens, locked, true);
        if (packed && c63Commit(board, packed.moves, packed.empty)) return true;
    }
    return false;
};

const c63RangedThreat = (threats: IPublicPlacementThreats): boolean =>
    threats.rangeCreatures >= 2 && !threats.fireball && !threats.ringOfFire && !threats.meteorShower;

/**
 * r6c3 post-pass. Today's placeArmy has already run. The first public threat seats a screen on the
 * ray and the ward outside the landing. Area Throw and Large Caliber do not share a seat. Dryad,
 * bows that are not the ward, and named protectors stay. An illegal cell keeps the incumbent.
 */
export function placeArmyR6C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const board = boardFrom(incumbent, units, geom, new Set());
    const original = copyCells(board);
    const locked = c63Locked(board);
    const wards = c63Wards(board, locked);
    const screens = c63Screens(board, locked);
    let applied = false;
    if (threats.areaThrow) applied = c63Area(board, locked, wards, screens);
    else if (threats.largeCaliber) applied = c63Caliber(board, locked, wards, screens);
    else if (threats.fireBreath || threats.skewerStrike || threats.throughShot) {
        applied = c63Line(board, locked, wards, screens);
    } else if (threats.flyers >= 2) applied = c63Flyers(board, locked, wards, screens);
    else if (c63RangedThreat(threats)) {
        applied = threats.chakram ? c63Chakram(board, locked, wards, screens) : c63Shoot(board, locked, wards, screens);
    }
    if (!applied) restoreCells(board, original);
    return board.cells;
}

const C71_SHOOTER_BAN = [
    "Area Throw",
    "Large Caliber",
    "Fire Breath",
    "Skewer Strike",
    "Through Shot",
    "Lightning Spin",
    "Rapid Charge",
] as const;

interface C71Shooter {
    readonly reach: number;
    readonly sniper: boolean;
    readonly banned: boolean;
}

interface C71PackOptions {
    readonly reserve?: ReadonlySet<number>;
    readonly allow?: (unit: Unit, footprint: readonly XY[]) => boolean;
    readonly prefer?: (unit: Unit, anchor: XY) => number;
}

type C71RallyKind = "area" | "caliber" | "flyers" | "ground";

const c71EnemyShooters = (ids: readonly number[] | undefined): C71Shooter[] => {
    const found: C71Shooter[] = [];
    for (const id of ids ?? []) {
        const info = creatureInfo(id);
        if (!info?.ranged) continue;
        const abilities = CATALOG.get(info.name)?.abilities ?? [];
        found.push({
            reach: Math.floor(sniper3Distance(info.distance)),
            sniper: hasNamed(abilities, "Sniper"),
            banned: C71_SHOOTER_BAN.some((name) => hasNamed(abilities, name)),
        });
    }
    return found;
};

const c71NamedEnemy = (ids: readonly number[] | undefined, name: string): boolean =>
    (ids ?? []).some((id) => creatureInfo(id)?.name === name);

const c71DebuffEnemy = (ids: readonly number[] | undefined): boolean =>
    c71NamedEnemy(ids, "Beholder") || c71NamedEnemy(ids, "Orc");

/** A published non-flying melee body. Range and flyers do not satisfy the Handyman gate. */
const c71Walker = (ids: readonly number[] | undefined): boolean =>
    (ids ?? []).some((id) => {
        const info = creatureInfo(id);
        return !!info && info.melee && !info.canFly && !info.ranged;
    });

const c71RallyKind = (threats: IPublicPlacementThreats): C71RallyKind | undefined => {
    if (threats.areaThrow) return "area";
    if (threats.largeCaliber) return "caliber";
    if (threats.flyers >= 2) return "flyers";
    if (threats.rangeCreatures === 0 && threats.flyers === 0) return "ground";
    return undefined;
};

const c71OuterLats = (board: IBoard): Set<number> => c33CornerLaterals(board);

/** Nearest non-outer lateral. A tie stays on the low side, which is the file a pair centres on. */
const c71FocusLat = (board: IBoard): number | undefined => {
    const ranks = ranksOf(board);
    const outer = c71OuterLats(board);
    let best: number | undefined;
    let bestDist = Infinity;
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (outer.has(lat) || !r3Cell(board, ranks.back, lat)) continue;
        const dist = Math.abs(lat - board.geom.centreLat);
        if (best === undefined || dist < bestDist || (dist === bestDist && lat < best)) {
            best = lat;
            bestDist = dist;
        }
    }
    return best;
};

const c71Lats = (unit: Unit, anchor: XY, board: IBoard): number[] => lateralsOfAnchor(unit, anchor, board.geom);

const c71RankFoot = (unit: Unit, anchor: XY, board: IBoard, rank: number, entire: boolean): XY[] | undefined => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span) return undefined;
    if (entire ? span.minFront !== rank || span.maxFront !== rank : span.maxFront !== rank) return undefined;
    if (!span.cells.every((cell) => board.geom.legal.has(keyOf(cell)))) return undefined;
    return [...span.cells];
};

const c71AnchorsOn = (unit: Unit, board: IBoard, rank: number, entire: boolean): XY[] => {
    const found: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        if (c71RankFoot(unit, anchor, board, rank, entire)) found.push(anchor);
    }
    return found;
};

const c71CoversCell = (footprint: readonly XY[], cell: XY): boolean => footprint.some((entry) => sameCell(entry, cell));

const c71CoversAll = (footprint: readonly XY[], cells: readonly XY[]): boolean =>
    cells.every((cell) => c71CoversCell(footprint, cell));

const c71HitsKeys = (footprint: readonly XY[], keys: ReadonlySet<number>): boolean =>
    footprint.some((cell) => keys.has(keyOf(cell)));

const c71LatList = (footprint: readonly XY[], board: IBoard): number[] =>
    footprint.map((cell) => board.geom.lateral(cell));

const c71SharesLat = (left: readonly number[], right: readonly number[]): boolean =>
    left.some((lat) => right.includes(lat));

/** Laterals strictly between two footprints. Overlap or a shared edge is -1. */
const c71Between = (left: readonly number[], right: readonly number[]): number => {
    if (!left.length || !right.length) return -1;
    const leftMax = Math.max(...left);
    const rightMax = Math.max(...right);
    const leftMin = Math.min(...left);
    const rightMin = Math.min(...right);
    if (leftMax < rightMin) return rightMin - leftMax - 1;
    if (rightMax < leftMin) return leftMin - rightMax - 1;
    return -1;
};

const c71Ahead = (footprint: readonly XY[], board: IBoard): XY[] => {
    const own = new Set(footprint.map((cell) => keyOf(cell)));
    const ahead: XY[] = [];
    for (const cell of footprint) {
        const next = r3Cell(board, board.geom.frontness(cell) + 1, board.geom.lateral(cell));
        if (!next || own.has(keyOf(next))) continue;
        if (!ahead.some((entry) => sameCell(entry, next))) ahead.push(next);
    }
    return ahead;
};

const c71Move = (unit: Unit, anchor: XY, board: IBoard): number => {
    const current = board.cells.get(unit.getId());
    return current ? chebyshev(current, anchor) : 0;
};

const c71Cent = (lats: readonly number[], centre: number): number =>
    lats.length ? Math.abs((Math.min(...lats) + Math.max(...lats)) / 2 - centre) : Infinity;

const c71GroundBody = (unit: Unit): boolean => {
    if (unit.canFly() || unit.getAttackType() === RANGE || r3HasAbility(unit, "Rapid Charge")) return false;
    if (isSpellbookUnit(unit)) return false;
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

const c71Bodies = (board: IBoard): Unit[] =>
    board.units
        .filter((unit) => c71GroundBody(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => b.getArmor() - a.getArmor() || byId(a, b));

// Keep the historical local-volley candidate dormant for the army-wide Blessing.
const c71IsZena = (unit: Unit): boolean =>
    unit.getName() === "Zena" &&
    unit.getAttackType() === RANGE &&
    r3HasAbility(unit, "Rallying Volley") &&
    !r3HasAbility(unit, "Rallying Volley Blessing");

const c71IsArb = (unit: Unit): boolean =>
    unit.getName() === "Arbalester" && unit.getAttackType() === RANGE && r3HasAbility(unit, "Limited Supply");

const c71IsHandy = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE &&
    (unit.getName() === "Zena" || unit.getName() === "Centaur") &&
    r3HasAbility(unit, "Handyman");

const c71FrontOuter = (footprint: readonly XY[], board: IBoard): boolean => {
    const front = ranksOf(board).front;
    const outer = c71OuterLats(board);
    return footprint.some((cell) => board.geom.frontness(cell) === front && outer.has(board.geom.lateral(cell)));
};

/** A floor-11 bow without the Sniper ability never takes a front outer corner. */
const c71BlocksCorner = (unit: Unit, footprint: readonly XY[], board: IBoard): boolean =>
    bowReach(unit) === 11 && !r3HasAbility(unit, "Sniper") && c71FrontOuter(footprint, board);

const c71LegalFoot = (unit: Unit, anchor: XY, board: IBoard, occupied: ReadonlySet<number>): XY[] | undefined => {
    const footprint = footprintCellsForAnchor(unit, anchor);
    if (!footprint.length) return undefined;
    for (const cell of footprint) {
        const key = keyOf(cell);
        if (!board.geom.legal.has(key) || occupied.has(key)) return undefined;
    }
    return footprint;
};

const c71Pack = (
    board: IBoard,
    fixed: ReadonlyMap<string, XY>,
    options: C71PackOptions = {},
): Map<string, XY> | undefined => {
    const occupied = new Set<number>();
    const plan = new Map<string, XY>();
    const byUnit = new Map(board.units.map((unit) => [unit.getId(), unit]));
    for (const [id, anchor] of fixed) {
        const unit = byUnit.get(id);
        if (!unit || !board.cells.has(id)) return undefined;
        const footprint = c71LegalFoot(unit, anchor, board, occupied);
        if (!footprint) return undefined;
        if (options.reserve && footprint.some((cell) => options.reserve?.has(keyOf(cell)))) return undefined;
        for (const cell of footprint) occupied.add(keyOf(cell));
        plan.set(id, { x: anchor.x, y: anchor.y });
    }
    if (options.reserve) {
        for (const key of options.reserve) occupied.add(key);
    }
    const rest = board.units.filter((unit) => board.cells.has(unit.getId()) && !fixed.has(unit.getId()));
    rest.sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b));
    for (const unit of rest) {
        const current = board.cells.get(unit.getId());
        const spots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            const footprint = c71LegalFoot(unit, anchor, board, occupied);
            if (!footprint || (options.allow && !options.allow(unit, footprint))) continue;
            spots.push(anchor);
        }
        spots.sort((a, b) => {
            const prefer = (options.prefer?.(unit, a) ?? 0) - (options.prefer?.(unit, b) ?? 0);
            if (prefer) return prefer;
            const aStay = current && sameCell(a, current) ? 0 : 1;
            const bStay = current && sameCell(b, current) ? 0 : 1;
            if (aStay !== bStay) return aStay - bStay;
            const aDist = current ? chebyshev(a, current) : 0;
            const bDist = current ? chebyshev(b, current) : 0;
            return aDist - bDist || a.x - b.x || a.y - b.y;
        });
        const spot = spots[0];
        if (!spot) return undefined;
        for (const cell of footprintCellsForAnchor(unit, spot)) occupied.add(keyOf(cell));
        plan.set(unit.getId(), { x: spot.x, y: spot.y });
    }
    return plan.size === board.cells.size ? plan : undefined;
};

const c71Commit = (board: IBoard, plan: ReadonlyMap<string, XY>): boolean => {
    if (plan.size !== board.cells.size) return false;
    const byUnit = new Map(board.units.map((unit) => [unit.getId(), unit]));
    const occupied = new Set<number>();
    const next = new Map<string, XY>();
    for (const [id, anchor] of plan) {
        const unit = byUnit.get(id);
        if (!unit) return false;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.length) return false;
        for (const cell of footprint) {
            const key = keyOf(cell);
            if (!board.geom.legal.has(key) || occupied.has(key)) return false;
            occupied.add(key);
        }
        next.set(id, { x: anchor.x, y: anchor.y });
    }
    if (next.size !== board.cells.size) return false;
    board.cells.clear();
    for (const [id, cell] of next) board.cells.set(id, cell);
    return true;
};

const c71ApplyPlan = (board: IBoard, plan: Map<string, XY> | undefined, ok: () => boolean): boolean => {
    if (!plan) return false;
    const snapshot = copyCells(board);
    if (!c71Commit(board, plan) || !ok()) {
        restoreCells(board, snapshot);
        return false;
    }
    return true;
};

const c71PairOk = (left: readonly XY[], right: readonly XY[]): boolean => minChebyshev(left, right) === 2;

const c71FarFrom = (footprint: readonly XY[], board: IBoard, selfId: string, gap: number): boolean => {
    for (const other of board.units) {
        if (other.getId() === selfId) continue;
        const cells = board.footprint(other);
        if (cells.length && minChebyshev(footprint, cells) < gap) return false;
    }
    return true;
};

const c71RallyArea = (board: IBoard, zena: Unit, arb: Unit): boolean => {
    const ranks = ranksOf(board);
    const corners = backCornerKeys(board.geom);
    const open = (unit: Unit): XY[] =>
        c71AnchorsOn(unit, board, ranks.back, true).filter(
            (anchor) => !c71HitsKeys(footprintCellsForAnchor(unit, anchor), corners),
        );
    const seats: { zena: XY; arb: XY; move: number; cent: number; zenaLat: number; arbLat: number }[] = [];
    for (const zenaAnchor of open(zena)) {
        const zenaFp = footprintCellsForAnchor(zena, zenaAnchor);
        const zenaLats = c71Lats(zena, zenaAnchor, board);
        for (const arbAnchor of open(arb)) {
            const arbFp = footprintCellsForAnchor(arb, arbAnchor);
            if (!c71PairOk(zenaFp, arbFp)) continue;
            const arbLats = c71Lats(arb, arbAnchor, board);
            seats.push({
                zena: zenaAnchor,
                arb: arbAnchor,
                move: c71Move(zena, zenaAnchor, board) + c71Move(arb, arbAnchor, board),
                cent: c71Cent(zenaLats, board.geom.centreLat) + c71Cent(arbLats, board.geom.centreLat),
                zenaLat: Math.min(...zenaLats),
                arbLat: Math.min(...arbLats),
            });
        }
    }
    seats.sort((a, b) => a.move - b.move || a.cent - b.cent || a.zenaLat - b.zenaLat || a.arbLat - b.arbLat);
    for (const seat of seats) {
        const zenaFp = footprintCellsForAnchor(zena, seat.zena);
        const arbFp = footprintCellsForAnchor(arb, seat.arb);
        const plan = c71Pack(
            board,
            new Map([
                [zena.getId(), seat.zena],
                [arb.getId(), seat.arb],
            ]),
            {
                allow: (_unit, footprint) =>
                    minChebyshev(footprint, zenaFp) >= 2 && minChebyshev(footprint, arbFp) >= 2,
            },
        );
        if (
            c71ApplyPlan(board, plan, () => {
                const placedZena = board.footprint(zena);
                const placedArb = board.footprint(arb);
                return (
                    c71PairOk(placedZena, placedArb) &&
                    !c71HitsKeys(placedZena, corners) &&
                    !c71HitsKeys(placedArb, corners) &&
                    placedZena.every((cell) => board.geom.frontness(cell) === ranks.back) &&
                    placedArb.every((cell) => board.geom.frontness(cell) === ranks.back) &&
                    c71FarFrom(placedZena, board, zena.getId(), 2) &&
                    c71FarFrom(placedArb, board, arb.getId(), 2)
                );
            })
        ) {
            return true;
        }
    }
    return false;
};

const c71RallyCaliber = (board: IBoard, zena: Unit, arb: Unit): boolean => {
    const ranks = ranksOf(board);
    const corners = [...backCornerKeys(board.geom)].map((key) => ({ x: key >> 4, y: key & 0xf }));
    const origin = medianLat(zena, board);
    corners.sort((a, b) => {
        const aDist = Math.abs(board.geom.lateral(a) - origin);
        const bDist = Math.abs(board.geom.lateral(b) - origin);
        return aDist - bDist || board.geom.lateral(a) - board.geom.lateral(b);
    });
    for (const corner of corners) {
        const cornerLat = board.geom.lateral(corner);
        const inward =
            cornerLat < board.geom.centreLat
                ? cornerLat + 2
                : cornerLat > board.geom.centreLat
                  ? cornerLat - 2
                  : undefined;
        if (inward === undefined) continue;
        const target = r3Cell(board, ranks.back, inward);
        if (!target) continue;
        const zenaSpots = c71AnchorsOn(zena, board, ranks.back, true).filter((anchor) =>
            c71CoversCell(footprintCellsForAnchor(zena, anchor), corner),
        );
        const arbSpots = c71AnchorsOn(arb, board, ranks.back, true).filter((anchor) =>
            c71CoversCell(footprintCellsForAnchor(arb, anchor), target),
        );
        zenaSpots.sort((a, b) => c71Move(zena, a, board) - c71Move(zena, b, board) || a.x - b.x || a.y - b.y);
        arbSpots.sort((a, b) => c71Move(arb, a, board) - c71Move(arb, b, board) || a.x - b.x || a.y - b.y);
        for (const zenaAnchor of zenaSpots) {
            const zenaFp = footprintCellsForAnchor(zena, zenaAnchor);
            for (const arbAnchor of arbSpots) {
                const arbFp = footprintCellsForAnchor(arb, arbAnchor);
                if (!c71PairOk(zenaFp, arbFp)) continue;
                const plan = c71Pack(
                    board,
                    new Map([
                        [zena.getId(), zenaAnchor],
                        [arb.getId(), arbAnchor],
                    ]),
                );
                if (
                    c71ApplyPlan(
                        board,
                        plan,
                        () =>
                            c71CoversCell(board.footprint(zena), corner) &&
                            c71CoversCell(board.footprint(arb), target) &&
                            c71PairOk(board.footprint(zena), board.footprint(arb)),
                    )
                ) {
                    return true;
                }
            }
        }
    }
    return false;
};

const c71BodyAnchors = (
    board: IBoard,
    body: Unit,
    middle: readonly XY[],
    arbLats: readonly number[],
    zenaLats: readonly number[],
    zenaFp: readonly XY[],
    arbFp: readonly XY[],
    ahead: readonly XY[],
): XY[] => {
    const anchors: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(body, anchor);
        if (!footprint.length || !footprint.every((cell) => board.geom.legal.has(keyOf(cell)))) continue;
        if (!c71CoversAll(footprint, middle)) continue;
        const lats = c71LatList(footprint, board);
        if (!lats.every((lat) => arbLats.includes(lat)) || lats.some((lat) => zenaLats.includes(lat))) continue;
        if (minChebyshev(footprint, zenaFp) === 0 || minChebyshev(footprint, arbFp) === 0) continue;
        if (ahead.some((cell) => c71CoversCell(footprint, cell))) continue;
        anchors.push(anchor);
    }
    return anchors;
};

const c71RallyFlyers = (board: IBoard, zena: Unit, arb: Unit): boolean => {
    const ranks = ranksOf(board);
    const bodies = c71Bodies(board);
    const zenaSpots = c71AnchorsOn(zena, board, ranks.back, true);
    const arbSpots = c71AnchorsOn(arb, board, ranks.back, true);
    const pairs: { zena: XY; arb: XY; move: number; cent: number }[] = [];
    for (const zenaAnchor of zenaSpots) {
        const zenaFp = footprintCellsForAnchor(zena, zenaAnchor);
        const zenaLats = c71Lats(zena, zenaAnchor, board);
        for (const arbAnchor of arbSpots) {
            const arbFp = footprintCellsForAnchor(arb, arbAnchor);
            if (!c71PairOk(zenaFp, arbFp)) continue;
            const arbLats = c71Lats(arb, arbAnchor, board);
            pairs.push({
                zena: zenaAnchor,
                arb: arbAnchor,
                move: c71Move(zena, zenaAnchor, board) + c71Move(arb, arbAnchor, board),
                cent: c71Cent(zenaLats, board.geom.centreLat) + c71Cent(arbLats, board.geom.centreLat),
            });
        }
    }
    pairs.sort((a, b) => a.move - b.move || a.cent - b.cent || a.zena.x - b.zena.x || a.zena.y - b.zena.y);
    for (const body of bodies) {
        for (const pair of pairs) {
            const zenaFp = footprintCellsForAnchor(zena, pair.zena);
            const arbFp = footprintCellsForAnchor(arb, pair.arb);
            const zenaLats = c71LatList(zenaFp, board);
            const arbLats = [...new Set(c71LatList(arbFp, board))];
            const middle = arbLats
                .map((lat) => r3Cell(board, ranks.middle, lat))
                .filter((cell): cell is XY => cell !== undefined);
            if (middle.length !== arbLats.length) continue;
            const ahead = c71Ahead(zenaFp, board);
            const anchors = c71BodyAnchors(board, body, middle, arbLats, zenaLats, zenaFp, arbFp, ahead);
            anchors.sort((a, b) => c71Move(body, a, board) - c71Move(body, b, board) || a.x - b.x || a.y - b.y);
            for (const bodyAnchor of anchors) {
                const reserve = new Set(ahead.map((cell) => keyOf(cell)));
                const plan = c71Pack(
                    board,
                    new Map([
                        [zena.getId(), pair.zena],
                        [arb.getId(), pair.arb],
                        [body.getId(), bodyAnchor],
                    ]),
                    { reserve },
                );
                if (
                    c71ApplyPlan(board, plan, () => {
                        const placedZena = board.footprint(zena);
                        const placedArb = board.footprint(arb);
                        const placedBody = board.footprint(body);
                        const placedArbLats = [...new Set(c71LatList(placedArb, board))];
                        const placedMiddle = placedArbLats
                            .map((lat) => r3Cell(board, ranks.middle, lat))
                            .filter((cell): cell is XY => cell !== undefined);
                        const placedAhead = c71Ahead(placedZena, board);
                        const bodyLats = c71LatList(placedBody, board);
                        const placedZenaLats = c71LatList(placedZena, board);
                        return (
                            c71PairOk(placedZena, placedArb) &&
                            placedZena.every((cell) => board.geom.frontness(cell) === ranks.back) &&
                            placedArb.every((cell) => board.geom.frontness(cell) === ranks.back) &&
                            c71CoversAll(placedBody, placedMiddle) &&
                            bodyLats.every((lat) => placedArbLats.includes(lat)) &&
                            !bodyLats.some((lat) => placedZenaLats.includes(lat)) &&
                            placedAhead.every(
                                (cell) =>
                                    !board.units.some((unit) =>
                                        board.footprint(unit).some((entry) => sameCell(entry, cell)),
                                    ),
                            )
                        );
                    })
                ) {
                    return true;
                }
            }
        }
    }
    return false;
};

const c71RallyGround = (board: IBoard, zena: Unit, arb: Unit): boolean => {
    const ranks = ranksOf(board);
    const focus = c71FocusLat(board);
    if (focus === undefined) return false;
    const outer = c71OuterLats(board);
    const zenaSpots = c71AnchorsOn(zena, board, ranks.front, true).filter((anchor) => {
        const footprint = footprintCellsForAnchor(zena, anchor);
        const lats = c71Lats(zena, anchor, board);
        return lats.includes(focus) && !lats.some((lat) => outer.has(lat)) && !c71BlocksCorner(zena, footprint, board);
    });
    zenaSpots.sort(
        (a, b) =>
            c71Cent(c71Lats(zena, a, board), focus) - c71Cent(c71Lats(zena, b, board), focus) ||
            c71Lats(zena, a, board).length - c71Lats(zena, b, board).length ||
            c71Move(zena, a, board) - c71Move(zena, b, board) ||
            a.x - b.x ||
            a.y - b.y,
    );
    for (const zenaAnchor of zenaSpots) {
        const zenaFp = footprintCellsForAnchor(zena, zenaAnchor);
        const zenaLats = c71Lats(zena, zenaAnchor, board);
        const arbSpots = c71AnchorsOn(arb, board, ranks.back, true).filter((anchor) => {
            const arbLats = c71Lats(arb, anchor, board);
            return !c71SharesLat(arbLats, zenaLats) && c71PairOk(zenaFp, footprintCellsForAnchor(arb, anchor));
        });
        arbSpots.sort((a, b) => {
            const aLats = c71Lats(arb, a, board);
            const bLats = c71Lats(arb, b, board);
            return (
                c71Cent(aLats, board.geom.centreLat) - c71Cent(bLats, board.geom.centreLat) ||
                c71Move(arb, a, board) - c71Move(arb, b, board) ||
                Math.min(...aLats) - Math.min(...bLats)
            );
        });
        for (const arbAnchor of arbSpots) {
            const plan = c71Pack(
                board,
                new Map([
                    [zena.getId(), zenaAnchor],
                    [arb.getId(), arbAnchor],
                ]),
            );
            if (
                c71ApplyPlan(board, plan, () => {
                    const placedZena = board.footprint(zena);
                    const placedArb = board.footprint(arb);
                    const placedZenaLats = c71LatList(placedZena, board);
                    return (
                        placedZenaLats.includes(focus) &&
                        placedZena.every((cell) => board.geom.frontness(cell) === ranks.front) &&
                        placedArb.every((cell) => board.geom.frontness(cell) === ranks.back) &&
                        !c71SharesLat(c71LatList(placedArb, board), placedZenaLats) &&
                        c71PairOk(placedZena, placedArb) &&
                        !c71BlocksCorner(zena, placedZena, board)
                    );
                })
            ) {
                return true;
            }
        }
    }
    return false;
};

const c71Rally = (board: IBoard, kind: C71RallyKind): boolean => {
    const zenas = board.units.filter((unit) => c71IsZena(unit) && board.footprint(unit).length > 0).sort(byId);
    const arbs = board.units.filter((unit) => c71IsArb(unit) && board.footprint(unit).length > 0).sort(byId);
    for (const zena of zenas) {
        for (const arb of arbs) {
            if (zena.getId() === arb.getId()) continue;
            const applied =
                kind === "area"
                    ? c71RallyArea(board, zena, arb)
                    : kind === "caliber"
                      ? c71RallyCaliber(board, zena, arb)
                      : kind === "flyers"
                        ? c71RallyFlyers(board, zena, arb)
                        : c71RallyGround(board, zena, arb);
            if (applied) return true;
        }
    }
    return false;
};

const c71ShotReach = (unit: Unit): number => (r3HasAbility(unit, "Sniper") ? Number.POSITIVE_INFINITY : bowReach(unit));

const c71AbsolveBlocked = (threats: IPublicPlacementThreats): boolean =>
    threats.areaThrow ||
    threats.largeCaliber ||
    threats.fireBreath ||
    threats.skewerStrike ||
    threats.throughShot ||
    threats.chakram;

const c71OnlyOn = (footprint: readonly XY[], keys: ReadonlySet<number>): boolean =>
    footprint.length > 0 && footprint.every((cell) => keys.has(keyOf(cell)));

const c71Absolve = (board: IBoard, threats: IPublicPlacementThreats, range: readonly Unit[]): boolean => {
    const monks = board.units
        .filter((unit) => unit.getName() === "Monk" && onBackRank(unit, board) && board.footprint(unit).length > 0)
        .sort(byId);
    const bodies = c71Bodies(board);
    if (!monks.length || !bodies.length) return false;
    const ranks = ranksOf(board);
    for (const monk of monks) {
        const monkAnchor = board.cells.get(monk.getId());
        if (!monkAnchor) continue;
        const monkLats = [...new Set(board.laterals(monk))];
        const middle = monkLats
            .map((lat) => r3Cell(board, ranks.middle, lat))
            .filter((cell): cell is XY => cell !== undefined);
        const front = monkLats
            .map((lat) => r3Cell(board, ranks.front, lat))
            .filter((cell): cell is XY => cell !== undefined);
        if (middle.length !== monkLats.length || front.length !== monkLats.length) continue;
        const frontKeys = new Set(front.map((cell) => keyOf(cell)));
        const others = range.filter((unit) => unit.getId() !== monk.getId());
        const shortest = others.slice().sort((a, b) => c71ShotReach(a) - c71ShotReach(b) || byId(a, b))[0];
        const occupant = board.units.find(
            (unit) =>
                unit.getId() !== monk.getId() && board.footprint(unit).some((cell) => c71CoversCell(middle, cell)),
        );
        for (const body of bodies) {
            const anchors: XY[] = [];
            for (const anchor of board.geom.baseCells) {
                const footprint = footprintCellsForAnchor(body, anchor);
                if (!footprint.length || !footprint.every((cell) => board.geom.legal.has(keyOf(cell)))) continue;
                if (!c71CoversAll(footprint, middle) || minChebyshev(footprint, board.footprint(monk)) === 0) continue;
                const bodyLats = c71LatList(footprint, board);
                const sharesStaying = (bow: Unit): boolean => {
                    const bowFp = board.footprint(bow);
                    if (!c71SharesLat(bodyLats, c71LatList(bowFp, board))) return false;
                    return !c71OnlyOn(bowFp, frontKeys);
                };
                if (shortest && sharesStaying(shortest)) continue;
                if (range.length >= 3 && others.some((bow) => sharesStaying(bow))) continue;
                anchors.push(anchor);
            }
            anchors.sort(
                (a, b) =>
                    c71Move(body, a, board) - c71Move(body, b, board) ||
                    Number(!sameCell(a, middle[0])) - Number(!sameCell(b, middle[0])) ||
                    a.x - b.x ||
                    a.y - b.y,
            );
            for (const anchor of anchors) {
                const bodyFp = footprintCellsForAnchor(body, anchor);
                const bodyLats = c71LatList(bodyFp, board);
                const fixed = new Map<string, XY>([
                    [monk.getId(), monkAnchor],
                    [body.getId(), anchor],
                ]);
                let blocked = false;
                for (const bow of others) {
                    const bowFp = board.footprint(bow);
                    const bowAnchor = board.cells.get(bow.getId());
                    if (!bowAnchor) {
                        blocked = true;
                        break;
                    }
                    const onFront = c71HitsKeys(bowFp, frontKeys);
                    const shares = c71SharesLat(bodyLats, c71LatList(bowFp, board));
                    const guarded = range.length >= 3 || bow.getId() === shortest?.getId();
                    if (!onFront) {
                        if (guarded && shares) {
                            blocked = true;
                            break;
                        }
                        fixed.set(bow.getId(), bowAnchor);
                    }
                }
                if (blocked) continue;
                if (threats.chainLightning) {
                    for (const [id, fixedAnchor] of fixed) {
                        if (id === monk.getId() || id === body.getId()) continue;
                        const unit = board.units.find((item) => item.getId() === id);
                        if (!unit) {
                            blocked = true;
                            break;
                        }
                        if (minChebyshev(footprintCellsForAnchor(unit, fixedAnchor), bodyFp) < 3) {
                            blocked = true;
                            break;
                        }
                    }
                }
                if (blocked) continue;
                const oldBody = board.cells.get(body.getId());
                const plan = c71Pack(board, fixed, {
                    allow: (unit, footprint) => {
                        if (unit.getAttackType() === RANGE && unit.getId() !== monk.getId()) {
                            if (c71HitsKeys(footprint, frontKeys)) return false;
                            const guarded = range.length >= 3 || unit.getId() === shortest?.getId();
                            if (guarded && c71SharesLat(c71LatList(footprint, board), bodyLats)) return false;
                        }
                        return (
                            !threats.chainLightning ||
                            unit.getId() === monk.getId() ||
                            minChebyshev(footprint, bodyFp) >= 3
                        );
                    },
                    prefer: (unit, spot) =>
                        occupant && oldBody && unit.getId() === occupant.getId() && sameCell(spot, oldBody) ? 0 : 1,
                });
                if (
                    c71ApplyPlan(board, plan, () => {
                        const placedMonk = board.cells.get(monk.getId());
                        const placedBody = board.footprint(body);
                        if (!placedMonk || !sameCell(placedMonk, monkAnchor) || !c71CoversAll(placedBody, middle)) {
                            return false;
                        }
                        const placedLats = c71LatList(placedBody, board);
                        if (shortest && c71SharesLat(placedLats, board.laterals(shortest))) return false;
                        if (range.length >= 3 && others.some((bow) => c71SharesLat(placedLats, board.laterals(bow)))) {
                            return false;
                        }
                        for (const cell of front) {
                            if (
                                range.some(
                                    (bow) =>
                                        bow.getId() !== monk.getId() &&
                                        board.footprint(bow).some((entry) => sameCell(entry, cell)),
                                )
                            ) {
                                return false;
                            }
                        }
                        if (!threats.chainLightning) return true;
                        return board.units.every((unit) => {
                            if (unit.getId() === monk.getId() || unit.getId() === body.getId()) return true;
                            const cells = board.footprint(unit);
                            return !cells.length || minChebyshev(cells, placedBody) >= 3;
                        });
                    })
                ) {
                    return true;
                }
            }
        }
    }
    return false;
};

const c71ReachEligible = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE &&
    bowReach(unit) === 11 &&
    !r3HasAbility(unit, "Sniper") &&
    !r3HasAbility(unit, "No Melee") &&
    !r3HasAbility(unit, "Through Shot") &&
    !r3HasAbility(unit, "Guiding Winds") &&
    !r3HasAbility(unit, "Area Throw") &&
    !r3HasAbility(unit, "Large Caliber");

const c71ReachEnemy = (ids: readonly number[] | undefined, threats: IPublicPlacementThreats): boolean => {
    if (threats.rangeCreatures < 2 || threats.flyers >= 2) return false;
    const shooters = c71EnemyShooters(ids);
    if (shooters.length < 2) return false;
    if (
        shooters.some(
            (shooter) => shooter.banned || shooter.reach === 6 || shooter.reach === 11 || shooter.reach === 12,
        )
    ) {
        return false;
    }
    return shooters.every(
        (shooter) =>
            shooter.sniper || shooter.reach === 8 || shooter.reach === 9 || shooter.reach === 10 || shooter.reach >= 13,
    );
};

const c71FileClear = (board: IBoard, lats: readonly number[], selfId: string): boolean =>
    !board.units.some((unit) => unit.getId() !== selfId && c71SharesLat(board.laterals(unit), lats));

const c71Reach = (board: IBoard, range: readonly Unit[]): boolean => {
    const eligible = range
        .filter((unit) => c71ReachEligible(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => {
            const damage =
                (b.getAttackDamageMin() + b.getAttackDamageMax()) / 2 -
                (a.getAttackDamageMin() + a.getAttackDamageMax()) / 2;
            if (damage) return damage;
            const gaze = Number(r3HasAbility(b, "Petrifying Gaze")) - Number(r3HasAbility(a, "Petrifying Gaze"));
            return gaze || b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b);
        });
    const bow = eligible[0];
    if (!bow) return false;
    const staying = range.filter((unit) => unit.getId() !== bow.getId());
    const ranks = ranksOf(board);
    const outer = c71OuterLats(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (!outer.has(lat) && r3Cell(board, ranks.front, lat)) laterals.push(lat);
    }
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    for (const lat of laterals) {
        const target = r3Cell(board, ranks.front, lat);
        const anchors = c71AnchorsOn(bow, board, ranks.front, true).filter((anchor) => {
            const footprint = footprintCellsForAnchor(bow, anchor);
            const lats = c71Lats(bow, anchor, board);
            if (!lats.includes(lat) || lats.some((item) => outer.has(item)) || c71BlocksCorner(bow, footprint, board)) {
                return false;
            }
            if (staying.some((other) => lateralDistance(lats, board.laterals(other)) < 2)) return false;
            return c71FileClear(board, lats, bow.getId());
        });
        anchors.sort((a, b) => (target ? chebyshev(a, target) - chebyshev(b, target) : 0) || a.x - b.x || a.y - b.y);
        const anchor = anchors[0];
        if (!anchor) continue;
        const current = board.cells.get(bow.getId());
        if (current && sameCell(current, anchor)) return true;
        if (board.place(bow, anchor)) return true;
    }
    return false;
};

const c71TouchesFront = (footprint: readonly XY[], board: IBoard): boolean => {
    const front = ranksOf(board).front;
    return footprint.some((cell) => board.geom.frontness(cell) === front);
};

const c71HandyEnemy = (ids: readonly number[] | undefined, threats: IPublicPlacementThreats): boolean =>
    threats.rangeCreatures === 0 &&
    threats.flyers === 0 &&
    !threats.areaThrow &&
    !threats.largeCaliber &&
    c71Walker(ids);

const c71FaceAnchors = (unit: Unit, board: IBoard): XY[] => {
    const outer = c71OuterLats(board);
    return c71AnchorsOn(unit, board, ranksOf(board).front, false).filter((anchor) => {
        const footprint = footprintCellsForAnchor(unit, anchor);
        const lats = c71Lats(unit, anchor, board);
        return !lats.some((lat) => outer.has(lat)) && !c71BlocksCorner(unit, footprint, board);
    });
};

const c71LockedHandy = (board: IBoard, handy: readonly Unit[], range: readonly Unit[]): Set<string> => {
    const handyIds = new Set(handy.map((unit) => unit.getId()));
    const locked = new Set<string>();
    const protectedLats = new Set<number>();
    for (const bow of range) {
        if (handyIds.has(bow.getId())) continue;
        locked.add(bow.getId());
        for (const lat of board.laterals(bow)) protectedLats.add(lat);
    }
    for (const unit of board.units) {
        if (!board.cells.has(unit.getId()) || handyIds.has(unit.getId()) || locked.has(unit.getId())) continue;
        if (board.laterals(unit).some((lat) => protectedLats.has(lat))) locked.add(unit.getId());
    }
    return locked;
};

const c71Handy = (board: IBoard, range: readonly Unit[], threats: IPublicPlacementThreats): boolean => {
    const handy = range.filter((unit) => c71IsHandy(unit) && board.footprint(unit).length > 0).sort(byId);
    const focus = c71FocusLat(board);
    if (!handy.length || focus === undefined) return false;
    const locked = c71LockedHandy(board, handy, range);
    const spin = threats.lightningSpin;
    const tryPack = (anchors: ReadonlyMap<string, XY>): boolean => {
        const moved: XY[][] = [];
        const fixed = new Map<string, XY>();
        for (const id of locked) {
            const current = board.cells.get(id);
            if (!current) return false;
            fixed.set(id, current);
        }
        for (const bow of handy) {
            if (anchors.has(bow.getId()) || locked.has(bow.getId())) continue;
            const current = board.cells.get(bow.getId());
            if (!current) return false;
            fixed.set(bow.getId(), current);
        }
        for (const [id, anchor] of anchors) {
            const unit = board.units.find((item) => item.getId() === id);
            if (!unit || locked.has(id)) return false;
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!footprint.every((cell) => board.geom.legal.has(keyOf(cell)))) return false;
            for (const [otherId, otherAnchor] of fixed) {
                const other = board.units.find((item) => item.getId() === otherId);
                if (!other) return false;
                if (minChebyshev(footprint, footprintCellsForAnchor(other, otherAnchor)) === 0) return false;
            }
            moved.push(footprint);
            fixed.set(id, anchor);
        }
        if (spin) {
            const fronts: XY[][] = [];
            for (const [id, anchor] of fixed) {
                if (anchors.has(id)) continue;
                const unit = board.units.find((item) => item.getId() === id);
                if (!unit) return false;
                const footprint = footprintCellsForAnchor(unit, anchor);
                if (c71TouchesFront(footprint, board)) fronts.push(footprint);
            }
            for (let left = 0; left < moved.length; left += 1) {
                const foot = moved[left];
                if (!foot) continue;
                for (let right = left + 1; right < moved.length; right += 1) {
                    const other = moved[right];
                    if (other && minChebyshev(foot, other) < 2) return false;
                }
                if (fronts.some((front) => minChebyshev(foot, front) < 2)) return false;
            }
        }
        const plan = c71Pack(board, fixed, {
            allow: (_unit, footprint) =>
                !spin ||
                !c71TouchesFront(footprint, board) ||
                moved.every((foot) => minChebyshev(footprint, foot) >= 2),
        });
        return c71ApplyPlan(board, plan, () => {
            for (const [id, anchor] of anchors) {
                const current = board.cells.get(id);
                if (!current || !sameCell(current, anchor)) return false;
            }
            for (const id of locked) {
                const current = board.cells.get(id);
                const before = fixed.get(id);
                if (!current || !before || !sameCell(current, before)) return false;
            }
            if (!spin) return true;
            const movedNow = [...anchors.keys()]
                .map((id) => board.units.find((unit) => unit.getId() === id))
                .filter((unit): unit is Unit => unit !== undefined)
                .map((unit) => board.footprint(unit));
            const others = board.units
                .filter((unit) => !anchors.has(unit.getId()) && c71TouchesFront(board.footprint(unit), board))
                .map((unit) => board.footprint(unit));
            for (let left = 0; left < movedNow.length; left += 1) {
                const foot = movedNow[left];
                if (!foot?.length) return false;
                for (let right = left + 1; right < movedNow.length; right += 1) {
                    const other = movedNow[right];
                    if (other && minChebyshev(foot, other) < 2) return false;
                }
                if (others.some((other) => minChebyshev(foot, other) < 2)) return false;
            }
            return true;
        });
    };
    const onFocus = (unit: Unit): XY[] =>
        c71FaceAnchors(unit, board)
            .filter((anchor) => c71Lats(unit, anchor, board).includes(focus))
            .sort((a, b) => c71Move(unit, a, board) - c71Move(unit, b, board) || a.x - b.x || a.y - b.y);
    if (handy.length === 1) {
        const bow = handy[0];
        if (!bow) return false;
        for (const anchor of onFocus(bow)) {
            if (tryPack(new Map([[bow.getId(), anchor]]))) return true;
        }
        return false;
    }
    if (handy.length === 2) {
        const bowA = handy[0];
        const bowB = handy[1];
        if (!bowA || !bowB) return false;
        const pairs: { a: XY; b: XY; score: number }[] = [];
        for (const a of c71FaceAnchors(bowA, board)) {
            const aLats = c71Lats(bowA, a, board);
            const aFp = footprintCellsForAnchor(bowA, a);
            for (const b of c71FaceAnchors(bowB, board)) {
                const bLats = c71Lats(bowB, b, board);
                const bFp = footprintCellsForAnchor(bowB, b);
                if (minChebyshev(aFp, bFp) === 0 || c71Between(aLats, bLats) < 2) continue;
                const all = [...aLats, ...bLats];
                const mid = (Math.min(...all) + Math.max(...all)) / 2;
                const span = Math.max(...all) - Math.min(...all);
                pairs.push({
                    a,
                    b,
                    score:
                        Math.abs(mid - focus) * 10000 + span * 100 + c71Move(bowA, a, board) + c71Move(bowB, b, board),
                });
            }
        }
        pairs.sort((left, right) => left.score - right.score || left.a.x - right.a.x || left.a.y - right.a.y);
        for (const pair of pairs) {
            if (
                tryPack(
                    new Map([
                        [bowA.getId(), pair.a],
                        [bowB.getId(), pair.b],
                    ]),
                )
            )
                return true;
        }
        for (const bow of handy) {
            for (const anchor of onFocus(bow)) {
                if (tryPack(new Map([[bow.getId(), anchor]]))) return true;
            }
        }
        return false;
    }
    const chosen = new Map<string, XY>();
    const placedLats: number[][] = [];
    const placedFeet: XY[][] = [];
    for (const bow of handy) {
        const anchors = c71FaceAnchors(bow, board).sort((a, b) => {
            const aLats = c71Lats(bow, a, board);
            const bLats = c71Lats(bow, b, board);
            const aFit = placedLats.every((lats) => c71Between(aLats, lats) >= 2) ? 0 : 1;
            const bFit = placedLats.every((lats) => c71Between(bLats, lats) >= 2) ? 0 : 1;
            const aAll = [...aLats, ...placedLats.flat()];
            const bAll = [...bLats, ...placedLats.flat()];
            const aMid = Math.abs((Math.min(...aAll) + Math.max(...aAll)) / 2 - focus);
            const bMid = Math.abs((Math.min(...bAll) + Math.max(...bAll)) / 2 - focus);
            return (
                aFit - bFit || aMid - bMid || c71Move(bow, a, board) - c71Move(bow, b, board) || a.x - b.x || a.y - b.y
            );
        });
        for (const anchor of anchors) {
            const lats = c71Lats(bow, anchor, board);
            const footprint = footprintCellsForAnchor(bow, anchor);
            if (placedLats.some((other) => c71Between(lats, other) < 2)) continue;
            if (placedFeet.some((other) => minChebyshev(footprint, other) === 0)) continue;
            chosen.set(bow.getId(), anchor);
            placedLats.push(lats);
            placedFeet.push(footprint);
            break;
        }
    }
    const ids = [...chosen.keys()];
    while (ids.length) {
        if (tryPack(new Map(ids.map((id) => [id, chosen.get(id) as XY])))) return true;
        ids.pop();
    }
    return false;
};

/**
 * r7c1 post-pass. Today's placeArmy has already run. The historical local Volley paired
 * Zena and Arbalester at Chebyshev 2; the army-wide Blessing skips that pass. A Monk keeps
 * a cleansed lane, one floor-11 bow takes an inner front file,
 * or Handyman bows step to the front. The first branch that matches is the only one.
 * The zone and the augment spend stay.
 */
export function placeArmyR7C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const range = board.units.filter((unit) => unit.getAttackType() === RANGE && board.footprint(unit).length > 0);
    if (range.length < 2) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const ids = context.publicOpponentCreatureIds;
    const original = copyCells(board);
    const kind = c71RallyKind(threats);
    const hasPair =
        board.units.some((unit) => c71IsZena(unit) && board.footprint(unit).length > 0) &&
        board.units.some((unit) => c71IsArb(unit) && board.footprint(unit).length > 0);
    if (hasPair && kind) {
        if (!c71Rally(board, kind)) restoreCells(board, original);
        return board.cells;
    }
    const monkReady = board.units.some((unit) => unit.getName() === "Monk" && onBackRank(unit, board));
    if (monkReady && c71DebuffEnemy(ids) && !c71AbsolveBlocked(threats)) {
        if (!c71Absolve(board, threats, range)) restoreCells(board, original);
        return board.cells;
    }
    if (c71ReachEnemy(ids, threats) && range.some((unit) => c71ReachEligible(unit))) {
        if (!c71Reach(board, range)) restoreCells(board, original);
        return board.cells;
    }
    if (range.some((unit) => c71IsHandy(unit)) && c71HandyEnemy(ids, threats)) {
        if (!c71Handy(board, range, threats)) restoreCells(board, original);
        return board.cells;
    }
    return board.cells;
}

/** Bow, non-range caster, Monk, Dryad, or a named protector. Already on a required seat, the branch aborts. */
const c72Stays = (unit: Unit): boolean => {
    if (unit.getAttackType() === RANGE) return true;
    if (CASTER_STAYS.has(unit.getName()) || PROTECTORS.has(unit.getName())) return true;
    return isCasterUnit(unit);
};

/** Non-flying, non-charger, non-range body that is not a stay. */
const c72IsScreen = (unit: Unit): boolean => !unit.canFly() && !isCharger(unit) && !c72Stays(unit);

const c72IsFlyer = (unit: Unit): boolean => unit.canFly() && !c72Stays(unit) && unit.getAttackType() !== RANGE;

/** Ground body we may move. Flyers, bows, casters, and named protectors are not plugs. */
const c72Ground = (unit: Unit): boolean => !unit.canFly() && !c72Stays(unit);

const c72Immune = (unit: Unit): boolean => r3HasAbility(unit, "Fire Element") || r3HasAbility(unit, "Enchanted Skin");

const c72Heavy = (unit: Unit): boolean => r3HasAbility(unit, "Heavy Armor");

const c72ByLowArmor = (a: Unit, b: Unit): number => a.getArmor() - b.getArmor() || byId(a, b);

const c72Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (board.cells.has(unit.getId()) && c72Stays(unit)) locked.add(unit.getId());
    }
    return locked;
};

const c72Fastest = (board: IBoard, locked: ReadonlySet<string>): Unit | undefined =>
    board.units
        .filter((unit) => isCharger(unit) && !locked.has(unit.getId()) && board.cells.has(unit.getId()))
        .sort(c62BySpeed)[0];

const c72Screens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units.filter((unit) => c72IsScreen(unit) && !locked.has(unit.getId()) && board.cells.has(unit.getId()));

const c72Flyers = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    board.units.filter((unit) => c72IsFlyer(unit) && !locked.has(unit.getId()) && board.cells.has(unit.getId()));

const c72CentreLat = (board: IBoard): number | undefined => {
    const cell = c62CentreCell(board);
    return cell ? board.geom.lateral(cell) : undefined;
};

const c72Current = (board: IBoard, unit: Unit): ISpan | undefined => {
    const anchor = board.cells.get(unit.getId());
    return anchor ? spanAt(unit, anchor, board.geom) : undefined;
};

const c72StayHits = (board: IBoard, locked: ReadonlySet<string>, keys: ReadonlySet<number>): boolean => {
    if (!keys.size) return false;
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        if (board.footprint(unit).some((cell) => keys.has(keyOf(cell)))) return true;
    }
    return false;
};

const c72Stamp = (board: IBoard, taken: Set<number>, plan: Map<string, XY>, unit: Unit, anchor: XY): boolean => {
    const span = c62Stamp(taken, unit, anchor, board);
    if (!span) return false;
    plan.set(unit.getId(), { x: anchor.x, y: anchor.y });
    return true;
};

const c72Finish = (
    board: IBoard,
    locked: ReadonlySet<string>,
    plan: Map<string, XY>,
    forbidden: ReadonlySet<number>,
): boolean => c62Commit(board, locked, plan, forbidden, () => true);

const c72PlanKeys = (board: IBoard, plan: ReadonlyMap<string, XY>): Set<number> => {
    const keys = new Set<number>();
    for (const [id, anchor] of plan) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) keys.add(keyOf(cell));
    }
    return keys;
};

const c72SeatOn = (unit: Unit, board: IBoard, taken: ReadonlySet<number>, cell: XY): XY | undefined => {
    if (!unit.isSmallSize()) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.cells.length === 1 && c62Covers(span, cell),
        () => 0,
    );
};

/** Entire footprint must sit on `cells`, preferring the earliest cell in that list. */
const c72SeatWithin = (unit: Unit, board: IBoard, taken: ReadonlySet<number>, cells: readonly XY[]): XY | undefined => {
    const keys = new Set(cells.map((cell) => keyOf(cell)));
    if (!keys.size) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.cells.every((cell) => keys.has(keyOf(cell))),
        (span) => {
            let best = cells.length;
            for (let index = 0; index < cells.length; index += 1) {
                const cell = cells[index];
                if (cell && c62Covers(span, cell)) best = Math.min(best, index);
            }
            return best * 100 + span.cells.length;
        },
    );
};

const c72SeatFrontCentre = (unit: Unit, board: IBoard, taken: ReadonlySet<number>): XY | undefined => {
    const cell = c62CentreCell(board);
    const ranks = c62Ranks(board);
    if (!cell) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.maxFront === ranks.front && c62Covers(span, cell),
        (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat) * 100 + (ranks.front - span.minFront),
    );
};

/** Tail on the back-rank centre cell. A 2-deep body keeps its face on the middle rank, never the front. */
const c72SeatRear = (unit: Unit, board: IBoard, taken: ReadonlySet<number>, backCell: XY): XY | undefined => {
    const ranks = c62Ranks(board);
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.minFront === ranks.back && span.maxFront < ranks.front && c62Covers(span, backCell),
        (span) => Math.abs(medianNumber(span.laterals) - board.geom.centreLat) * 100 + (span.maxFront - ranks.back),
    );
};

/** One file, front rank only, so a wider body cannot step onto the lane. */
const c72SeatFrontOnly = (unit: Unit, board: IBoard, taken: ReadonlySet<number>, lat: number): XY | undefined => {
    const ranks = c62Ranks(board);
    const cell = r3Cell(board, ranks.front, lat);
    if (!cell) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) =>
            span.minFront === ranks.front &&
            span.maxFront === ranks.front &&
            span.laterals.length === 1 &&
            span.laterals[0] === lat &&
            c62Covers(span, cell),
        () => 0,
    );
};

const c72InZone = (lat: number, ranks: C62Ranks): boolean => lat >= ranks.minLat && lat <= ranks.maxLat;

const c72BehindCells = (board: IBoard, span: ISpan): XY[] => {
    const laterals = new Set(span.laterals);
    const cells = board.geom.baseCells.filter(
        (cell) => laterals.has(board.geom.lateral(cell)) && board.geom.frontness(cell) < span.minFront,
    );
    cells.sort(
        (a, b) =>
            board.geom.frontness(b) - board.geom.frontness(a) ||
            board.geom.lateral(a) - board.geom.lateral(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    return cells;
};

const c72ForbidExcept = (forbidden: Set<number>, cells: readonly XY[], keep: ReadonlySet<number>): void => {
    for (const cell of cells) {
        const key = keyOf(cell);
        if (!keep.has(key)) forbidden.add(key);
    }
};

const c72FileCells = (board: IBoard, laterals: ReadonlySet<number>): XY[] =>
    board.geom.baseCells.filter((cell) => laterals.has(board.geom.lateral(cell)));

/**
 * Face on the front of `lat`. Extra laterals must pass `allow`. Used for bodies that are deeper than one cell.
 */
const c72SeatFace = (
    unit: Unit,
    board: IBoard,
    taken: ReadonlySet<number>,
    lat: number,
    allow: (span: ISpan) => boolean,
): XY | undefined => {
    const ranks = c62Ranks(board);
    const cell = r3Cell(board, ranks.front, lat);
    if (!cell) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) => span.maxFront === ranks.front && c62Covers(span, cell) && allow(span),
        (span) => span.cells.length + Math.abs(medianNumber(span.laterals) - lat),
    );
};

const c72SeatFlyers = (
    board: IBoard,
    taken: Set<number>,
    plan: Map<string, XY>,
    flyers: readonly Unit[],
    slots: readonly number[],
    allow: (span: ISpan) => boolean,
): boolean => {
    const used = new Set<number>();
    for (const flyer of flyers) {
        let seated = false;
        for (const lat of slots) {
            if (used.has(lat)) continue;
            const anchor = c72SeatFace(flyer, board, taken, lat, (span) => {
                if (span.laterals.some((value) => used.has(value))) return false;
                return allow(span);
            });
            if (!anchor) continue;
            const span = spanAt(flyer, anchor, board.geom);
            if (!span || !c72Stamp(board, taken, plan, flyer, anchor)) return false;
            for (const value of span.laterals) used.add(value);
            seated = true;
            break;
        }
        if (!seated) return false;
    }
    return true;
};

const c72FireImmune = (board: IBoard, locked: ReadonlySet<string>, immune: Unit): boolean => {
    const taken = c62Taken(board, locked, new Map());
    const anchor = c72SeatFrontCentre(immune, board, taken);
    if (!anchor) return false;
    const span = spanAt(immune, anchor, board.geom);
    if (!span) return false;
    const plan = new Map<string, XY>();
    if (!c72Stamp(board, taken, plan, immune, anchor)) return false;
    const behind = c72BehindCells(board, span);
    if (behind.some((cell) => c72StayHits(board, locked, new Set([keyOf(cell)])))) return false;
    const queue: Unit[] = [];
    const charger = c72Fastest(board, locked);
    if (charger && charger.getId() !== immune.getId()) queue.push(charger);
    const screens = c72Screens(board, locked).filter((unit) => unit.getId() !== immune.getId());
    queue.push(...screens.filter(c72Heavy).sort(c62ByArmor));
    queue.push(...screens.filter((unit) => !c72Heavy(unit)).sort(c62ByArmor));
    for (const unit of queue) {
        const spot = c72SeatWithin(unit, board, taken, behind);
        if (!spot) {
            if (isCharger(unit)) return false;
            continue;
        }
        if (!c72Stamp(board, taken, plan, unit, spot)) return false;
    }
    const keep = c72PlanKeys(board, plan);
    const forbidden = new Set<number>();
    const ranks = c62Ranks(board);
    for (const cell of board.geom.baseCells) {
        if (board.geom.frontness(cell) !== ranks.front) continue;
        const key = keyOf(cell);
        if (keep.has(key)) continue;
        if (c72StayHits(board, locked, new Set([key]))) return false;
        forbidden.add(key);
    }
    return c72Finish(board, locked, plan, forbidden);
};

const c72FireOpen = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const centre = c72CentreLat(board);
    const back = centre === undefined ? undefined : r3Cell(board, ranks.back, centre);
    if (centre === undefined || !back) return false;
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        const span = c72Current(board, unit);
        if (!span || !span.cells.some((cell) => board.geom.frontness(cell) === ranks.front)) continue;
        if (!unit.isSmallSize() || c72Heavy(unit)) return false;
    }
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const charger = c72Fastest(board, locked);
    let chargerSpan: ISpan | undefined;
    if (charger) {
        const anchor = c72SeatRear(charger, board, taken, back);
        if (!anchor || !c72Stamp(board, taken, plan, charger, anchor)) return false;
        chargerSpan = spanAt(charger, anchor, board.geom);
        if (!chargerSpan) return false;
    }
    const chargerLats = new Set(chargerSpan?.laterals ?? []);
    const frontLats = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        const span = c72Current(board, unit);
        if (!span) continue;
        if (!span.cells.some((cell) => board.geom.frontness(cell) === ranks.front)) continue;
        for (const lat of span.laterals) {
            const middle = r3Cell(board, ranks.middle, lat);
            if (
                middle &&
                chargerSpan?.cells.some(
                    (cell) => board.geom.lateral(cell) === lat && board.geom.frontness(cell) === ranks.middle,
                )
            ) {
                return false;
            }
            frontLats.add(lat);
        }
    }
    const nearFront = (lat: number): boolean => [...frontLats, ...chargerLats].some((file) => Math.abs(file - lat) < 2);
    const slots: number[] = [];
    for (let dist = 2; dist <= ranks.maxLat - ranks.minLat; dist += 2) {
        for (const lat of [centre - dist, centre + dist]) {
            if (!c72InZone(lat, ranks) || frontLats.has(lat) || nearFront(lat)) continue;
            const middle = r3Cell(board, ranks.middle, lat);
            if (middle && c72StayHits(board, locked, new Set([keyOf(middle)]))) continue;
            if (slots.some((slot) => Math.abs(slot - lat) < 2)) continue;
            slots.push(lat);
        }
    }
    const eligible = c72Screens(board, locked)
        .filter((unit) => unit.isSmallSize() && !c72Heavy(unit))
        .sort(c62ByArmor);
    for (const lat of slots) {
        const screen = eligible[0];
        const cell = r3Cell(board, ranks.front, lat);
        if (!screen || !cell || c72StayHits(board, locked, new Set([keyOf(cell)]))) continue;
        const anchor = c72SeatOn(screen, board, taken, cell);
        if (!anchor || !c72Stamp(board, taken, plan, screen, anchor)) continue;
        eligible.shift();
        frontLats.add(lat);
    }
    const keep = c72PlanKeys(board, plan);
    const forbidden = new Set<number>();
    for (const lat of frontLats) {
        const middle = r3Cell(board, ranks.middle, lat);
        if (!middle || keep.has(keyOf(middle))) continue;
        if (c72StayHits(board, locked, new Set([keyOf(middle)]))) return false;
        forbidden.add(keyOf(middle));
    }
    for (const cell of board.geom.baseCells) {
        if (board.geom.frontness(cell) !== ranks.front) continue;
        const key = keyOf(cell);
        if (keep.has(key) || c72StayHits(board, locked, new Set([key]))) continue;
        forbidden.add(key);
    }
    return c72Finish(board, locked, plan, forbidden);
};

const c72Fire = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const immunes = board.units
        .filter((unit) => c72Immune(unit) && !locked.has(unit.getId()) && board.cells.has(unit.getId()))
        .sort(c62ByLargest);
    if (immunes.length) {
        for (const immune of immunes) {
            if (c72FireImmune(board, locked, immune)) return true;
        }
        return false;
    }
    return c72FireOpen(board, locked);
};

const c72SkewerSmall = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const centre = c72CentreLat(board);
    if (centre === undefined) return false;
    const file = new Set(c72FileCells(board, new Set([centre])).map((cell) => keyOf(cell)));
    if (c72StayHits(board, locked, file)) return false;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const front = r3Cell(board, ranks.front, centre);
    const middle = r3Cell(board, ranks.middle, centre);
    const back = r3Cell(board, ranks.back, centre);
    const screen = c72Screens(board, locked)
        .filter((unit) => unit.isSmallSize())
        .sort(c62ByArmor)[0];
    if (screen) {
        if (!front) return false;
        const anchor = c72SeatOn(screen, board, taken, front);
        if (!anchor || !c72Stamp(board, taken, plan, screen, anchor)) return false;
    }
    const charger = c72Fastest(board, locked);
    if (charger && back) {
        const anchor = c72SeatOn(charger, board, taken, back);
        if (anchor) c72Stamp(board, taken, plan, charger, anchor);
    }
    const keep = c72PlanKeys(board, plan);
    const forbidden = new Set<number>();
    if (middle) forbidden.add(keyOf(middle));
    for (const key of file) {
        if (!keep.has(key)) forbidden.add(key);
    }
    if (middle) forbidden.add(keyOf(middle));
    return c72Finish(board, locked, plan, forbidden);
};

const c72SkewerLarge = (board: IBoard, locked: ReadonlySet<string>, plug: Unit): boolean => {
    const taken = c62Taken(board, locked, new Map());
    const anchor = c72SeatFrontCentre(plug, board, taken);
    const span = anchor ? spanAt(plug, anchor, board.geom) : undefined;
    if (!anchor || !span || span.cells.length < 2) return false;
    const plan = new Map<string, XY>();
    if (!c72Stamp(board, taken, plan, plug, anchor)) return false;
    const ranks = c62Ranks(board);
    const plugLats = new Set(span.laterals);
    const backs: XY[] = [];
    for (const lat of plugLats) {
        const cell = r3Cell(board, ranks.back, lat);
        if (!cell || c62Covers(span, cell)) continue;
        if (c72StayHits(board, locked, new Set([keyOf(cell)]))) return false;
        backs.push(cell);
    }
    backs.sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b) || a.x - b.x || a.y - b.y);
    const queue: Unit[] = [];
    const charger = c72Fastest(board, locked);
    if (charger && charger.getId() !== plug.getId()) queue.push(charger);
    queue.push(
        ...c72Screens(board, locked)
            .filter((unit) => unit.isSmallSize() && unit.getId() !== plug.getId())
            .sort(c62ByArmor),
    );
    queue.push(
        ...c72Flyers(board, locked)
            .filter((unit) => unit.isSmallSize() && unit.getId() !== plug.getId())
            .sort(byId),
    );
    for (const unit of queue) {
        const spot = c72SeatWithin(unit, board, taken, backs);
        if (!spot) continue;
        if (!c72Stamp(board, taken, plan, unit, spot)) return false;
    }
    const forbidden = new Set<number>();
    for (const lat of plugLats) {
        for (const cell of board.geom.baseCells) {
            if (board.geom.lateral(cell) !== lat || c62Covers(span, cell)) continue;
            if (board.geom.frontness(cell) > ranks.back && board.geom.frontness(cell) < ranks.front) {
                forbidden.add(keyOf(cell));
            }
        }
    }
    const adjacent: XY[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (plugLats.has(lat)) continue;
        if (![...plugLats].some((file) => Math.abs(file - lat) === 1)) continue;
        const cell = r3Cell(board, ranks.front, lat);
        if (cell) adjacent.push(cell);
    }
    if (c72StayHits(board, locked, new Set(adjacent.map((cell) => keyOf(cell))))) return false;
    c72ForbidExcept(forbidden, adjacent, new Set());
    return c72Finish(board, locked, plan, forbidden);
};

const c72Skewer = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const grounds = board.units.filter((unit) => c72Ground(unit) && board.cells.has(unit.getId())).sort(c62ByLargest);
    if (!grounds.length || grounds.every((unit) => unit.isSmallSize())) return c72SkewerSmall(board, locked);
    const plug = grounds[0];
    return plug ? c72SkewerLarge(board, locked, plug) : false;
};

const c72CageReady = (board: IBoard, locked: ReadonlySet<string>): boolean =>
    c72Flyers(board, locked).some((unit) => unit.isSmallSize()) &&
    c72Screens(board, locked).filter((unit) => unit.isSmallSize()).length >= 4;

/** Outer cage file plus `step`. The cage itself is the centre file and one file to either side. */
const c72OffCage = (centre: number, step: number, high: boolean): number =>
    high ? centre + 1 + step : centre - 1 - step;

const c72Cage = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const centre = c72CentreLat(board);
    if (centre === undefined) return false;
    const middle = r3Cell(board, ranks.middle, centre);
    const front = r3Cell(board, ranks.front, centre);
    const back = r3Cell(board, ranks.back, centre);
    const left = r3Cell(board, ranks.middle, centre - 1);
    const right = r3Cell(board, ranks.middle, centre + 1);
    if (!middle || !front || !back || !left || !right) return false;
    const flyer = c72Flyers(board, locked)
        .filter((unit) => unit.isSmallSize())
        .sort(c72ByLowArmor)[0];
    if (!flyer) return false;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const flyerAnchor = c72SeatOn(flyer, board, taken, middle);
    if (!flyerAnchor || !c72Stamp(board, taken, plan, flyer, flyerAnchor)) return false;
    const screens = c72Screens(board, locked)
        .filter((unit) => unit.isSmallSize())
        .sort(c62ByArmor);
    for (const cell of [front, left, right, back]) {
        let placed = false;
        for (let index = 0; index < screens.length; index += 1) {
            const screen = screens[index];
            if (!screen) continue;
            const anchor = c72SeatOn(screen, board, taken, cell);
            if (!anchor || !c72Stamp(board, taken, plan, screen, anchor)) continue;
            screens.splice(index, 1);
            placed = true;
            break;
        }
        if (!placed) return false;
    }
    const charger = c72Fastest(board, locked);
    const chargerLats = new Set<number>();
    if (charger) {
        let seated = false;
        for (const high of [false, true]) {
            const lat = c72OffCage(centre, 3, high);
            if (!c72InZone(lat, ranks)) continue;
            const anchor = c72SeatFace(charger, board, taken, lat, (span) =>
                span.laterals.every((value) => Math.abs(value - centre) > 1),
            );
            if (!anchor) continue;
            const span = spanAt(charger, anchor, board.geom);
            if (!span || !c72Stamp(board, taken, plan, charger, anchor)) return false;
            for (const value of span.laterals) chargerLats.add(value);
            seated = true;
            break;
        }
        if (!seated) return false;
    }
    const slots: number[] = [];
    for (let step = 2; step <= ranks.maxLat - ranks.minLat; step += 2) {
        for (const high of [true, false]) {
            const lat = c72OffCage(centre, step, high);
            if (!c72InZone(lat, ranks) || chargerLats.has(lat)) continue;
            slots.push(lat);
        }
    }
    const extras = c72Flyers(board, locked)
        .filter((unit) => unit.getId() !== flyer.getId())
        .sort(byId);
    if (
        !c72SeatFlyers(board, taken, plan, extras, slots, (span) =>
            span.laterals.every((lat) => !chargerLats.has(lat) && Math.abs(lat - centre) > 1),
        )
    ) {
        return false;
    }
    const keep = c72PlanKeys(board, plan);
    const forbidden = new Set<number>();
    c72ForbidExcept(forbidden, c72FileCells(board, chargerLats), keep);
    return c72Finish(board, locked, plan, forbidden);
};

const c72OutsideLats = (board: IBoard, plugged: ReadonlySet<number>): number[] => {
    const ranks = c62Ranks(board);
    const outward = lateralsNearestCentre(board);
    if (!plugged.size) return outward;
    const low = Math.min(...plugged);
    const high = Math.max(...plugged);
    return outward.filter((lat) => lat >= ranks.minLat && lat <= ranks.maxLat && (lat < low || lat > high));
};

const c72Plugged = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const pool = c72Screens(board, locked)
        .filter((unit) => unit.isSmallSize())
        .sort(byId);
    const started = pool.length;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const plugged = new Set<number>();
    const seatedFlyers = new Set<string>();
    for (const lat of lateralsNearestCentre(board)) {
        if (pool.length < 2) break;
        const front = r3Cell(board, ranks.front, lat);
        const back = r3Cell(board, ranks.back, lat);
        const middle = r3Cell(board, ranks.middle, lat);
        if (!front || !back || !middle) continue;
        const blocked = new Set([keyOf(front), keyOf(back), keyOf(middle)]);
        if (c72StayHits(board, locked, blocked)) continue;
        const frontUnit = [...pool].sort(c62ByArmor)[0];
        const backUnit = [...pool].filter((unit) => unit.getId() !== frontUnit?.getId()).sort(bySlowest)[0];
        if (!frontUnit || !backUnit) break;
        const frontAnchor = c72SeatOn(frontUnit, board, taken, front);
        const backAnchor = c72SeatOn(backUnit, board, taken, back);
        if (!frontAnchor || !backAnchor) continue;
        if (!c72Stamp(board, taken, plan, frontUnit, frontAnchor)) return false;
        if (!c72Stamp(board, taken, plan, backUnit, backAnchor)) return false;
        pool.splice(
            0,
            pool.length,
            ...pool.filter((unit) => unit.getId() !== frontUnit.getId() && unit.getId() !== backUnit.getId()),
        );
        plugged.add(lat);
        const flyer = c72Flyers(board, locked)
            .filter((unit) => unit.isSmallSize() && !seatedFlyers.has(unit.getId()))
            .sort(c72ByLowArmor)[0];
        const flyerAnchor = flyer ? c72SeatOn(flyer, board, taken, middle) : undefined;
        if (flyer && flyerAnchor && c72Stamp(board, taken, plan, flyer, flyerAnchor)) {
            seatedFlyers.add(flyer.getId());
        }
    }
    if (started >= 2 && plugged.size === 0) return false;
    const charger = c72Fastest(board, locked);
    const chargerLats = new Set<number>();
    if (charger) {
        let seated = false;
        for (const lat of c72OutsideLats(board, plugged)) {
            const anchor = c72SeatFace(charger, board, taken, lat, (span) =>
                span.laterals.every((value) => !plugged.has(value)),
            );
            if (!anchor) continue;
            const span = spanAt(charger, anchor, board.geom);
            if (!span || !c72Stamp(board, taken, plan, charger, anchor)) return false;
            for (const value of span.laterals) chargerLats.add(value);
            seated = true;
            break;
        }
        if (!seated) return false;
    }
    const blocked = new Set<number>([...plugged, ...chargerLats]);
    if (!blocked.size) {
        const centre = c72CentreLat(board);
        if (centre !== undefined) blocked.add(centre);
    }
    const slots: number[] = [];
    if (blocked.size) {
        const low = Math.min(...blocked);
        const high = Math.max(...blocked);
        for (let step = 2; step <= ranks.maxLat - ranks.minLat; step += 2) {
            if (c72InZone(high + step, ranks)) slots.push(high + step);
            if (c72InZone(low - step, ranks)) slots.push(low - step);
        }
    }
    const extras = c72Flyers(board, locked)
        .filter((unit) => !seatedFlyers.has(unit.getId()))
        .sort(byId);
    if (
        !c72SeatFlyers(board, taken, plan, extras, slots, (span) =>
            span.laterals.every((lat) => !blocked.has(lat) && [...blocked].every((file) => Math.abs(file - lat) >= 2)),
        )
    ) {
        return false;
    }
    const keep = c72PlanKeys(board, plan);
    const forbidden = new Set<number>();
    for (const lat of plugged) {
        const middle = r3Cell(board, ranks.middle, lat);
        if (!middle || keep.has(keyOf(middle))) continue;
        forbidden.add(keyOf(middle));
    }
    if (chargerLats.size) {
        const chargerAnchor = charger ? plan.get(charger.getId()) : undefined;
        const chargerSpan = charger && chargerAnchor ? spanAt(charger, chargerAnchor, board.geom) : undefined;
        for (const cell of c72FileCells(board, chargerLats)) {
            if (!chargerSpan || board.geom.frontness(cell) <= chargerSpan.maxFront) continue;
            forbidden.add(keyOf(cell));
        }
    }
    return c72Finish(board, locked, plan, forbidden);
};

const c72Runway = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const ranks = c62Ranks(board);
    const centre = c72CentreLat(board);
    const back = centre === undefined ? undefined : r3Cell(board, ranks.back, centre);
    const charger = c72Fastest(board, locked);
    if (!charger || !back) return false;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const anchor = c72SeatRear(charger, board, taken, back);
    const span = anchor ? spanAt(charger, anchor, board.geom) : undefined;
    if (!anchor || !span || !c72Stamp(board, taken, plan, charger, anchor)) return false;
    const lane = new Set(span.laterals);
    const low = Math.min(...lane);
    const high = Math.max(...lane);
    const beside = [low - 1, high + 1].filter((lat) => c72InZone(lat, ranks));
    beside.sort(
        (a, b) =>
            Math.min(...[...lane].map((lat) => Math.abs(lat - a))) -
                Math.min(...[...lane].map((lat) => Math.abs(lat - b))) ||
            Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) ||
            a - b,
    );
    const screens = c72Screens(board, locked)
        .filter((unit) => unit.isSmallSize() && unit.getId() !== charger.getId())
        .sort(c62ByArmor);
    const screenLats = new Set<number>();
    for (const lat of beside) {
        const screen = screens[0];
        const cell = r3Cell(board, ranks.front, lat);
        if (!screen || !cell) continue;
        if (c72StayHits(board, locked, new Set([keyOf(cell)]))) return false;
        const seat = c72SeatFrontOnly(screen, board, taken, lat);
        if (!seat || !c72Stamp(board, taken, plan, screen, seat)) return false;
        screens.shift();
        screenLats.add(lat);
    }
    const slots: number[] = [];
    for (let step = 2; step <= ranks.maxLat - ranks.minLat; step += 1) {
        if (c72InZone(high + step, ranks)) slots.push(high + step);
        if (c72InZone(low - step, ranks)) slots.push(low - step);
    }
    const flyers = c72Flyers(board, locked)
        .filter((unit) => unit.getId() !== charger.getId())
        .sort(byId);
    const clearOf = (lat: number): boolean =>
        [...lane].every((file) => Math.abs(file - lat) >= 2) && !screenLats.has(lat);
    if (!c72SeatFlyers(board, taken, plan, flyers, slots, (body) => body.laterals.every((lat) => clearOf(lat)))) {
        return false;
    }
    const forbidden = new Set<number>();
    c72ForbidExcept(forbidden, c72FileCells(board, lane), c72PlanKeys(board, plan));
    return c72Finish(board, locked, plan, forbidden);
};

/**
 * r7c2 post-pass. Today's placeArmy has already run. An immune body keeps the breath file, a shot is
 * boxed on the middle rank, flyers meet a plugged back rank, or a charger holds an empty centre
 * runway. The current zone stays. Area Throw and Large Caliber leave the map alone. The first
 * branch that matches is the only one.
 */
export function placeArmyR7C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const original = copyCells(board);
    const locked = c72Locked(board);
    const keep = (): Map<string, XY> => {
        restoreCells(board, original);
        return board.cells;
    };
    if (threats.fireBreath) return c72Fire(board, locked) ? board.cells : keep();
    if (threats.skewerStrike) return c72Skewer(board, locked) ? board.cells : keep();
    if (threats.lightningSpin || threats.throughShot || threats.chakram) return board.cells;
    if (!threats.lineAttack && threats.rangeCreatures > 0 && c72CageReady(board, locked)) {
        return c72Cage(board, locked) ? board.cells : keep();
    }
    if (!threats.lineAttack && threats.flyers > 0) return c72Plugged(board, locked) ? board.cells : keep();
    if (!threats.lineAttack && threats.flyers === 0 && c72Fastest(board, locked)) {
        return c72Runway(board, locked) ? board.cells : keep();
    }
    return board.cells;
}

const c73Fixed = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE ||
    unit.getName() === "Dryad" ||
    unit.getName() === "Monk" ||
    unit.getName() === "Abomination" ||
    unit.getName() === "Arachna Queen";

/** Movable non-range caster. Monk, Dryad, bows, and named protectors are not this body. */
const c73Caster = (unit: Unit): boolean => isCasterUnit(unit) && !c73Fixed(unit);

/** Non-flying melee screen. Protectors, casters, bows, and spellbooks are not screens. */
const c73Screen = (unit: Unit): boolean => {
    if (unit.canFly() || c73Fixed(unit) || isCasterUnit(unit) || PROTECTORS.has(unit.getName())) return false;
    if (isSpellbookUnit(unit)) return false;
    const attack = unit.getAttackType();
    return attack === MELEE || attack === MELEE_MAGIC;
};

/** Second body for a one-cell breath: small, grounded, and not a caster or a stay. */
const c73Second = (unit: Unit): boolean =>
    unit.isSmallSize() && !unit.canFly() && !c73Fixed(unit) && !isCasterUnit(unit) && !PROTECTORS.has(unit.getName());

const c73Depth3 = (board: IBoard): boolean => {
    const ranks = ranksOf(board);
    return ranks.front - ranks.back === 2;
};

const c73Foot = (unit: Unit, anchor: XY): XY[] => footprintCellsForAnchor(unit, anchor);

const c73Unit = (board: IBoard, id: string): Unit | undefined => board.units.find((unit) => unit.getId() === id);

const c73Add = (taken: Set<number>, cells: readonly XY[]): void => {
    for (const cell of cells) taken.add(keyOf(cell));
};

const c73Covers = (cells: readonly XY[], target: XY): boolean => cells.some((cell) => sameCell(cell, target));

const c73Lats = (cells: readonly XY[], geom: IGeom): number[] => cells.map((cell) => geom.lateral(cell));

const c73LatGap = (left: readonly number[], right: readonly number[]): number => {
    if (!left.length || !right.length) return Infinity;
    let best = Infinity;
    for (const a of left) {
        for (const b of right) best = Math.min(best, Math.abs(a - b));
    }
    return best;
};

const c73FinalAnchor = (board: IBoard, unit: Unit, moves: ReadonlyMap<string, XY>): XY | undefined =>
    moves.get(unit.getId()) ?? board.cells.get(unit.getId());

const c73FinalFoot = (board: IBoard, unit: Unit, moves: ReadonlyMap<string, XY>): XY[] => {
    const anchor = c73FinalAnchor(board, unit, moves);
    return anchor ? c73Foot(unit, anchor) : [];
};

const c73Changed = (board: IBoard, unit: Unit, moves: ReadonlyMap<string, XY>): boolean => {
    const next = moves.get(unit.getId());
    const current = board.cells.get(unit.getId());
    return !!next && (!current || !sameCell(next, current));
};

const c73CentrePair = (board: IBoard): number[] => {
    const ranks = ranksOf(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) laterals.push(lat);
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    return laterals.slice(0, 2).sort((a, b) => a - b);
};

const c73CornerLat = (board: IBoard, lat: number): boolean => {
    const ranks = ranksOf(board);
    return lat === ranks.minLat || lat === ranks.maxLat;
};

const c73OnRank = (footprint: readonly XY[], board: IBoard, rank: number): boolean =>
    footprint.length > 0 && footprint.every((cell) => board.geom.frontness(cell) === rank);

const c73Ring = (footprint: readonly XY[], board: IBoard): XY[] =>
    board.geom.baseCells.filter((cell) => minChebyshev([cell], footprint) === 1);

/** A one-rank lateral step. Forward moves are not slides. */
const c73Slides = (unit: Unit, board: IBoard, anchor: XY): boolean => {
    if (!c73Screen(unit)) return false;
    const current = board.cells.get(unit.getId());
    if (!current || sameCell(current, anchor)) return false;
    const before = spanAt(unit, current, board.geom);
    const after = spanAt(unit, anchor, board.geom);
    if (!before || !after) return false;
    if (before.minFront !== after.minFront || before.maxFront !== after.maxFront) return false;
    return (
        Math.abs(before.minLat - after.minLat) === 1 && before.maxLat - before.minLat === after.maxLat - after.minLat
    );
};

const c73Occupy = (board: IBoard, seats: ReadonlyMap<string, XY>, ignore: ReadonlySet<string>): Set<number> => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        const anchor = seats.get(unit.getId()) ?? board.cells.get(unit.getId());
        if (!anchor) continue;
        c73Add(taken, c73Foot(unit, anchor));
    }
    return taken;
};

/** Front of a back-rank caster file is already held, and the ranks between would be the empty middle. */
const c73SharesFront = (board: IBoard, footprint: readonly XY[], occupied: ReadonlySet<number>): boolean => {
    const ranks = ranksOf(board);
    for (const cell of footprint) {
        if (board.geom.frontness(cell) !== ranks.back) continue;
        const front = r3Cell(board, ranks.front, board.geom.lateral(cell));
        if (front && occupied.has(keyOf(front))) return true;
    }
    return false;
};

const c73Ranked = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    scoreOf: (footprint: readonly XY[], anchor: XY) => number | undefined,
): XY[] => {
    const found: { anchor: XY; score: number }[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = c73Foot(unit, anchor);
        if (!r3Legal(footprint, board, taken)) continue;
        const score = scoreOf(footprint, anchor);
        if (score === undefined) continue;
        found.push({ anchor: { x: anchor.x, y: anchor.y }, score });
    }
    found.sort((a, b) => a.score - b.score || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
    return found.map((entry) => entry.anchor);
};

const c73Best = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    scoreOf: (footprint: readonly XY[], anchor: XY) => number | undefined,
): XY | undefined => c73Ranked(board, unit, taken, scoreOf)[0];

/** Same-file back caster, empty ranks between, and a body on the front of that file. */
const c73GapBuilt = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    const ranks = ranksOf(board);
    for (const caster of board.units) {
        if (!c73Caster(caster)) continue;
        const backLats = c73FinalFoot(board, caster, moves)
            .filter((cell) => board.geom.frontness(cell) === ranks.back)
            .map((cell) => board.geom.lateral(cell));
        for (const lat of backLats) {
            let between = false;
            let frontUnit: Unit | undefined;
            const wasBetween: Unit[] = [];
            for (const unit of board.units) {
                if (unit.getId() === caster.getId()) continue;
                const current = board.footprint(unit);
                if (
                    current.some(
                        (cell) =>
                            board.geom.lateral(cell) === lat &&
                            board.geom.frontness(cell) > ranks.back &&
                            board.geom.frontness(cell) < ranks.front,
                    )
                ) {
                    wasBetween.push(unit);
                }
                for (const cell of c73FinalFoot(board, unit, moves)) {
                    if (board.geom.lateral(cell) !== lat) continue;
                    const rank = board.geom.frontness(cell);
                    if (rank > ranks.back && rank < ranks.front) between = true;
                    if (rank === ranks.front) frontUnit = unit;
                }
            }
            if (between || !frontUnit) continue;
            const cleared = wasBetween.some((unit) => c73Changed(board, unit, moves));
            if (c73Changed(board, caster, moves) || c73Changed(board, frontUnit, moves) || cleared) return true;
        }
    }
    return false;
};

/** Three consecutive middle-rank laterals, with a body this pass put on that rank. */
const c73ThreeWide = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    const middle = ranksOf(board).middle;
    const byLat = new Map<number, Unit>();
    for (const unit of board.units) {
        if (unit.canFly() || c73Caster(unit) || c73Fixed(unit) || PROTECTORS.has(unit.getName())) continue;
        if (unit.getAttackType() === RANGE) continue;
        for (const cell of c73FinalFoot(board, unit, moves)) {
            if (board.geom.frontness(cell) !== middle) continue;
            const lat = board.geom.lateral(cell);
            const prior = byLat.get(lat);
            if (!prior || byId(unit, prior) < 0) byLat.set(lat, unit);
        }
    }
    const lats = [...byLat.keys()].sort((a, b) => a - b);
    let run: Unit[] = [];
    let previous = Number.NaN;
    const guilty = (bodies: readonly Unit[]): boolean =>
        bodies.length >= 3 &&
        bodies.some((unit) => {
            const next = moves.get(unit.getId());
            if (!next || !c73Changed(board, unit, moves)) return false;
            return c73Foot(unit, next).some((cell) => board.geom.frontness(cell) === middle);
        });
    for (const lat of lats) {
        const unit = byLat.get(lat);
        if (!unit) continue;
        if (run.length && lat !== previous + 1) {
            if (guilty(run)) return true;
            run = [];
        }
        run.push(unit);
        previous = lat;
    }
    return guilty(run);
};

const c73Behind = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    for (const unit of board.units) {
        if (!c73Screen(unit) || !c73Changed(board, unit, moves)) continue;
        const next = moves.get(unit.getId());
        if (!next) continue;
        const footprint = c73Foot(unit, next);
        const screenFront = Math.max(...footprint.map((cell) => board.geom.frontness(cell)));
        const lats = new Set(c73Lats(footprint, board.geom));
        for (const caster of board.units) {
            if (!c73Caster(caster)) continue;
            const cells = c73FinalFoot(board, caster, moves);
            if (!cells.length) continue;
            const casterFront = Math.min(...cells.map((cell) => board.geom.frontness(cell)));
            if (screenFront >= casterFront) continue;
            if (cells.some((cell) => lats.has(board.geom.lateral(cell)))) return true;
        }
    }
    return false;
};

const c73CornerCaster = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    const front = ranksOf(board).front;
    for (const unit of board.units) {
        if (!c73Caster(unit) || !c73Changed(board, unit, moves)) continue;
        const next = moves.get(unit.getId());
        if (!next) continue;
        if (
            c73Foot(unit, next).some(
                (cell) => board.geom.frontness(cell) === front && c73CornerLat(board, board.geom.lateral(cell)),
            )
        ) {
            return true;
        }
    }
    return false;
};

const c73Forbidden = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean =>
    c73GapBuilt(board, moves) ||
    c73ThreeWide(board, moves) ||
    c73Behind(board, moves) ||
    c73CornerCaster(board, moves) ||
    [...moves.entries()].some(([id, anchor]) => {
        const unit = c73Unit(board, id);
        return !!unit && c73Slides(unit, board, anchor);
    });

const c73Commit = (board: IBoard, moves: ReadonlyMap<string, XY>): boolean => {
    if (c73Forbidden(board, moves)) return false;
    const occupied = new Set<number>();
    for (const unit of board.units) {
        const anchor = c73FinalAnchor(board, unit, moves);
        if (!anchor) continue;
        const footprint = c73Foot(unit, anchor);
        if (!r3Legal(footprint, board, occupied)) return false;
        c73Add(occupied, footprint);
    }
    for (const [id, anchor] of moves) {
        const unit = c73Unit(board, id);
        if (!unit || c73Fixed(unit)) return false;
        const current = board.cells.get(id);
        if (current && sameCell(current, anchor)) continue;
        board.cells.set(id, { x: anchor.x, y: anchor.y });
    }
    return true;
};

/**
 * Seat `seats` and keep `empty` clear. Units already on those cells move to the nearest legal cell.
 * Held and fixed stacks do not move; an overlap with them refuses the plan.
 */
const c73Place = (
    board: IBoard,
    seats: ReadonlyMap<string, XY>,
    empty: ReadonlySet<number>,
    hold: ReadonlySet<string>,
    avoid: ReadonlySet<number>,
): Map<string, XY> | undefined => {
    const held = new Set(hold);
    for (const unit of board.units) {
        if (c73Fixed(unit)) held.add(unit.getId());
    }
    const reserved = new Set<number>(empty);
    for (const [id, anchor] of seats) {
        const unit = c73Unit(board, id);
        if (!unit || held.has(id)) return undefined;
        const footprint = c73Foot(unit, anchor);
        if (!r3Legal(footprint, board, reserved)) return undefined;
        if (footprint.some((cell) => avoid.has(keyOf(cell)) || empty.has(keyOf(cell)))) return undefined;
        c73Add(reserved, footprint);
    }
    const relocators: Unit[] = [];
    const taken = new Set(reserved);
    for (const unit of board.units) {
        if (seats.has(unit.getId()) || !board.cells.has(unit.getId())) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        if (footprint.some((cell) => reserved.has(keyOf(cell)))) {
            if (held.has(unit.getId())) return undefined;
            relocators.push(unit);
            continue;
        }
        c73Add(taken, footprint);
    }
    const moves = new Map<string, XY>();
    for (const [id, anchor] of seats) moves.set(id, { x: anchor.x, y: anchor.y });
    relocators.sort(byId);
    for (const unit of relocators) {
        const current = board.cells.get(unit.getId());
        const spot = c73Best(board, unit, taken, (footprint, anchor) => {
            if (footprint.some((cell) => avoid.has(keyOf(cell)))) return undefined;
            const trial = new Map(moves);
            trial.set(unit.getId(), anchor);
            if (c73Forbidden(board, trial)) return undefined;
            return current ? chebyshev(anchor, current) : 0;
        });
        if (!spot) return undefined;
        moves.set(unit.getId(), spot);
        c73Add(taken, c73Foot(unit, spot));
    }
    for (const key of empty) {
        for (const unit of board.units) {
            const anchor = c73FinalAnchor(board, unit, moves);
            if (anchor && c73Covers(c73Foot(unit, anchor), { x: key >> 4, y: key & 0xf })) return undefined;
        }
    }
    if (c73Forbidden(board, moves)) return undefined;
    return moves;
};

const c73AngelAnchor = (angel: Unit, board: IBoard, blocked: ReadonlySet<number>): XY | undefined => {
    const pair = c73CentrePair(board);
    const low = pair[0];
    const high = pair[1];
    if (low === undefined || high === undefined || high - low !== 1) return undefined;
    const wanted = new Set([low, high]);
    const front = ranksOf(board).front;
    return c73Best(board, angel, blocked, (footprint) => {
        const fronts = footprint.map((cell) => board.geom.frontness(cell));
        if (!fronts.length || Math.max(...fronts) !== front) return undefined;
        const face = new Set(
            footprint.filter((cell) => board.geom.frontness(cell) === front).map((cell) => board.geom.lateral(cell)),
        );
        if (face.size !== wanted.size) return undefined;
        for (const lat of wanted) if (!face.has(lat)) return undefined;
        return 0;
    });
};

/** Area Throw with an Angel: the boulder lands on him, and casters sit just outside that ring. */
const c73AreaAngel = (board: IBoard, angel: Unit): boolean => {
    const ranks = ranksOf(board);
    const blocked = new Set<number>();
    for (const unit of board.units) {
        if (c73Fixed(unit)) c73Add(blocked, board.footprint(unit));
    }
    const angelAnchor = c73AngelAnchor(angel, board, blocked);
    if (!angelAnchor) return false;
    const angelFoot = c73Foot(angel, angelAnchor);
    const ring = c73Ring(angelFoot, board);
    if (ring.some((cell) => blocked.has(keyOf(cell)))) return false;
    const taken = new Set<number>(blocked);
    c73Add(taken, angelFoot);
    for (const cell of ring) taken.add(keyOf(cell));
    const seats = new Map<string, XY>([[angel.getId(), angelAnchor]]);
    for (const caster of board.units.filter(c73Caster).sort(byId)) {
        const current = board.cells.get(caster.getId());
        const spot = c73Best(board, caster, taken, (footprint, anchor) => {
            if (!c73OnRank(footprint, board, ranks.back)) return undefined;
            if (minChebyshev(footprint, angelFoot) !== 2) return undefined;
            return current ? chebyshev(anchor, current) : 0;
        });
        if (!spot) return false;
        seats.set(caster.getId(), spot);
        c73Add(taken, c73Foot(caster, spot));
    }
    const planned = c73Place(board, seats, new Set(ring.map((cell) => keyOf(cell))), new Set(), new Set());
    return planned ? c73Commit(board, planned) : false;
};

/**
 * Area Throw with no Angel. A caster moves only while something stands in its ring, to the nearest
 * back cell whose ring is clear, and those occupants go to the front outside it.
 */
const c73AreaBare = (board: IBoard): boolean => {
    const ranks = ranksOf(board);
    const casters = board.units.filter((unit) => c73Caster(unit) && board.footprint(unit).length > 0).sort(byId);
    const moving = casters.filter((caster) =>
        board.units.some(
            (other) =>
                other.getId() !== caster.getId() &&
                board.footprint(other).length > 0 &&
                minChebyshev(board.footprint(caster), board.footprint(other)) === 1,
        ),
    );
    if (!moving.length) return true;
    const movingIds = new Set(moving.map((unit) => unit.getId()));
    const occupants: Unit[] = [];
    const seen = new Set<string>();
    for (const caster of moving) {
        for (const other of board.units) {
            if (other.getId() === caster.getId() || movingIds.has(other.getId()) || seen.has(other.getId())) continue;
            if (c73Fixed(other) || PROTECTORS.has(other.getName()) || !board.footprint(other).length) continue;
            if (minChebyshev(board.footprint(caster), board.footprint(other)) !== 1) continue;
            seen.add(other.getId());
            occupants.push(other);
        }
    }
    const stayer = new Set<number>();
    for (const unit of board.units) {
        if (movingIds.has(unit.getId()) || seen.has(unit.getId())) continue;
        c73Add(stayer, board.footprint(unit));
    }
    const taken = new Set<number>(stayer);
    const seats = new Map<string, XY>();
    const placed: XY[][] = casters.filter((unit) => !movingIds.has(unit.getId())).map((unit) => board.footprint(unit));
    const centre = new Set(c73CentrePair(board));
    for (const caster of moving) {
        const current = board.cells.get(caster.getId());
        const spot = c73Best(board, caster, taken, (footprint, anchor) => {
            if (!c73OnRank(footprint, board, ranks.back)) return undefined;
            if (c73Ring(footprint, board).some((cell) => taken.has(keyOf(cell)))) return undefined;
            const lats = c73Lats(footprint, board.geom);
            if (placed.some((other) => c73LatGap(lats, c73Lats(other, board.geom)) < 3)) return undefined;
            if (c73SharesFront(board, footprint, stayer)) return undefined;
            return current ? chebyshev(anchor, current) : 0;
        });
        if (!spot) return false;
        seats.set(caster.getId(), spot);
        const footprint = c73Foot(caster, spot);
        placed.push(footprint);
        c73Add(taken, footprint);
        for (const cell of c73Ring(footprint, board)) taken.add(keyOf(cell));
    }
    for (const occupant of occupants.sort(byId)) {
        const current = board.cells.get(occupant.getId());
        const spot = c73Best(board, occupant, taken, (footprint, anchor) => {
            if (!c73OnRank(footprint, board, ranks.front)) return undefined;
            if (placed.some((other) => minChebyshev(footprint, other) < 2)) return undefined;
            if (placed.some((other) => c73LatGap(c73Lats(footprint, board.geom), c73Lats(other, board.geom)) === 0)) {
                return undefined;
            }
            if (footprint.some((cell) => centre.has(board.geom.lateral(cell)))) return undefined;
            if (c73Slides(occupant, board, anchor)) return undefined;
            return current ? chebyshev(anchor, current) : 0;
        });
        if (!spot) return false;
        seats.set(occupant.getId(), spot);
        c73Add(taken, c73Foot(occupant, spot));
    }
    if (c73Forbidden(board, seats)) return false;
    return c73Commit(board, seats);
};

/** Large Caliber splashes the struck cell. Screens step to distance 2; the caster stays. */
const c73Caliber = (board: IBoard): boolean => {
    const ranks = ranksOf(board);
    const casters = board.units.filter((unit) => c73Caster(unit) && board.footprint(unit).length > 0);
    const seats = new Map<string, XY>();
    const screens = board.units.filter((unit) => c73Screen(unit) && board.footprint(unit).length > 0).sort(byId);
    for (const screen of screens) {
        let caster: Unit | undefined;
        for (const candidate of casters) {
            if (minChebyshev(board.footprint(screen), board.footprint(candidate)) !== 1) continue;
            if (!caster || byId(candidate, caster) < 0) caster = candidate;
        }
        if (!caster) continue;
        const casterFoot = board.footprint(caster);
        const casterLats = new Set(c73Lats(casterFoot, board.geom));
        const taken = c73Occupy(board, seats, new Set([screen.getId()]));
        const current = board.cells.get(screen.getId());
        const spot = c73Best(board, screen, taken, (footprint, anchor) => {
            const onFront = footprint.some((cell) => board.geom.frontness(cell) === ranks.front);
            if (!onFront) return undefined;
            if (screen.isSmallSize() && !c73OnRank(footprint, board, ranks.front)) return undefined;
            if (minChebyshev(footprint, casterFoot) !== 2) return undefined;
            if (footprint.some((cell) => casterLats.has(board.geom.lateral(cell)))) return undefined;
            if (c73Slides(screen, board, anchor)) return undefined;
            return current ? chebyshev(anchor, current) : 0;
        });
        if (!spot) continue;
        seats.set(screen.getId(), spot);
    }
    if (!seats.size) return true;
    return c73Commit(board, seats);
};

/** Breath, skewer, or through shot: the cell behind the front body is filled, and the caster steps off that file. */
const c73Line = (board: IBoard): boolean => {
    if (!c73Depth3(board)) return false;
    const ranks = ranksOf(board);
    let best: { caster: Unit; ally: Unit; dist: number } | undefined;
    for (const caster of board.units) {
        if (!c73Caster(caster) || !board.footprint(caster).length) continue;
        for (const ally of board.units) {
            if (ally.getId() === caster.getId() || !board.footprint(ally).length) continue;
            const allyFoot = board.footprint(ally);
            if (!allyFoot.some((cell) => board.geom.frontness(cell) === ranks.front)) continue;
            const dist = minChebyshev(board.footprint(caster), allyFoot);
            if (!best || dist < best.dist) {
                best = { caster, ally, dist };
                continue;
            }
            if (dist !== best.dist) continue;
            if (
                byId(caster, best.caster) < 0 ||
                (caster.getId() === best.caster.getId() && byId(ally, best.ally) < 0)
            ) {
                best = { caster, ally, dist };
            }
        }
    }
    if (!best) return false;
    const { caster, ally } = best;
    const allyFoot = board.footprint(ally);
    const strike = [
        ...new Set(
            allyFoot
                .filter((cell) => board.geom.frontness(cell) === ranks.front)
                .map((cell) => board.geom.lateral(cell)),
        ),
    ].sort((a, b) => a - b);
    const lowStrike = strike[0];
    const highStrike = strike[strike.length - 1];
    if (lowStrike === undefined || highStrike === undefined) return false;
    const past = [lowStrike - 1, highStrike + 1].filter((lat) => lat >= ranks.minLat && lat <= ranks.maxLat);
    const casterLat = medianLat(caster, board);
    past.sort((a, b) => Math.abs(a - casterLat) - Math.abs(b - casterLat) || a - b);
    const middleCell = ally.isSmallSize() ? r3Cell(board, ranks.middle, lowStrike) : undefined;
    const seconds = ally.isSmallSize()
        ? board.units
              .filter(
                  (unit) =>
                      c73Second(unit) &&
                      unit.getId() !== ally.getId() &&
                      unit.getId() !== caster.getId() &&
                      board.cells.has(unit.getId()),
              )
              .sort((a, b) => {
                  const aAnchor = board.cells.get(a.getId());
                  const bAnchor = board.cells.get(b.getId());
                  const aDist = aAnchor && middleCell ? chebyshev(aAnchor, middleCell) : Infinity;
                  const bDist = bAnchor && middleCell ? chebyshev(bAnchor, middleCell) : Infinity;
                  return aDist - bDist || byId(a, b);
              })
        : [];
    const hold = new Set<string>([ally.getId()]);
    const attempt = (second: Unit | undefined, clearBack: boolean): boolean => {
        const seats = new Map<string, XY>();
        const empty = new Set<number>();
        if (clearBack) {
            for (const lat of strike) {
                const back = r3Cell(board, ranks.back, lat);
                if (back) empty.add(keyOf(back));
            }
        }
        const blocked = new Set<number>(empty);
        c73Add(blocked, allyFoot);
        for (const unit of board.units) {
            if (c73Fixed(unit)) c73Add(blocked, board.footprint(unit));
        }
        if (second && middleCell) {
            if (c73Slides(second, board, middleCell)) return false;
            if (!r3Legal(c73Foot(second, middleCell), board, blocked)) return false;
            seats.set(second.getId(), middleCell);
            c73Add(blocked, c73Foot(second, middleCell));
        }
        const fronts = c73Occupy(board, seats, new Set([caster.getId()]));
        let casterAnchor: XY | undefined;
        for (const lat of past) {
            const spot = c73Best(board, caster, blocked, (footprint) => {
                if (!c73OnRank(footprint, board, ranks.back)) return undefined;
                const lats = c73Lats(footprint, board.geom);
                if (c73LatGap(lats, strike) !== 1 || !lats.includes(lat)) return undefined;
                if (c73SharesFront(board, footprint, fronts)) return undefined;
                return 0;
            });
            if (!spot) continue;
            casterAnchor = spot;
            break;
        }
        if (!casterAnchor) return false;
        seats.set(caster.getId(), casterAnchor);
        const planned = c73Place(board, seats, empty, hold, new Set());
        return planned ? c73Commit(board, planned) : false;
    };
    if (ally.isSmallSize()) {
        for (const second of seconds) {
            if (attempt(second, true) || attempt(second, false)) return true;
        }
        return attempt(undefined, true) || attempt(undefined, false);
    }
    return attempt(undefined, false);
};

/** Two enemy flyers: a grounded caster on the inner wing file, its small screen on the landing cell. */
const c73Flyers = (board: IBoard): boolean => {
    if (!c73Depth3(board)) return false;
    const ranks = ranksOf(board);
    const casters = board.units
        .filter((unit) => c73Caster(unit) && !unit.canFly() && board.footprint(unit).length > 0)
        .sort(byId);
    if (!casters.length) return true;
    const wings = [ranks.minLat + 1, ranks.maxLat - 1];
    const centre = new Set(c73CentrePair(board));
    const hold = new Set<string>();
    for (const unit of board.units) {
        if (unit.canFly()) hold.add(unit.getId());
    }
    for (const lat of [ranks.minLat, ranks.maxLat]) {
        const corner = r3Cell(board, ranks.back, lat);
        if (!corner) continue;
        for (const unit of board.units) {
            if (c73Covers(board.footprint(unit), corner)) hold.add(unit.getId());
        }
    }
    const avoid = new Set<number>();
    const seats = new Map<string, XY>();
    const used = new Set<string>();
    let accepted: Map<string, XY> | undefined;
    for (let index = 0; index < Math.min(casters.length, wings.length); index += 1) {
        const lat = wings[index];
        const caster = casters[index];
        if (lat === undefined || !caster || centre.has(lat) || c73CornerLat(board, lat)) continue;
        const back = r3Cell(board, ranks.back, lat);
        const middle = r3Cell(board, ranks.middle, lat);
        if (!back || !middle || hold.has(caster.getId())) continue;
        const screens = board.units
            .filter(
                (unit) => c73Screen(unit) && unit.isSmallSize() && !used.has(unit.getId()) && !hold.has(unit.getId()),
            )
            .sort((a, b) => {
                const aAnchor = board.cells.get(a.getId());
                const bAnchor = board.cells.get(b.getId());
                const aDist = aAnchor ? chebyshev(aAnchor, middle) : Infinity;
                const bDist = bAnchor ? chebyshev(bAnchor, middle) : Infinity;
                return aDist - bDist || byId(a, b);
            });
        for (const screen of screens) {
            if (c73Slides(screen, board, middle)) continue;
            const beside = new Set(avoid);
            for (const side of [lat - 1, lat + 1]) {
                const cell = r3Cell(board, ranks.back, side);
                if (cell) beside.add(keyOf(cell));
            }
            const trial = new Map(seats);
            trial.set(caster.getId(), back);
            trial.set(screen.getId(), middle);
            const planned = c73Place(board, trial, new Set(), hold, beside);
            if (!planned) continue;
            for (const side of [lat - 1, lat + 1]) {
                const cell = r3Cell(board, ranks.back, side);
                if (cell) avoid.add(keyOf(cell));
            }
            seats.set(caster.getId(), back);
            seats.set(screen.getId(), middle);
            used.add(screen.getId());
            accepted = planned;
            break;
        }
    }
    if (!accepted) return true;
    return c73Commit(board, accepted);
};

const c73Exposed = (caster: Unit, bows: readonly Unit[], board: IBoard): boolean => {
    const footprint = board.footprint(caster);
    const lats = new Set(c73Lats(footprint, board.geom));
    return bows.some((bow) => {
        const cells = board.footprint(bow);
        return cells.some((cell) => lats.has(board.geom.lateral(cell))) || minChebyshev(footprint, cells) <= 1;
    });
};

/** Two enemy bows: a caster sharing their file, or touching one, steps to a clear back cell. */
const c73Shooters = (board: IBoard): boolean => {
    const ranks = ranksOf(board);
    const bows = board.units.filter((unit) => unit.getAttackType() === RANGE && board.footprint(unit).length > 0);
    const casters = board.units.filter((unit) => c73Caster(unit) && board.footprint(unit).length > 0).sort(byId);
    const threatened = casters.filter((caster) => c73Exposed(caster, bows, board));
    if (!threatened.length) return true;
    const screens = board.units.filter((unit) => c73Screen(unit) && board.footprint(unit).length > 0);
    const owner = new Map<string, string>();
    for (const screen of screens) {
        let best: Unit | undefined;
        let bestDist = Infinity;
        for (const caster of casters) {
            const dist = minChebyshev(board.footprint(screen), board.footprint(caster));
            if (!best || dist < bestDist || (dist === bestDist && byId(caster, best) < 0)) {
                best = caster;
                bestDist = dist;
            }
        }
        if (best) owner.set(screen.getId(), best.getId());
    }
    const seats = new Map<string, XY>();
    const centre = board.geom.centreLat;
    for (const caster of threatened) {
        const owned = screens
            .filter((unit) => owner.get(unit.getId()) === caster.getId() && !seats.has(unit.getId()))
            .sort(
                (a, b) =>
                    minChebyshev(board.footprint(a), board.footprint(caster)) -
                        minChebyshev(board.footprint(b), board.footprint(caster)) || byId(a, b),
            );
        const screen = owned[0];
        const screenMoves =
            !!screen && !bows.some((bow) => minChebyshev(board.footprint(screen), board.footprint(bow)) === 1);
        const ignore = new Set<string>([caster.getId()]);
        if (screenMoves && screen) ignore.add(screen.getId());
        const taken = c73Occupy(board, seats, ignore);
        const current = board.cells.get(caster.getId());
        const spots = c73Ranked(board, caster, taken, (footprint, anchor) => {
            if (!c73OnRank(footprint, board, ranks.back)) return undefined;
            if (
                footprint.some(
                    (cell) =>
                        board.geom.frontness(cell) === ranks.back && c73CornerLat(board, board.geom.lateral(cell)),
                )
            ) {
                return undefined;
            }
            if (bows.some((bow) => minChebyshev(footprint, board.footprint(bow)) < 2)) return undefined;
            if (
                casters.some(
                    (other) =>
                        other.getId() !== caster.getId() &&
                        minChebyshev(footprint, c73FinalFoot(board, other, seats)) < 2,
                )
            ) {
                return undefined;
            }
            if (c73SharesFront(board, footprint, taken)) return undefined;
            const edge = Math.abs(medianNumber(c73Lats(footprint, board.geom)) - centre);
            return edge * 100 + (current ? chebyshev(anchor, current) : 0);
        });
        for (const spot of spots) {
            const casterFoot = c73Foot(caster, spot);
            if (!screenMoves || !screen) {
                seats.set(caster.getId(), spot);
                break;
            }
            const screenTaken = new Set(taken);
            c73Add(screenTaken, casterFoot);
            const origin = board.cells.get(screen.getId());
            const screenSpot = c73Best(board, screen, screenTaken, (footprint, anchor) => {
                if (!c73OnRank(footprint, board, ranks.front)) return undefined;
                if (c73LatGap(c73Lats(footprint, board.geom), c73Lats(casterFoot, board.geom)) !== 1) return undefined;
                if (minChebyshev(footprint, casterFoot) !== 2) return undefined;
                if (c73Slides(screen, board, anchor)) return undefined;
                return origin ? chebyshev(anchor, origin) : 0;
            });
            if (screenSpot) {
                seats.set(caster.getId(), spot);
                seats.set(screen.getId(), screenSpot);
                break;
            }
            if (!board.footprint(screen).some((cell) => c73Covers(casterFoot, cell))) {
                seats.set(caster.getId(), spot);
                break;
            }
        }
    }
    if (!seats.size) return true;
    return c73Commit(board, seats);
};

/**
 * r7c3 post-pass. Today's placeArmy has already run. An Angel takes the Area Throw boulder, a second
 * body takes the one-cell breath, or a small screen takes the flyer landing. No Placement spend.
 * Ranged stacks, Dryad, Monk, Abomination, and Arachna Queen stay. The first matching branch is the
 * only one. An illegal cell keeps the incumbent.
 */
export function placeArmyR7C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (!board.units.some(c73Caster)) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const original = copyCells(board);
    const angel = board.units
        .filter((unit) => unit.getName() === "Angel" && board.footprint(unit).length > 0)
        .sort(byId)[0];
    let ok = false;
    if (threats.areaThrow) ok = angel ? c73AreaAngel(board, angel) : c73AreaBare(board);
    else if (threats.largeCaliber) ok = c73Caliber(board);
    else if (threats.fireBreath || threats.skewerStrike || threats.throughShot) ok = c73Line(board);
    else if (threats.flyers >= 2 && threats.rangeCreatures < 2) ok = c73Flyers(board);
    else if (
        threats.rangeCreatures >= 2 &&
        threats.flyers < 2 &&
        !threats.fireball &&
        !threats.ringOfFire &&
        !threats.meteorShower
    ) {
        ok = c73Shooters(board);
    }
    if (!ok) restoreCells(board, original);
    return board.cells;
}

interface I81Seat {
    readonly anchor: XY;
    readonly footprint: XY[];
    readonly laterals: number[];
    readonly median: number;
}

const c81Sniper = (unit: Unit): boolean => r3HasAbility(unit, "Sniper");

const c81Reach10Bow = (unit: Unit): boolean => bowReach(unit) === 10 && !c81Sniper(unit);

const c81Line = (threats: IPublicPlacementThreats): boolean =>
    threats.fireBreath || threats.skewerStrike || threats.throughShot;

const c81BlastGap = (threats: IPublicPlacementThreats): number =>
    threats.areaThrow ? 3 : threats.largeCaliber ? 2 : 0;

/** A non-Sniper public shooter whose catalog Sniper-3 reach is 6 or less. */
const c81ShortShooter = (creatureIds: readonly number[] | undefined): boolean => {
    if (!creatureIds?.length) return false;
    for (const creatureId of creatureIds) {
        const info = creatureInfo(creatureId);
        if (!info?.ranged || info.distance <= 0) continue;
        if (hasNamed(CATALOG.get(info.name)?.abilities, "Sniper")) continue;
        if (Math.floor(sniper3Distance(info.distance)) <= 6) return true;
    }
    return false;
};

const c81Guard = (unit: Unit): boolean => {
    if (unit.canFly() || isCharger(unit) || unit.getAttackType() === RANGE) return false;
    const name = unit.getName();
    return name !== "Monk" && name !== "Dryad" && !PROTECTORS.has(name);
};

const c81GroundBody = (unit: Unit): boolean =>
    !unit.canFly() && unit.getAttackType() !== RANGE && !PROTECTORS.has(unit.getName());

const c81LegalFoot = (footprint: readonly XY[], board: IBoard): boolean =>
    footprint.length > 0 && footprint.every((cell) => board.geom.legal.has(keyOf(cell)) && !isBoardEdge(cell));

const c81EntireRank = (footprint: readonly XY[], rank: number, board: IBoard): boolean =>
    c81LegalFoot(footprint, board) && footprint.every((cell) => board.geom.frontness(cell) === rank);

const c81Interior = (laterals: readonly number[], ranks: IRanks): boolean =>
    laterals.every((lat) => lat > ranks.minLat && lat < ranks.maxLat);

const c81LowLats = (laterals: readonly number[], centre: number): boolean => laterals.every((lat) => lat <= centre);

const c81HitsCorner = (unit: Unit, board: IBoard): boolean => {
    const ranks = ranksOf(board);
    return board
        .footprint(unit)
        .some(
            (cell) =>
                board.geom.frontness(cell) === ranks.back &&
                (board.geom.lateral(cell) === ranks.minLat || board.geom.lateral(cell) === ranks.maxLat),
        );
};

const c81Blocked = (board: IBoard): Set<number> => {
    const blocked = new Set<number>();
    for (const unit of board.units) {
        if (!PROTECTORS.has(unit.getName())) continue;
        for (const cell of board.footprint(unit)) blocked.add(keyOf(cell));
    }
    return blocked;
};

const c81HitsKeys = (footprint: readonly XY[], keys: ReadonlySet<number>): boolean =>
    footprint.some((cell) => keys.has(keyOf(cell)));

const c81FileClear = (board: IBoard, laterals: readonly number[], selfId: string): boolean => {
    const mine = new Set(laterals);
    return board.units.every((unit) => unit.getId() === selfId || !board.laterals(unit).some((lat) => mine.has(lat)));
};

const c81Far = (footprint: readonly XY[], board: IBoard, selfId: string, gap: number): boolean =>
    gap <= 0 ||
    board.units.every((unit) => {
        if (unit.getId() === selfId) return true;
        const cells = board.footprint(unit);
        return cells.length === 0 || minChebyshev(footprint, cells) >= gap;
    });

const c81SeatsOn = (unit: Unit, rank: number, board: IBoard, accept: (seat: I81Seat) => boolean): I81Seat[] => {
    const seats: I81Seat[] = [];
    const seen = new Set<number>();
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!c81EntireRank(footprint, rank, board)) continue;
        const key = keyOf(anchor);
        if (seen.has(key)) continue;
        const laterals = footprint.map((cell) => board.geom.lateral(cell));
        const seat: I81Seat = {
            anchor: { x: anchor.x, y: anchor.y },
            footprint,
            laterals,
            median: medianNumber(laterals),
        };
        if (!accept(seat)) continue;
        seen.add(key);
        seats.push(seat);
    }
    return seats;
};

const c81ByCentre = (centre: number, left: I81Seat, right: I81Seat): number =>
    Math.abs(left.median - centre) - Math.abs(right.median - centre) ||
    left.median - right.median ||
    left.anchor.x - right.anchor.x ||
    left.anchor.y - right.anchor.y;

const c81Shift = (
    board: IBoard,
    unit: Unit,
    forbidden: ReadonlySet<number>,
    locked: ReadonlySet<string>,
    gapFrom: readonly (readonly XY[])[],
    gap: number,
    home?: XY,
): boolean => {
    if (locked.has(unit.getId())) return false;
    const origin = home ?? board.cells.get(unit.getId());
    const spots = board.geom.baseCells.filter((anchor) => {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!c81LegalFoot(footprint, board)) return false;
        if (footprint.some((cell) => forbidden.has(keyOf(cell)))) return false;
        if (gap > 0 && gapFrom.some((other) => other.length > 0 && minChebyshev(footprint, other) < gap)) return false;
        return board.free(unit, anchor);
    });
    spots.sort((left, right) => {
        const leftDist = origin ? chebyshev(left, origin) : 0;
        const rightDist = origin ? chebyshev(right, origin) : 0;
        return leftDist - rightDist || left.x - right.x || left.y - right.y;
    });
    const spot = spots[0];
    if (!spot) return false;
    const current = board.cells.get(unit.getId());
    if (current && sameCell(current, spot)) return true;
    return board.place(unit, spot);
};

const c81Commit = (
    board: IBoard,
    seats: readonly { unit: Unit; anchor: XY }[],
    hold: ReadonlySet<string>,
    gap: number,
    gapFrom: readonly (readonly XY[])[],
    gapOwners: ReadonlySet<string>,
): boolean => {
    if (!seats.length) return false;
    const snapshot = copyCells(board);
    const planned: XY[][] = [];
    const reserved = new Set<number>();
    const moverIds = new Set<string>();
    for (const seat of seats) {
        const footprint = footprintCellsForAnchor(seat.unit, seat.anchor);
        if (!c81LegalFoot(footprint, board)) {
            restoreCells(board, snapshot);
            return false;
        }
        planned.push(footprint);
        moverIds.add(seat.unit.getId());
        for (const cell of footprint) reserved.add(keyOf(cell));
    }
    for (const id of moverIds) board.cells.delete(id);
    const locked = new Set<string>(hold);
    for (const unit of board.units) {
        if (PROTECTORS.has(unit.getName()) || moverIds.has(unit.getId())) locked.add(unit.getId());
    }
    const offenders = board.units
        .filter((unit) => {
            if (locked.has(unit.getId()) || moverIds.has(unit.getId())) return false;
            const cells = board.footprint(unit);
            if (!cells.length) return false;
            if (planned.some((footprint) => minChebyshev(cells, footprint) === 0)) return true;
            return gap > 0 && gapFrom.some((footprint) => footprint.length > 0 && minChebyshev(cells, footprint) < gap);
        })
        .sort(byId);
    const homes = new Map<string, XY>();
    for (const unit of offenders) {
        const home = board.cells.get(unit.getId());
        if (home) homes.set(unit.getId(), { x: home.x, y: home.y });
        board.cells.delete(unit.getId());
    }
    const restore = (): boolean => {
        restoreCells(board, snapshot);
        return false;
    };
    for (const unit of offenders) {
        if (!c81Shift(board, unit, reserved, locked, gap > 0 ? gapFrom : [], gap, homes.get(unit.getId()))) {
            return restore();
        }
    }
    for (const seat of seats) {
        if (!board.free(seat.unit, seat.anchor)) return restore();
        board.cells.set(seat.unit.getId(), { x: seat.anchor.x, y: seat.anchor.y });
    }
    if (gap > 0) {
        for (const footprint of gapFrom) {
            for (const unit of board.units) {
                if (gapOwners.has(unit.getId())) continue;
                const cells = board.footprint(unit);
                if (cells.length > 0 && minChebyshev(cells, footprint) < gap) return restore();
            }
        }
    }
    return true;
};

const c81ClearLaterals = (board: IBoard, laterals: ReadonlySet<number>, hold: ReadonlySet<string>): boolean => {
    const shares = (unit: Unit): boolean => board.laterals(unit).some((lat) => laterals.has(lat));
    if (board.units.some((unit) => PROTECTORS.has(unit.getName()) && shares(unit))) return false;
    const snapshot = copyCells(board);
    const forbidden = new Set<number>();
    for (const cell of board.geom.baseCells) {
        if (laterals.has(board.geom.lateral(cell))) forbidden.add(keyOf(cell));
    }
    const offenders = board.units.filter((unit) => !hold.has(unit.getId()) && shares(unit)).sort(byId);
    const homes = new Map<string, XY>();
    for (const unit of offenders) {
        const home = board.cells.get(unit.getId());
        if (home) homes.set(unit.getId(), { x: home.x, y: home.y });
        board.cells.delete(unit.getId());
    }
    for (const unit of offenders) {
        if (!c81Shift(board, unit, forbidden, hold, [], 0, homes.get(unit.getId()))) {
            restoreCells(board, snapshot);
            return false;
        }
    }
    return true;
};

const c81ByReach = (left: Unit, right: Unit): number =>
    bowReach(right) - bowReach(left) || Number(c81Sniper(right)) - Number(c81Sniper(left)) || byId(left, right);

const c81BySeat = (left: Unit, right: Unit): number =>
    Number(c81Sniper(right)) - Number(c81Sniper(left)) || bowReach(right) - bowReach(left) || byId(left, right);

const c81Hold = (board: IBoard, moving: ReadonlySet<string>): Set<string> => {
    const hold = new Set<string>();
    for (const unit of board.units) {
        if (PROTECTORS.has(unit.getName())) hold.add(unit.getId());
        if (unit.getAttackType() === RANGE && !moving.has(unit.getId())) hold.add(unit.getId());
    }
    return hold;
};

const c81PlaceBody = (
    board: IBoard,
    bow: I81Seat,
    otherLats: readonly number[],
    line: boolean,
    used: Set<string>,
): void => {
    const ranks = ranksOf(board);
    const centre = board.geom.centreLat;
    const bowLats = new Set(bow.laterals);
    const banned = new Set<number>([...bowLats, ...otherLats]);
    const bodies = board.units
        .filter((unit) => c81GroundBody(unit) && !used.has(unit.getId()) && board.footprint(unit).length > 0)
        .sort((left, right) => {
            const leftHome = board.cells.get(left.getId());
            const rightHome = board.cells.get(right.getId());
            const leftDist = leftHome ? chebyshev(leftHome, bow.anchor) : 0;
            const rightDist = rightHome ? chebyshev(rightHome, bow.anchor) : 0;
            return leftDist - rightDist || byId(left, right);
        });
    const rank = line ? ranks.middle : ranks.front;
    for (const body of bodies) {
        const options = c81SeatsOn(body, rank, board, (seat) => {
            if (line) {
                if (seat.laterals.some((lat) => banned.has(lat))) return false;
                return lateralDistance(seat.laterals, bow.laterals) === 1;
            }
            const targetLats = new Set(bow.laterals);
            return (
                seat.laterals.every((lat) => targetLats.has(lat)) &&
                seat.footprint.some(
                    (cell) => targetLats.has(board.geom.lateral(cell)) && board.geom.frontness(cell) === rank,
                )
            );
        });
        options.sort((left, right) => {
            if (line) return c81ByCentre(centre, left, right);
            const leftHit = left.footprint.some((cell) => bowLats.has(board.geom.lateral(cell))) ? 0 : 1;
            const rightHit = right.footprint.some((cell) => bowLats.has(board.geom.lateral(cell))) ? 0 : 1;
            return (
                leftHit - rightHit || left.footprint.length - right.footprint.length || c81ByCentre(centre, left, right)
            );
        });
        const hold = c81Hold(board, new Set([body.getId()]));
        for (const id of used) hold.add(id);
        for (const seat of options) {
            if (!c81Commit(board, [{ unit: body, anchor: seat.anchor }], hold, 0, [], new Set())) continue;
            used.add(body.getId());
            return;
        }
    }
};

const c81FlyerPocket = (
    board: IBoard,
    range: readonly Unit[],
    threats: IPublicPlacementThreats,
    exempt: Set<string>,
): boolean => {
    const ranks = ranksOf(board);
    const centre = board.geom.centreLat;
    const blocked = c81Blocked(board);
    const ranked = [...range].sort(c81ByReach);
    const primary = ranked.slice(0, 2);
    const first = primary[0];
    const second = primary[1];
    if (!first || !second) return false;
    const seatOrder = [first, second].sort(c81BySeat);
    const lead = seatOrder[0];
    const follow = seatOrder[1];
    if (!lead || !follow) return false;
    const open = (seat: I81Seat): boolean => c81Interior(seat.laterals, ranks) && !c81HitsKeys(seat.footprint, blocked);
    const leadSeats = c81SeatsOn(lead, ranks.middle, board, open).sort((left, right) =>
        c81ByCentre(centre, left, right),
    );
    const followSeats = c81SeatsOn(follow, ranks.middle, board, open).sort((left, right) =>
        c81ByCentre(centre, left, right),
    );
    const gap = c81BlastGap(threats);
    const extras = ranked.slice(2, 4);
    for (const leadSeat of leadSeats) {
        for (const followSeat of followSeats) {
            if (lateralDistance(leadSeat.laterals, followSeat.laterals) < 4) continue;
            if (minChebyshev(leadSeat.footprint, followSeat.footprint) === 0) continue;
            const pocket = [leadSeat, followSeat];
            const extraSeats: { unit: Unit; seat: I81Seat }[] = [];
            for (const extra of extras) {
                const need = Math.max(2, gap);
                const seat = c81SeatsOn(extra, ranks.back, board, (candidate) => {
                    if (!c81Interior(candidate.laterals, ranks) || c81HitsKeys(candidate.footprint, blocked)) {
                        return false;
                    }
                    if (
                        lateralDistance(
                            candidate.laterals,
                            pocket.flatMap((item) => item.laterals),
                        ) < 3
                    )
                        return false;
                    if (pocket.some((item) => minChebyshev(candidate.footprint, item.footprint) < need)) return false;
                    if (extraSeats.some((item) => minChebyshev(candidate.footprint, item.seat.footprint) < 1)) {
                        return false;
                    }
                    return true;
                }).sort((left, right) => c81ByCentre(centre, left, right))[0];
                if (seat) extraSeats.push({ unit: extra, seat });
            }
            const seated = [
                { unit: lead, anchor: leadSeat.anchor },
                { unit: follow, anchor: followSeat.anchor },
                ...extraSeats.map((item) => ({ unit: item.unit, anchor: item.seat.anchor })),
            ];
            const moving = new Set(seated.map((item) => item.unit.getId()));
            const gapFrom = gap > 0 ? [leadSeat.footprint, followSeat.footprint] : [];
            const gapOwners = new Set(gap > 0 ? [lead.getId(), follow.getId()] : []);
            if (!c81Commit(board, seated, c81Hold(board, moving), gap, gapFrom, gapOwners)) continue;
            if (gap === 0) {
                const used = new Set<string>();
                const byBow = new Map<string, I81Seat>([
                    [lead.getId(), leadSeat],
                    [follow.getId(), followSeat],
                ]);
                const bodyOrder = [lead, follow].sort(c81ByReach);
                const line = c81Line(threats);
                for (const bow of bodyOrder) {
                    const seat = byBow.get(bow.getId());
                    if (!seat) continue;
                    const other = bodyOrder
                        .filter((unit) => unit.getId() !== bow.getId())
                        .flatMap((unit) => {
                            const otherSeat = byBow.get(unit.getId());
                            return otherSeat ? otherSeat.laterals : [];
                        });
                    c81PlaceBody(board, seat, other, line, used);
                }
            }
            for (const id of moving) exempt.add(id);
            return true;
        }
    }
    return false;
};

const c81LowHalf = (
    board: IBoard,
    range: readonly Unit[],
    threats: IPublicPlacementThreats,
    exempt: Set<string>,
): boolean => {
    const ranks = ranksOf(board);
    const centre = board.geom.centreLat;
    const blocked = c81Blocked(board);
    const ordered = [...range].sort(c81ByReach);
    const chosen: { unit: Unit; seat: I81Seat }[] = [];
    let outer: I81Seat | undefined;
    let inner: I81Seat | undefined;
    const separated = (seat: I81Seat): boolean =>
        chosen.every(
            (item) =>
                lateralDistance(seat.laterals, item.seat.laterals) >= 2 &&
                minChebyshev(seat.footprint, item.seat.footprint) >= 2,
        );
    for (const bow of ordered) {
        let seat: I81Seat | undefined;
        if (!outer) {
            const options = c81SeatsOn(
                bow,
                ranks.back,
                board,
                (candidate) =>
                    candidate.laterals.includes(ranks.minLat) &&
                    c81LowLats(candidate.laterals, centre) &&
                    !c81HitsKeys(candidate.footprint, blocked),
            );
            options.sort(
                (left, right) =>
                    Math.max(...left.laterals) - Math.max(...right.laterals) ||
                    left.anchor.x - right.anchor.x ||
                    left.anchor.y - right.anchor.y,
            );
            seat = options[0];
            if (seat) outer = seat;
        } else if (!inner) {
            const outerMax = Math.max(...outer.laterals);
            const outerFoot = outer.footprint;
            const options = c81SeatsOn(bow, ranks.back, board, (candidate) => {
                if (!c81LowLats(candidate.laterals, centre) || c81HitsKeys(candidate.footprint, blocked)) return false;
                if (Math.min(...candidate.laterals) < outerMax + 2) return false;
                return minChebyshev(candidate.footprint, outerFoot) >= 2;
            });
            options.sort(
                (left, right) =>
                    Math.min(...left.laterals) - Math.min(...right.laterals) ||
                    left.anchor.x - right.anchor.x ||
                    left.anchor.y - right.anchor.y,
            );
            seat = options[0];
            if (seat) inner = seat;
        }
        if (!seat) {
            const options = c81SeatsOn(
                bow,
                ranks.middle,
                board,
                (candidate) =>
                    c81LowLats(candidate.laterals, centre) &&
                    !c81HitsKeys(candidate.footprint, blocked) &&
                    separated(candidate),
            );
            options.sort(
                (left, right) =>
                    Math.min(...left.laterals) - Math.min(...right.laterals) ||
                    left.median - right.median ||
                    left.anchor.x - right.anchor.x ||
                    left.anchor.y - right.anchor.y,
            );
            seat = options[0];
        }
        if (!seat) continue;
        chosen.push({ unit: bow, seat });
    }
    if (!chosen.length) return false;
    const original = copyCells(board);
    const moving = new Set(chosen.map((item) => item.unit.getId()));
    const hold = new Set<string>(moving);
    for (const unit of board.units) {
        if (PROTECTORS.has(unit.getName())) hold.add(unit.getId());
    }
    if (
        !c81Commit(
            board,
            chosen.map((item) => ({ unit: item.unit, anchor: item.seat.anchor })),
            hold,
            0,
            [],
            new Set(),
        )
    ) {
        return false;
    }
    if (c81Line(threats)) {
        const laterals = new Set<number>();
        for (const item of chosen) {
            for (const lat of item.seat.laterals) laterals.add(lat);
        }
        if (!c81ClearLaterals(board, laterals, hold)) {
            restoreCells(board, original);
            return false;
        }
    }
    for (const bow of range) exempt.add(bow.getId());
    return true;
};

const c81ReachMiddle = (board: IBoard, range: readonly Unit[], threats: IPublicPlacementThreats): void => {
    const ranks = ranksOf(board);
    const centre = board.geom.centreLat;
    const gap = c81BlastGap(threats);
    const line = c81Line(threats);
    const movers = range
        .filter((bow) => c81Reach10Bow(bow) && onBackRank(bow, board))
        .sort((left, right) => medianLat(left, board) - medianLat(right, board) || byId(left, right));
    const placed: number[][] = [];
    for (const bow of movers) {
        const preferred = medianLat(bow, board);
        const seats = c81SeatsOn(bow, ranks.middle, board, (seat) => {
            if (!c81Interior(seat.laterals, ranks) || !board.free(bow, seat.anchor)) return false;
            return placed.every((laterals) => lateralDistance(seat.laterals, laterals) >= 3);
        });
        seats.sort((left, right) => {
            const prefer = Math.abs(left.median - preferred) - Math.abs(right.median - preferred);
            if (prefer) return prefer;
            return c81ByCentre(centre, left, right);
        });
        const chosen = seats[0];
        if (!chosen) continue;
        if (line && !c81FileClear(board, chosen.laterals, bow.getId())) continue;
        if (gap > 0 && !c81Far(chosen.footprint, board, bow.getId(), gap)) continue;
        const current = board.cells.get(bow.getId());
        if (!current || !sameCell(current, chosen.anchor)) {
            if (!board.place(bow, chosen.anchor)) continue;
        }
        placed.push(chosen.laterals);
    }
};

/** Unmoved bows take a freed back corner. Moved bows and splash spreads stay put. */
const c81Reseat = (board: IBoard, exempt: ReadonlySet<string>): void => {
    const ranks = ranksOf(board);
    const looseIds = new Set(
        board.units
            .filter(
                (unit) =>
                    unit.getAttackType() === RANGE &&
                    !exempt.has(unit.getId()) &&
                    board.footprint(unit).length > 0 &&
                    !c81HitsCorner(unit, board),
            )
            .map((unit) => unit.getId()),
    );
    if (!looseIds.size) return;
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (looseIds.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    for (const bow of board.units) {
        if (!looseIds.has(bow.getId())) continue;
        let seated = false;
        for (const lat of [ranks.minLat, ranks.maxLat]) {
            const seats = c81SeatsOn(
                bow,
                ranks.back,
                board,
                (seat) => seat.laterals.includes(lat) && !c81HitsKeys(seat.footprint, taken),
            );
            seats.sort(
                (left, right) =>
                    left.footprint.length - right.footprint.length ||
                    left.anchor.x - right.anchor.x ||
                    left.anchor.y - right.anchor.y,
            );
            const seat = seats[0];
            if (!seat) continue;
            const current = board.cells.get(bow.getId());
            if (!current || !sameCell(current, seat.anchor)) {
                if (!board.place(bow, seat.anchor)) continue;
            }
            for (const cell of seat.footprint) taken.add(keyOf(cell));
            seated = true;
            break;
        }
        if (!seated) {
            for (const cell of board.footprint(bow)) taken.add(keyOf(cell));
        }
    }
};

const c81CornerFront = (board: IBoard, bows: readonly Unit[]): Set<number> => {
    const ranks = ranksOf(board);
    const banned = new Set<number>();
    for (const bow of bows) {
        if (!c81HitsCorner(bow, board)) continue;
        for (const lat of new Set(board.laterals(bow))) {
            const front = r3Cell(board, ranks.front, lat);
            if (front) banned.add(keyOf(front));
        }
    }
    return banned;
};

const c81AssignGuards = (
    board: IBoard,
    guards: readonly Unit[],
    rank: number,
    accept: (guard: Unit, seat: I81Seat) => boolean,
    prefer: (guard: Unit, seat: I81Seat) => number,
): { unit: Unit; anchor: XY }[] => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const assigned: { unit: Unit; anchor: XY }[] = [];
    for (const guard of guards) {
        const own = board.footprint(guard).map((cell) => keyOf(cell));
        for (const key of own) taken.delete(key);
        const options = c81SeatsOn(
            guard,
            rank,
            board,
            (seat) => accept(guard, seat) && !c81HitsKeys(seat.footprint, taken),
        );
        options.sort(
            (left, right) =>
                prefer(guard, left) - prefer(guard, right) ||
                left.anchor.x - right.anchor.x ||
                left.anchor.y - right.anchor.y,
        );
        const seat = options[0];
        if (!seat) {
            for (const key of own) taken.add(key);
            continue;
        }
        for (const cell of seat.footprint) taken.add(keyOf(cell));
        assigned.push({ unit: guard, anchor: seat.anchor });
    }
    return assigned;
};

const c81ApplyGuards = (board: IBoard, seats: readonly { unit: Unit; anchor: XY }[]): void => {
    if (!seats.length) return;
    const snapshot = copyCells(board);
    for (const seat of seats) board.cells.delete(seat.unit.getId());
    for (const seat of seats) {
        if (
            !c81LegalFoot(footprintCellsForAnchor(seat.unit, seat.anchor), board) ||
            !board.free(seat.unit, seat.anchor)
        ) {
            restoreCells(board, snapshot);
            return;
        }
        board.cells.set(seat.unit.getId(), { x: seat.anchor.x, y: seat.anchor.y });
    }
};

const c81Guards = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const guards = board.units.filter((unit) => c81Guard(unit) && board.footprint(unit).length > 0).sort(byId);
    if (!guards.length) return;
    const bows = placedRange(board.units, board);
    const ranks = ranksOf(board);
    const centre = board.geom.centreLat;
    const bowGap = (footprint: readonly XY[], need: number): boolean =>
        bows.every((bow) => {
            const cells = board.footprint(bow);
            return cells.length === 0 || minChebyshev(footprint, cells) >= need;
        });
    if (threats.areaThrow || threats.largeCaliber) {
        const need = threats.areaThrow ? 3 : 2;
        const close = guards.filter((guard) =>
            bows.some((bow) => minChebyshev(board.footprint(guard), board.footprint(bow)) === 1),
        );
        const seats = c81AssignGuards(
            board,
            close,
            ranks.front,
            (_guard, seat) => bowGap(seat.footprint, need),
            (guard, seat) => {
                const origin = board.cells.get(guard.getId());
                const distance = origin ? chebyshev(seat.anchor, origin) : 0;
                return distance * 1000 + Math.abs(seat.median - centre);
            },
        );
        c81ApplyGuards(board, seats);
        return;
    }
    if (
        threats.rangeCreatures < 2 ||
        threats.flyers > 0 ||
        threats.rapidCharge ||
        c81Line(threats) ||
        threats.areaThrow ||
        threats.largeCaliber
    ) {
        return;
    }
    const banned = c81CornerFront(board, bows);
    const ring = (guard: Unit): boolean =>
        bows.some((bow) => minChebyshev(board.footprint(guard), board.footprint(bow)) <= 1);
    const ordered = [...guards].sort((left, right) => Number(ring(right)) - Number(ring(left)) || byId(left, right));
    const seats = c81AssignGuards(
        board,
        ordered,
        ranks.front,
        (_guard, seat) => !c81HitsKeys(seat.footprint, banned) && bowGap(seat.footprint, 2),
        (_guard, seat) => Math.abs(seat.median - centre) * 1000 + seat.median,
    );
    c81ApplyGuards(board, seats);
};

/**
 * r8c1 post-pass. Today's placeArmy has already run. Flyers open a middle-rank pocket, a charge
 * compacts bows onto the low half, or a non-Sniper reach-10 bow steps off the back rank. The first
 * matching bow branch is the only one. A bow that branch moves is not returned to a corner.
 * Guards never move a bow. Abomination, Angel, and Arachna Queen stay. No Placement spend.
 */
export function placeArmyR8C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const range = placedRange(units, board);
    if (range.length < 2) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const before = copyCells(board);
    const exempt = new Set<string>();
    let flyerRan = false;
    let compactRan = false;
    if (threats.flyers >= 2) {
        flyerRan = true;
        c81FlyerPocket(board, range, threats, exempt);
    } else if (threats.rapidCharge && threats.rangeCreatures < 2 && threats.flyers < 2) {
        if (!threats.areaThrow && !threats.largeCaliber) compactRan = c81LowHalf(board, range, threats, exempt);
    } else if (range.some(c81Reach10Bow) && threats.flyers < 2 && !c81ShortShooter(context.publicOpponentCreatureIds)) {
        for (const bow of range) {
            if (c81Reach10Bow(bow)) exempt.add(bow.getId());
        }
        c81ReachMiddle(board, range, threats);
    }
    if (!threats.areaThrow && !threats.largeCaliber && changedFrom(before, board.cells)) c81Reseat(board, exempt);
    if (!flyerRan && !compactRan) c81Guards(board, threats);
    return board.cells;
}

/** Fire Breath, Skewer Strike, Lightning Spin, or Chakram. Through Shot is not this line. */
const c82Line = (threats: IPublicPlacementThreats): boolean =>
    threats.fireBreath || threats.skewerStrike || threats.lightningSpin || threats.chakram;

const c82Fixed = (unit: Unit): boolean => unit.getAttackType() === RANGE || PROTECTORS.has(unit.getName());

/** Non-flying, non-charger, non-range body. Monk, Dryad, and the named protectors are not screens. */
const c82Screen = (unit: Unit): boolean =>
    !unit.canFly() &&
    !isCharger(unit) &&
    unit.getAttackType() !== RANGE &&
    unit.getName() !== "Monk" &&
    unit.getName() !== "Dryad" &&
    !PROTECTORS.has(unit.getName());

const c82Flyer = (unit: Unit): boolean => unit.canFly() && unit.getAttackType() !== RANGE && !c82Fixed(unit);

const c82Locked = (board: IBoard): Set<string> => {
    const locked = new Set<string>();
    for (const unit of board.units) {
        if (board.cells.has(unit.getId()) && c82Fixed(unit)) locked.add(unit.getId());
    }
    return locked;
};

const c82Placed = (board: IBoard, locked: ReadonlySet<string>, accept: (unit: Unit) => boolean): Unit[] =>
    board.units.filter((unit) => accept(unit) && !locked.has(unit.getId()) && board.cells.has(unit.getId()));

const c82Screens = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    c82Placed(board, locked, c82Screen).sort(c62ByArmor);

const c82Flyers = (board: IBoard, locked: ReadonlySet<string>): Unit[] => c82Placed(board, locked, c82Flyer).sort(byId);

const c82SmallFlyers = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    c82Flyers(board, locked).filter((unit) => unit.isSmallSize());

const c82Chargers = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    c82Placed(board, locked, isCharger).sort(c62BySpeed);

const c82Walkers = (board: IBoard, locked: ReadonlySet<string>): Unit[] =>
    c82Placed(board, locked, (unit) => !unit.canFly() && !c82Fixed(unit)).sort(c62BySpeed);

const c82Files = (board: IBoard): number[] => {
    const ranks = c62Ranks(board);
    const files: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (r3Cell(board, ranks.back, lat) && r3Cell(board, ranks.middle, lat) && r3Cell(board, ranks.front, lat)) {
            files.push(lat);
        }
    }
    return files;
};

const c82Centre = (board: IBoard): number | undefined => {
    const cell = c62CentreCell(board);
    return cell ? board.geom.lateral(cell) : undefined;
};

const c82BowLats = (board: IBoard, locked: ReadonlySet<string>): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId()) || unit.getAttackType() !== RANGE) continue;
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const c82Open = (board: IBoard, locked: ReadonlySet<string>): number[] => {
    const bows = c82BowLats(board, locked);
    return c82Files(board).filter((lat) => !bows.has(lat));
};

/** The outermost non-bow file, and the outermost file on the opposite side of centre. */
const c82Wings = (open: readonly number[], centre: number): { wing?: number; other?: number } => {
    if (!open.length) return {};
    const low = open[0];
    const high = open[open.length - 1];
    if (low === undefined || high === undefined || high === low) return { wing: low };
    const wing = Math.abs(high - centre) > Math.abs(low - centre) ? high : low;
    return { wing, other: wing === low ? high : low };
};

const c82Inward = (open: readonly number[], wing: number, centre: number): number | undefined => {
    const sorted = [...open].sort((a, b) => a - b);
    const index = sorted.indexOf(wing);
    if (index < 0) return undefined;
    return wing <= centre ? sorted[index + 1] : sorted[index - 1];
};

const c82Only =
    (rank: number) =>
    (span: ISpan): boolean =>
        span.minFront === rank && span.maxFront === rank;

const c82Face =
    (rank: number) =>
    (span: ISpan): boolean =>
        span.maxFront === rank;

/** Tail on the back rank, face short of the front, so the cells ahead of the body stay free. */
const c82Rear =
    (back: number, front: number) =>
    (span: ISpan): boolean =>
        span.minFront === back && span.maxFront < front;

const c82Keep = (board: IBoard, locked: ReadonlySet<string>, plan: ReadonlyMap<string, XY>): Set<number> => {
    const keep = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) keep.add(keyOf(cell));
    }
    for (const [id, anchor] of plan) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) keep.add(keyOf(cell));
    }
    return keep;
};

const c82Forbid = (forbidden: Set<number>, keep: ReadonlySet<number>, cell: XY | undefined): void => {
    if (!cell) return;
    const key = keyOf(cell);
    if (keep.has(key)) return;
    forbidden.add(key);
};

const c82Claim = (
    board: IBoard,
    forbidden: Set<number>,
    keep: ReadonlySet<number>,
    laterals: Iterable<number>,
): void => {
    const want = new Set(laterals);
    if (!want.size) return;
    for (const cell of board.geom.baseCells) {
        if (!want.has(board.geom.lateral(cell))) continue;
        c82Forbid(forbidden, keep, cell);
    }
};

const c82CreatesGap = (board: IBoard, taken: ReadonlySet<number>, span: ISpan): boolean => {
    const touched = new Set(span.laterals);
    const occupied = new Map<number, Set<number>>();
    const add = (cell: XY): void => {
        const lat = board.geom.lateral(cell);
        if (!touched.has(lat)) return;
        const ranks = occupied.get(lat) ?? new Set<number>();
        ranks.add(board.geom.frontness(cell));
        occupied.set(lat, ranks);
    };
    for (const key of taken) add(c62CellOf(key));
    for (const cell of span.cells) add(cell);
    for (const ranks of occupied.values()) {
        const values = [...ranks].sort((a, b) => a - b);
        for (let index = 1; index < values.length; index += 1) {
            if (values[index] - values[index - 1] === 2) return true;
        }
    }
    return false;
};

const c82HasGap = (board: IBoard): boolean => {
    const occupied = new Map<number, Set<number>>();
    for (const unit of board.units) {
        for (const cell of board.footprint(unit)) {
            const lat = board.geom.lateral(cell);
            const ranks = occupied.get(lat) ?? new Set<number>();
            ranks.add(board.geom.frontness(cell));
            occupied.set(lat, ranks);
        }
    }
    for (const ranks of occupied.values()) {
        const values = [...ranks].sort((a, b) => a - b);
        for (let index = 1; index < values.length; index += 1) {
            if (values[index] - values[index - 1] === 2) return true;
        }
    }
    return false;
};

const c82Paired = (board: IBoard): boolean => {
    const owner = new Map<number, string>();
    for (const unit of board.units) {
        for (const lat of board.laterals(unit)) {
            const prior = owner.get(lat);
            if (prior !== undefined && prior !== unit.getId()) return true;
            owner.set(lat, unit.getId());
        }
    }
    return false;
};

const c82BadCharger = (board: IBoard, fastest: Unit | undefined): boolean => {
    if (!fastest) return false;
    const centre = c82Centre(board);
    const ranks = c62Ranks(board);
    if (centre === undefined) return false;
    const cells = board.footprint(fastest).filter((cell) => board.geom.lateral(cell) === centre);
    if (!cells.length || cells.some((cell) => board.geom.frontness(cell) !== ranks.back)) return false;
    return !board.units.some((unit) => unit.getId() !== fastest.getId() && board.laterals(unit).includes(centre));
};

const c82Undo = (taken: Set<number>, plan: Map<string, XY>, unit: Unit, span: ISpan): void => {
    plan.delete(unit.getId());
    for (const cell of span.cells) taken.delete(keyOf(cell));
};

const c82Seat = (
    board: IBoard,
    taken: Set<number>,
    plan: Map<string, XY>,
    unit: Unit,
    cell: XY | undefined,
    accept: (span: ISpan) => boolean,
    chakram = false,
    score: (span: ISpan) => number = (span) => span.cells.length,
): ISpan | undefined => {
    if (!cell || plan.has(unit.getId())) return undefined;
    const anchor = c62Pick(
        unit,
        board,
        taken,
        (span) => c62Covers(span, cell) && accept(span) && (!chakram || !c82CreatesGap(board, taken, span)),
        score,
    );
    if (!anchor) return undefined;
    const span = c62Stamp(taken, unit, anchor, board);
    if (!span) return undefined;
    plan.set(unit.getId(), { x: anchor.x, y: anchor.y });
    return span;
};

const c82TooClose = (laterals: readonly number[], used: ReadonlySet<number>, gap: number): boolean =>
    laterals.some((lat) => [...used].some((other) => Math.abs(lat - other) < gap));

const c82Hits = (laterals: readonly number[], blocked: ReadonlySet<number>): boolean =>
    laterals.some((lat) => blocked.has(lat));

const c82BanGaps = (board: IBoard, keep: ReadonlySet<number>, forbidden: Set<number>): void => {
    const occupied = new Map<number, Set<number>>();
    for (const key of keep) {
        const cell = c62CellOf(key);
        const lat = board.geom.lateral(cell);
        const ranks = occupied.get(lat) ?? new Set<number>();
        ranks.add(board.geom.frontness(cell));
        occupied.set(lat, ranks);
    }
    for (const cell of board.geom.baseCells) {
        const key = keyOf(cell);
        if (keep.has(key)) continue;
        const ranks = occupied.get(board.geom.lateral(cell));
        if (!ranks) continue;
        const rank = board.geom.frontness(cell);
        for (const other of ranks) {
            if (Math.abs(other - rank) !== 2) continue;
            const between = Math.min(other, rank) + 1;
            if (!ranks.has(between)) forbidden.add(key);
        }
    }
};

const c82Finish = (
    board: IBoard,
    locked: ReadonlySet<string>,
    plan: Map<string, XY>,
    forbidden: Set<number>,
    fastest: Unit | undefined,
    chakram: boolean,
    singleFile: boolean,
    stay: (unit: Unit, span: ISpan) => boolean = c62Stay,
): boolean => {
    if (!plan.size) return false;
    const keep = c82Keep(board, locked, plan);
    const centre = c82Centre(board);
    const ranks = c62Ranks(board);
    if (centre !== undefined) c82Forbid(forbidden, keep, r3Cell(board, ranks.back, centre));
    if (chakram) c82BanGaps(board, keep, forbidden);
    if (!c62Commit(board, locked, plan, forbidden, stay)) return false;
    if (chakram && c82HasGap(board)) return false;
    if (singleFile && c82Paired(board)) return false;
    if (c82BadCharger(board, fastest)) return false;
    return true;
};

const c82FreeFile = (board: IBoard, taken: ReadonlySet<number>, lat: number): boolean => {
    const ranks = c62Ranks(board);
    const cells = [ranks.back, ranks.middle, ranks.front].map((rank) => r3Cell(board, rank, lat));
    return cells.every((cell) => cell !== undefined && !taken.has(keyOf(cell)));
};

const c82ChargeWing = (board: IBoard, locked: ReadonlySet<string>, threats: IPublicPlacementThreats): boolean => {
    const centre = c82Centre(board);
    const open = c82Open(board, locked);
    if (centre === undefined || !open.length) return false;
    const ranks = c62Ranks(board);
    const { wing, other } = c82Wings(open, centre);
    if (wing === undefined) return false;
    const inward = c82Inward(open, wing, centre);
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const claimed = new Set<number>();
    const screens = c82Screens(board, locked);
    const wingCell = r3Cell(board, ranks.front, wing);
    let wingSpan: ISpan | undefined;
    for (const screen of screens) {
        wingSpan = c82Seat(board, taken, plan, screen, wingCell, c82Only(ranks.front), threats.chakram);
        if (wingSpan) break;
    }
    if (!wingSpan) {
        for (const screen of screens) {
            wingSpan = c82Seat(board, taken, plan, screen, wingCell, c82Face(ranks.front), threats.chakram);
            if (wingSpan) break;
        }
    }
    if (wingSpan) for (const lat of wingSpan.laterals) claimed.add(lat);
    const second =
        c82Chargers(board, locked).find((unit) => !plan.has(unit.getId())) ??
        c82Walkers(board, locked).find((unit) => !plan.has(unit.getId()));
    const wingHeld = wingSpan?.laterals.includes(wing) === true;
    const inwardLat = wingHeld && inward !== undefined && !claimed.has(inward) ? inward : wing;
    const secondSpan = second
        ? c82Seat(
              board,
              taken,
              plan,
              second,
              r3Cell(board, ranks.front, inwardLat),
              c82Face(ranks.front),
              threats.chakram,
          )
        : undefined;
    if (secondSpan) for (const lat of secondSpan.laterals) claimed.add(lat);
    if (!wingSpan && !secondSpan) return false;
    if (other !== undefined && !claimed.has(other)) {
        const extra = screens.find((unit) => !plan.has(unit.getId()));
        const span = extra
            ? c82Seat(
                  board,
                  taken,
                  plan,
                  extra,
                  r3Cell(board, ranks.front, other),
                  c82Only(ranks.front),
                  threats.chakram,
              )
            : undefined;
        if (span) for (const lat of span.laterals) claimed.add(lat);
    }
    const screenLats = new Set<number>();
    for (const [id, anchor] of plan) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!unit || !span || !c82Screen(unit)) continue;
        for (const lat of span.laterals) screenLats.add(lat);
    }
    const flyers = c82Flyers(board, locked);
    if (c82Line(threats)) {
        const seatBeside = (flyer: Unit): boolean => {
            const openLats = c82Files(board).filter((lat) => c82FreeFile(board, taken, lat) && !screenLats.has(lat));
            const ordered = [...openLats].sort((a, b) => {
                const dist = (lat: number): number =>
                    screenLats.size ? Math.min(...[...screenLats].map((file) => Math.abs(lat - file))) : Infinity;
                return dist(a) - dist(b) || a - b;
            });
            for (const lat of ordered) {
                const dist = screenLats.size
                    ? Math.min(...[...screenLats].map((file) => Math.abs(lat - file)))
                    : Infinity;
                if (dist !== 1) continue;
                const span = c82Seat(
                    board,
                    taken,
                    plan,
                    flyer,
                    r3Cell(board, ranks.front, lat),
                    c82Face(ranks.front),
                    threats.chakram,
                );
                if (!span || c82Hits(span.laterals, screenLats)) {
                    if (span) c82Undo(taken, plan, flyer, span);
                    continue;
                }
                for (const file of span.laterals) claimed.add(file);
                return true;
            }
            return false;
        };
        for (const flyer of flyers) {
            if (seatBeside(flyer)) continue;
            const screen = screens.find((unit) => !plan.has(unit.getId()));
            if (!screen) continue;
            for (const lat of c82Files(board)) {
                if (!c82FreeFile(board, taken, lat) || claimed.has(lat)) continue;
                const neighbour = [lat - 1, lat + 1].find(
                    (file) => c82FreeFile(board, taken, file) && !claimed.has(file) && !screenLats.has(file),
                );
                if (neighbour === undefined) continue;
                const span = c82Seat(
                    board,
                    taken,
                    plan,
                    screen,
                    r3Cell(board, ranks.front, lat),
                    c82Only(ranks.front),
                    threats.chakram,
                );
                if (!span) continue;
                for (const file of span.laterals) {
                    claimed.add(file);
                    screenLats.add(file);
                }
                if (seatBeside(flyer)) break;
                c82Undo(taken, plan, screen, span);
                for (const file of span.laterals) {
                    claimed.delete(file);
                    screenLats.delete(file);
                }
            }
        }
    } else if (threats.rangeCreatures > 0) {
        for (const flyer of flyers) {
            for (const lat of screenLats) {
                const middle = r3Cell(board, ranks.middle, lat);
                if (!middle || taken.has(keyOf(middle))) continue;
                const span = c82Seat(
                    board,
                    taken,
                    plan,
                    flyer,
                    r3Cell(board, ranks.back, lat),
                    c82Only(ranks.back),
                    threats.chakram,
                );
                if (!span) continue;
                for (const file of span.laterals) claimed.add(file);
                break;
            }
        }
    } else {
        const backs = [wing, inwardLat].filter((lat): lat is number => lat !== undefined);
        for (const flyer of flyers) {
            for (const lat of backs) {
                const middle = r3Cell(board, ranks.middle, lat);
                if (!middle || taken.has(keyOf(middle))) continue;
                const span = c82Seat(
                    board,
                    taken,
                    plan,
                    flyer,
                    r3Cell(board, ranks.back, lat),
                    c82Only(ranks.back),
                    threats.chakram,
                );
                if (!span) continue;
                for (const file of span.laterals) claimed.add(file);
                break;
            }
        }
    }
    const forbidden = new Set<number>();
    c82Claim(board, forbidden, c82Keep(board, locked, plan), claimed);
    const covered = c82Keep(board, locked, plan);
    const wingFront = r3Cell(board, ranks.front, wing);
    if (!wingFront || !covered.has(keyOf(wingFront))) return false;
    return c82Finish(board, locked, plan, forbidden, c82Chargers(board, locked)[0], threats.chakram, false);
};

const c82Reserve = (open: readonly number[]): number | undefined =>
    open.length > 1 ? open[open.length - 1] : undefined;

const c82Shadows = (
    board: IBoard,
    locked: ReadonlySet<string>,
    taken: Set<number>,
    plan: Map<string, XY>,
    flyers: readonly Unit[],
    depth: "flyerBack" | "flyerFront",
    reserved: ReadonlySet<number>,
    chakram: boolean,
): Set<number> => {
    const ranks = c62Ranks(board);
    const open = c82Open(board, locked);
    const screens = c82Screens(board, locked);
    const used = new Set<number>();
    for (const flyer of flyers) {
        if (plan.has(flyer.getId())) continue;
        for (const lat of open) {
            if (reserved.has(lat) || c82TooClose([lat], used, 2)) continue;
            const screenRank = depth === "flyerBack" ? ranks.front : ranks.back;
            const flyerRank = depth === "flyerBack" ? ranks.back : ranks.front;
            let screenSpan: ISpan | undefined;
            let screen: Unit | undefined;
            for (const candidate of screens) {
                if (plan.has(candidate.getId())) continue;
                const span = c82Seat(
                    board,
                    taken,
                    plan,
                    candidate,
                    r3Cell(board, screenRank, lat),
                    c82Only(screenRank),
                    chakram,
                );
                if (!span) continue;
                if (c82Hits(span.laterals, reserved) || c82TooClose(span.laterals, used, 2)) {
                    c82Undo(taken, plan, candidate, span);
                    continue;
                }
                screenSpan = span;
                screen = candidate;
                break;
            }
            if (!screenSpan || !screen) continue;
            const flyerSpan = c82Seat(
                board,
                taken,
                plan,
                flyer,
                r3Cell(board, flyerRank, lat),
                (span) =>
                    c82Only(flyerRank)(span) && span.laterals.every((file) => screenSpan?.laterals.includes(file)),
                chakram,
            );
            if (!flyerSpan) {
                c82Undo(taken, plan, screen, screenSpan);
                continue;
            }
            for (const file of screenSpan.laterals) used.add(file);
            for (const file of flyerSpan.laterals) used.add(file);
            break;
        }
    }
    return used;
};

const c82SeatOuterCharger = (
    board: IBoard,
    locked: ReadonlySet<string>,
    taken: Set<number>,
    plan: Map<string, XY>,
    where: "front" | "back",
    reserved: number | undefined,
    blocked: ReadonlySet<number>,
    chakram: boolean,
): Set<number> => {
    const fastest = c82Chargers(board, locked)[0];
    const claimed = new Set<number>();
    if (!fastest || plan.has(fastest.getId())) return claimed;
    const centre = c82Centre(board);
    const ranks = c62Ranks(board);
    const open = c82Open(board, locked).filter((lat) => lat !== centre && !blocked.has(lat));
    const ordered = [...open].sort(
        (a, b) =>
            Number(b === reserved) - Number(a === reserved) ||
            Math.abs(b - (centre ?? 0)) - Math.abs(a - (centre ?? 0)) ||
            a - b,
    );
    const accept = where === "front" ? c82Face(ranks.front) : c82Rear(ranks.back, ranks.front);
    const rank = where === "front" ? ranks.front : ranks.back;
    for (const lat of ordered) {
        const span = c82Seat(board, taken, plan, fastest, r3Cell(board, rank, lat), accept, chakram);
        if (!span || (centre !== undefined && c82Hits(span.laterals, new Set([centre])))) {
            if (span) c82Undo(taken, plan, fastest, span);
            continue;
        }
        for (const file of span.laterals) claimed.add(file);
        break;
    }
    return claimed;
};

const c82OffLine = (
    board: IBoard,
    locked: ReadonlySet<string>,
    chakram: boolean,
    depth: "flyerBack" | "flyerFront",
    face: "front" | "back",
): boolean => {
    const small = c82SmallFlyers(board, locked);
    if (!small.length) return false;
    const open = c82Open(board, locked);
    const reservedLat = c82Reserve(open);
    const reserved = new Set<number>(reservedLat === undefined ? [] : [reservedLat]);
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const used = chakram
        ? c82ChakramPairs(board, locked, taken, plan, small, reserved)
        : c82Shadows(board, locked, taken, plan, small, depth, reserved, false);
    if (!used.size) return false;
    // A shooter shadow puts the charger on the back of an outer file. A line shadow, a chakram
    // offset, and a swapped flyer-front shadow put it on the front of the opposite wing.
    const charger = c82SeatOuterCharger(board, locked, taken, plan, face, reservedLat, used, chakram);
    const forbidden = new Set<number>();
    const claimed = new Set<number>([...used, ...charger]);
    c82Claim(board, forbidden, c82Keep(board, locked, plan), claimed);
    const boxed = c82Boxer(board, plan, small);
    const stay = (unit: Unit, span: ISpan): boolean =>
        !c82Screen(unit) || span.cells.every((cell) => !boxed.has(keyOf(cell)));
    return c82Finish(board, locked, plan, forbidden, c82Chargers(board, locked)[0], chakram, false, stay);
};

const c82ChakramPairs = (
    board: IBoard,
    locked: ReadonlySet<string>,
    taken: Set<number>,
    plan: Map<string, XY>,
    flyers: readonly Unit[],
    reserved: ReadonlySet<number>,
): Set<number> => {
    const ranks = c62Ranks(board);
    const open = c82Files(board);
    const screens = c82Screens(board, locked);
    const used = new Set<number>();
    for (const flyer of flyers) {
        if (plan.has(flyer.getId())) continue;
        let placed = false;
        for (const lat of open) {
            if (reserved.has(lat) || !c82FreeFile(board, taken, lat) || c82TooClose([lat], used, 2)) continue;
            const neighbour = [lat - 1, lat + 1].find(
                (file) =>
                    !reserved.has(file) &&
                    c82FreeFile(board, taken, file) &&
                    !c82TooClose([file], used, 2) &&
                    r3Cell(board, ranks.front, file) !== undefined,
            );
            if (neighbour === undefined) continue;
            const screen = screens.find((unit) => !plan.has(unit.getId()));
            if (!screen) break;
            const screenSpan = c82Seat(
                board,
                taken,
                plan,
                screen,
                r3Cell(board, ranks.front, lat),
                c82Only(ranks.front),
                true,
            );
            if (!screenSpan) continue;
            const flyerSpan = c82Seat(
                board,
                taken,
                plan,
                flyer,
                r3Cell(board, ranks.front, neighbour),
                c82Only(ranks.front),
                true,
            );
            if (!flyerSpan) {
                c82Undo(taken, plan, screen, screenSpan);
                continue;
            }
            for (const file of [...screenSpan.laterals, ...flyerSpan.laterals]) used.add(file);
            placed = true;
            break;
        }
        if (!placed) continue;
    }
    return used;
};

const c82Boxer = (board: IBoard, plan: ReadonlyMap<string, XY>, flyers: readonly Unit[]): Set<number> => {
    const allowed = c82Keep(board, new Set(), plan);
    const boxed = new Set<number>();
    for (const flyer of flyers) {
        const anchor = plan.get(flyer.getId());
        const span = anchor ? spanAt(flyer, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of board.geom.baseCells) {
            if (!span.cells.some((entry) => chebyshev(entry, cell) <= 1)) continue;
            const key = keyOf(cell);
            if (!allowed.has(key)) boxed.add(key);
        }
    }
    return boxed;
};

const c82LineFront = (board: IBoard, locked: ReadonlySet<string>, chakram: boolean): boolean => {
    const centre = c82Centre(board);
    const lockedLats = new Set<number>();
    for (const unit of board.units) {
        if (!locked.has(unit.getId())) continue;
        for (const lat of board.laterals(unit)) lockedLats.add(lat);
    }
    const open = c82Open(board, locked).filter((lat) => !lockedLats.has(lat));
    if (centre === undefined || !open.length) return false;
    const ranks = c62Ranks(board);
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const used = new Set<number>();
    for (const screen of c82Screens(board, locked)) {
        for (const lat of open) {
            if (c82TooClose([lat], used, 2)) continue;
            const strict = c82Seat(
                board,
                taken,
                plan,
                screen,
                r3Cell(board, ranks.front, lat),
                c82Only(ranks.front),
                chakram,
            );
            const span =
                strict ??
                c82Seat(board, taken, plan, screen, r3Cell(board, ranks.front, lat), c82Face(ranks.front), chakram);
            if (!span || c82TooClose(span.laterals, used, 2) || c82Hits(span.laterals, lockedLats)) {
                if (span) c82Undo(taken, plan, screen, span);
                continue;
            }
            for (const file of span.laterals) used.add(file);
            break;
        }
    }
    const fastest = c82Chargers(board, locked)[0];
    if (fastest && !plan.has(fastest.getId())) {
        const files = [...open].sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre) || a - b);
        for (const lat of files) {
            if (lat === centre || used.has(lat)) continue;
            const span = c82Seat(
                board,
                taken,
                plan,
                fastest,
                r3Cell(board, ranks.back, lat),
                c82Rear(ranks.back, ranks.front),
                chakram,
            );
            if (!span || c82Hits(span.laterals, new Set([centre])) || c82Hits(span.laterals, lockedLats)) {
                if (span) c82Undo(taken, plan, fastest, span);
                continue;
            }
            for (const file of span.laterals) used.add(file);
            break;
        }
    }
    for (const unit of c82Placed(board, locked, (candidate) => !c82Fixed(candidate))) {
        if (plan.has(unit.getId())) continue;
        for (const lat of open) {
            if (used.has(lat)) continue;
            const span = c82Seat(
                board,
                taken,
                plan,
                unit,
                r3Cell(board, ranks.front, lat),
                c82Face(ranks.front),
                chakram,
            );
            if (!span || c82Hits(span.laterals, used) || c82Hits(span.laterals, lockedLats)) {
                if (span) c82Undo(taken, plan, unit, span);
                continue;
            }
            for (const file of span.laterals) used.add(file);
            break;
        }
    }
    if (!plan.size) return false;
    const forbidden = new Set<number>();
    const keep = c82Keep(board, locked, plan);
    c82Claim(board, forbidden, keep, used);
    c82Claim(board, forbidden, keep, lockedLats);
    return c82Finish(board, locked, plan, forbidden, fastest, chakram, true);
};

const c82ShotCup = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const centre = c82Centre(board);
    const ranks = c62Ranks(board);
    if (centre === undefined) return false;
    const middle = r3Cell(board, ranks.middle, centre);
    const front = r3Cell(board, ranks.front, centre);
    const back = r3Cell(board, ranks.back, centre);
    if (!middle || !front || !back) return false;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const chargers = c82Chargers(board, locked);
    const fastest = chargers[0];
    if (fastest) {
        const span = c82Seat(
            board,
            taken,
            plan,
            fastest,
            middle,
            (seat) => seat.minFront >= ranks.middle && !c62Covers(seat, back),
            false,
            (seat) => (c62Covers(seat, front) ? 1000 : 0) + seat.cells.length,
        );
        if (!span) return false;
    }
    const small = c82Screens(board, locked).filter((unit) => unit.isSmallSize() && !plan.has(unit.getId()));
    const sideLow = r3Cell(board, ranks.middle, centre - 1);
    const sideHigh = r3Cell(board, ranks.middle, centre + 1);
    for (const cell of [front, sideLow, sideHigh]) {
        const screen = small.find((unit) => !plan.has(unit.getId()));
        if (!screen || !cell) continue;
        c82Seat(board, taken, plan, screen, cell, c82Only(board.geom.frontness(cell)));
    }
    const blocked = new Set<number>([centre]);
    for (const [id, anchor] of plan) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (span) for (const lat of span.laterals) blocked.add(lat);
    }
    const claimed = new Set<number>();
    for (const charger of chargers.slice(1)) {
        const files = c82Open(board, locked)
            .filter((lat) => !blocked.has(lat) && lat !== centre)
            .sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre) || a - b);
        for (const lat of files) {
            const span = c82Seat(
                board,
                taken,
                plan,
                charger,
                r3Cell(board, ranks.back, lat),
                c82Rear(ranks.back, ranks.front),
            );
            if (!span || c82Hits(span.laterals, blocked) || c82Hits(span.laterals, new Set([centre]))) {
                if (span) c82Undo(taken, plan, charger, span);
                continue;
            }
            for (const file of span.laterals) {
                blocked.add(file);
                claimed.add(file);
            }
            break;
        }
    }
    if (!plan.size) return false;
    const forbidden = new Set<number>();
    const keep = c82Keep(board, locked, plan);
    c82Forbid(forbidden, keep, back);
    const corners = [c82Files(board)[0], c82Files(board)[c82Files(board).length - 1]];
    for (const lat of corners)
        c82Forbid(forbidden, keep, lat === undefined ? undefined : r3Cell(board, ranks.front, lat));
    const cupLats = new Set<number>(claimed);
    for (const [id, anchor] of plan) {
        const body = board.units.find((candidate) => candidate.getId() === id);
        const span = body ? spanAt(body, anchor, board.geom) : undefined;
        if (span) for (const lat of span.laterals) cupLats.add(lat);
    }
    c82Claim(board, forbidden, keep, cupLats);
    return c82Finish(board, locked, plan, forbidden, fastest, false, false);
};

const c82InvertCup = (board: IBoard, locked: ReadonlySet<string>): boolean => {
    const centre = c82Centre(board);
    const ranks = c62Ranks(board);
    if (centre === undefined) return false;
    const middle = r3Cell(board, ranks.middle, centre);
    const front = r3Cell(board, ranks.front, centre);
    const back = r3Cell(board, ranks.back, centre);
    if (!middle || !front || !back) return false;
    const taken = c62Taken(board, locked, new Map());
    const plan = new Map<string, XY>();
    const screens = c82Screens(board, locked);
    let backSpan: ISpan | undefined;
    for (const screen of screens) {
        backSpan = c82Seat(
            board,
            taken,
            plan,
            screen,
            back,
            (span) => c82Only(ranks.back)(span) && span.laterals.every((lat) => lat === centre),
        );
        if (backSpan) break;
    }
    if (!backSpan) {
        for (const screen of screens) {
            if (plan.has(screen.getId())) continue;
            backSpan = c82Seat(board, taken, plan, screen, back, c82Only(ranks.back));
            if (backSpan) break;
        }
    }
    if (!backSpan) return false;
    const small = screens.filter((unit) => unit.isSmallSize());
    for (const lat of [centre - 1, centre + 1]) {
        const screen = small.find((unit) => !plan.has(unit.getId()));
        if (!screen) break;
        c82Seat(board, taken, plan, screen, r3Cell(board, ranks.middle, lat), c82Only(ranks.middle));
    }
    const cup = new Set<number>([centre - 1, centre, centre + 1]);
    const corners = new Set<number>();
    const files = c82Files(board);
    if (files[0] !== undefined) corners.add(keyOf(r3Cell(board, ranks.front, files[0]) ?? { x: -1, y: -1 }));
    if (files.length) {
        const last = files[files.length - 1];
        if (last !== undefined) corners.add(keyOf(r3Cell(board, ranks.front, last) ?? { x: -1, y: -1 }));
    }
    for (const key of [keyOf(middle), keyOf(front), ...corners]) taken.add(key);
    const fastest = c82Chargers(board, locked)[0];
    const chargerLats = new Set<number>();
    if (fastest) {
        for (const lat of [centre - 2, centre + 2]) {
            const span = c82Seat(board, taken, plan, fastest, r3Cell(board, ranks.front, lat), c82Face(ranks.front));
            if (!span || c82Hits(span.laterals, cup)) {
                if (span) c82Undo(taken, plan, fastest, span);
                continue;
            }
            for (const file of span.laterals) chargerLats.add(file);
            break;
        }
    }
    const flyerLats = new Set<number>();
    const candidates = c82Open(board, locked)
        .filter((lat) => Math.abs(lat - centre) >= 3 && !chargerLats.has(lat))
        .sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);
    for (const flyer of c82Flyers(board, locked)) {
        for (const lat of candidates) {
            if (flyerLats.has(lat)) continue;
            const strict = c82Seat(board, taken, plan, flyer, r3Cell(board, ranks.back, lat), c82Only(ranks.back));
            const span =
                strict ??
                c82Seat(board, taken, plan, flyer, r3Cell(board, ranks.back, lat), c82Rear(ranks.back, ranks.front));
            if (!span || c82Hits(span.laterals, cup) || c82Hits(span.laterals, chargerLats)) {
                if (span) c82Undo(taken, plan, flyer, span);
                continue;
            }
            for (const file of span.laterals) flyerLats.add(file);
            break;
        }
    }
    const forbidden = new Set<number>();
    const keep = c82Keep(board, locked, plan);
    c82Forbid(forbidden, keep, middle);
    c82Forbid(forbidden, keep, front);
    for (const key of corners) c82Forbid(forbidden, keep, c62CellOf(key));
    c82Claim(board, forbidden, keep, chargerLats);
    c82Claim(board, forbidden, keep, flyerLats);
    return c82Finish(board, locked, plan, forbidden, fastest, false, false);
};

/**
 * r8c2 post-pass. Today's placeArmy has already run. A charge threat fills the wing, a line or a
 * shooter shadow keeps the cell between a screen and a small flyer empty, and the other public
 * rosters build an empty-back or inverted cup. Area Throw, Large Caliber, and Through Shot leave
 * the map alone. The first branch that matches is the only one. The zone stays.
 */
export function placeArmyR8C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber || threats.throughShot) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const original = copyCells(board);
    const locked = c82Locked(board);
    const keep = (): Map<string, XY> => {
        restoreCells(board, original);
        return board.cells;
    };
    const line = c82Line(threats);
    const shooters = threats.rangeCreatures > 0;
    const enemyFlyers = threats.flyers > 0;
    const small = c82SmallFlyers(board, locked);
    if (threats.rapidCharge) return c82ChargeWing(board, locked, threats) ? board.cells : keep();
    if (line && enemyFlyers && small.length > 0) {
        return c82OffLine(board, locked, threats.chakram, "flyerBack", "front") ? board.cells : keep();
    }
    if (line && !enemyFlyers) return c82LineFront(board, locked, threats.chakram) ? board.cells : keep();
    if (!line && shooters && small.length > 0) {
        return c82OffLine(board, locked, false, "flyerBack", "back") ? board.cells : keep();
    }
    if (!line && shooters) return c82ShotCup(board, locked) ? board.cells : keep();
    if (!line && !shooters && enemyFlyers && small.length > 0) {
        return c82OffLine(board, locked, false, "flyerFront", "front") ? board.cells : keep();
    }
    if (!line && !shooters && enemyFlyers) return c82InvertCup(board, locked) ? board.cells : keep();
    return board.cells;
}

const C83_BUFFER_NAMES = new Set(["Healer", "Satyr", "Ogre Mage"]);
const C83_DAMAGE_SPELLS = new Set([
    "Fire Strike",
    "Fireball",
    "Ring of Fire",
    "Meteor Shower",
    "Meteorite",
    "Lightning Strike",
]);
const C83_LOCK_NAMES = new Set(["Monk", "Dryad", "Blacksmith", "Angel", "Abomination", "Arachna Queen"]);
const C83_NOT_SCREEN = new Set(["Monk", "Dryad", "Abomination", "Angel", "Arachna Queen"]);

const c83At = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c83Unit = (board: IBoard, id: string): Unit | undefined => board.units.find((unit) => unit.getId() === id);

const c83Locked = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE || isCharger(unit) || C83_LOCK_NAMES.has(unit.getName());

const c83AllyBuff = (spell: { isBuff(): boolean; getSpellTargetType(): SpellTargetType }): boolean => {
    if (!spell.isBuff()) return false;
    const target = spell.getSpellTargetType();
    return (
        target === SpellTargetType.ANY_ALLY ||
        target === SpellTargetType.ALL_ALLIES ||
        target === SpellTargetType.ALLIES_AREA
    );
};

const c83DamageSpell = (unit: Unit): boolean =>
    unit.getSpells().some((spell) => C83_DAMAGE_SPELLS.has(spell.getName()));

/** Non-range caster whose usable spells are only ally or mass buffs, plus Healer, Satyr, and Ogre Mage. */
const c83IsBuffer = (unit: Unit): boolean => {
    if (unit.getAttackType() === RANGE || c83DamageSpell(unit)) return false;
    if (C83_BUFFER_NAMES.has(unit.getName())) return isCasterUnit(unit) || unit.getSpells().length > 0;
    if (!isCasterUnit(unit)) return false;
    const usable = unit.getSpells().filter((spell) => isSpellUsableByCaster(unit, spell));
    return usable.length > 0 && usable.every(c83AllyBuff);
};

const c83IsDamageCaster = (unit: Unit): boolean => isCasterUnit(unit) && !c83IsBuffer(unit);

const c83GroundCaster = (unit: Unit): boolean => isCasterUnit(unit) && !unit.canFly() && !c83Locked(unit);

/** Non-flying, non-charger, non-range body. Casters stay out of the screen role so a branch can hold them. */
const c83IsScreen = (unit: Unit): boolean =>
    !unit.canFly() &&
    !isCharger(unit) &&
    unit.getAttackType() !== RANGE &&
    !C83_NOT_SCREEN.has(unit.getName()) &&
    !isCasterUnit(unit) &&
    !c83IsBuffer(unit);

const c83Immovable = (unit: Unit, hold: ReadonlySet<string>): boolean => c83Locked(unit) || hold.has(unit.getId());

const c83Placed = (board: IBoard, accept: (unit: Unit) => boolean): Unit[] =>
    board.units.filter((unit) => accept(unit) && board.cells.has(unit.getId())).sort(byId);

const c83Screens = (board: IBoard, smallOnly: boolean): Unit[] =>
    c83Placed(board, (unit) => c83IsScreen(unit) && !c83Locked(unit) && (!smallOnly || unit.isSmallSize()));

const c83Casters = (board: IBoard): Unit[] =>
    c83Placed(board, c83GroundCaster).sort(
        (a, b) => Number(onBackRank(b, board)) - Number(onBackRank(a, board)) || byId(a, b),
    );

const c83AnchorLat = (board: IBoard, unit: Unit): number => {
    const anchor = board.cells.get(unit.getId());
    return anchor ? board.geom.lateral(anchor) : medianLat(unit, board);
};

const c83CornerKeys = (board: IBoard): Set<number> => {
    const back = ranksOf(board).back;
    const cells = board.geom.baseCells.filter((cell) => board.geom.frontness(cell) === back);
    if (!cells.length) return new Set();
    let min = Infinity;
    let max = -Infinity;
    for (const cell of cells) {
        const lat = board.geom.lateral(cell);
        min = Math.min(min, lat);
        max = Math.max(max, lat);
    }
    const keys = new Set<number>();
    for (const cell of cells) {
        const lat = board.geom.lateral(cell);
        if (lat === min || lat === max) keys.add(keyOf(cell));
    }
    return keys;
};

const c83CapKeys = (board: IBoard): Set<number> => {
    const front = ranksOf(board).front;
    const cells = board.geom.baseCells.filter((cell) => board.geom.frontness(cell) === front);
    cells.sort(
        (a, b) =>
            Math.abs(board.geom.lateral(a) - board.geom.centreLat) -
                Math.abs(board.geom.lateral(b) - board.geom.centreLat) ||
            board.geom.lateral(a) - board.geom.lateral(b) ||
            a.x - b.x ||
            a.y - b.y,
    );
    return new Set(cells.slice(0, 3).map((cell) => keyOf(cell)));
};

const c83Separated = (footprint: readonly XY[], board: IBoard, ignore: ReadonlySet<string>, gap: number): boolean => {
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        const other = board.footprint(unit);
        if (other.length && minChebyshev(footprint, other) < gap) return false;
    }
    return footprint.length > 0;
};

const c83Occupant = (board: IBoard, cell: XY, ignore?: ReadonlySet<string>): Unit | undefined => {
    let found: Unit | undefined;
    for (const unit of board.units) {
        if (ignore?.has(unit.getId())) continue;
        if (!board.footprint(unit).some((entry) => sameCell(entry, cell))) continue;
        if (!found || byId(unit, found) < 0) found = unit;
    }
    return found;
};

const c83Nearest = (units: readonly Unit[], board: IBoard, target: XY): Unit | undefined => {
    let best: Unit | undefined;
    let bestDist = Infinity;
    for (const unit of units) {
        const anchor = board.cells.get(unit.getId());
        if (!anchor) continue;
        const dist = chebyshev(anchor, target);
        if (!best || dist < bestDist || (dist === bestDist && byId(unit, best) < 0)) {
            best = unit;
            bestDist = dist;
        }
    }
    return best;
};

const c83Anchors = (board: IBoard, unit: Unit, allow: (footprint: readonly XY[], anchor: XY) => boolean): XY[] => {
    const current = board.cells.get(unit.getId());
    const found: { anchor: XY; dist: number }[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!allow(footprint, anchor)) continue;
        found.push({ anchor: c83At(anchor), dist: current ? chebyshev(anchor, current) : 0 });
    }
    found.sort((a, b) => a.dist - b.dist || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
    return found.map((entry) => entry.anchor);
};

const c83TouchesDamage = (board: IBoard, unit: Unit): boolean =>
    board.units.some((other) => {
        if (other.getId() === unit.getId() || !c83IsDamageCaster(other)) return false;
        const left = board.footprint(unit);
        const right = board.footprint(other);
        return left.length > 0 && right.length > 0 && minChebyshev(left, right) <= 1;
    });

const c83Blockers = (board: IBoard, fixed: ReadonlyMap<string, XY>, hold: ReadonlySet<string>): Unit[] | undefined => {
    const blockers: Unit[] = [];
    const seen = new Set<string>();
    for (const [id, anchor] of fixed) {
        const mover = c83Unit(board, id);
        if (!mover) return undefined;
        const footprint = footprintCellsForAnchor(mover, anchor);
        for (const other of board.units) {
            if (other.getId() === id || fixed.has(other.getId()) || seen.has(other.getId())) continue;
            const cells = board.footprint(other);
            if (!cells.length || minChebyshev(footprint, cells) > 0) continue;
            if (c83Immovable(other, hold)) return undefined;
            seen.add(other.getId());
            blockers.push(other);
        }
    }
    return blockers;
};

const c83Relocate = (
    board: IBoard,
    fixed: ReadonlyMap<string, XY>,
    movers: readonly Unit[],
    allow: (unit: Unit, footprint: readonly XY[], anchor: XY) => boolean,
): Map<string, XY> | undefined => {
    const placements = new Map<string, XY>();
    const taken = new Set<number>();
    const reserved = new Set<string>([...fixed.keys(), ...movers.map((unit) => unit.getId())]);
    for (const unit of board.units) {
        if (reserved.has(unit.getId())) continue;
        const anchor = board.cells.get(unit.getId());
        if (!anchor) continue;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) return undefined;
        for (const cell of footprint) taken.add(keyOf(cell));
    }
    for (const [id, anchor] of fixed) {
        const unit = c83Unit(board, id);
        if (!unit || c83Locked(unit)) return undefined;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!r3Legal(footprint, board, taken)) return undefined;
        for (const cell of footprint) taken.add(keyOf(cell));
        placements.set(id, c83At(anchor));
    }
    const ordered = [...movers].sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b));
    for (const unit of ordered) {
        if (c83Locked(unit)) return undefined;
        const current = board.cells.get(unit.getId());
        let best: XY | undefined;
        let bestDist = Infinity;
        for (const anchor of board.geom.baseCells) {
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!r3Legal(footprint, board, taken) || !allow(unit, footprint, anchor)) continue;
            const dist = current ? chebyshev(anchor, current) : 0;
            if (
                !best ||
                dist < bestDist ||
                (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
            ) {
                best = c83At(anchor);
                bestDist = dist;
            }
        }
        if (!best) return undefined;
        for (const cell of footprintCellsForAnchor(unit, best)) taken.add(keyOf(cell));
        placements.set(unit.getId(), best);
    }
    return placements;
};

/** Commit inside the current zone. Locked stacks, including every corner bow, never move. */
const c83Apply = (
    board: IBoard,
    fixed: ReadonlyMap<string, XY>,
    extra: readonly Unit[],
    allow: (unit: Unit, footprint: readonly XY[], anchor: XY) => boolean,
    hold: ReadonlySet<string>,
): boolean => {
    if (!fixed.size && !extra.length) return false;
    for (const id of fixed.keys()) {
        const unit = c83Unit(board, id);
        if (!unit || c83Locked(unit)) return false;
    }
    const blockers = c83Blockers(board, fixed, hold);
    if (!blockers) return false;
    const movers: Unit[] = [];
    const seen = new Set<string>(fixed.keys());
    for (const unit of [...blockers, ...extra]) {
        if (seen.has(unit.getId())) continue;
        if (c83Immovable(unit, hold)) return false;
        seen.add(unit.getId());
        movers.push(unit);
    }
    const placements = c83Relocate(board, fixed, movers, allow);
    if (!placements) return false;
    for (const [id, anchor] of placements) board.cells.set(id, c83At(anchor));
    return true;
};

const c83Hold = (board: IBoard, accept: (unit: Unit) => boolean): Set<string> =>
    new Set(board.units.filter(accept).map((unit) => unit.getId()));

const c83OnBack = (footprint: readonly XY[], board: IBoard): boolean => {
    const back = ranksOf(board).back;
    return footprint.length > 0 && footprint.every((cell) => board.geom.frontness(cell) === back);
};

const c83Area = (board: IBoard): boolean => {
    const buffers = c83Placed(board, (unit) => c83IsBuffer(unit) && !c83Locked(unit));
    if (!buffers.length) return false;
    const corners = c83CornerKeys(board);
    const ranks = ranksOf(board);
    const hold = c83Hold(board, c83IsDamageCaster);
    for (const buffer of buffers) {
        const spots = c83Anchors(board, buffer, (footprint) => {
            if (!c83OnBack(footprint, board) || footprint.some((cell) => corners.has(keyOf(cell)))) return false;
            return c83Separated(footprint, board, new Set([buffer.getId()]), 3);
        });
        const oldLats = new Set(board.laterals(buffer));
        for (const spot of spots) {
            const buffFoot = footprintCellsForAnchor(buffer, spot);
            const fixed = new Map<string, XY>([[buffer.getId(), spot]]);
            const allow = (_unit: Unit, footprint: readonly XY[]): boolean => minChebyshev(footprint, buffFoot) >= 3;
            const vacated = [...oldLats].filter((lat) => !buffFoot.some((cell) => board.geom.lateral(cell) === lat));
            if (vacated.length === 1) {
                const front = r3Cell(board, ranks.front, vacated[0] ?? -1);
                const screens = c83Screens(board, true).filter(
                    (unit) => unit.getId() !== buffer.getId() && !c83TouchesDamage(board, unit),
                );
                const screen = front ? c83Nearest(screens, board, front) : undefined;
                if (front && screen) {
                    const screenFoot = footprintCellsForAnchor(screen, front);
                    if (minChebyshev(screenFoot, buffFoot) >= 3) {
                        const withScreen = new Map(fixed);
                        withScreen.set(screen.getId(), c83At(front));
                        if (c83Apply(board, withScreen, [], allow, hold)) return true;
                    }
                }
            }
            if (c83Apply(board, fixed, [], allow, hold)) return true;
        }
    }
    return false;
};

const c83Caliber = (board: IBoard): boolean => {
    const satyrs = c83Placed(board, (unit) => unit.getName() === "Satyr" && !c83Locked(unit));
    const casters = c83Placed(board, c83IsDamageCaster);
    if (!satyrs.length || !casters.length) return false;
    const spots: { satyr: Unit; anchor: XY; dist: number }[] = [];
    for (const satyr of satyrs) {
        const current = board.cells.get(satyr.getId());
        if (!current) continue;
        for (const caster of casters) {
            if (caster.getId() === satyr.getId()) continue;
            const casterFoot = board.footprint(caster);
            const anchor = c83Anchors(board, satyr, (footprint) => {
                if (!c83OnBack(footprint, board) || !casterFoot.length) return false;
                if (minChebyshev(footprint, casterFoot) !== 2) return false;
                return c83Separated(footprint, board, new Set([satyr.getId()]), 2);
            })[0];
            if (!anchor) continue;
            spots.push({ satyr, anchor, dist: chebyshev(anchor, current) });
        }
    }
    spots.sort(
        (a, b) => a.dist - b.dist || byId(a.satyr, b.satyr) || a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y,
    );
    const hold = c83Hold(board, (unit) => c83IsDamageCaster(unit) || c83IsBuffer(unit));
    for (const spot of spots) {
        const fixed = new Map<string, XY>([[spot.satyr.getId(), spot.anchor]]);
        if (c83Apply(board, fixed, [], () => true, hold)) return true;
    }
    return false;
};

const c83FileFront = (board: IBoard, unit: Unit): { lat: number; front?: XY; middle?: XY } => {
    const ranks = ranksOf(board);
    const lat = c83AnchorLat(board, unit);
    return {
        lat,
        front: r3Cell(board, ranks.front, lat),
        middle: ranks.front - ranks.back >= 2 ? r3Cell(board, ranks.front - 1, lat) : undefined,
    };
};

const c83BreathOne = (board: IBoard, caster: Unit): boolean => {
    const file = c83FileFront(board, caster);
    if (!file.front || !file.middle) return false;
    const front = file.front;
    const middle = file.middle;
    const casterFoot = board.footprint(caster);
    if (casterFoot.some((cell) => sameCell(cell, middle))) return false;
    if (casterFoot.some((cell) => sameCell(cell, front)) && !caster.isSmallSize()) return false;
    const hold = new Set<string>([caster.getId()]);
    const frontUnit = c83Occupant(board, front);
    const breathKey = keyOf(middle);
    const frontKey = keyOf(front);
    const offBreath = (_unit: Unit, footprint: readonly XY[]): boolean =>
        footprint.every((cell) => {
            const key = keyOf(cell);
            return key !== breathKey && key !== frontKey;
        });
    if (!frontUnit || !frontUnit.isSmallSize()) {
        if (frontUnit && (frontUnit.getId() === caster.getId() || c83Immovable(frontUnit, hold))) return false;
        const screens = c83Screens(board, true)
            .filter((screen) => {
                if (screen.getId() === caster.getId()) return false;
                if (frontUnit && screen.getId() === frontUnit.getId()) return false;
                return !frontUnit || !board.laterals(screen).includes(file.lat);
            })
            .sort((a, b) => {
                const aAnchor = board.cells.get(a.getId());
                const bAnchor = board.cells.get(b.getId());
                const aDist = aAnchor ? chebyshev(aAnchor, front) : Infinity;
                const bDist = bAnchor ? chebyshev(bAnchor, front) : Infinity;
                return aDist - bDist || byId(a, b);
            });
        for (const screen of screens) {
            const fixed = new Map<string, XY>([[screen.getId(), c83At(front)]]);
            const extra: Unit[] = [];
            const old = board.cells.get(screen.getId());
            if (frontUnit && old) {
                const swapped = footprintCellsForAnchor(frontUnit, old);
                if (swapped.every((cell) => keyOf(cell) !== breathKey && keyOf(cell) !== frontKey)) {
                    const trial = new Map(fixed);
                    trial.set(frontUnit.getId(), c83At(old));
                    const middleUnit = c83Occupant(
                        board,
                        middle,
                        new Set([screen.getId(), frontUnit.getId(), caster.getId()]),
                    );
                    if (middleUnit && !c83Immovable(middleUnit, hold)) {
                        if (c83Apply(board, trial, [middleUnit], offBreath, hold)) return true;
                    } else if (!middleUnit && c83Apply(board, trial, [], offBreath, hold)) return true;
                }
            }
            if (frontUnit) extra.push(frontUnit);
            const middleUnit = c83Occupant(
                board,
                middle,
                new Set([screen.getId(), frontUnit?.getId() ?? "", caster.getId()]),
            );
            if (middleUnit) {
                if (c83Immovable(middleUnit, hold)) continue;
                extra.push(middleUnit);
            }
            if (c83Apply(board, fixed, extra, offBreath, hold)) return true;
        }
        return false;
    }
    const middleUnit = c83Occupant(board, middle, new Set([frontUnit.getId(), caster.getId()]));
    if (!middleUnit) return false;
    if (c83Immovable(middleUnit, hold)) return false;
    return c83Apply(
        board,
        new Map(),
        [middleUnit],
        (unit, footprint) => footprint.every((cell) => keyOf(cell) !== breathKey) && unit.getId() !== caster.getId(),
        hold,
    );
};

const c83Breath = (board: IBoard): boolean => {
    for (const caster of c83Casters(board)) {
        const file = c83FileFront(board, caster);
        if (!file.front || !file.middle) continue;
        const frontUnit = c83Occupant(board, file.front);
        const middleUnit = c83Occupant(board, file.middle, new Set([caster.getId()]));
        if (frontUnit?.isSmallSize() && !middleUnit) continue;
        if (c83BreathOne(board, caster)) return true;
    }
    return false;
};

const c83SkewerOne = (board: IBoard, caster: Unit): boolean => {
    const file = c83FileFront(board, caster);
    if (!file.front) return false;
    const front = file.front;
    const frontUnit = c83Occupant(board, front);
    if (frontUnit && !frontUnit.isSmallSize()) return false;
    if (frontUnit && (frontUnit.getId() === caster.getId() || c83Locked(frontUnit))) return false;
    const casterFoot = board.footprint(caster);
    const hold = new Set<string>([caster.getId()]);
    const larges = c83Screens(board, false)
        .filter(
            (screen) =>
                !screen.isSmallSize() &&
                screen.getId() !== frontUnit?.getId() &&
                !board.laterals(screen).includes(file.lat),
        )
        .sort((a, b) => {
            const aAnchor = board.cells.get(a.getId());
            const bAnchor = board.cells.get(b.getId());
            const aDist = aAnchor ? chebyshev(aAnchor, front) : Infinity;
            const bDist = bAnchor ? chebyshev(bAnchor, front) : Infinity;
            return aDist - bDist || byId(a, b);
        });
    for (const large of larges) {
        const old = board.cells.get(large.getId());
        const anchors = c83Anchors(
            board,
            large,
            (footprint) =>
                footprint.some((cell) => sameCell(cell, front)) &&
                (!casterFoot.length || minChebyshev(footprint, casterFoot) > 0),
        );
        for (const anchor of anchors) {
            const fixed = new Map<string, XY>([[large.getId(), anchor]]);
            if (frontUnit && old) {
                const trial = new Map(fixed);
                trial.set(frontUnit.getId(), c83At(old));
                if (c83Apply(board, trial, [], () => true, hold)) return true;
            }
            if (c83Apply(board, fixed, frontUnit ? [frontUnit] : [], () => true, hold)) return true;
        }
    }
    return false;
};

const c83Skewer = (board: IBoard): boolean => {
    for (const caster of c83Casters(board)) {
        const front = c83FileFront(board, caster).front;
        const frontUnit = front ? c83Occupant(board, front) : undefined;
        if (frontUnit && !frontUnit.isSmallSize()) continue;
        if (c83SkewerOne(board, caster)) return true;
    }
    return false;
};

const c83ThroughOne = (board: IBoard, caster: Unit): boolean => {
    const file = c83FileFront(board, caster);
    if (!file.front) return false;
    const corners = c83CornerKeys(board);
    const screens = c83Screens(board, true).filter((screen) => screen.getId() !== caster.getId());
    const already = c83Occupant(board, file.front);
    const screen =
        already && screens.some((unit) => unit.getId() === already.getId())
            ? already
            : c83Nearest(screens, board, file.front);
    if (!screen) return false;
    const onFile = board.units.filter((unit) => {
        if (unit.getId() === screen.getId() || unit.getId() === caster.getId()) return false;
        return board.footprint(unit).some((cell) => board.geom.lateral(cell) === file.lat);
    });
    if (onFile.some((unit) => c83Locked(unit))) return false;
    const spots = c83Anchors(board, caster, (footprint) => {
        if (!c83OnBack(footprint, board) || footprint.some((cell) => corners.has(keyOf(cell)))) return false;
        return footprint.every((cell) => board.geom.lateral(cell) !== file.lat);
    });
    for (const spot of spots) {
        const fixed = new Map<string, XY>([
            [caster.getId(), spot],
            [screen.getId(), c83At(file.front)],
        ]);
        const allow = (_unit: Unit, footprint: readonly XY[]): boolean =>
            footprint.every((cell) => board.geom.lateral(cell) !== file.lat);
        if (c83Apply(board, fixed, onFile, allow, new Set())) return true;
    }
    return false;
};

const c83Through = (board: IBoard): boolean => {
    for (const caster of c83Casters(board)) {
        if (c83ThroughOne(board, caster)) return true;
    }
    return false;
};

const c83SpinOne = (board: IBoard, caster: Unit): boolean => {
    const file = c83FileFront(board, caster);
    if (!file.front) return false;
    const screen = c83Nearest(
        c83Screens(board, true).filter((unit) => unit.getId() !== caster.getId()),
        board,
        file.front,
    );
    if (!screen) return false;
    const screenFoot = footprintCellsForAnchor(screen, file.front);
    const casterFoot = board.footprint(caster);
    const forbidden = new Set<number>();
    const ranks = ranksOf(board);
    for (const side of [file.lat - 1, file.lat + 1]) {
        const shoulder = r3Cell(board, ranks.front, side);
        if (shoulder) forbidden.add(keyOf(shoulder));
    }
    if (screenFoot.some((cell) => forbidden.has(keyOf(cell)))) return false;
    const hold = new Set<string>([caster.getId()]);
    const extra: Unit[] = [];
    for (const unit of board.units) {
        if (unit.getId() === screen.getId() || unit.getId() === caster.getId()) continue;
        const footprint = board.footprint(unit);
        if (!footprint.length) continue;
        const shoulder = footprint.some((cell) => forbidden.has(keyOf(cell)));
        const both = minChebyshev(footprint, screenFoot) <= 1 && minChebyshev(footprint, casterFoot) <= 1;
        if (!shoulder && !both) continue;
        if (c83Immovable(unit, hold)) return false;
        extra.push(unit);
    }
    const allow = (_unit: Unit, footprint: readonly XY[]): boolean => {
        if (footprint.some((cell) => forbidden.has(keyOf(cell)))) return false;
        return !(minChebyshev(footprint, screenFoot) <= 1 && minChebyshev(footprint, casterFoot) <= 1);
    };
    return c83Apply(board, new Map([[screen.getId(), c83At(file.front)]]), extra, allow, hold);
};

const c83Spin = (board: IBoard): boolean => {
    for (const caster of c83Casters(board)) {
        if (c83SpinOne(board, caster)) return true;
    }
    return false;
};

const c83Ward = (board: IBoard): Unit | undefined => {
    const caster = c83Casters(board)[0];
    if (caster) return caster;
    return c83Placed(board, (unit) => unit.getName() === "Monk" && onBackRank(unit, board))[0];
};

const c83Flyers = (board: IBoard): boolean => {
    const ward = c83Ward(board);
    if (!ward) return false;
    const ranks = ranksOf(board);
    const body = [...new Set(board.laterals(ward))];
    const closest = [...body].sort(
        (a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b,
    )[0];
    if (closest === undefined) return false;
    const toward = closest < board.geom.centreLat ? 1 : closest > board.geom.centreLat ? -1 : 0;
    const firstLat = toward === 0 ? closest - 1 : closest + toward;
    const otherLat = toward === 0 ? closest + 1 : closest - toward;
    const first = r3Cell(board, ranks.back, firstLat);
    const other = r3Cell(board, ranks.back, otherLat);
    const rangeAt = (cell: XY | undefined): boolean =>
        !!cell &&
        board.units.some(
            (unit) => unit.getAttackType() === RANGE && board.footprint(unit).some((entry) => sameCell(entry, cell)),
        );
    if (rangeAt(first) && rangeAt(other)) return false;
    const chosen = first && !rangeAt(first) ? first : other && !rangeAt(other) ? other : undefined;
    if (!chosen || body.includes(board.geom.lateral(chosen))) return false;
    const screen = c83Nearest(
        c83Screens(board, true).filter((unit) => unit.getId() !== ward.getId()),
        board,
        chosen,
    );
    if (!screen) return false;
    const wardFoot = board.footprint(ward);
    if (minChebyshev(footprintCellsForAnchor(screen, chosen), wardFoot) === 0) return false;
    const capped = c83CapKeys(board);
    const wardLats = new Set(body);
    const wardBack = Math.min(...wardFoot.map((cell) => board.geom.frontness(cell)));
    const allow = (_unit: Unit, footprint: readonly XY[]): boolean =>
        footprint.every(
            (cell) =>
                !capped.has(keyOf(cell)) &&
                !(wardLats.has(board.geom.lateral(cell)) && board.geom.frontness(cell) < wardBack),
        );
    return c83Apply(board, new Map([[screen.getId(), c83At(chosen)]]), [], allow, new Set([ward.getId()]));
};

const c83NamedSpell = (unit: Unit, name: string): boolean => unit.getSpells().some((spell) => spell.getName() === name);

const c83PlanCovers = (board: IBoard, cell: XY, fixed: ReadonlyMap<string, XY>): boolean =>
    board.units.some((unit) => {
        const anchor = fixed.get(unit.getId()) ?? board.cells.get(unit.getId());
        return !!anchor && footprintCellsForAnchor(unit, anchor).some((entry) => sameCell(entry, cell));
    });

const c83Free = (
    board: IBoard,
    footprint: readonly XY[],
    ignore: ReadonlySet<string>,
    fixed: ReadonlyMap<string, XY>,
    hold: ReadonlySet<string>,
): boolean => {
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (ignore.has(unit.getId())) continue;
        const pinned = fixed.get(unit.getId());
        if (pinned) {
            for (const cell of footprintCellsForAnchor(unit, pinned)) taken.add(keyOf(cell));
            continue;
        }
        if (!c83Immovable(unit, hold)) continue;
        const anchor = board.cells.get(unit.getId());
        if (!anchor) continue;
        for (const cell of footprintCellsForAnchor(unit, anchor)) taken.add(keyOf(cell));
    }
    return r3Legal(footprint, board, taken);
};

const c83Ahead = (board: IBoard, caster: Unit, claimed: ReadonlySet<string>): Unit | undefined => {
    const lats = new Set(board.laterals(caster));
    const casterFoot = board.footprint(caster);
    const casterFront = casterFoot.length ? Math.max(...casterFoot.map((cell) => board.geom.frontness(cell))) : -1;
    const ahead = board.units.filter((unit) => {
        if (unit.getId() === caster.getId() || claimed.has(unit.getId())) return false;
        if (unit.getAttackType() === RANGE || c83Locked(unit) || c83IsBuffer(unit)) return false;
        return board
            .footprint(unit)
            .some((cell) => lats.has(board.geom.lateral(cell)) && board.geom.frontness(cell) > casterFront);
    });
    ahead.sort(
        (a, b) =>
            minChebyshev(board.footprint(a), casterFoot) - minChebyshev(board.footprint(b), casterFoot) || byId(a, b),
    );
    return ahead[0];
};

const c83LateralStep = (
    board: IBoard,
    unit: Unit,
    caster: Unit,
    fixed: ReadonlyMap<string, XY>,
    hold: ReadonlySet<string>,
): XY | undefined => {
    const anchor = board.cells.get(unit.getId());
    if (!anchor) return undefined;
    const casterAnchor = fixed.get(caster.getId()) ?? board.cells.get(caster.getId());
    const casterFoot = casterAnchor ? footprintCellsForAnchor(caster, casterAnchor) : [];
    const inward = board.geom.inwardDelta(anchor);
    const deltas = inward === 0 ? [1, -1] : [inward, -inward];
    for (const delta of deltas) {
        const next = board.geom.shiftLateral(anchor, delta);
        const footprint = footprintCellsForAnchor(unit, next);
        if (!casterFoot.length || minChebyshev(footprint, casterFoot) !== 1) continue;
        if (!c83Free(board, footprint, new Set([unit.getId()]), fixed, hold)) continue;
        return c83At(next);
    }
    return undefined;
};

const c83Shooters = (board: IBoard): boolean => {
    const rings = c83Placed(board, (unit) => isCasterUnit(unit) && c83NamedSpell(unit, "Ring of Fire"));
    const buffers = c83Placed(board, (unit) => c83IsBuffer(unit) && !c83NamedSpell(unit, "Ring of Fire"));
    if (!rings.length && !buffers.length) return false;
    const fixed = new Map<string, XY>();
    const stepped = new Set<string>();
    const hold = c83Hold(
        board,
        (unit) => c83IsBuffer(unit) || (isCasterUnit(unit) && c83NamedSpell(unit, "Ring of Fire")),
    );
    let stepFailed = false;
    for (const caster of rings) {
        const ahead = c83Ahead(board, caster, stepped);
        if (!ahead) continue;
        const dest = c83LateralStep(board, ahead, caster, fixed, hold);
        if (!dest) {
            stepFailed = true;
            break;
        }
        fixed.set(ahead.getId(), dest);
        stepped.add(ahead.getId());
    }
    if (stepFailed) return false;
    const ranks = ranksOf(board);
    for (const buffer of buffers) {
        if (fixed.has(buffer.getId())) continue;
        const anchor = board.cells.get(buffer.getId());
        if (!anchor) continue;
        const front = r3Cell(board, ranks.front, board.geom.lateral(anchor));
        if (!front || c83Occupant(board, front) || c83PlanCovers(board, front, fixed)) continue;
        const screen = c83Nearest(
            c83Screens(board, true).filter((unit) => !stepped.has(unit.getId()) && !fixed.has(unit.getId())),
            board,
            front,
        );
        if (!screen) return false;
        fixed.set(screen.getId(), c83At(front));
    }
    if (!fixed.size) return false;
    for (const id of stepped) hold.delete(id);
    const capped = c83CapKeys(board);
    const back = ranksOf(board).back;
    const protectedFeet = [...rings, ...buffers].map((unit) => board.footprint(unit));
    const allow = (_unit: Unit, footprint: readonly XY[]): boolean => {
        if (footprint.some((cell) => capped.has(keyOf(cell)))) return false;
        const onBack = footprint.some((cell) => board.geom.frontness(cell) === back);
        if (!onBack) return true;
        return !protectedFeet.some((foot) => foot.length > 0 && minChebyshev(footprint, foot) <= 1);
    };
    return c83Apply(board, fixed, [], allow, hold);
};

/**
 * r8c3 post-pass. Today's placeArmy has already run. The first public branch is the only one.
 * Area Throw and Large Caliber do not fall through. No Placement spend, and no corner bow moves.
 */
export function placeArmyR8C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const original = copyCells(board);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const finish = (ok: boolean): Map<string, XY> => {
        if (!ok) restoreCells(board, original);
        return board.cells;
    };
    if (threats.areaThrow) return finish(c83Area(board));
    if (threats.largeCaliber) return finish(c83Caliber(board));
    if (threats.fireBreath && !threats.skewerStrike) return finish(c83Breath(board));
    if (threats.skewerStrike && !threats.fireBreath) return finish(c83Skewer(board));
    if (threats.throughShot && !threats.fireBreath && !threats.skewerStrike) return finish(c83Through(board));
    if (threats.lightningSpin && !threats.fireBreath && !threats.skewerStrike && !threats.throughShot) {
        return finish(c83Spin(board));
    }
    if (threats.flyers >= 2 && threats.rangeCreatures < 2) return finish(c83Flyers(board));
    if (
        threats.rangeCreatures >= 2 &&
        threats.flyers < 2 &&
        !threats.areaThrow &&
        !threats.largeCaliber &&
        !threats.fireBreath &&
        !threats.chakram &&
        !threats.fireball &&
        !threats.ringOfFire &&
        !threats.meteorShower
    ) {
        return finish(c83Shooters(board));
    }
    return board.cells;
}

/** Monk, Dryad, Abomination, Angel, and Arachna Queen never move. */
const C91_STILL = new Set(["Monk", "Dryad", "Abomination", "Angel", "Arachna Queen"]);

const c91Still = (unit: Unit): boolean => C91_STILL.has(unit.getName());

const c91Guard = (unit: Unit): boolean => !c91Still(unit) && !unit.canFly() && unit.getAttackType() !== RANGE;

const c91Leather = (unit: Unit): boolean => r3HasAbility(unit, "Leather Armor");

const c91Aura = (unit: Unit): boolean => r3HasAbility(unit, "Guiding Winds");

const c91Sniper = (unit: Unit): boolean => r3HasAbility(unit, "Sniper");

interface IC91Ends {
    readonly min: number;
    readonly max: number;
    readonly keys: ReadonlySet<number>;
}

const c91Ends = (board: IBoard): IC91Ends => {
    const keys = backCornerKeys(board.geom);
    let min = Infinity;
    let max = -Infinity;
    for (const key of keys) {
        const lat = board.geom.lateral({ x: key >> 4, y: key & 0xf });
        if (lat < min) min = lat;
        if (lat > max) max = lat;
    }
    return { min, max, keys };
};

const c91OnEnd = (unit: Unit, board: IBoard, ends: IC91Ends): boolean =>
    board.footprint(unit).some((cell) => ends.keys.has(keyOf(cell)));

const c91EntirelyBack = (footprint: readonly XY[], board: IBoard): boolean =>
    footprint.length > 0 && footprint.every((cell) => board.geom.frontness(cell) === board.geom.backFront);

const c91TouchesBack = (unit: Unit, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => board.geom.frontness(cell) === board.geom.backFront);

const c91Seat = (board: IBoard, unit: Unit, anchor: XY): boolean => {
    const current = board.cells.get(unit.getId());
    if (current && sameCell(current, anchor)) return true;
    return board.place(unit, anchor);
};

const c91Covers = (unit: Unit, target: XY, board: IBoard): boolean =>
    board.footprint(unit).some((cell) => sameCell(cell, target));

const c91Occupied = (board: IBoard, target: XY): boolean =>
    board.units.some((unit) => board.footprint(unit).some((cell) => sameCell(cell, target)));

const c91MinDist = (footprint: readonly XY[], board: IBoard, selfId: string): number => {
    let best = Infinity;
    for (const other of board.units) {
        if (other.getId() === selfId) continue;
        const cells = board.footprint(other);
        if (!cells.length) continue;
        best = Math.min(best, minChebyshev(footprint, cells));
    }
    return best;
};

const c91BowGap = (footprint: readonly XY[], board: IBoard, selfId: string, gap: number): boolean => {
    for (const other of board.units) {
        if (other.getId() === selfId || other.getAttackType() !== RANGE) continue;
        const cells = board.footprint(other);
        if (cells.length && minChebyshev(footprint, cells) < gap) return false;
    }
    return true;
};

const c91BowLaterals = (board: IBoard): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of board.units) {
        if (unit.getAttackType() !== RANGE) continue;
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const c91EndGroups = (bows: readonly Unit[], board: IBoard, ends: IC91Ends): { low: Unit[]; high: Unit[] } => {
    const low: Unit[] = [];
    const high: Unit[] = [];
    for (const bow of bows) {
        let onLow = false;
        let onHigh = false;
        for (const cell of board.footprint(bow)) {
            if (!ends.keys.has(keyOf(cell))) continue;
            const lat = board.geom.lateral(cell);
            if (lat === ends.min) onLow = true;
            if (lat === ends.max) onHigh = true;
        }
        if (onLow) low.push(bow);
        if (onHigh) high.push(bow);
    }
    return { low, high };
};

const c91SpreadGuards = (board: IBoard, guards: readonly Unit[], bows: readonly Unit[]): Unit[] =>
    guards
        .filter((guard) => {
            const foot = board.footprint(guard);
            if (!foot.length) return false;
            let count = 0;
            for (const bow of bows) {
                const cells = board.footprint(bow);
                if (cells.length && minChebyshev(foot, cells) === 1) count += 1;
            }
            return count >= 2;
        })
        .sort(byId);

const c91SplashSeat = (board: IBoard, guard: Unit, bows: readonly Unit[]): void => {
    const current = board.cells.get(guard.getId());
    if (!current) return;
    const front = zoneLimits(board.geom).maxFront;
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        if (!board.free(guard, anchor)) continue;
        const footprint = footprintCellsForAnchor(guard, anchor);
        if (!footprint.length) continue;
        const fronts = footprint.map((cell) => board.geom.frontness(cell));
        if (Math.max(...fronts) !== front) continue;
        if (c91MinDist(footprint, board, guard.getId()) < 2) continue;
        let nearest = Infinity;
        for (const bow of bows) {
            const cells = board.footprint(bow);
            if (!cells.length) continue;
            nearest = Math.min(nearest, minChebyshev(footprint, cells));
        }
        if (nearest !== 2) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => chebyshev(a, current) - chebyshev(b, current) || a.x - b.x || a.y - b.y);
    const spot = spots[0];
    if (spot) c91Seat(board, guard, spot);
};

const c91LeatherSpot = (board: IBoard, bow: Unit, ends: IC91Ends, corners: readonly XY[]): XY | undefined => {
    const current = board.cells.get(bow.getId());
    if (!current) return undefined;
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        if (!board.free(bow, anchor)) continue;
        const footprint = footprintCellsForAnchor(bow, anchor);
        if (!c91EntirelyBack(footprint, board)) continue;
        if (footprint.some((cell) => ends.keys.has(keyOf(cell)))) continue;
        if (corners.some((cell) => minChebyshev(footprint, [cell]) < 4)) continue;
        if (!c91BowGap(footprint, board, bow.getId(), 4)) continue;
        if (c91MinDist(footprint, board, bow.getId()) < 2) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => chebyshev(a, current) - chebyshev(b, current) || a.x - b.x || a.y - b.y);
    return spots[0];
};

/** Leather leaves a back corner only when the enemy has shots and at least one flyer. */
const c91LeatherSwap = (board: IBoard, bows: readonly Unit[], ends: IC91Ends): void => {
    const vacated: XY[] = [];
    const seen = new Set<number>();
    for (const bow of bows.filter(c91Leather).sort(byId)) {
        if (c91Still(bow) || !c91OnEnd(bow, board, ends)) continue;
        const before = board.footprint(bow).filter((cell) => ends.keys.has(keyOf(cell)));
        const spot = c91LeatherSpot(board, bow, ends, before);
        if (!spot) continue;
        const current = board.cells.get(bow.getId());
        if (!current || sameCell(current, spot) || !c91Seat(board, bow, spot)) continue;
        const after = board.footprint(bow);
        for (const cell of before) {
            if (after.some((next) => sameCell(next, cell)) || c91Occupied(board, cell)) continue;
            const key = keyOf(cell);
            if (seen.has(key)) continue;
            seen.add(key);
            vacated.push(cell);
        }
    }
    vacated.sort((a, b) => board.geom.lateral(a) - board.geom.lateral(b) || a.x - b.x || a.y - b.y);
    const used = new Set<string>();
    const seatCorner = (unit: Unit, corner: XY): boolean => {
        if (c91Still(unit) || !board.cells.has(unit.getId())) return false;
        const foot = board.footprint(unit);
        if (foot.some((cell) => sameCell(cell, corner)) && c91EntirelyBack(foot, board)) return true;
        const spots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            const footprint = footprintCellsForAnchor(unit, anchor);
            if (!c91EntirelyBack(footprint, board) || !board.free(unit, anchor)) continue;
            if (!footprint.some((cell) => sameCell(cell, corner))) continue;
            spots.push(anchor);
        }
        spots.sort((a, b) => (sameCell(a, corner) ? 0 : 1) - (sameCell(b, corner) ? 0 : 1) || a.x - b.x || a.y - b.y);
        const spot = spots[0];
        return spot ? c91Seat(board, unit, spot) : false;
    };
    if (bows.length >= 3) {
        const candidates = bows
            .filter((unit) => !c91Leather(unit) && !c91Aura(unit) && !c91Still(unit))
            .sort((a, b) => b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b));
        for (const corner of vacated) {
            if (c91Occupied(board, corner)) continue;
            for (const bow of candidates) {
                if (used.has(bow.getId()) || !seatCorner(bow, corner)) continue;
                used.add(bow.getId());
                break;
            }
        }
        return;
    }
    if (bows.length !== 2) return;
    for (const corner of vacated) {
        if (c91Occupied(board, corner)) continue;
        const other = bows.find((unit) => !c91Leather(unit) && !used.has(unit.getId()));
        if (!other || c91Still(other) || !seatCorner(other, corner)) continue;
        used.add(other.getId());
    }
};

const c91PeelGap = (threats: IPublicPlacementThreats): number => (threats.rangeNullField ? 5 : 4);

const c91ThirdScore = (cells: readonly XY[], board: IBoard, thirds: readonly [number, number]): number => {
    let best = Infinity;
    for (const cell of cells) {
        const lat = board.geom.lateral(cell);
        best = Math.min(best, Math.abs(lat - thirds[0]), Math.abs(lat - thirds[1]));
    }
    return best;
};

const c91BestThird = (
    board: IBoard,
    bow: Unit,
    gap: number,
    ends: IC91Ends,
    thirds: readonly [number, number],
): XY | undefined => {
    if (!c91TouchesBack(bow, board)) return undefined;
    const current = board.cells.get(bow.getId());
    let best: { anchor: XY; score: number; near: number } | undefined;
    for (const anchor of board.geom.baseCells) {
        if (!board.free(bow, anchor)) continue;
        const footprint = footprintCellsForAnchor(bow, anchor);
        if (!c91EntirelyBack(footprint, board)) continue;
        if (footprint.some((cell) => ends.keys.has(keyOf(cell)))) continue;
        if (!c91BowGap(footprint, board, bow.getId(), gap)) continue;
        const score = c91ThirdScore(footprint, board, thirds);
        const near = current
            ? Math.abs(medianNumber(lateralsOfAnchor(bow, anchor, board.geom)) - medianLat(bow, board))
            : 0;
        if (
            !best ||
            score < best.score - 1e-9 ||
            (Math.abs(score - best.score) <= 1e-9 &&
                (near < best.near - 1e-9 ||
                    (Math.abs(near - best.near) <= 1e-9 &&
                        (anchor.x < best.anchor.x || (anchor.x === best.anchor.x && anchor.y < best.anchor.y)))))
        ) {
            best = { anchor, score, near };
        }
    }
    if (!best) return undefined;
    if (current) {
        const foot = board.footprint(bow);
        const parked =
            c91EntirelyBack(foot, board) &&
            foot.every((cell) => !ends.keys.has(keyOf(cell))) &&
            c91BowGap(foot, board, bow.getId(), gap);
        if (parked && c91ThirdScore(foot, board, thirds) <= best.score + 1e-9) return current;
    }
    return best.anchor;
};

const c91Slide = (board: IBoard, extras: readonly Unit[], gap: number, ends: IC91Ends): void => {
    const limits = zoneLimits(board.geom);
    const span = limits.maxLat - limits.minLat;
    const thirds: readonly [number, number] = [limits.minLat + span / 3, limits.minLat + (2 * span) / 3];
    const ordered = extras.filter((unit) => board.cells.has(unit.getId())).sort(byId);
    for (let pass = 0; pass < ordered.length; pass += 1) {
        let moved = false;
        for (const bow of ordered) {
            const spot = c91BestThird(board, bow, gap, ends, thirds);
            if (!spot) continue;
            const current = board.cells.get(bow.getId());
            if (current && sameCell(current, spot)) continue;
            if (!c91Seat(board, bow, spot)) continue;
            moved = true;
        }
        if (!moved) break;
    }
};

const c91ClearSpot = (
    board: IBoard,
    unit: Unit,
    bowLats: ReadonlySet<number>,
    ends: IC91Ends,
    front: number,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    if (!current) return undefined;
    const currentLat = medianLat(unit, board);
    const limits = zoneLimits(board.geom);
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        if (!board.free(unit, anchor)) continue;
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.length) continue;
        const laterals = footprint.map((cell) => board.geom.lateral(cell));
        if (laterals.some((lat) => bowLats.has(lat) || lat === ends.min || lat === ends.max)) continue;
        if (laterals.some((lat) => lat < limits.minLat || lat > limits.maxLat)) continue;
        if (footprint.some((cell) => board.geom.frontness(cell) === front)) continue;
        if (c91MinDist(footprint, board, unit.getId()) < 2) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => {
        const aLat = medianNumber(lateralsOfAnchor(unit, a, board.geom));
        const bLat = medianNumber(lateralsOfAnchor(unit, b, board.geom));
        const near = Math.abs(aLat - currentLat) - Math.abs(bLat - currentLat);
        const aSame = board.geom.frontness(a) === board.geom.frontness(current) ? 0 : 1;
        const bSame = board.geom.frontness(b) === board.geom.frontness(current) ? 0 : 1;
        return near || aSame - bSame || chebyshev(a, current) - chebyshev(b, current) || a.x - b.x || a.y - b.y;
    });
    return spots[0];
};

const c91Clear = (board: IBoard, exempt: ReadonlySet<string>, ends: IC91Ends): void => {
    const bowLats = c91BowLaterals(board);
    const front = zoneLimits(board.geom).maxFront;
    const movers = board.units
        .filter((unit) => {
            if (exempt.has(unit.getId()) || c91Still(unit) || unit.getAttackType() === RANGE) return false;
            return board.footprint(unit).some((cell) => bowLats.has(board.geom.lateral(cell)));
        })
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of movers) {
        const spot = c91ClearSpot(board, unit, bowLats, ends, front);
        if (spot) c91Seat(board, unit, spot);
    }
};

const c91CornerFront = (board: IBoard, ends: IC91Ends): XY[] => {
    const front = ranksOf(board).front;
    const groups = c91EndGroups(
        board.units.filter((unit) => unit.getAttackType() === RANGE),
        board,
        ends,
    );
    const targets: XY[] = [];
    if (groups.low.length) {
        const cell = r3Cell(board, front, ends.min);
        if (cell) targets.push(cell);
    }
    if (groups.high.length && ends.max !== ends.min) {
        const cell = r3Cell(board, front, ends.max);
        if (cell) targets.push(cell);
    }
    return targets;
};

const c91BesideTargets = (board: IBoard, ends: IC91Ends): XY[] => {
    const bowLats = c91BowLaterals(board);
    const middle = ranksOf(board).middle;
    const limits = zoneLimits(board.geom);
    const corners = board.units
        .filter((unit) => unit.getAttackType() === RANGE && c91OnEnd(unit, board, ends))
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    const targets: XY[] = [];
    const seen = new Set<number>();
    for (const bow of corners) {
        const neighbors = new Set<number>();
        for (const lat of board.laterals(bow)) {
            neighbors.add(lat - 1);
            neighbors.add(lat + 1);
        }
        const options = [...neighbors]
            .filter((lat) => lat >= limits.minLat && lat <= limits.maxLat && !bowLats.has(lat))
            .sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
        for (const lat of options) {
            if (seen.has(lat)) continue;
            const cell = r3Cell(board, middle, lat);
            if (!cell) continue;
            seen.add(lat);
            targets.push(cell);
            break;
        }
    }
    return targets;
};

const c91CentreLaterals = (board: IBoard, ends: IC91Ends, spaced: boolean): number[] => {
    const limits = zoneLimits(board.geom);
    const bowLats = c91BowLaterals(board);
    const front = ranksOf(board).front;
    const options: number[] = [];
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        if (lat === ends.min || lat === ends.max || bowLats.has(lat)) continue;
        if (!r3Cell(board, front, lat)) continue;
        options.push(lat);
    }
    const centre = board.geom.centreLat;
    let best: [number, number] | undefined;
    let bestScore = Infinity;
    let bestSpan = Infinity;
    for (let i = 0; i < options.length; i += 1) {
        for (let j = i + 1; j < options.length; j += 1) {
            const left = options[i];
            const right = options[j];
            const span = right - left;
            if (spaced && span < 2) continue;
            const score = Math.abs(left - centre) + Math.abs(right - centre);
            if (
                !best ||
                score < bestScore - 1e-9 ||
                (Math.abs(score - bestScore) <= 1e-9 && span < bestSpan) ||
                (Math.abs(score - bestScore) <= 1e-9 && span === bestSpan && left < best[0])
            ) {
                best = [left, right];
                bestScore = score;
                bestSpan = span;
            }
        }
    }
    if (best) return best;
    if (!spaced && options.length === 1) return [options[0]];
    return [];
};

const c91CanCover = (board: IBoard, unit: Unit, target: XY, allow: (footprint: readonly XY[]) => boolean): boolean => {
    if (c91Still(unit) || !board.cells.has(unit.getId())) return false;
    if (c91Covers(unit, target, board) && allow(board.footprint(unit))) return true;
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.some((cell) => sameCell(cell, target)) || !board.free(unit, anchor)) continue;
        if (allow(footprint)) return true;
    }
    return false;
};

const c91MoveOnto = (board: IBoard, unit: Unit, target: XY, allow: (footprint: readonly XY[]) => boolean): boolean => {
    if (!c91CanCover(board, unit, target, allow)) return false;
    if (c91Covers(unit, target, board) && allow(board.footprint(unit))) return true;
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const footprint = footprintCellsForAnchor(unit, anchor);
        if (!footprint.some((cell) => sameCell(cell, target)) || !board.free(unit, anchor)) continue;
        if (!allow(footprint)) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => (sameCell(a, target) ? 0 : 1) - (sameCell(b, target) ? 0 : 1) || a.x - b.x || a.y - b.y);
    const spot = spots[0];
    return spot ? c91Seat(board, unit, spot) : false;
};

const c91FillTargets = (
    board: IBoard,
    guards: readonly Unit[],
    targets: readonly XY[],
    allow: (footprint: readonly XY[]) => boolean,
): void => {
    const used = new Set<string>();
    for (const target of targets) {
        const lat = board.geom.lateral(target);
        const options = guards.filter((guard) => !used.has(guard.getId()) && c91CanCover(board, guard, target, allow));
        options.sort((a, b) => {
            const aCover = c91Covers(a, target, board) ? 0 : 1;
            const bCover = c91Covers(b, target, board) ? 0 : 1;
            if (aCover !== bCover) return aCover - bCover;
            const aFile = board.laterals(a).includes(lat) ? 0 : 1;
            const bFile = board.laterals(b).includes(lat) ? 0 : 1;
            if (aFile !== bFile) return aFile - bFile;
            const aAnchor = board.cells.get(a.getId());
            const bAnchor = board.cells.get(b.getId());
            const aDist = aAnchor ? chebyshev(aAnchor, target) : Infinity;
            const bDist = bAnchor ? chebyshev(bAnchor, target) : Infinity;
            return aDist - bDist || byId(a, b);
        });
        for (const guard of options) {
            if (!c91MoveOnto(board, guard, target, allow)) continue;
            used.add(guard.getId());
            break;
        }
    }
};

type C91GuardMode = "flyers" | "beside" | "centre" | "none";

const c91GuardMode = (threats: IPublicPlacementThreats, splashCase: boolean, outnumber: boolean): C91GuardMode => {
    if (!outnumber || splashCase) return "none";
    const pierce = threats.fireBreath || threats.skewerStrike || threats.throughShot;
    if (threats.flyers >= 2 && threats.rangeCreatures === 0) return "flyers";
    if (threats.rangeCreatures >= 2 && !pierce && !threats.lightningSpin) return "beside";
    if (threats.rangeCreatures === 0 && threats.flyers === 0) return "centre";
    return "none";
};

/**
 * r9c1 post-pass. Today's placeArmy has already run. Leather leaves a back corner only under shots
 * and wings, extra bows peel along the back rank, and an illegal seat keeps the cell it had.
 * No Placement spend, and the zone is not extended.
 */
export function placeArmyR9C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const ends = c91Ends(board);
    if (!Number.isFinite(ends.min) || !Number.isFinite(ends.max)) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    const bows = board.units.filter((unit) => unit.getAttackType() === RANGE);
    const guards = board.units.filter(c91Guard);
    const spread = c91SpreadGuards(board, guards, bows);
    const outnumber = bows.length > guards.length;
    const allowAny = (): boolean => true;
    if (threats.areaThrow || threats.largeCaliber) {
        if (outnumber && spread[0]) c91SplashSeat(board, spread[0], bows);
        return board.cells;
    }
    if (outnumber && spread[0]) c91SplashSeat(board, spread[0], bows);
    const splashCase = spread.length > 0;
    if (bows.length >= 2 && threats.rangeCreatures >= 2 && threats.flyers >= 1 && bows.some(c91Leather)) {
        c91LeatherSwap(board, bows, ends);
    }
    const peel =
        bows.length >= 3 &&
        threats.rangeCreatures >= 2 &&
        !threats.fireball &&
        !threats.ringOfFire &&
        !threats.meteorShower;
    const spin = !peel && threats.lightningSpin && threats.rangeCreatures < 2 && bows.length >= 3;
    if (peel || spin) {
        const locked = new Set<string>();
        if (peel) {
            for (const bow of bows) {
                if (c91OnEnd(bow, board, ends)) locked.add(bow.getId());
            }
        } else {
            const groups = c91EndGroups(bows, board, ends);
            if (groups.low.length > 0 && groups.high.length > 0) {
                for (const bow of groups.low) locked.add(bow.getId());
                for (const bow of groups.high) locked.add(bow.getId());
            }
            for (const bow of bows) {
                if (threats.rangeCreatures < 2 && c91Sniper(bow) && c91OnEnd(bow, board, ends)) locked.add(bow.getId());
            }
        }
        const extras = bows.filter(
            (unit) => !locked.has(unit.getId()) && !c91Still(unit) && c91TouchesBack(unit, board),
        );
        c91Slide(board, extras, peel ? c91PeelGap(threats) : 4, ends);
    }
    const mode = c91GuardMode(threats, splashCase, outnumber);
    const pierce = threats.fireBreath || threats.skewerStrike || threats.throughShot;
    const exempt = new Set<string>();
    if (splashCase) {
        for (const guard of spread) exempt.add(guard.getId());
    }
    const flyerTargets = mode === "flyers" ? c91CornerFront(board, ends) : [];
    if (mode === "flyers") {
        const claimed = new Set<string>();
        for (const target of flyerTargets) {
            const lat = board.geom.lateral(target);
            const onFile = guards
                .filter((guard) => !claimed.has(guard.getId()) && board.laterals(guard).includes(lat))
                .sort((a, b) => {
                    const aAnchor = board.cells.get(a.getId());
                    const bAnchor = board.cells.get(b.getId());
                    const aDist = aAnchor ? chebyshev(aAnchor, target) : Infinity;
                    const bDist = bAnchor ? chebyshev(bAnchor, target) : Infinity;
                    return aDist - bDist || byId(a, b);
                });
            const pick = onFile[0];
            if (!pick) continue;
            claimed.add(pick.getId());
            exempt.add(pick.getId());
        }
    }
    if (pierce || spin) c91Clear(board, exempt, ends);
    if (mode === "flyers") {
        const seated = new Set<string>();
        for (const target of flyerTargets) {
            const lat = board.geom.lateral(target);
            const kept = guards.find(
                (guard) =>
                    exempt.has(guard.getId()) && !seated.has(guard.getId()) && board.laterals(guard).includes(lat),
            );
            if (kept) {
                c91MoveOnto(board, kept, target, allowAny);
                seated.add(kept.getId());
                continue;
            }
            c91FillTargets(
                board,
                guards.filter((guard) => !seated.has(guard.getId())),
                [target],
                allowAny,
            );
            const placed = guards.find((guard) => !seated.has(guard.getId()) && c91Covers(guard, target, board));
            if (placed) seated.add(placed.getId());
        }
        return board.cells;
    }
    if (mode === "beside") {
        const bowLats = c91BowLaterals(board);
        c91FillTargets(board, guards, c91BesideTargets(board, ends), (footprint) =>
            footprint.every((cell) => !bowLats.has(board.geom.lateral(cell))),
        );
        return board.cells;
    }
    if (mode === "centre") {
        const laterals = c91CentreLaterals(board, ends, pierce || threats.lightningSpin);
        const front = ranksOf(board).front;
        const targets: XY[] = [];
        for (const lat of laterals) {
            const cell = r3Cell(board, front, lat);
            if (cell) targets.push(cell);
        }
        const between = new Set<number>();
        if (laterals.length === 2) {
            for (let lat = laterals[0] + 1; lat < laterals[1]; lat += 1) between.add(lat);
        }
        const bowLats = c91BowLaterals(board);
        c91FillTargets(board, guards, targets, (footprint) =>
            footprint.every((cell) => {
                const lat = board.geom.lateral(cell);
                return !bowLats.has(lat) && !between.has(lat);
            }),
        );
    }
    return board.cells;
}

/** Range stacks and these names never move. Monk and Dryad are also range. */
const C92_STILL = new Set(["Monk", "Dryad", "Abomination", "Angel", "Arachna Queen"]);

const c92Fixed = (unit: Unit): boolean => unit.getAttackType() === RANGE || C92_STILL.has(unit.getName());

/** Ground melee body. Troll counts; chargers, flyers, bows, spellbooks, and the still names do not. */
const c92Screen = (unit: Unit): boolean => {
    if (c92Fixed(unit) || unit.canFly() || isCharger(unit) || isSpellbookUnit(unit)) return false;
    if (unit.getAttackType() === MELEE) return true;
    return unit.getAttackType() === MELEE_MAGIC;
};

const c92Charger = (unit: Unit): boolean => !c92Fixed(unit) && isCharger(unit) && unit.getAttackType() !== RANGE;

/** Flying charger stays a charger. Angel and Arachna Queen are fixed by name. */
const c92Flyer = (unit: Unit): boolean =>
    !c92Fixed(unit) && unit.canFly() && !isCharger(unit) && unit.getAttackType() !== RANGE;

const c92Ground = (unit: Unit): boolean => !unit.canFly() && (c92Screen(unit) || c92Charger(unit));

const c92Placed = (board: IBoard, accept: (unit: Unit) => boolean): Unit[] =>
    board.units.filter((unit) => accept(unit) && board.cells.has(unit.getId()));

const c92Flyers = (board: IBoard): Unit[] => c92Placed(board, c92Flyer).sort(byId);

const c92Screens = (board: IBoard): Unit[] => c92Placed(board, c92Screen);

const c92Fastest = (board: IBoard): Unit | undefined => c92Placed(board, c92Charger).sort(c62BySpeed)[0];

const c92CentreLat = (board: IBoard): number | undefined => {
    const cell = c62CentreCell(board);
    return cell ? board.geom.lateral(cell) : undefined;
};

const c92Hit = (span: ISpan, keys: ReadonlySet<number>): boolean => span.cells.some((cell) => keys.has(keyOf(cell)));

/** Distance to the nearest blocked file. An empty block is not a constraint. */
const c92Dist = (lat: number, blocked: ReadonlySet<number>): number => {
    if (!blocked.size) return 0;
    let best = Infinity;
    for (const other of blocked) best = Math.min(best, Math.abs(lat - other));
    return best;
};

const c92NearFiles = (files: readonly number[], blocked: ReadonlySet<number>, minDist: number): number[] =>
    files
        .filter((lat) => (blocked.size ? c92Dist(lat, blocked) >= minDist : minDist <= 0))
        .sort((a, b) => c92Dist(a, blocked) - c92Dist(b, blocked) || a - b);

type C92Allow = (unit: Unit, span: ISpan) => boolean;

/** Charger stays off the centre middle. Screen stays off the back centre. */
const c92Hard = (board: IBoard): C92Allow => {
    const centre = c92CentreLat(board);
    const ranks = c62Ranks(board);
    const middle = centre === undefined ? undefined : r3Cell(board, ranks.middle, centre);
    const back = centre === undefined ? undefined : r3Cell(board, ranks.back, centre);
    const middleKey = middle ? keyOf(middle) : undefined;
    const backKey = back ? keyOf(back) : undefined;
    return (unit, span) => {
        if (middleKey !== undefined && c92Charger(unit) && c92Hit(span, new Set([middleKey]))) return false;
        if (backKey !== undefined && c92Screen(unit) && c92Hit(span, new Set([backKey]))) return false;
        return true;
    };
};

const c92Cover = (
    board: IBoard,
    taken: ReadonlySet<number>,
    unit: Unit,
    allow: C92Allow,
    accept: (span: ISpan) => boolean,
    score: (span: ISpan) => number,
): XY | undefined => c62Pick(unit, board, taken, (span) => accept(span) && allow(unit, span), score);

const c92OnRank = (
    board: IBoard,
    taken: ReadonlySet<number>,
    unit: Unit,
    rank: number,
    lat: number,
    allow: C92Allow,
    onlyFile: boolean,
): XY | undefined => {
    const cell = r3Cell(board, rank, lat);
    if (!cell) return undefined;
    return c92Cover(
        board,
        taken,
        unit,
        allow,
        (span) =>
            span.minFront === rank &&
            span.maxFront === rank &&
            c62Covers(span, cell) &&
            (!onlyFile || span.laterals.every((value) => value === lat)),
        (span) => span.cells.length,
    );
};

const c92Take = (
    board: IBoard,
    taken: Set<number>,
    plan: Map<string, XY>,
    unit: Unit,
    anchor: XY,
): ISpan | undefined => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span || !spanIsLegal(span, board.geom, taken)) return undefined;
    for (const cell of span.cells) taken.add(keyOf(cell));
    plan.set(unit.getId(), { x: anchor.x, y: anchor.y });
    return span;
};

const c92Hold = (taken: Set<number>, span: ISpan | undefined): void => {
    if (!span) return;
    for (const cell of span.cells) taken.add(keyOf(cell));
};

const c92Incumbent = (board: IBoard, unit: Unit): ISpan | undefined => {
    const anchor = board.cells.get(unit.getId());
    return anchor ? spanAt(unit, anchor, board.geom) : undefined;
};

const c92Reserved = (board: IBoard, plan: ReadonlyMap<string, XY>): Set<number> => {
    const keys = new Set<number>();
    for (const [id, anchor] of plan) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) keys.add(keyOf(cell));
    }
    return keys;
};

const c92Forbid = (
    board: IBoard,
    forbidden: Set<number>,
    reserved: ReadonlySet<number>,
    accept: (cell: XY) => boolean,
): void => {
    for (const cell of board.geom.baseCells) {
        if (!accept(cell)) continue;
        const key = keyOf(cell);
        if (!reserved.has(key)) forbidden.add(key);
    }
};

const c92ForbidLat = (board: IBoard, forbidden: Set<number>, reserved: ReadonlySet<number>, lat: number): void => {
    c92Forbid(board, forbidden, reserved, (cell) => board.geom.lateral(cell) === lat);
};

/**
 * Planned seats apply only when they are legal. Anyone left over keeps the incumbent cell when that
 * cell is still free and allowed; an overlap or a forbidden cell is the only reason to step aside.
 * Failure writes nothing, so the whole post-pass keeps today's map.
 */
const c92Apply = (
    board: IBoard,
    plan: ReadonlyMap<string, XY>,
    forbidden: ReadonlySet<number>,
    allow: C92Allow,
): boolean => {
    const fixed = new Set(
        board.units.filter((unit) => c92Fixed(unit) && board.cells.has(unit.getId())).map((unit) => unit.getId()),
    );
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!fixed.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const assigned = new Map<string, XY>();
    const claim = (unit: Unit, anchor: XY): boolean => {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) return false;
        for (const cell of span.cells) taken.add(keyOf(cell));
        assigned.set(unit.getId(), { x: anchor.x, y: anchor.y });
        return true;
    };
    const planned = board.units
        .filter((unit) => plan.has(unit.getId()) && !fixed.has(unit.getId()))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of planned) {
        const anchor = plan.get(unit.getId());
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!anchor || !span || c92Hit(span, forbidden) || !allow(unit, span)) continue;
        claim(unit, anchor);
    }
    const rest = board.units
        .filter((unit) => board.cells.has(unit.getId()) && !fixed.has(unit.getId()) && !assigned.has(unit.getId()))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of rest) {
        const current = board.cells.get(unit.getId());
        const currentSpan = current ? spanAt(unit, current, board.geom) : undefined;
        if (
            current &&
            currentSpan &&
            !c92Hit(currentSpan, forbidden) &&
            allow(unit, currentSpan) &&
            claim(unit, current)
        ) {
            continue;
        }
        const nearest = (gate: (span: ISpan) => boolean): XY | undefined =>
            c62Pick(
                unit,
                board,
                taken,
                (span) => gate(span),
                (span) => (current ? chebyshev(c62Centre(span), current) * 100 + span.cells.length : span.cells.length),
            );
        const choice =
            nearest((span) => !c92Hit(span, forbidden) && allow(unit, span)) ??
            nearest((span) => allow(unit, span)) ??
            nearest(() => true);
        if (!choice || !claim(unit, choice)) return false;
    }
    for (const [id, anchor] of assigned) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const c92CloseRunway = (board: IBoard, taken: Set<number>, plan: Map<string, XY>, allow: C92Allow): void => {
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const covers = (unit: Unit, anchor: XY | undefined): boolean => {
        if (!anchor) return false;
        const span = spanAt(unit, anchor, board.geom);
        return !!span && span.laterals.includes(centre);
    };
    for (const unit of board.units) {
        if (c92Fixed(unit) && covers(unit, board.cells.get(unit.getId()))) return;
        if (covers(unit, plan.get(unit.getId()))) return;
    }
    const screens = c92Screens(board)
        .filter((unit) => !plan.has(unit.getId()))
        .sort(c62ByArmor);
    for (const screen of screens) {
        const anchor = c92OnRank(board, taken, screen, ranks.front, centre, allow, true);
        if (!anchor || !c92Take(board, taken, plan, screen, anchor)) continue;
        return;
    }
};

/** Largest non-flying body on the front centre. A non-small plug clears every lateral it covers. */
const c92Skewer = (board: IBoard): void => {
    const allow = c92Hard(board);
    const centre = c92CentreLat(board);
    const centreCell = c62CentreCell(board);
    if (centre === undefined || !centreCell) return;
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const plug = c92Placed(board, c92Ground).sort(c62ByLargest)[0];
    let plugSpan: ISpan | undefined;
    if (plug) {
        const anchor = c62SeatCentre(plug, board, taken, false);
        const span = anchor ? spanAt(plug, anchor, board.geom) : undefined;
        if (anchor && span && allow(plug, span)) plugSpan = c92Take(board, taken, plan, plug, anchor);
        if (!plugSpan) {
            const current = board.cells.get(plug.getId());
            if (current) plugSpan = c92Take(board, taken, plan, plug, current);
        }
    }
    const plugLats = new Set(plugSpan?.laterals ?? []);
    const small = [
        ...c92Screens(board)
            .filter((unit) => unit.isSmallSize() && unit.getId() !== plug?.getId())
            .sort(c62ByArmor),
        ...c92Flyers(board)
            .filter((unit) => unit.isSmallSize())
            .sort(byId),
    ];
    const outside = c92NearFiles(c82Files(board), plugLats, 1);
    const used = new Set<number>();
    const ranks = c62Ranks(board);
    for (const unit of small) {
        for (const lat of outside) {
            if (used.has(lat) || plugLats.has(lat)) continue;
            const anchor = c92OnRank(board, taken, unit, ranks.back, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, unit, anchor);
            if (!span) continue;
            for (const file of span.laterals) used.add(file);
            break;
        }
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    if (plug && plugSpan && !plug.isSmallSize()) {
        c92Forbid(board, forbidden, reserved, (cell) => plugLats.has(board.geom.lateral(cell)));
    }
    for (const lat of used) c92ForbidLat(board, forbidden, reserved, lat);
    c92Apply(board, plan, forbidden, allow);
};

/** Breath pierces, so the face is a screen, not a large plug. Charger steps low; flyers step high. */
const c92Breath = (board: IBoard): void => {
    const allow = c92Hard(board);
    const centre = c92CentreLat(board);
    const centreCell = c62CentreCell(board);
    if (centre === undefined || !centreCell) return;
    const ranks = c62Ranks(board);
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const screen = c92Screens(board).sort(c62ByArmor)[0];
    const middle = r3Cell(board, ranks.middle, centre);
    let screenSpan: ISpan | undefined;
    let seated = false;
    if (screen) {
        const anchor = c92Cover(
            board,
            taken,
            screen,
            allow,
            (span) =>
                span.minFront === ranks.front &&
                span.maxFront === ranks.front &&
                c62Covers(span, centreCell) &&
                !(middle && c62Covers(span, middle)),
            (span) => span.laterals.length * 100 + Math.abs(medianNumber(span.laterals) - board.geom.centreLat),
        );
        if (anchor) screenSpan = c92Take(board, taken, plan, screen, anchor);
        seated = !!screenSpan;
        if (!screenSpan) {
            screenSpan = c92Incumbent(board, screen);
            c92Hold(taken, screenSpan);
        }
    }
    const screenLats = new Set(screenSpan?.laterals ?? (screen ? [] : [centre]));
    if (!screenLats.size) screenLats.add(centre);
    const charger = c92Fastest(board);
    if (charger && charger.getId() !== screen?.getId()) {
        const lat = Math.min(...screenLats) - 1;
        const anchor = c92OnRank(board, taken, charger, ranks.middle, lat, allow, true);
        if (anchor) c92Take(board, taken, plan, charger, anchor);
    }
    let next = Math.max(...screenLats) + 1;
    const maxLat = c62Ranks(board).maxLat;
    for (const flyer of c92Flyers(board)) {
        for (let lat = next; lat <= maxLat; lat += 1) {
            if (screenLats.has(lat)) continue;
            const anchor = c92OnRank(board, taken, flyer, ranks.back, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, flyer, anchor);
            if (!span) continue;
            next = Math.max(...span.laterals) + 1;
            break;
        }
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    if (seated && screenSpan) {
        const behind = screenSpan.maxFront - 1;
        c92Forbid(
            board,
            forbidden,
            reserved,
            (cell) => board.geom.frontness(cell) === behind && screenLats.has(board.geom.lateral(cell)),
        );
    }
    c92Apply(board, plan, forbidden, allow);
};

/** One body on a file. The screen owns the centre face; the charger and flyers stay two files off. */
const c92Through = (board: IBoard): void => {
    const allow = c92Hard(board);
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const files = c82Files(board);
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const screen = c92Screens(board).sort(c62ByArmor)[0];
    const shadow = new Set<number>([centre]);
    let screenSeated = false;
    if (screen) {
        const anchor = c92OnRank(board, taken, screen, ranks.front, centre, allow, true);
        const span = anchor ? c92Take(board, taken, plan, screen, anchor) : undefined;
        if (span) {
            screenSeated = true;
            shadow.clear();
            for (const lat of span.laterals) shadow.add(lat);
        } else {
            c92Hold(taken, c92Incumbent(board, screen));
        }
    }
    const charger = c92Fastest(board);
    const chargeLats = new Set<number>();
    if (charger && charger.getId() !== screen?.getId()) {
        for (const lat of c92NearFiles(files, shadow, 2)) {
            const anchor = c92OnRank(board, taken, charger, ranks.back, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, charger, anchor);
            if (!span) continue;
            for (const file of span.laterals) chargeLats.add(file);
            break;
        }
    }
    const blocked = new Set<number>([...shadow, ...chargeLats]);
    const flyerFiles = c92NearFiles(files, blocked, 2);
    const used = new Set<number>();
    for (const flyer of c92Flyers(board)) {
        for (const lat of flyerFiles) {
            if (used.has(lat)) continue;
            const anchor = c92OnRank(board, taken, flyer, ranks.middle, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, flyer, anchor);
            if (!span) continue;
            for (const file of span.laterals) used.add(file);
            break;
        }
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    if (screenSeated) {
        for (const lat of shadow) c92ForbidLat(board, forbidden, reserved, lat);
    }
    for (const lat of [...chargeLats, ...used]) c92ForbidLat(board, forbidden, reserved, lat);
    c92Apply(board, plan, forbidden, allow);
};

const c92PackBack = (
    board: IBoard,
    units: readonly Unit[],
    taken: Set<number>,
    plan: Map<string, XY>,
    allow: C92Allow,
    acceptLat: (lat: number) => boolean,
): void => {
    const ranks = c62Ranks(board);
    const files = c82Files(board).filter(acceptLat);
    const pending = [...units];
    let index = 0;
    while (index < files.length && pending.length > 0) {
        const lat = files[index];
        if (lat === undefined) break;
        let placed = false;
        for (let i = 0; i < pending.length; i += 1) {
            const unit = pending[i];
            if (!unit) continue;
            const anchor = c92Cover(
                board,
                taken,
                unit,
                allow,
                (span) =>
                    span.minFront === ranks.back &&
                    span.maxFront === ranks.back &&
                    span.minLat === lat &&
                    span.laterals.every(acceptLat),
                (span) => span.cells.length,
            );
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, unit, anchor);
            if (!span) continue;
            pending.splice(i, 1);
            const next = files.findIndex((file) => file > span.maxLat);
            index = next < 0 ? files.length : next;
            placed = true;
            break;
        }
        if (!placed) index += 1;
    }
};

/** Low half holds screens and our flyers. The charger takes only the outer front of the high half. */
const c92Outnumber = (board: IBoard, allow: C92Allow): void => {
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const centreLat = board.geom.centreLat;
    const ranks = c62Ranks(board);
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const lowScreen = (lat: number): boolean => halfOf(lat, centreLat) === "low" && lat !== centre;
    const screens = c92Screens(board).sort((a, b) => footprintArea(a) - footprintArea(b) || byId(a, b));
    c92PackBack(board, screens, taken, plan, allow, lowScreen);
    const flyerFiles = c82Files(board)
        .filter((lat) => halfOf(lat, centreLat) === "low")
        .sort((a, b) => Number(a !== centre) - Number(b !== centre) || a - b);
    for (const flyer of c92Flyers(board)) {
        for (const lat of flyerFiles) {
            const anchor = c92OnRank(board, taken, flyer, ranks.front, lat, allow, true);
            if (!anchor) continue;
            if (c92Take(board, taken, plan, flyer, anchor)) break;
        }
    }
    const high = c82Files(board).filter((lat) => halfOf(lat, centreLat) === "high");
    const outer = high[high.length - 1];
    const charger = c92Fastest(board);
    let chargerSpan: ISpan | undefined;
    if (charger && outer !== undefined) {
        const anchor = c92OnRank(board, taken, charger, ranks.front, outer, allow, true);
        if (anchor) chargerSpan = c92Take(board, taken, plan, charger, anchor);
    }
    if (charger && !chargerSpan) {
        chargerSpan = c92Incumbent(board, charger);
        c92Hold(taken, chargerSpan);
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    if (charger && chargerSpan && !plan.has(charger.getId())) {
        for (const cell of chargerSpan.cells) reserved.add(keyOf(cell));
    }
    c92Forbid(board, forbidden, reserved, (cell) => halfOf(board.geom.lateral(cell), centreLat) === "high");
    c92Apply(board, plan, forbidden, allow);
};

const c92BestPair = (
    board: IBoard,
    screen: Unit,
    flyer: Unit,
    taken: ReadonlySet<number>,
    centre: number,
    allow: C92Allow,
): { screen: XY; flyer: XY; score: number } | undefined => {
    const ranks = c62Ranks(board);
    let best: { screen: XY; flyer: XY; score: number } | undefined;
    for (const screenAnchor of board.geom.baseCells) {
        const screenSpan = spanAt(screen, screenAnchor, board.geom);
        if (!screenSpan || !spanIsLegal(screenSpan, board.geom, taken) || !allow(screen, screenSpan)) continue;
        if (screenSpan.minFront !== ranks.back || screenSpan.maxFront !== ranks.back) continue;
        if (screenSpan.laterals.includes(centre)) continue;
        const next = new Set(taken);
        for (const cell of screenSpan.cells) next.add(keyOf(cell));
        for (const flyerAnchor of board.geom.baseCells) {
            const flyerSpan = spanAt(flyer, flyerAnchor, board.geom);
            if (!flyerSpan || !spanIsLegal(flyerSpan, board.geom, next) || !allow(flyer, flyerSpan)) continue;
            if (flyerSpan.minFront !== ranks.back || flyerSpan.maxFront !== ranks.back) continue;
            if (flyerSpan.laterals.includes(centre)) continue;
            const lats = [...new Set([...screenSpan.laterals, ...flyerSpan.laterals])].sort((a, b) => a - b);
            const last = lats[lats.length - 1];
            const first = lats[0];
            if (first === undefined || last === undefined) continue;
            if (last - first + 1 !== lats.length) continue;
            if (minChebyshev(screenSpan.cells, flyerSpan.cells) !== 1) continue;
            const score = first * 10000 + last * 10 + (screenSpan.maxLat < flyerSpan.minLat ? 0 : 1);
            if (
                !best ||
                score < best.score ||
                (score === best.score &&
                    (screenAnchor.x < best.screen.x ||
                        (screenAnchor.x === best.screen.x && screenAnchor.y < best.screen.y)))
            ) {
                best = {
                    screen: { x: screenAnchor.x, y: screenAnchor.y },
                    flyer: { x: flyerAnchor.x, y: flyerAnchor.y },
                    score,
                };
            }
        }
    }
    return best;
};

/** Each flyer shares the back rank with one screen, low outer files first. Charger takes the far wing. */
const c92Paired = (board: IBoard, allow: C92Allow): void => {
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const screens = c92Screens(board).sort(c62ByArmor);
    const used = new Set<string>();
    let pairLow = true;
    let paired = false;
    for (const flyer of c92Flyers(board)) {
        let best: { screen: Unit; screenAnchor: XY; flyerAnchor: XY; score: number } | undefined;
        for (const screen of screens) {
            if (used.has(screen.getId())) continue;
            const pair = c92BestPair(board, screen, flyer, taken, centre, allow);
            if (!pair) continue;
            if (!best || pair.score < best.score) {
                best = { screen, screenAnchor: pair.screen, flyerAnchor: pair.flyer, score: pair.score };
            }
        }
        if (!best) continue;
        const screenSpan = c92Take(board, taken, plan, best.screen, best.screenAnchor);
        const flyerSpan = screenSpan ? c92Take(board, taken, plan, flyer, best.flyerAnchor) : undefined;
        if (!screenSpan || !flyerSpan) continue;
        used.add(best.screen.getId());
        if (!paired) pairLow = Math.min(screenSpan.minLat, flyerSpan.minLat) <= board.geom.centreLat;
        paired = true;
    }
    const files = c82Files(board);
    const outer = pairLow ? files[files.length - 1] : files[0];
    const charger = c92Fastest(board);
    const chargeLats = new Set<number>();
    if (charger && outer !== undefined) {
        const anchor = c92OnRank(board, taken, charger, ranks.front, outer, allow, true);
        if (anchor) {
            const span = c92Take(board, taken, plan, charger, anchor);
            if (span) for (const lat of span.laterals) chargeLats.add(lat);
        }
    }
    c92CloseRunway(board, taken, plan, allow);
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    for (const lat of chargeLats) c92ForbidLat(board, forbidden, reserved, lat);
    c92Apply(board, plan, forbidden, allow);
};

/** No flyer of our own. Charger steps one file off centre; a small screen keeps that file's back cell. */
const c92NoFlyer = (board: IBoard, allow: C92Allow): void => {
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const files = new Set(c82Files(board));
    const off = files.has(centre - 1) ? centre - 1 : files.has(centre + 1) ? centre + 1 : undefined;
    if (off === undefined) return;
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const charger = c92Fastest(board);
    const chargeLats = new Set<number>();
    if (charger) {
        const anchor = c92OnRank(board, taken, charger, ranks.front, off, allow, true);
        if (anchor) {
            const span = c92Take(board, taken, plan, charger, anchor);
            if (span) for (const lat of span.laterals) chargeLats.add(lat);
        }
    }
    const screen = c92Screens(board)
        .filter((unit) => unit.isSmallSize())
        .sort(c62ByArmor)[0];
    if (screen && chargeLats.size) {
        const lat = Math.min(...chargeLats);
        const anchor = c92OnRank(board, taken, screen, ranks.back, lat, allow, true);
        if (anchor) c92Take(board, taken, plan, screen, anchor);
    }
    c92CloseRunway(board, taken, plan, allow);
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    for (const lat of chargeLats) c92ForbidLat(board, forbidden, reserved, lat);
    c92Forbid(board, forbidden, reserved, (cell) => {
        const lat = board.geom.lateral(cell);
        return lat === centre && board.geom.frontness(cell) !== ranks.front;
    });
    c92Apply(board, plan, forbidden, allow);
};

const c92EnemyFlyers = (board: IBoard): void => {
    const allow = c92Hard(board);
    const flyers = c92Flyers(board);
    const screens = c92Screens(board);
    if (flyers.length > screens.length) c92Outnumber(board, allow);
    else if (flyers.length > 0) c92Paired(board, allow);
    else c92NoFlyer(board, allow);
};

/** Slowest screen baits the centre file. Other screens and the charger stay two files away. */
const c92Ranged = (board: IBoard): void => {
    const allow = c92Hard(board);
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const files = c82Files(board);
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const screens = c92Screens(board);
    const bait = [...screens].sort((a, b) => a.getSteps() - b.getSteps() || byId(a, b))[0];
    let baitSpan: ISpan | undefined;
    if (bait) {
        const anchor = c92OnRank(board, taken, bait, ranks.front, centre, allow, true);
        if (anchor) baitSpan = c92Take(board, taken, plan, bait, anchor);
        if (!baitSpan) {
            baitSpan = c92Incumbent(board, bait);
            c92Hold(taken, baitSpan);
        }
    }
    const charger = c92Fastest(board);
    const chargeLats = new Set<number>();
    if (charger) {
        for (const lat of c92NearFiles(files, new Set([centre]), 2)) {
            const anchor = c92OnRank(board, taken, charger, ranks.back, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, charger, anchor);
            if (!span) continue;
            for (const file of span.laterals) chargeLats.add(file);
            break;
        }
    }
    const blocked = new Set<number>([centre, ...chargeLats]);
    const destinations = c92NearFiles(files, blocked, 2);
    const screenFiles = new Set<number>();
    const others = screens.filter((unit) => unit.getId() !== bait?.getId()).sort(c62ByArmor);
    for (const screen of others) {
        for (const lat of destinations) {
            if (screenFiles.has(lat)) continue;
            const anchor = c92OnRank(board, taken, screen, ranks.front, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, screen, anchor);
            if (!span) continue;
            for (const file of span.laterals) screenFiles.add(file);
            break;
        }
    }
    const flyerUsed = new Set<number>();
    for (const flyer of c92Flyers(board)) {
        for (const lat of screenFiles) {
            if (flyerUsed.has(lat)) continue;
            const anchor = c92OnRank(board, taken, flyer, ranks.middle, lat, allow, true);
            if (!anchor) continue;
            const span = c92Take(board, taken, plan, flyer, anchor);
            if (!span) continue;
            for (const file of span.laterals) flyerUsed.add(file);
            break;
        }
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    if (baitSpan && !plan.has(bait?.getId() ?? "")) {
        for (const cell of baitSpan.cells) reserved.add(keyOf(cell));
    }
    c92ForbidLat(board, forbidden, reserved, centre);
    for (const lat of chargeLats) c92ForbidLat(board, forbidden, reserved, lat);
    c92Forbid(board, forbidden, reserved, (cell) => board.geom.frontness(cell) === ranks.front);
    c92Apply(board, plan, forbidden, allow);
};

/**
 * Checker, not a wall: screens on centre, centre-2, and centre+2. Charger backs centre-1.
 * The first flyer backs centre+1. Neither of those files takes a screen.
 */
const c92Checker = (board: IBoard): void => {
    const centre = c92CentreLat(board);
    if (centre === undefined) return;
    const ranks = c62Ranks(board);
    const files = new Set(c82Files(board));
    const slots = [centre, centre - 2, centre + 2].filter((lat) => files.has(lat));
    const slotKeys = new Set<number>();
    for (const lat of slots) {
        const cell = r3Cell(board, ranks.front, lat);
        if (cell) slotKeys.add(keyOf(cell));
    }
    const hard = c92Hard(board);
    const allow: C92Allow = (unit, span) => {
        if (!hard(unit, span)) return false;
        if (!c92Screen(unit)) return true;
        if (span.laterals.some((lat) => lat === centre - 1 || lat === centre + 1)) return false;
        const frontCells = span.cells.filter((cell) => board.geom.frontness(cell) === ranks.front);
        if (!frontCells.length) return true;
        return frontCells.every((cell) => slotKeys.has(keyOf(cell)));
    };
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!c92Fixed(unit)) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const plan = new Map<string, XY>();
    const screens = c92Screens(board).sort(c62ByArmor);
    for (const lat of slots) {
        for (const screen of screens) {
            if (plan.has(screen.getId())) continue;
            const anchor = c92OnRank(board, taken, screen, ranks.front, lat, allow, true);
            if (!anchor || !c92Take(board, taken, plan, screen, anchor)) continue;
            break;
        }
    }
    const charger = c92Fastest(board);
    if (charger && files.has(centre - 1)) {
        const anchor = c92OnRank(board, taken, charger, ranks.back, centre - 1, allow, true);
        if (anchor) c92Take(board, taken, plan, charger, anchor);
    }
    const flyer = c92Flyers(board)[0];
    if (flyer && files.has(centre + 1)) {
        const anchor = c92OnRank(board, taken, flyer, ranks.back, centre + 1, allow, true);
        if (anchor) c92Take(board, taken, plan, flyer, anchor);
    }
    const forbidden = new Set<number>();
    const reserved = c92Reserved(board, plan);
    c92Forbid(board, forbidden, reserved, (cell) => {
        const lat = board.geom.lateral(cell);
        if (lat !== centre - 1 && lat !== centre + 1) return false;
        return board.geom.frontness(cell) !== ranks.back;
    });
    c92Apply(board, plan, forbidden, allow);
};

/**
 * r9c2 post-pass. Today's placeArmy has already run. Screens, chargers, and non-range flyers reseat.
 * Range stacks, Monk, Dryad, Abomination, Angel, and Arachna Queen stay. Area Throw and Large Caliber
 * leave the map alone. A straight line is Fire Breath, Skewer Strike, or Through Shot. The first
 * matching branch is the only one. An illegal seat keeps the incumbent cell. The zone is not extended.
 */
export function placeArmyR9C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const straight = threats.fireBreath || threats.skewerStrike || threats.throughShot;
    if (threats.skewerStrike && !threats.fireBreath) c92Skewer(board);
    else if (threats.fireBreath) c92Breath(board);
    else if (threats.throughShot) c92Through(board);
    else if (threats.flyers > 0) c92EnemyFlyers(board);
    else if (threats.rangeCreatures > 0) c92Ranged(board);
    else if (!straight) c92Checker(board);
    return board.cells;
}

interface IC93Zone {
    readonly back: number;
    readonly middle: number | undefined;
    readonly front: number;
    readonly laterals: readonly number[];
}

interface IC93Seat {
    readonly id: string;
    readonly cells: readonly XY[];
}

const c93At = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c93Unit = (board: IBoard, id: string): Unit | undefined => board.units.find((unit) => unit.getId() === id);

const c93Foot = (unit: Unit, anchor: XY): XY[] => footprintCellsForAnchor(unit, anchor);

const c93Zone = (board: IBoard): IC93Zone => {
    const ranks = ranksOf(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        const back = r3Cell(board, ranks.back, lat);
        if (!back || isBoardEdge(back) || !board.geom.legal.has(keyOf(back))) continue;
        laterals.push(lat);
    }
    return {
        back: ranks.back,
        middle: ranks.front >= ranks.back + 2 ? ranks.back + 1 : undefined,
        front: ranks.front,
        laterals,
    };
};

const c93Cell = (board: IBoard, rank: number, lat: number): XY | undefined => {
    const cell = r3Cell(board, rank, lat);
    if (!cell || isBoardEdge(cell) || !board.geom.legal.has(keyOf(cell))) return undefined;
    return cell;
};

const c93File = (board: IBoard, lat: number): XY[] => {
    const zone = c93Zone(board);
    const cells: XY[] = [];
    for (let rank = zone.back; rank <= zone.front; rank += 1) {
        const cell = c93Cell(board, rank, lat);
        if (cell) cells.push(cell);
    }
    return cells;
};

const c93Ring = (board: IBoard, foot: readonly XY[]): XY[] =>
    board.geom.baseCells.filter((cell) => {
        if (isBoardEdge(cell) || foot.some((entry) => sameCell(entry, cell))) return false;
        return minChebyshev([cell], foot) === 1;
    });

const c93ByHp = (a: Unit, b: Unit): number => b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b);

const c93OnCorner = (unit: Unit, board: IBoard): boolean => {
    const zone = c93Zone(board);
    const min = zone.laterals[0];
    const max = zone.laterals[zone.laterals.length - 1];
    if (min === undefined || max === undefined) return false;
    return board.footprint(unit).some((cell) => {
        if (board.geom.frontness(cell) !== zone.back) return false;
        const lat = board.geom.lateral(cell);
        return lat === min || lat === max;
    });
};

const c93MonkFallback = (board: IBoard): boolean =>
    !board.units.some((unit) => isCasterUnit(unit) && board.footprint(unit).length > 0) &&
    board.units.some((unit) => unit.getName() === "Monk" && board.footprint(unit).length > 0);

const c93Immovable = (unit: Unit, board: IBoard, monkFallback: boolean): boolean => {
    if (unit.getName() === "Dryad" || PROTECTORS.has(unit.getName())) return true;
    if (unit.getAttackType() === RANGE && c93OnCorner(unit, board)) {
        return !(monkFallback && unit.getName() === "Monk");
    }
    return false;
};

/** Corner bows stay put, except Monk used as the caster fallback. Dryad and the named protectors never move. */
const c93Fixed = (board: IBoard, bows: boolean): Set<string> => {
    const monkFallback = c93MonkFallback(board);
    const fixed = new Set<string>();
    for (const unit of board.units) {
        if (!board.footprint(unit).length) continue;
        if (c93Immovable(unit, board, monkFallback)) fixed.add(unit.getId());
        if (bows && unit.getAttackType() === RANGE && !(monkFallback && unit.getName() === "Monk")) {
            fixed.add(unit.getId());
        }
    }
    return fixed;
};

const c93Protected = (board: IBoard): Unit[] => {
    const casters = board.units
        .filter((unit) => isCasterUnit(unit) && board.footprint(unit).length > 0)
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    if (casters.length) return casters;
    return board.units.filter((unit) => unit.getName() === "Monk" && board.footprint(unit).length > 0).sort(byId);
};

const c93ScreenUnit = (unit: Unit): boolean =>
    unit.isSmallSize() &&
    !unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !isCasterUnit(unit) &&
    unit.getName() !== "Monk" &&
    unit.getName() !== "Dryad" &&
    !PROTECTORS.has(unit.getName());

const c93Screens = (board: IBoard): Unit[] =>
    board.units.filter((unit) => c93ScreenUnit(unit) && board.footprint(unit).length > 0).sort(c93ByHp);

const c93FrontCentre = (board: IBoard): XY | undefined => {
    const zone = c93Zone(board);
    const laterals = zone.laterals.filter((lat) => c93Cell(board, zone.front, lat) !== undefined);
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    const lat = laterals[0];
    return lat === undefined ? undefined : c93Cell(board, zone.front, lat);
};

const c93Toward = (lat: number, centre: number): number => (lat < centre ? 1 : lat > centre ? -1 : 0);

const c93FixedFeet = (board: IBoard, fixed: ReadonlySet<string>, ignore: ReadonlySet<string>): XY[][] => {
    const feet: XY[][] = [];
    for (const unit of board.units) {
        if (!fixed.has(unit.getId()) || ignore.has(unit.getId())) continue;
        const cells = board.footprint(unit);
        if (cells.length) feet.push(cells);
    }
    return feet;
};

const c93Hits = (cells: readonly XY[], feet: readonly (readonly XY[])[]): boolean =>
    feet.some((foot) => foot.length > 0 && minChebyshev(cells, foot) === 0);

const c93Write = (board: IBoard, moves: ReadonlyMap<string, XY>): void => {
    for (const [id, anchor] of moves) {
        const current = board.cells.get(id);
        if (current && sameCell(current, anchor)) continue;
        board.cells.set(id, c93At(anchor));
    }
};

const c93Discover = (
    board: IBoard,
    moves: ReadonlyMap<string, XY>,
    empty: ReadonlySet<number>,
    fixed: ReadonlySet<string>,
    separateAll: boolean,
    strict: (unit: Unit, cells: readonly XY[], feet: readonly IC93Seat[]) => boolean,
): Set<string> | undefined => {
    const seeds: IC93Seat[] = [];
    for (const [id, anchor] of moves) {
        const unit = c93Unit(board, id);
        const cells = unit ? c93Foot(unit, anchor) : [];
        if (cells.length) seeds.push({ id, cells });
    }
    const pending = new Set<string>();
    let grew = true;
    while (grew) {
        grew = false;
        const feet: IC93Seat[] = seeds.filter((seat) => !pending.has(seat.id));
        for (const unit of board.units) {
            if (moves.has(unit.getId()) || pending.has(unit.getId())) continue;
            const cells = board.footprint(unit);
            if (cells.length) feet.push({ id: unit.getId(), cells });
        }
        for (const unit of board.units) {
            if (moves.has(unit.getId()) || pending.has(unit.getId())) continue;
            const cells = board.footprint(unit);
            if (!cells.length) continue;
            const hitsEmpty = cells.some((cell) => empty.has(keyOf(cell)));
            const hitsSeed =
                seeds.some((seat) => minChebyshev(cells, seat.cells) === 0) ||
                (separateAll && seeds.some((seat) => minChebyshev(cells, seat.cells) <= 1));
            const overlaps = feet.some((seat) => seat.id !== unit.getId() && minChebyshev(cells, seat.cells) === 0);
            const close =
                separateAll && feet.some((seat) => seat.id !== unit.getId() && minChebyshev(cells, seat.cells) <= 1);
            const forced = strict(unit, cells, feet);
            if (fixed.has(unit.getId())) {
                if (hitsEmpty || hitsSeed || forced) return undefined;
                continue;
            }
            if (!hitsEmpty && !overlaps && !close && !forced) continue;
            pending.add(unit.getId());
            grew = true;
            break;
        }
    }
    return pending;
};

const c93PlacePending = (
    board: IBoard,
    seed: ReadonlyMap<string, XY>,
    pending: ReadonlySet<string>,
    empty: ReadonlySet<number>,
    avoid: ReadonlySet<number>,
    separateAll: boolean,
    order: (a: Unit, b: Unit) => number,
    accept: (unit: Unit, span: ISpan, feet: readonly IC93Seat[]) => boolean,
): Map<string, XY> | undefined => {
    const moves = new Map<string, XY>();
    for (const [id, anchor] of seed) moves.set(id, c93At(anchor));
    const left = new Set(pending);
    const evictees = board.units.filter((unit) => left.has(unit.getId())).sort(order);
    for (const unit of evictees) {
        const current = board.cells.get(unit.getId());
        const blocked = new Set<number>();
        const feet: IC93Seat[] = [];
        const remember = (id: string, cells: readonly XY[]): void => {
            feet.push({ id, cells });
            for (const cell of cells) blocked.add(keyOf(cell));
        };
        for (const [id, anchor] of moves) {
            const owner = c93Unit(board, id);
            if (!owner) return undefined;
            remember(id, c93Foot(owner, anchor));
        }
        for (const other of board.units) {
            if (other.getId() === unit.getId() || left.has(other.getId()) || moves.has(other.getId())) continue;
            const cells = board.footprint(other);
            if (cells.length) remember(other.getId(), cells);
        }
        let best: XY | undefined;
        let bestDist = Infinity;
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(unit, anchor, board.geom);
            if (!span || !spanIsLegal(span, board.geom, blocked)) continue;
            if (span.cells.some((cell) => empty.has(keyOf(cell)) || avoid.has(keyOf(cell)))) continue;
            if (separateAll && feet.some((seat) => minChebyshev(span.cells, seat.cells) <= 1)) continue;
            if (!accept(unit, span, feet)) continue;
            const dist = current ? chebyshev(anchor, current) : 0;
            const better =
                !best ||
                dist < bestDist ||
                (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)));
            if (!better) continue;
            best = anchor;
            bestDist = dist;
        }
        if (!best) return undefined;
        moves.set(unit.getId(), c93At(best));
        left.delete(unit.getId());
    }
    return moves;
};

const c93Resolve = (
    board: IBoard,
    seed: ReadonlyMap<string, XY>,
    empty: ReadonlySet<number>,
    fixed: ReadonlySet<string>,
    separateAll: boolean,
    strict: (unit: Unit, cells: readonly XY[], feet: readonly IC93Seat[]) => boolean,
    accept: (unit: Unit, span: ISpan, feet: readonly IC93Seat[]) => boolean,
    avoid: ReadonlySet<number> = new Set(),
): Map<string, XY> | undefined => {
    const moves = new Map<string, XY>();
    const taken = new Set<number>();
    for (const [id, anchor] of seed) {
        const unit = c93Unit(board, id);
        if (!unit) return undefined;
        if (fixed.has(id)) {
            const current = board.cells.get(id);
            if (!current || !sameCell(current, anchor)) return undefined;
        }
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) return undefined;
        if (span.cells.some((cell) => empty.has(keyOf(cell)))) return undefined;
        for (const cell of span.cells) taken.add(keyOf(cell));
        moves.set(id, c93At(anchor));
    }
    const pending = c93Discover(board, moves, empty, fixed, separateAll, strict);
    if (!pending) return undefined;
    if (!pending.size) return moves;
    const orders = [
        (a: Unit, b: Unit) => byFootprintAreaLargestFirst(a, b) || byId(a, b),
        (a: Unit, b: Unit) => byId(a, b),
    ];
    for (const order of orders) {
        const placed = c93PlacePending(board, moves, pending, empty, avoid, separateAll, order, accept);
        if (placed) return placed;
    }
    return undefined;
};

const c93Commit = (
    board: IBoard,
    seed: ReadonlyMap<string, XY>,
    empty: ReadonlySet<number>,
    fixed: Set<string>,
    separateAll: boolean,
    strict: (unit: Unit, cells: readonly XY[], feet: readonly IC93Seat[]) => boolean = () => false,
    accept: (unit: Unit, span: ISpan, feet: readonly IC93Seat[]) => boolean = () => true,
    avoid: ReadonlySet<number> = new Set(),
): boolean => {
    for (const id of seed.keys()) fixed.delete(id);
    const resolved = c93Resolve(board, seed, empty, fixed, separateAll, strict, accept, avoid);
    if (!resolved) return false;
    c93Write(board, resolved);
    return true;
};

const c93BestBack = (
    board: IBoard,
    unit: Unit,
    placed: readonly (readonly XY[])[],
    empty: ReadonlySet<number>,
    fixed: ReadonlySet<string>,
    back: number,
    gap: number,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    const blocked = c93FixedFeet(board, fixed, new Set([unit.getId()]));
    let best: XY | undefined;
    let bestDist = Infinity;
    let bestPure = -1;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, new Set())) continue;
        if (span.minFront !== back) continue;
        if (unit.isSmallSize() && span.maxFront !== back) continue;
        if (span.cells.some((cell) => empty.has(keyOf(cell)))) continue;
        if (placed.some((foot) => minChebyshev(span.cells, foot) < gap)) continue;
        if (c93Hits(span.cells, blocked)) continue;
        if (c93Hits(c93Ring(board, span.cells), blocked)) continue;
        const pure = span.maxFront === back ? 1 : 0;
        const dist = current ? chebyshev(anchor, current) : 0;
        const better =
            !best ||
            pure > bestPure ||
            (pure === bestPure &&
                (dist < bestDist ||
                    (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))));
        if (!better) continue;
        best = anchor;
        bestDist = dist;
        bestPure = pure;
    }
    return best ? c93At(best) : undefined;
};

/** Area Throw, not Large Caliber. The screen is the boulder; casters sit at chebyshev >= 3 with an empty ring. */
const c93Area = (board: IBoard): boolean => {
    const protectedUnits = c93Protected(board);
    const screen = c93Screens(board)[0];
    if (!protectedUnits.length || !screen) return false;
    const centre = c93FrontCentre(board);
    if (!centre) return false;
    const zone = c93Zone(board);
    const screenSpan = spanAt(screen, centre, board.geom);
    if (!screenSpan || !spanIsLegal(screenSpan, board.geom, new Set())) return false;
    const screenFoot = screenSpan.cells;
    const fixed = c93Fixed(board, false);
    const blocked = c93FixedFeet(board, fixed, new Set([screen.getId()]));
    const screenRing = c93Ring(board, screenFoot);
    if (c93Hits(screenFoot, blocked) || c93Hits(screenRing, blocked)) return false;
    const protectedIds = new Set(protectedUnits.map((unit) => unit.getId()));
    const empty = new Set<number>();
    for (const cell of screenRing) empty.add(keyOf(cell));
    const seed = new Map<string, XY>([[screen.getId(), c93At(centre)]]);
    const placed: XY[][] = [[...screenFoot]];
    for (const unit of protectedUnits) {
        const spot = c93BestBack(board, unit, placed, empty, fixed, zone.back, 3);
        if (!spot) continue;
        const foot = c93Foot(unit, spot);
        seed.set(unit.getId(), spot);
        placed.push(foot);
        for (const cell of c93Ring(board, foot)) empty.add(keyOf(cell));
    }
    const strict = (unit: Unit, cells: readonly XY[], feet: readonly IC93Seat[]): boolean => {
        if (!protectedIds.has(unit.getId())) return false;
        if (!cells.length || !cells.every((cell) => board.geom.frontness(cell) === zone.back)) return true;
        if (unit.isSmallSize() && cells.some((cell) => board.geom.frontness(cell) !== zone.back)) return true;
        if (minChebyshev(cells, screenFoot) < 3) return true;
        return feet.some(
            (seat) => seat.id !== unit.getId() && protectedIds.has(seat.id) && minChebyshev(cells, seat.cells) < 3,
        );
    };
    const accept = (unit: Unit, span: ISpan, feet: readonly IC93Seat[]): boolean => {
        if (!protectedIds.has(unit.getId())) return true;
        if (span.minFront !== zone.back) return false;
        if (unit.isSmallSize() && span.maxFront !== zone.back) return false;
        if (minChebyshev(span.cells, screenFoot) < 3) return false;
        return !feet.some(
            (seat) => seat.id !== unit.getId() && protectedIds.has(seat.id) && minChebyshev(span.cells, seat.cells) < 3,
        );
    };
    if (c93Commit(board, seed, empty, c93Fixed(board, false), true, strict, accept)) return true;
    // A caster with no legal back seat keeps today's cell instead of cancelling the screen.
    return c93Commit(board, seed, empty, c93Fixed(board, false), true);
};

/** Large Caliber, not Area Throw. The shell lands on the screen, so chebyshev >= 2 is outside it. */
const c93Caliber = (board: IBoard): boolean => {
    const screen = c93Screens(board)[0];
    const protectedUnit = c93Protected(board).find((unit) => unit.isSmallSize());
    if (!screen || !protectedUnit) return false;
    const centre = c93FrontCentre(board);
    if (!centre) return false;
    const zone = c93Zone(board);
    const screenSpan = spanAt(screen, centre, board.geom);
    if (!screenSpan || !spanIsLegal(screenSpan, board.geom, new Set())) return false;
    const screenFoot = screenSpan.cells;
    const screenLat = board.geom.lateral(centre);
    const current = medianLat(protectedUnit, board);
    const laterals = [screenLat - 2, screenLat + 2].sort(
        (a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b,
    );
    for (const lat of laterals) {
        const anchor = c93Cell(board, zone.back, lat);
        if (!anchor) continue;
        const span = spanAt(protectedUnit, anchor, board.geom);
        if (!span || span.minFront !== zone.back || span.maxFront !== zone.back) continue;
        if (minChebyshev(span.cells, screenFoot) < 2) continue;
        const between = screenLat + Math.sign(lat - screenLat);
        const empty = new Set<number>();
        for (const cell of c93Ring(board, screenFoot)) empty.add(keyOf(cell));
        for (const cell of c93Ring(board, span.cells)) empty.add(keyOf(cell));
        for (const cell of c93File(board, between)) empty.add(keyOf(cell));
        const behind = c93Cell(board, zone.front - 1, screenLat);
        if (behind) empty.add(keyOf(behind));
        if ([...screenFoot, ...span.cells].some((cell) => empty.has(keyOf(cell)))) continue;
        const seed = new Map<string, XY>([
            [screen.getId(), c93At(centre)],
            [protectedUnit.getId(), c93At(anchor)],
        ]);
        if (c93Commit(board, seed, empty, c93Fixed(board, false), false)) return true;
    }
    const empty = new Set<number>();
    for (const cell of c93Ring(board, screenFoot)) empty.add(keyOf(cell));
    const behind = c93Cell(board, zone.front - 1, screenLat);
    if (behind) empty.add(keyOf(behind));
    if (screenFoot.some((cell) => empty.has(keyOf(cell)))) return false;
    const fixed = c93Fixed(board, false);
    fixed.add(protectedUnit.getId());
    return c93Commit(board, new Map([[screen.getId(), c93At(centre)]]), empty, fixed, false);
};

/** Fire Breath only. One empty lateral between the back-rank pair, and both middle cells stay empty. */
const c93Breath = (board: IBoard): boolean => {
    const zone = c93Zone(board);
    if (zone.middle === undefined) return false;
    const screen = c93Screens(board)[0];
    if (!screen) return false;
    const middle = zone.middle;
    for (const unit of c93Protected(board)) {
        if (!unit.isSmallSize()) continue;
        const pairs: { cost: number; seed: Map<string, XY>; empty: Set<number> }[] = [];
        const protectedLat = medianLat(unit, board);
        const screenLat = medianLat(screen, board);
        for (const lat of zone.laterals) {
            for (const sign of [2, -2] as const) {
                const other = lat + sign;
                const protectedCell = c93Cell(board, zone.back, lat);
                const screenCell = c93Cell(board, zone.back, other);
                const protectedMiddle = c93Cell(board, middle, lat);
                const screenMiddle = c93Cell(board, middle, other);
                const between = c93Cell(board, zone.back, lat + Math.sign(sign));
                if (!protectedCell || !screenCell || !protectedMiddle || !screenMiddle || !between) continue;
                const protectedFoot = c93Foot(unit, protectedCell);
                const screenFoot = c93Foot(screen, screenCell);
                if (minChebyshev(protectedFoot, screenFoot) !== 2) continue;
                const empty = new Set<number>([keyOf(protectedMiddle), keyOf(screenMiddle), keyOf(between)]);
                if ([...protectedFoot, ...screenFoot].some((cell) => empty.has(keyOf(cell)))) continue;
                pairs.push({
                    cost: Math.abs(lat - protectedLat) * 10 + Math.abs(other - screenLat),
                    seed: new Map<string, XY>([
                        [unit.getId(), c93At(protectedCell)],
                        [screen.getId(), c93At(screenCell)],
                    ]),
                    empty,
                });
            }
        }
        pairs.sort((a, b) => a.cost - b.cost || a.seed.size - b.seed.size);
        for (const pair of pairs) {
            const fixed = new Set(board.units.map((entry) => entry.getId()));
            if (c93Commit(board, pair.seed, pair.empty, fixed, false)) return true;
        }
    }
    return false;
};

const c93BackOrMiddle = (board: IBoard, span: ISpan): boolean => {
    const zone = c93Zone(board);
    if (zone.middle === undefined) return span.minFront === zone.back && span.maxFront === zone.back;
    return span.minFront >= zone.back && span.maxFront <= zone.middle && span.maxFront < zone.front;
};

/** Two or more flyers, and Meteor Shower: the adjacent screen steps out to chebyshev >= 3. */
const c93Meteor = (board: IBoard): boolean => {
    const protectedUnit = c93Protected(board)[0];
    const current = protectedUnit ? board.cells.get(protectedUnit.getId()) : undefined;
    if (!protectedUnit || !current) return false;
    const original = board.footprint(protectedUnit);
    if (!original.length) return false;
    const dangerous = c93Screens(board)
        .map((unit) => ({ unit, dist: minChebyshev(board.footprint(unit), original) }))
        .filter((entry) => entry.dist <= 2)
        .sort((a, b) => a.dist - b.dist || c93ByHp(a.unit, b.unit));
    const screen = dangerous[0]?.unit;
    const ignore = new Set([protectedUnit.getId(), screen?.getId() ?? ""]);
    const blocked = c93FixedFeet(board, c93Fixed(board, false), ignore);
    const clearRing = (cells: readonly XY[]): boolean =>
        !c93Hits(cells, blocked) && !c93Hits(c93Ring(board, cells), blocked);
    const spots: { anchor: XY; dist: number }[] = [];
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(protectedUnit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, new Set()) || !clearRing(span.cells)) continue;
        if (!sameCell(anchor, current) && !c93BackOrMiddle(board, span)) continue;
        spots.push({ anchor, dist: chebyshev(anchor, current) });
    }
    spots.sort(
        (a, b) =>
            a.dist - b.dist ||
            board.geom.frontness(a.anchor) - board.geom.frontness(b.anchor) ||
            board.geom.lateral(a.anchor) - board.geom.lateral(b.anchor),
    );
    const screenCurrent = screen ? board.cells.get(screen.getId()) : undefined;
    for (const spot of spots) {
        const foot = c93Foot(protectedUnit, spot.anchor);
        const empty = new Set<number>();
        for (const cell of c93Ring(board, foot)) empty.add(keyOf(cell));
        const screenSpots: { anchor: XY; dist: number }[] = [];
        if (screen) {
            for (const anchor of board.geom.baseCells) {
                const span = spanAt(screen, anchor, board.geom);
                if (!span || !spanIsLegal(span, board.geom, new Set()) || !c93BackOrMiddle(board, span)) continue;
                if (minChebyshev(span.cells, foot) < 3 || c93Hits(span.cells, blocked)) continue;
                screenSpots.push({ anchor, dist: screenCurrent ? chebyshev(anchor, screenCurrent) : 0 });
            }
            screenSpots.sort(
                (a, b) =>
                    a.dist - b.dist ||
                    board.geom.frontness(a.anchor) - board.geom.frontness(b.anchor) ||
                    board.geom.lateral(a.anchor) - board.geom.lateral(b.anchor),
            );
        }
        const seeds: Map<string, XY>[] = [];
        if (screen) {
            for (const screenSpot of screenSpots) {
                const seed = new Map<string, XY>();
                if (!sameCell(spot.anchor, current)) seed.set(protectedUnit.getId(), c93At(spot.anchor));
                seed.set(screen.getId(), c93At(screenSpot.anchor));
                seeds.push(seed);
            }
        } else {
            const seed = new Map<string, XY>();
            if (!sameCell(spot.anchor, current)) seed.set(protectedUnit.getId(), c93At(spot.anchor));
            seeds.push(seed);
        }
        for (const seed of seeds) {
            if (!seed.size && [...empty].every((cell) => !c93Occupies(board, cell, protectedUnit.getId()))) {
                return true;
            }
            if (c93Commit(board, seed, empty, c93Fixed(board, false), false)) return true;
        }
    }
    return false;
};

const c93Occupies = (board: IBoard, cellKey: number, ignore: string): boolean =>
    board.units.some(
        (unit) => unit.getId() !== ignore && board.footprint(unit).some((cell) => keyOf(cell) === cellKey),
    );

/** Two or more flyers, no meteor. One screen on the file, one on the single middle cell toward centre. */
const c93Cap = (board: IBoard): boolean => {
    const zone = c93Zone(board);
    if (zone.middle === undefined) return false;
    const protectedUnit = c93Protected(board).find((unit) => unit.isSmallSize());
    const screens = c93Screens(board);
    const screen = screens[0];
    if (!protectedUnit || !screen) return false;
    const second = screens[1];
    const middle = zone.middle;
    const current = medianLat(protectedUnit, board);
    const laterals = [...zone.laterals].sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
    for (const lat of laterals) {
        const back = c93Cell(board, zone.back, lat);
        const mid = c93Cell(board, middle, lat);
        if (!back || !mid) continue;
        const step = c93Toward(lat, board.geom.centreLat);
        const inward = step === 0 ? undefined : c93Cell(board, middle, lat + step);
        if (second && step !== 0 && !inward) continue;
        const seed = new Map<string, XY>([
            [protectedUnit.getId(), c93At(back)],
            [screen.getId(), c93At(mid)],
        ]);
        if (second && inward) seed.set(second.getId(), c93At(inward));
        const avoid = new Set<number>();
        const outer = step === 0 ? undefined : c93Cell(board, middle, lat - step);
        if (outer) avoid.add(keyOf(outer));
        if (
            c93Commit(
                board,
                seed,
                new Set(),
                c93Fixed(board, false),
                false,
                () => false,
                () => true,
                avoid,
            )
        ) {
            return true;
        }
    }
    return false;
};

const c93Flyers = (board: IBoard, threats: IPublicPlacementThreats): boolean =>
    threats.meteorShower ? c93Meteor(board) : c93Cap(board);

/** Two or more enemy bows. One inner file is packed; a second caster only gets a front screen past a chakram hop. */
const c93Shooters = (board: IBoard): boolean => {
    const zone = c93Zone(board);
    if (zone.middle === undefined || zone.front !== zone.back + 2) return false;
    const protectedUnits = c93Protected(board).filter((unit) => unit.isSmallSize());
    const screens = c93Screens(board);
    const primary = protectedUnits[0];
    const screenA = screens[0];
    const screenB = screens[1];
    if (!primary || !screenA || !screenB) return false;
    const second = protectedUnits[1];
    const screenC = screens[2];
    const middle = zone.middle;
    const min = zone.laterals[0];
    const max = zone.laterals[zone.laterals.length - 1];
    const current = medianLat(primary, board);
    const inners = zone.laterals
        .filter((lat) => lat !== min && lat !== max)
        .sort(
            (a, b) =>
                Math.abs(a - current) - Math.abs(b - current) ||
                Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) ||
                a - b,
        );
    const plan = (lat: number, other: number | undefined): Map<string, XY> | undefined => {
        const back = c93Cell(board, zone.back, lat);
        const mid = c93Cell(board, middle, lat);
        const front = c93Cell(board, zone.front, lat);
        if (!back || !mid || !front) return undefined;
        const file = [back, mid, front];
        const seed = new Map<string, XY>([
            [primary.getId(), c93At(back)],
            [screenA.getId(), c93At(mid)],
            [screenB.getId(), c93At(front)],
        ]);
        if (second && screenC && other !== undefined) {
            const back2 = c93Cell(board, zone.back, other);
            const front2 = c93Cell(board, zone.front, other);
            if (!back2 || !front2 || Math.abs(other - lat) < 4) return undefined;
            const protectedFoot = c93Foot(second, back2);
            const screenFoot = c93Foot(screenC, front2);
            if (minChebyshev(protectedFoot, file) < 4 || minChebyshev(screenFoot, file) < 4) return undefined;
            seed.set(second.getId(), c93At(back2));
            seed.set(screenC.getId(), c93At(front2));
        }
        const fixed = c93Fixed(board, true);
        for (const id of seed.keys()) fixed.delete(id);
        return c93Resolve(
            board,
            seed,
            new Set(),
            fixed,
            false,
            () => false,
            () => true,
        );
    };
    let fallback: Map<string, XY> | undefined;
    for (const lat of inners) {
        if (second && screenC) {
            const secondLat = medianLat(second, board);
            const others = zone.laterals
                .filter((other) => Math.abs(other - lat) >= 4)
                .sort((a, b) => Math.abs(a - secondLat) - Math.abs(b - secondLat) || a - b);
            for (const other of others) {
                const resolved = plan(lat, other);
                if (!resolved) continue;
                c93Write(board, resolved);
                return true;
            }
        }
        if (!fallback) fallback = plan(lat, undefined);
    }
    if (!fallback) return false;
    c93Write(board, fallback);
    return true;
};

/**
 * r9c3 post-pass. Today's placeArmy has already run. Spellcasters — Monk, when the army has none —
 * sit outside the shell, the breath, the meteor, or on one packed file. Corner bows stay except the
 * Monk fallback. Dryad, Abomination, Angel, and Arachna Queen stay. Skewer Strike or Through Shot
 * alone does not move anyone. No Placement spend, and the zone is not extended. An illegal seat
 * keeps the incumbent cell.
 */
export function placeArmyR9C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    if (!c93Protected(board).length) return board.cells;
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow && threats.largeCaliber) return board.cells;
    if (threats.areaThrow) c93Area(board);
    else if (threats.largeCaliber) c93Caliber(board);
    else if (threats.fireBreath) c93Breath(board);
    else if (threats.flyers >= 2) c93Flyers(board, threats);
    else if (threats.rangeCreatures >= 2 && threats.flyers < 2 && !threats.meteorShower) c93Shooters(board);
    return board.cells;
}

interface C10Enemy {
    readonly threats: IPublicPlacementThreats;
    readonly band11: boolean;
    readonly rangedStun: boolean;
}

const c10Range = (board: IBoard): Unit[] =>
    board.units.filter((unit) => unit.getAttackType() === RANGE && board.footprint(unit).length > 0);

const c10Base = (unit: Unit): number => {
    const creatureId = creatureIdForName(unit.getName());
    const distance = creatureId === undefined ? undefined : creatureInfo(creatureId)?.distance;
    if (distance !== undefined && distance > 0) return distance;
    return unit.getRangeShotDistance();
};

/** Catalog shot after one Sniper-3 step. The band is the floor of the distance actually used. */
const c10PlainDistance = (unit: Unit): number => sniper3Distance(c10Base(unit));

const c10PlainBand = (unit: Unit): number => Math.floor(c10PlainDistance(unit));

/** clamp(0, 35, 5 * stack power + luck). Reads the carrier; does not assume a full stack. */
const c10Percent = (carrier: Unit): number => {
    const stack = Math.max(0, Math.min(5, carrier.getStackPower()));
    return Math.max(0, Math.min(35, 5 * stack + carrier.getLuck()));
};

const c10BoostedDistance = (base: number, percent: number): number =>
    roundUnitStat(sniper3Distance(base) + roundUnitStat((base / 100) * percent, 2), 2);

const c10Hit = (unit: Unit): number => {
    const entry = CATALOG.get(unit.getName());
    const max = entry?.damageMax ?? unit.getAttackDamageMax();
    const min = entry?.damageMin ?? unit.getAttackDamageMin();
    return max * 1000 + min;
};

const c10ByHit = (a: Unit, b: Unit): number => c10Hit(b) - c10Hit(a) || byId(a, b);

const c10EnemyOf = (ids: readonly number[] | undefined): C10Enemy => {
    const threats = publicPlacementThreats(ids);
    let band11 = false;
    let rangedStun = false;
    for (const creatureId of ids ?? []) {
        const info = creatureInfo(creatureId);
        if (!info?.ranged) continue;
        if (info.distance > 0 && Math.floor(sniper3Distance(info.distance)) === 11) band11 = true;
        if (hasNamed(CATALOG.get(info.name)?.abilities, "Stun")) rangedStun = true;
    }
    return { threats, band11, rangedStun };
};

const c10SplashBow = (unit: Unit): boolean => r3HasAbility(unit, "Area Throw") || r3HasAbility(unit, "Large Caliber");

const c10Foot = (board: IBoard, unit: Unit, assignments: ReadonlyMap<string, XY>): XY[] => {
    const anchor = assignments.get(unit.getId()) ?? board.cells.get(unit.getId());
    return anchor ? footprintCellsForAnchor(unit, anchor) : [];
};

/** Our own Area Throw or Large Caliber bow must not be placed inside chebyshev 1 of an ally. */
const c10SplashBad = (board: IBoard, assignments: ReadonlyMap<string, XY>): boolean => {
    if (!assignments.size) return false;
    for (const bow of board.units) {
        if (!c10SplashBow(bow)) continue;
        const bowMoved = assignments.has(bow.getId());
        const bowCells = c10Foot(board, bow, assignments);
        if (!bowCells.length) continue;
        for (const other of board.units) {
            if (other.getId() === bow.getId()) continue;
            if (!bowMoved && !assignments.has(other.getId())) continue;
            const otherCells = c10Foot(board, other, assignments);
            if (otherCells.length > 0 && minChebyshev(bowCells, otherCells) <= 1) return true;
        }
    }
    return false;
};

const c10Write = (board: IBoard, assignments: ReadonlyMap<string, XY>): boolean => {
    if (!assignments.size || c10SplashBad(board, assignments)) return false;
    const occupied = takenCells(board, new Set(assignments.keys()));
    for (const [id, anchor] of assignments) {
        const unit = board.units.find((candidate) => candidate.getId() === id);
        const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
        if (!unit || !span || !spanIsLegal(span, board.geom, occupied)) return false;
        for (const cell of span.cells) occupied.add(keyOf(cell));
    }
    for (const [id, anchor] of assignments) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

/** Undefined when the seat is illegal. False when the legal seat changes nothing. */
const c10Apply = (
    board: IBoard,
    before: ReadonlyMap<string, XY>,
    assignments: ReadonlyMap<string, XY>,
): boolean | undefined => {
    if (!c10Write(board, assignments)) return undefined;
    return changedFrom(before, board.cells);
};

const c10Nearest = (
    board: IBoard,
    unit: Unit,
    occupied: ReadonlySet<number>,
    accept?: (cells: readonly XY[], anchor: XY) => boolean,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    let best: XY | undefined;
    let bestDist = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, occupied)) continue;
        if (accept && !accept(span.cells, anchor)) continue;
        const dist = current ? chebyshev(anchor, current) : 0;
        if (
            !best ||
            dist < bestDist ||
            (dist === bestDist && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestDist = dist;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c10Covering = (
    board: IBoard,
    unit: Unit,
    target: XY,
    occupied: ReadonlySet<number>,
    accept?: (cells: readonly XY[]) => boolean,
): XY | undefined => {
    let best: XY | undefined;
    let bestScore = Infinity;
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, occupied)) continue;
        if (!span.cells.some((cell) => sameCell(cell, target))) continue;
        if (accept && !accept(span.cells)) continue;
        const score = (sameCell(anchor, target) ? 0 : 100) + span.cells.length;
        if (
            !best ||
            score < bestScore ||
            (score === bestScore && (anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
        ) {
            best = anchor;
            bestScore = score;
        }
    }
    return best ? { x: best.x, y: best.y } : undefined;
};

const c10CannonUnit = (range: readonly Unit[]): Unit | undefined =>
    range
        .filter((unit) => r3HasAbility(unit, "No Melee"))
        .sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b))[0];

/** The two highest-band small bows, and only while they already hold a back corner. */
const c10CornerHolders = (board: IBoard, range: readonly Unit[]): Unit[] => {
    if (range.length < 3) return [];
    const corners = backCornerKeys(board.geom);
    return range
        .filter((unit) => unit.isSmallSize())
        .sort((a, b) => bowReach(b) - bowReach(a) || byId(a, b))
        .slice(0, 2)
        .filter((unit) => board.footprint(unit).some((cell) => corners.has(keyOf(cell))));
};

const c10CannonAnchors = (board: IBoard, cannon: Unit, blocked: ReadonlySet<number>): XY[] => {
    const ranks = ranksOf(board);
    const current = board.cells.get(cannon.getId());
    const spots: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(cannon, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, blocked)) continue;
        const depthOk = span.cells.every((cell) => {
            const front = board.geom.frontness(cell);
            return front === ranks.back || front === ranks.middle;
        });
        if (!depthOk) continue;
        if (span.laterals.some((lat) => lat === ranks.minLat || lat === ranks.maxLat)) continue;
        spots.push(anchor);
    }
    spots.sort((a, b) => {
        const aSpan = spanAt(cannon, a, board.geom);
        const bSpan = spanAt(cannon, b, board.geom);
        const aMed = aSpan ? Math.abs(medianNumber(aSpan.laterals) - board.geom.centreLat) : Infinity;
        const bMed = bSpan ? Math.abs(medianNumber(bSpan.laterals) - board.geom.centreLat) : Infinity;
        const aHere = current && sameCell(a, current) ? 0 : 1;
        const bHere = current && sameCell(b, current) ? 0 : 1;
        return aMed - bMed || aHere - bHere || a.x - b.x || a.y - b.y;
    });
    return spots;
};

const c10BackCorners = (board: IBoard): XY[] => {
    const cells: XY[] = [];
    for (const key of backCornerKeys(board.geom)) cells.push({ x: key >> 4, y: key & 0xf });
    return cells;
};

const c10FarCorners = (board: IBoard, cannonCells: readonly XY[], bow: Unit): XY[] => {
    const current = board.cells.get(bow.getId());
    const corners = c10BackCorners(board);
    if (!corners.length || !cannonCells.length) return [];
    let farthest = -Infinity;
    for (const corner of corners) farthest = Math.max(farthest, minChebyshev([corner], cannonCells));
    return corners
        .filter((corner) => minChebyshev([corner], cannonCells) === farthest)
        .sort((a, b) => {
            const aHere = current && sameCell(current, a) ? 0 : 1;
            const bHere = current && sameCell(current, b) ? 0 : 1;
            const aMove = current ? chebyshev(a, current) : 0;
            const bMove = current ? chebyshev(b, current) : 0;
            return (
                aHere - bHere ||
                aMove - bMove ||
                board.geom.edgeness(b) - board.geom.edgeness(a) ||
                a.x - b.x ||
                a.y - b.y
            );
        });
};

const c10Overlaps = (cells: readonly XY[], keys: ReadonlySet<number>): boolean =>
    cells.some((cell) => keys.has(keyOf(cell)));

/** Flyer or Rapid Charge, and neither splash: cannon off the extreme lateral, median toward centre. */
const c10Agile = (board: IBoard, cannon: Unit, range: readonly Unit[]): boolean => {
    const before = copyCells(board);
    const others = range.filter((unit) => unit.getId() !== cannon.getId());
    const holders = c10CornerHolders(board, range);
    const holderIds = new Set(holders.map((unit) => unit.getId()));
    const holderCells = new Set<number>();
    for (const holder of holders) {
        for (const cell of board.footprint(holder)) holderCells.add(keyOf(cell));
    }
    const seatBow = others.length === 1 ? others[0] : undefined;
    for (const anchor of c10CannonAnchors(board, cannon, holderCells)) {
        const cannonSpan = spanAt(cannon, anchor, board.geom);
        if (!cannonSpan) continue;
        if (c10Overlaps(cannonSpan.cells, holderCells)) continue;
        const reserved = new Set(holderCells);
        for (const cell of cannonSpan.cells) reserved.add(keyOf(cell));
        const corners = seatBow ? c10FarCorners(board, cannonSpan.cells, seatBow) : [undefined];
        if (!corners.length) continue;
        for (const corner of corners) {
            const assignments = new Map<string, XY>();
            assignments.set(cannon.getId(), { x: anchor.x, y: anchor.y });
            const reservedNow = new Set(reserved);
            if (seatBow && corner) {
                const bowAnchor = c10Covering(board, seatBow, corner, reservedNow, (cells) => {
                    if (!seatBow.isSmallSize()) return true;
                    return cells.every((cell) => board.geom.frontness(cell) === ranksOf(board).back);
                });
                if (!bowAnchor) continue;
                const bowSpan = spanAt(seatBow, bowAnchor, board.geom);
                if (!bowSpan) continue;
                for (const cell of bowSpan.cells) reservedNow.add(keyOf(cell));
                assignments.set(seatBow.getId(), bowAnchor);
            }
            const blockers = board.units
                .filter((unit) => {
                    if (assignments.has(unit.getId()) || holderIds.has(unit.getId())) return false;
                    return c10Overlaps(board.footprint(unit), reservedNow);
                })
                .sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b));
            const movers = new Set<string>([...assignments.keys(), ...blockers.map((unit) => unit.getId())]);
            const occupied = takenCells(board, movers);
            for (const key of reservedNow) occupied.add(key);
            let parked = true;
            for (const blocker of blockers) {
                const spot = c10Nearest(board, blocker, occupied, (cells, next) => {
                    if (c10Overlaps(cells, reservedNow)) return false;
                    const tentative = new Map(assignments);
                    tentative.set(blocker.getId(), next);
                    return !c10SplashBad(board, tentative);
                });
                const span = spot ? spanAt(blocker, spot, board.geom) : undefined;
                if (!spot || !span) {
                    parked = false;
                    break;
                }
                for (const cell of span.cells) occupied.add(keyOf(cell));
                assignments.set(blocker.getId(), spot);
            }
            if (!parked) continue;
            const cannonKeys = new Set(cannonSpan.cells.map((cell) => keyOf(cell)));
            const smallOverlap = range.some((unit) => {
                if (!unit.isSmallSize()) return false;
                return c10Overlaps(c10Foot(board, unit, assignments), cannonKeys);
            });
            if (smallOverlap) continue;
            const applied = c10Apply(board, before, assignments);
            if (applied === undefined) continue;
            return applied;
        }
    }
    return false;
};

/** Splash: leave the cannon and push every ally out of its chebyshev-1 ring. */
const c10Push = (board: IBoard, origin: Unit, gap: number): boolean => {
    const originCells = board.footprint(origin);
    if (!originCells.length) return false;
    const before = copyCells(board);
    const movers = board.units
        .filter((unit) => {
            if (unit.getId() === origin.getId()) return false;
            const cells = board.footprint(unit);
            return cells.length > 0 && minChebyshev(cells, originCells) < gap;
        })
        .sort(
            (a, b) =>
                minChebyshev(board.footprint(a), originCells) - minChebyshev(board.footprint(b), originCells) ||
                byId(a, b),
        );
    if (!movers.length) return false;
    const assignments = new Map<string, XY>();
    const occupied = takenCells(board, new Set(movers.map((unit) => unit.getId())));
    for (const unit of movers) {
        const spot = c10Nearest(board, unit, occupied, (cells, anchor) => {
            if (minChebyshev(cells, originCells) < gap) return false;
            const tentative = new Map(assignments);
            tentative.set(unit.getId(), anchor);
            return !c10SplashBad(board, tentative);
        });
        const span = spot ? spanAt(unit, spot, board.geom) : undefined;
        if (!spot || !span) {
            for (const cell of board.footprint(unit)) occupied.add(keyOf(cell));
            continue;
        }
        for (const cell of span.cells) occupied.add(keyOf(cell));
        assignments.set(unit.getId(), spot);
    }
    const applied = c10Apply(board, before, assignments);
    return applied === true;
};

/** Shooter wall: cannon stays on the back corner. Adjacent small bows slide along the back rank. */
const c10Slide = (board: IBoard, cannon: Unit, range: readonly Unit[]): boolean => {
    const cannonCells = board.footprint(cannon);
    if (!cannonCells.length) return false;
    const ranks = ranksOf(board);
    const before = copyCells(board);
    const bows = range
        .filter((unit) => {
            if (!unit.isSmallSize() || unit.getId() === cannon.getId()) return false;
            const cells = board.footprint(unit);
            return cells.length > 0 && minChebyshev(cells, cannonCells) <= 1;
        })
        .sort(
            (a, b) =>
                minChebyshev(board.footprint(a), cannonCells) - minChebyshev(board.footprint(b), cannonCells) ||
                byId(a, b),
        );
    if (!bows.length) return false;
    const assignments = new Map<string, XY>();
    const occupied = takenCells(board, new Set(bows.map((unit) => unit.getId())));
    for (const bow of bows) {
        const spot = c10Nearest(board, bow, occupied, (cells, anchor) => {
            if (!cells.every((cell) => board.geom.frontness(cell) === ranks.back)) return false;
            if (minChebyshev(cells, cannonCells) < 2) return false;
            const tentative = new Map(assignments);
            tentative.set(bow.getId(), anchor);
            return !c10SplashBad(board, tentative);
        });
        const span = spot ? spanAt(bow, spot, board.geom) : undefined;
        if (!spot || !span) {
            for (const cell of board.footprint(bow)) occupied.add(keyOf(cell));
            continue;
        }
        for (const cell of span.cells) occupied.add(keyOf(cell));
        assignments.set(bow.getId(), spot);
    }
    const applied = c10Apply(board, before, assignments);
    return applied === true;
};

const c10Cannon = (board: IBoard, range: readonly Unit[], enemy: C10Enemy): boolean => {
    const cannon = c10CannonUnit(range);
    if (!cannon) return false;
    const splash = enemy.threats.areaThrow || enemy.threats.largeCaliber;
    const agile = enemy.threats.flyers > 0 || enemy.threats.rapidCharge;
    if (agile && !splash) return c10Agile(board, cannon, range);
    if (splash) return c10Push(board, cannon, 2);
    if (enemy.threats.rangeCreatures >= 2 && enemy.threats.flyers === 0 && !enemy.threats.rapidCharge) {
        return c10Slide(board, cannon, range);
    }
    return false;
};

const c10Partner = (range: readonly Unit[], carrier: Unit): Unit | undefined => {
    const percent = c10Percent(carrier);
    const fits = range.filter((unit) => {
        if (unit.getId() === carrier.getId()) return false;
        if (r3HasAbility(unit, "Sniper") || r3HasAbility(unit, "No Melee")) return false;
        if (r3HasAbility(unit, "Area Throw") || r3HasAbility(unit, "Large Caliber")) return false;
        const base = c10Base(unit);
        const plain = Math.floor(sniper3Distance(base));
        const boosted = Math.floor(c10BoostedDistance(base, percent));
        return plain < 12 && boosted >= 12;
    });
    fits.sort((a, b) => c10ByHit(a, b) || c10Base(a) - c10Base(b));
    return fits[0];
};

const c10OnBack = (board: IBoard, cells: readonly XY[]): boolean => {
    const back = ranksOf(board).back;
    return cells.length > 0 && cells.every((cell) => board.geom.frontness(cell) === back);
};

/** Partner on the middle rank of Dryad's lateral, or the nearest middle lateral still inside the aura. */
const c10WindsMiddle = (board: IBoard, carrier: Unit, partner: Unit, range: readonly Unit[]): boolean => {
    const before = copyCells(board);
    const ranks = ranksOf(board);
    const carrierCells = board.footprint(carrier);
    const carrierLats = board.laterals(carrier);
    const candidates: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(partner, anchor, board.geom);
        if (!span || !span.cells.every((cell) => board.geom.frontness(cell) === ranks.middle)) continue;
        if (minChebyshev(span.cells, carrierCells) > 2) continue;
        if (span.cells.some((cell) => carrierCells.some((other) => sameCell(cell, other)))) continue;
        candidates.push(anchor);
    }
    candidates.sort((a, b) => {
        const aSpan = spanAt(partner, a, board.geom);
        const bSpan = spanAt(partner, b, board.geom);
        if (!aSpan || !bSpan) return a.x - b.x;
        const lat = lateralDistance(aSpan.laterals, carrierLats) - lateralDistance(bSpan.laterals, carrierLats);
        const centre =
            Math.abs(medianNumber(aSpan.laterals) - board.geom.centreLat) -
            Math.abs(medianNumber(bSpan.laterals) - board.geom.centreLat);
        return lat || centre || a.x - b.x || a.y - b.y;
    });
    for (const anchor of candidates) {
        const span = spanAt(partner, anchor, board.geom);
        if (!span) continue;
        const laterals = new Set(span.laterals);
        const toFix = range.filter((unit) => {
            if (unit.getId() === partner.getId() || unit.getId() === carrier.getId()) return false;
            const shares = board.laterals(unit).some((lat) => laterals.has(lat));
            const smallOffBack = unit.isSmallSize() && !c10OnBack(board, board.footprint(unit));
            return shares || smallOffBack;
        });
        const movers = new Set<string>([partner.getId(), ...toFix.map((unit) => unit.getId())]);
        const occupied = takenCells(board, movers);
        if (!spanIsLegal(span, board.geom, occupied)) continue;
        for (const cell of span.cells) occupied.add(keyOf(cell));
        const assignments = new Map<string, XY>([[partner.getId(), { x: anchor.x, y: anchor.y }]]);
        let parked = true;
        for (const bow of [...toFix].sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b))) {
            const spot = c10Nearest(board, bow, occupied, (cells, next) => {
                if (cells.some((cell) => laterals.has(board.geom.lateral(cell)))) return false;
                const smallOnBack = bow.isSmallSize() && c10OnBack(board, cells);
                const cannonDepth =
                    !bow.isSmallSize() &&
                    r3HasAbility(bow, "No Melee") &&
                    cells.every((cell) => {
                        const front = board.geom.frontness(cell);
                        return front === ranks.back || front === ranks.middle;
                    });
                if (!smallOnBack && !cannonDepth) return false;
                const tentative = new Map(assignments);
                tentative.set(bow.getId(), next);
                return !c10SplashBad(board, tentative);
            });
            const bowSpan = spot ? spanAt(bow, spot, board.geom) : undefined;
            if (!spot || !bowSpan) {
                parked = false;
                break;
            }
            for (const cell of bowSpan.cells) occupied.add(keyOf(cell));
            assignments.set(bow.getId(), spot);
        }
        if (!parked) continue;
        const applied = c10Apply(board, before, assignments);
        if (applied === undefined) continue;
        return applied;
    }
    return false;
};

/** Splash: partner on the back rank at chebyshev 2, and nobody left in Dryad's chebyshev-1 ring. */
const c10WindsSpread = (board: IBoard, carrier: Unit, partner: Unit): boolean => {
    const before = copyCells(board);
    const carrierCells = board.footprint(carrier);
    const candidates: XY[] = [];
    for (const anchor of board.geom.baseCells) {
        const span = spanAt(partner, anchor, board.geom);
        if (!span || !c10OnBack(board, span.cells)) continue;
        if (minChebyshev(span.cells, carrierCells) !== 2) continue;
        candidates.push(anchor);
    }
    const current = board.cells.get(partner.getId());
    candidates.sort((a, b) => {
        const aDist = current ? chebyshev(a, current) : 0;
        const bDist = current ? chebyshev(b, current) : 0;
        return aDist - bDist || a.x - b.x || a.y - b.y;
    });
    for (const anchor of candidates) {
        const span = spanAt(partner, anchor, board.geom);
        if (!span) continue;
        const blocking = board.units.filter((unit) => {
            if (unit.getId() === carrier.getId() || unit.getId() === partner.getId()) return false;
            const cells = board.footprint(unit);
            if (!cells.length) return false;
            return (
                minChebyshev(cells, carrierCells) <= 1 ||
                cells.some((cell) => span.cells.some((next) => sameCell(cell, next)))
            );
        });
        const crowded = board.units.some((unit) => {
            if (unit.getId() === carrier.getId() || unit.getId() === partner.getId()) return false;
            if (blocking.some((entry) => entry.getId() === unit.getId())) return false;
            const cells = board.footprint(unit);
            return cells.length > 0 && minChebyshev(cells, span.cells) < 2;
        });
        if (crowded) continue;
        const movers = new Set<string>([partner.getId(), ...blocking.map((unit) => unit.getId())]);
        const occupied = takenCells(board, movers);
        if (!spanIsLegal(span, board.geom, occupied)) continue;
        const assignments = new Map<string, XY>([[partner.getId(), { x: anchor.x, y: anchor.y }]]);
        for (const cell of span.cells) occupied.add(keyOf(cell));
        let parked = true;
        for (const unit of [...blocking].sort(byId)) {
            const spot = c10Nearest(board, unit, occupied, (cells, next) => {
                if (minChebyshev(cells, carrierCells) < 2 || minChebyshev(cells, span.cells) < 2) return false;
                const tentative = new Map(assignments);
                tentative.set(unit.getId(), next);
                return !c10SplashBad(board, tentative);
            });
            const unitSpan = spot ? spanAt(unit, spot, board.geom) : undefined;
            if (!spot || !unitSpan) {
                parked = false;
                break;
            }
            for (const cell of unitSpan.cells) occupied.add(keyOf(cell));
            assignments.set(unit.getId(), spot);
        }
        if (!parked) continue;
        const applied = c10Apply(board, before, assignments);
        if (applied === undefined) continue;
        return applied;
    }
    return false;
};

/** Two or more flyers: both stay on the back rank inside the aura. Do not step to the middle. */
const c10WindsFlyers = (board: IBoard, carrier: Unit, partner: Unit): boolean => {
    const before = copyCells(board);
    const carrierNow = board.cells.get(carrier.getId());
    const partnerNow = board.cells.get(partner.getId());
    const carrierAnchors: XY[] = [];
    if (carrierNow && c10OnBack(board, board.footprint(carrier))) carrierAnchors.push(carrierNow);
    else {
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(carrier, anchor, board.geom);
            if (span && c10OnBack(board, span.cells)) carrierAnchors.push(anchor);
        }
        carrierAnchors.sort((a, b) => {
            const aDist = carrierNow ? chebyshev(a, carrierNow) : 0;
            const bDist = carrierNow ? chebyshev(b, carrierNow) : 0;
            return aDist - bDist || a.x - b.x || a.y - b.y;
        });
    }
    for (const carrierAnchor of carrierAnchors) {
        const carrierSpan = spanAt(carrier, carrierAnchor, board.geom);
        if (!carrierSpan) continue;
        const partnerSpots: XY[] = [];
        for (const anchor of board.geom.baseCells) {
            const span = spanAt(partner, anchor, board.geom);
            if (!span || !c10OnBack(board, span.cells)) continue;
            if (minChebyshev(span.cells, carrierSpan.cells) > 2) continue;
            if (span.cells.some((cell) => carrierSpan.cells.some((other) => sameCell(cell, other)))) continue;
            partnerSpots.push(anchor);
        }
        partnerSpots.sort((a, b) => {
            const aSpan = spanAt(partner, a, board.geom);
            const bSpan = spanAt(partner, b, board.geom);
            const aGap = aSpan ? minChebyshev(aSpan.cells, carrierSpan.cells) : Infinity;
            const bGap = bSpan ? minChebyshev(bSpan.cells, carrierSpan.cells) : Infinity;
            const aHere = partnerNow && sameCell(a, partnerNow) ? 0 : 1;
            const bHere = partnerNow && sameCell(b, partnerNow) ? 0 : 1;
            const aDist = partnerNow ? chebyshev(a, partnerNow) : 0;
            const bDist = partnerNow ? chebyshev(b, partnerNow) : 0;
            return aHere - bHere || aGap - bGap || aDist - bDist || a.x - b.x || a.y - b.y;
        });
        for (const partnerAnchor of partnerSpots) {
            const partnerSpan = spanAt(partner, partnerAnchor, board.geom);
            if (!partnerSpan) continue;
            const assignments = new Map<string, XY>();
            if (!carrierNow || !sameCell(carrierNow, carrierAnchor)) {
                assignments.set(carrier.getId(), { x: carrierAnchor.x, y: carrierAnchor.y });
            }
            if (!partnerNow || !sameCell(partnerNow, partnerAnchor)) {
                assignments.set(partner.getId(), { x: partnerAnchor.x, y: partnerAnchor.y });
            }
            const reserved = new Set<number>();
            for (const cell of carrierSpan.cells) reserved.add(keyOf(cell));
            for (const cell of partnerSpan.cells) reserved.add(keyOf(cell));
            const blockers = board.units.filter((unit) => {
                if (unit.getId() === carrier.getId() || unit.getId() === partner.getId()) return false;
                return c10Overlaps(board.footprint(unit), reserved);
            });
            const movers = new Set<string>([carrier.getId(), partner.getId(), ...blockers.map((unit) => unit.getId())]);
            const occupied = takenCells(board, movers);
            if (!spanIsLegal(carrierSpan, board.geom, occupied) || !spanIsLegal(partnerSpan, board.geom, occupied)) {
                continue;
            }
            for (const key of reserved) occupied.add(key);
            let parked = true;
            for (const unit of [...blockers].sort(byId)) {
                const spot = c10Nearest(board, unit, occupied, (cells, next) => {
                    if (c10Overlaps(cells, reserved)) return false;
                    const tentative = new Map(assignments);
                    tentative.set(unit.getId(), next);
                    return !c10SplashBad(board, tentative);
                });
                const span = spot ? spanAt(unit, spot, board.geom) : undefined;
                if (!spot || !span) {
                    parked = false;
                    break;
                }
                for (const cell of span.cells) occupied.add(keyOf(cell));
                assignments.set(unit.getId(), spot);
            }
            if (!parked) continue;
            if (!assignments.size) return false;
            const applied = c10Apply(board, before, assignments);
            if (applied === undefined) continue;
            return applied;
        }
    }
    return false;
};

const c10Winds = (board: IBoard, range: readonly Unit[], units: readonly Unit[], enemy: C10Enemy): boolean => {
    const carriers = units.filter((unit) => r3HasAbility(unit, "Guiding Winds"));
    if (carriers.length !== 1) return false;
    const carrier = carriers[0];
    if (!carrier || !board.cells.has(carrier.getId())) return false;
    // Below band 12 the same-rank aura partner is already measured, so this job seats nobody.
    const partner = c10Partner(range, carrier);
    if (!partner) return false;
    if (enemy.threats.areaThrow || enemy.threats.largeCaliber) return c10WindsSpread(board, carrier, partner);
    if (enemy.threats.flyers >= 2) return c10WindsFlyers(board, carrier, partner);
    return c10WindsMiddle(board, carrier, partner, range);
};

const c10Eligible = (range: readonly Unit[]): Unit[] =>
    range.filter(
        (unit) =>
            c10PlainBand(unit) === 11 &&
            !r3HasAbility(unit, "Sniper") &&
            !r3HasAbility(unit, "No Melee") &&
            !r3HasAbility(unit, "Area Throw") &&
            !r3HasAbility(unit, "Large Caliber") &&
            !r3HasAbility(unit, "Guiding Winds"),
    );

const c10BowLat = (board: IBoard, bow: Unit): number | undefined => {
    const laterals = [...board.laterals(bow)];
    if (!laterals.length) return undefined;
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    return laterals[0];
};

/** Front-rank cell nearest the lateral centre. Extreme laterals are the measured front-corner step. */
const c10Centre = (board: IBoard, bow: Unit, range: readonly Unit[]): boolean => {
    const before = copyCells(board);
    const ranks = ranksOf(board);
    const laterals: number[] = [];
    for (let lat = ranks.minLat + 1; lat <= ranks.maxLat - 1; lat += 1) laterals.push(lat);
    laterals.sort((a, b) => Math.abs(a - board.geom.centreLat) - Math.abs(b - board.geom.centreLat) || a - b);
    const others = range.filter((unit) => unit.getId() !== bow.getId());
    for (const lat of laterals) {
        const cell = r3Cell(board, ranks.front, lat);
        if (!cell) continue;
        const occupied = takenCells(board, new Set([bow.getId()]));
        const anchor = c10Covering(board, bow, cell, occupied, (cells) => {
            if (!cells.every((entry) => board.geom.frontness(entry) === ranks.front)) return false;
            const shares = cells.some((entry) =>
                others.some((other) => board.laterals(other).includes(board.geom.lateral(entry))),
            );
            if (shares) return false;
            return others.every((other) => minChebyshev(cells, board.footprint(other)) >= 2);
        });
        if (!anchor) continue;
        const applied = c10Apply(board, before, new Map([[bow.getId(), anchor]]));
        if (applied === undefined) continue;
        return applied;
    }
    return false;
};

/** Pure ground with Petrifying Gaze: her front cell, once non-bows can leave that file. */
const c10GazeFile = (board: IBoard, gaze: Unit): boolean => {
    const before = copyCells(board);
    const ranks = ranksOf(board);
    const lat = c10BowLat(board, gaze);
    if (lat === undefined) return false;
    const front = r3Cell(board, ranks.front, lat);
    if (!front) return false;
    const blockers = board.units
        .filter(
            (unit) =>
                unit.getId() !== gaze.getId() && unit.getAttackType() !== RANGE && board.laterals(unit).includes(lat),
        )
        .sort((a, b) => footprintArea(b) - footprintArea(a) || byId(a, b));
    const movers = new Set<string>([gaze.getId(), ...blockers.map((unit) => unit.getId())]);
    const occupied = takenCells(board, movers);
    const anchor = c10Covering(
        board,
        gaze,
        front,
        occupied,
        (cells) =>
            cells.every((cell) => board.geom.frontness(cell) === ranks.front) &&
            cells.some((cell) => board.geom.lateral(cell) === lat),
    );
    if (!anchor) return false;
    const gazeSpan = spanAt(gaze, anchor, board.geom);
    if (!gazeSpan) return false;
    for (const cell of gazeSpan.cells) occupied.add(keyOf(cell));
    const assignments = new Map<string, XY>([[gaze.getId(), anchor]]);
    for (const unit of blockers) {
        const spot = c10Nearest(board, unit, occupied, (cells, next) => {
            if (cells.some((cell) => board.geom.lateral(cell) === lat)) return false;
            const tentative = new Map(assignments);
            tentative.set(unit.getId(), next);
            return !c10SplashBad(board, tentative);
        });
        const span = spot ? spanAt(unit, spot, board.geom) : undefined;
        if (!spot || !span) return false;
        for (const cell of span.cells) occupied.add(keyOf(cell));
        assignments.set(unit.getId(), spot);
    }
    const applied = c10Apply(board, before, assignments);
    return applied === true;
};

const c10BandJob = (board: IBoard, range: readonly Unit[], enemy: C10Enemy): boolean => {
    const eligible = c10Eligible(range);
    if (!eligible.length) return false;
    const threats = enemy.threats;
    if (threats.areaThrow || threats.largeCaliber) return false;
    if (threats.flyers >= 2 && threats.rangeCreatures === 0) return false;
    const shooter = threats.rangeCreatures >= 2 && enemy.band11 && !threats.fireBreath && !threats.throughShot;
    if (shooter) {
        const gaze = eligible.filter((unit) => r3HasAbility(unit, "Petrifying Gaze")).sort(c10ByHit);
        const support = range.some((unit) => r3HasAbility(unit, "Sniper") || c10PlainBand(unit) === 13);
        const chosen = gaze[0] ?? (support ? [...eligible].sort(c10ByHit)[0] : undefined);
        if (!chosen) return false;
        return c10Centre(board, chosen, range);
    }
    if (threats.rangeCreatures !== 0 || threats.flyers !== 0 || threats.fireBreath) return false;
    const gaze = eligible.filter((unit) => r3HasAbility(unit, "Petrifying Gaze")).sort(c10ByHit)[0];
    if (!gaze) return false;
    return c10GazeFile(board, gaze);
};

const c10IsBody = (unit: Unit, board: IBoard): boolean =>
    !unit.canFly() &&
    !unit.isSummoned() &&
    unit.getAttackType() !== RANGE &&
    !isCasterUnit(unit) &&
    !isSpellbookUnit(unit) &&
    board.footprint(unit).length > 0;

const c10Ahead = (board: IBoard, bow: Unit): XY | undefined => {
    const cells = board.footprint(bow);
    if (!cells.length) return undefined;
    const face = Math.max(...cells.map((cell) => board.geom.frontness(cell)));
    const lat = c10BowLat(board, bow);
    const faceCells = cells.filter((cell) => board.geom.frontness(cell) === face);
    const faceCell = faceCells.find((cell) => board.geom.lateral(cell) === lat) ?? faceCells[0];
    if (!faceCell) return undefined;
    const ahead = board.geom.towardEnemy(faceCell, 1);
    return board.geom.legal.has(keyOf(ahead)) ? ahead : undefined;
};

const c10ScreenAt = (
    board: IBoard,
    covered: Unit,
    body: Unit,
    target: XY,
    blast: boolean,
    range: readonly Unit[],
    cannonCells: readonly XY[],
): boolean => {
    const before = copyCells(board);
    const lat = c10BowLat(board, covered);
    const middle = lat === undefined ? undefined : r3Cell(board, ranksOf(board).middle, lat);
    if (blast && middle && board.footprint(covered).some((cell) => sameCell(cell, middle))) return false;
    const clearing =
        blast && middle
            ? board.units.filter((unit) => {
                  if (unit.getId() === body.getId() || unit.getId() === covered.getId()) return false;
                  return board.footprint(unit).some((cell) => sameCell(cell, middle));
              })
            : [];
    if (clearing.some((unit) => unit.getAttackType() === RANGE)) return false;
    if (clearing.some((unit) => cannonCells.length > 0 && minChebyshev(board.footprint(unit), cannonCells) <= 1)) {
        return false;
    }
    const movers = new Set<string>([body.getId(), ...clearing.map((unit) => unit.getId())]);
    const occupied = takenCells(board, movers);
    const anchor = c10Covering(board, body, target, occupied, (cells) => {
        if (!blast) return true;
        if (middle && cells.some((cell) => sameCell(cell, middle))) return false;
        return range.every((bow) => minChebyshev(cells, board.footprint(bow)) >= 2);
    });
    const bodySpan = anchor ? spanAt(body, anchor, board.geom) : undefined;
    if (!anchor || !bodySpan) return false;
    const assignments = new Map<string, XY>([[body.getId(), anchor]]);
    for (const cell of bodySpan.cells) occupied.add(keyOf(cell));
    for (const unit of [...clearing].sort(byId)) {
        const spot = c10Nearest(board, unit, occupied, (cells, next) => {
            if (middle && cells.some((cell) => sameCell(cell, middle))) return false;
            if (c10Overlaps(cells, new Set(bodySpan.cells.map((cell) => keyOf(cell))))) return false;
            const tentative = new Map(assignments);
            tentative.set(unit.getId(), next);
            return !c10SplashBad(board, tentative);
        });
        const span = spot ? spanAt(unit, spot, board.geom) : undefined;
        if (!spot || !span) return false;
        for (const cell of span.cells) occupied.add(keyOf(cell));
        assignments.set(unit.getId(), spot);
    }
    const applied = c10Apply(board, before, assignments);
    return applied === true;
};

const c10Screen = (board: IBoard, range: readonly Unit[], enemy: C10Enemy): boolean => {
    const hasDouble = range.some((unit) => r3HasAbility(unit, "Double Shot"));
    const hasLeather = range.some((unit) => r3HasAbility(unit, "Leather Armor"));
    if (!hasDouble && !hasLeather) return false;
    const covered =
        hasDouble && enemy.rangedStun
            ? range.filter((unit) => r3HasAbility(unit, "Double Shot")).sort(byId)[0]
            : range.filter((unit) => r3HasAbility(unit, "Leather Armor")).sort(byId)[0];
    if (!covered) return false;
    const lat = c10BowLat(board, covered);
    if (lat === undefined) return false;
    const bodies = board.units.filter((unit) => c10IsBody(unit, board));
    const onFile = bodies.some((unit) => board.laterals(unit).includes(lat));
    if (bodies.length >= range.length && onFile) return false;
    const cannon = c10CannonUnit(range);
    const cannonCells = cannon ? board.footprint(cannon) : [];
    const eligible = bodies.filter((unit) => {
        if (!cannonCells.length) return true;
        return minChebyshev(board.footprint(unit), cannonCells) > 1;
    });
    if (!eligible.length) return false;
    const threats = enemy.threats;
    const blasts =
        threats.areaThrow || threats.largeCaliber || threats.fireball || threats.ringOfFire || threats.meteorShower;
    const ranks = ranksOf(board);
    let target: XY | undefined;
    let blast = false;
    if (blasts) {
        target = r3Cell(board, ranks.front, lat);
        blast = true;
    } else if (threats.flyers >= 2 && !threats.areaThrow && !threats.largeCaliber) {
        target = c10Ahead(board, covered);
    } else if (threats.rangeCreatures >= 1 && threats.flyers < 2) {
        target = r3Cell(board, ranks.middle, lat);
    } else {
        return false;
    }
    if (!target) return false;
    if (blast && range.some((bow) => minChebyshev([target], board.footprint(bow)) < 2)) return false;
    const middle = r3Cell(board, ranks.middle, lat);
    const already = eligible.some((unit) => {
        const cells = board.footprint(unit);
        if (!cells.some((cell) => sameCell(cell, target))) return false;
        if (blast && middle && cells.some((cell) => sameCell(cell, middle))) return false;
        if (blast && range.some((bow) => minChebyshev(cells, board.footprint(bow)) < 2)) return false;
        return true;
    });
    const middleClear =
        !blast ||
        !middle ||
        !board.units.some(
            (unit) => unit.getId() !== covered.getId() && board.footprint(unit).some((cell) => sameCell(cell, middle)),
        );
    if (already && middleClear) return false;
    const ordered = [...eligible].sort((a, b) => {
        const aAnchor = board.cells.get(a.getId());
        const bAnchor = board.cells.get(b.getId());
        const aDist = aAnchor ? chebyshev(aAnchor, target) : Infinity;
        const bDist = bAnchor ? chebyshev(bAnchor, target) : Infinity;
        return aDist - bDist || footprintArea(a) - footprintArea(b) || byId(a, b);
    });
    for (const body of ordered) {
        if (c10ScreenAt(board, covered, body, target, blast, range, cannonCells)) return true;
    }
    return false;
};

/**
 * r10c1 post-pass. Today's placeArmy has already run. The cannon leaves the extreme lateral, Guiding
 * Winds steps one partner up a rank, one band-11 bow takes the centre-front cell, or one scarce body
 * screens a back-rank bow. The first job that seats someone is the only one. No Placement spend, and
 * the zone is not extended. An illegal seat keeps the incumbent cell.
 */
export function placeArmyR10C1(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const range = c10Range(board);
    if (range.length < 2) return board.cells;
    const enemy = c10EnemyOf(context.publicOpponentCreatureIds);
    if (c10Cannon(board, range, enemy)) return board.cells;
    if (c10Winds(board, range, units, enemy)) return board.cells;
    if (c10BandJob(board, range, enemy)) return board.cells;
    c10Screen(board, range, enemy);
    return board.cells;
}

interface IC102Seat {
    readonly unit: Unit;
    readonly anchor: XY;
}

interface IC102Plan {
    readonly seats: IC102Seat[];
    readonly forbidden: Set<number>;
}

interface IC102Zone {
    readonly back: number;
    readonly middle: number;
    readonly front: number;
    readonly files: readonly number[];
    readonly centre: number;
    readonly low: number;
    readonly high: number;
    /** Lowest in-zone file, omitted when that file is the centre so the charger lane never is. */
    readonly lane: number | undefined;
}

interface IC102Locks {
    taken: Set<number>;
    fronts: Set<number>;
}

const c102Cell = (board: IBoard, rank: number, lat: number): XY | undefined => {
    const cell = r3Cell(board, rank, lat);
    if (!cell || isBoardEdge(cell) || !board.geom.legal.has(keyOf(cell))) return undefined;
    return cell;
};

const c102Zone = (board: IBoard): IC102Zone | undefined => {
    const limits = zoneLimits(board.geom);
    if (!Number.isFinite(limits.minLat) || !Number.isFinite(limits.maxLat) || !Number.isFinite(limits.maxFront)) {
        return undefined;
    }
    const back = board.geom.backFront;
    const front = limits.maxFront;
    const middle = back + 1;
    if (middle >= front) return undefined;
    const files: number[] = [];
    for (let lat = limits.minLat; lat <= limits.maxLat; lat += 1) {
        if (!c102Cell(board, back, lat) || !c102Cell(board, middle, lat) || !c102Cell(board, front, lat)) continue;
        files.push(lat);
    }
    const low = files[0];
    const high = files[files.length - 1];
    if (low === undefined || high === undefined) return undefined;
    let centre = low;
    for (const lat of files) {
        const dist = Math.abs(lat - board.geom.centreLat);
        const best = Math.abs(centre - board.geom.centreLat);
        if (dist < best || (dist === best && lat < centre)) centre = lat;
    }
    return { back, middle, front, files, centre, low, high, lane: low === centre ? undefined : low };
};

const c102Still = (unit: Unit): boolean =>
    unit.getAttackType() === RANGE ||
    unit.getName() === "Monk" ||
    unit.getName() === "Dryad" ||
    PROTECTORS.has(unit.getName());

const c102IsScreen = (unit: Unit): boolean =>
    unit.isSmallSize() &&
    !unit.canFly() &&
    !isCharger(unit) &&
    !c102Still(unit) &&
    !isCasterUnit(unit) &&
    !isSpellbookUnit(unit);

const c102Placed = (board: IBoard, accept: (unit: Unit) => boolean): Unit[] =>
    board.units.filter((unit) => accept(unit) && board.cells.has(unit.getId()));

const c102Screens = (board: IBoard): Unit[] => c102Placed(board, c102IsScreen);

const c102Larges = (board: IBoard): Unit[] =>
    c102Placed(board, (unit) => !c102Still(unit) && !unit.canFly() && !unit.isSmallSize());

const c102Movers = (board: IBoard): Unit[] =>
    c102Placed(
        board,
        (unit) => !c102Still(unit) && unit.canFly() && unit.getAttackType() !== RANGE && !isCharger(unit),
    ).sort(byId);

const c102Chargers = (board: IBoard): Unit[] =>
    c102Placed(board, (unit) => !c102Still(unit) && isCharger(unit)).sort(c62BySpeed);

const c102BySlow = (a: Unit, b: Unit): number => a.getSteps() - b.getSteps() || byId(a, b);

const c102LatCount = (unit: Unit, geom: IGeom): number => {
    const side = geom.lateral({ x: 0, y: 1 }) === 1 ? unit.getFootprintHeight() : unit.getFootprintWidth();
    return Math.max(1, Math.floor(side));
};

const c102Outward = (lats: readonly number[], centre: number): number[] =>
    [...lats].sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre) || a - b);

const c102HighFirst = (lats: readonly number[]): number[] => [...lats].sort((a, b) => b - a);

const c102Shoulders = (zone: IC102Zone): number[] =>
    [zone.centre - 1, zone.centre + 1].filter((lat) => zone.files.includes(lat));

const c102Stamp = (board: IBoard, taken: Set<number>, unit: Unit, anchor: XY): ISpan | undefined => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span || !spanIsLegal(span, board.geom, taken)) return undefined;
    for (const cell of span.cells) taken.add(keyOf(cell));
    return span;
};

const c102Push = (
    board: IBoard,
    taken: Set<number>,
    seats: IC102Seat[],
    fronts: Set<number>,
    zone: IC102Zone,
    unit: Unit,
    anchor: XY,
): boolean => {
    if (c102Still(unit) || seats.some((seat) => seat.unit.getId() === unit.getId())) return false;
    const span = c102Stamp(board, taken, unit, anchor);
    if (!span) return false;
    seats.push({ unit, anchor: { x: anchor.x, y: anchor.y } });
    for (const cell of span.cells) {
        if (board.geom.frontness(cell) === zone.front) fronts.add(board.geom.lateral(cell));
    }
    return true;
};

const c102Locked = (board: IBoard, zone: IC102Zone): IC102Locks => {
    const taken = new Set<number>();
    const fronts = new Set<number>();
    for (const unit of board.units) {
        if (!c102Still(unit)) continue;
        const anchor = board.cells.get(unit.getId());
        const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
        if (!span) continue;
        for (const cell of span.cells) {
            taken.add(keyOf(cell));
            if (board.geom.frontness(cell) === zone.front) fronts.add(board.geom.lateral(cell));
        }
    }
    return { taken, fronts };
};

const c102Replay = (board: IBoard, zone: IC102Zone, seats: readonly IC102Seat[]): IC102Locks => {
    const locked = c102Locked(board, zone);
    for (const seat of seats) {
        const span = c102Stamp(board, locked.taken, seat.unit, seat.anchor);
        if (!span) continue;
        for (const cell of span.cells) {
            if (board.geom.frontness(cell) === zone.front) locked.fronts.add(board.geom.lateral(cell));
        }
    }
    return locked;
};

const c102Seated = (seats: readonly IC102Seat[], unit: Unit): boolean =>
    seats.some((seat) => seat.unit.getId() === unit.getId());

const c102LeadCharger = (board: IBoard, seats: readonly IC102Seat[]): Unit | undefined => {
    const fastest = c102Chargers(board)[0];
    if (!fastest || c102Seated(seats, fastest)) return undefined;
    return fastest;
};

const c102SmallCharger = (board: IBoard, seats: readonly IC102Seat[]): Unit | undefined =>
    c102Chargers(board).find((unit) => unit.isSmallSize() && !c102Seated(seats, unit));

const c102RankFile = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    rank: number,
    lat: number,
): XY | undefined => {
    const cell = c102Cell(board, rank, lat);
    if (!cell) return undefined;
    return c62Pick(
        unit,
        board,
        taken,
        (span) =>
            span.minFront === rank &&
            span.maxFront === rank &&
            span.laterals.every((value) => value === lat) &&
            span.cells.some((entry) => sameCell(entry, cell)),
        (span) => span.cells.length,
    );
};

const c102Depth = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    zone: IC102Zone,
    edge: "low" | "high",
    avoid: ReadonlySet<number>,
): XY | undefined =>
    c62Pick(
        unit,
        board,
        taken,
        (span) => {
            if (span.minFront !== zone.back || span.maxFront !== zone.middle) return false;
            if (span.laterals.some((lat) => avoid.has(lat) || !zone.files.includes(lat))) return false;
            return true;
        },
        (span) => (edge === "low" ? span.minLat * 1000 + span.maxLat : -span.maxLat * 1000 - span.minLat),
    );

const c102FrontLow = (board: IBoard, unit: Unit, taken: ReadonlySet<number>, zone: IC102Zone): XY | undefined => {
    const count = c102LatCount(unit, board.geom);
    return c62Pick(
        unit,
        board,
        taken,
        (span) => {
            if (span.maxFront !== zone.front || span.minLat !== zone.low) return false;
            const unique = [...new Set(span.laterals)].sort((a, b) => a - b);
            if (unique.length !== count || unique[0] !== zone.low) return false;
            for (let index = 0; index < unique.length; index += 1) {
                const lat = unique[index];
                if (lat !== zone.low + index || !zone.files.includes(lat)) return false;
            }
            return true;
        },
        (span) => span.maxLat,
    );
};

const c102FrontCentre = (board: IBoard, unit: Unit, taken: ReadonlySet<number>, zone: IC102Zone): XY | undefined =>
    c62Pick(
        unit,
        board,
        taken,
        (span) => {
            if (span.maxFront !== zone.front) return false;
            if (!span.laterals.every((lat) => zone.files.includes(lat))) return false;
            return span.cells.some(
                (cell) => board.geom.frontness(cell) === zone.front && board.geom.lateral(cell) === zone.centre,
            );
        },
        (span) => {
            const face = span.cells
                .filter((cell) => board.geom.frontness(cell) === zone.front)
                .map((cell) => board.geom.lateral(cell));
            return Math.abs(medianNumber(face) - zone.centre) * 1000 + span.minLat;
        },
    );

const c102BackHome = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    zone: IC102Zone,
    avoid: ReadonlySet<number>,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    return c62Pick(
        unit,
        board,
        taken,
        (span) => {
            if (span.minFront !== zone.back) return false;
            return span.laterals.every((lat) => zone.files.includes(lat) && !avoid.has(lat));
        },
        (span) => {
            const depth = span.maxFront - span.minFront;
            const dist = current ? chebyshev(c62Centre(span), current) : 0;
            return depth * 10000 + dist;
        },
    );
};

const c102OffFile = (
    board: IBoard,
    unit: Unit,
    taken: ReadonlySet<number>,
    zone: IC102Zone,
    file: number,
): XY | undefined => {
    const current = board.cells.get(unit.getId());
    return c62Pick(
        unit,
        board,
        taken,
        (span) =>
            span.maxFront === zone.front && span.laterals.every((lat) => lat !== file && zone.files.includes(lat)),
        (span) => {
            const depth = span.maxFront - span.minFront;
            const dist = current ? chebyshev(c62Centre(span), current) : 0;
            return depth * 10000 + dist;
        },
    );
};

const c102LatsOf = (board: IBoard, unit: Unit, anchor: XY): number[] => {
    const span = spanAt(unit, anchor, board.geom);
    if (!span) return [];
    return [...new Set(span.laterals)];
};

const c102BanCell = (board: IBoard, taken: Set<number>, forbidden: Set<number>, rank: number, lat: number): void => {
    const cell = c102Cell(board, rank, lat);
    if (!cell) return;
    const key = keyOf(cell);
    if (taken.has(key)) return;
    taken.add(key);
    forbidden.add(key);
};

const c102BanExcept = (
    board: IBoard,
    taken: Set<number>,
    forbidden: Set<number>,
    lat: number,
    keep: number | undefined,
): void => {
    for (const cell of board.geom.baseCells) {
        if (isBoardEdge(cell) || board.geom.lateral(cell) !== lat) continue;
        if (keep !== undefined && board.geom.frontness(cell) === keep) continue;
        const key = keyOf(cell);
        if (taken.has(key)) continue;
        taken.add(key);
        forbidden.add(key);
    }
};

const c102EndsOpen = (board: IBoard, taken: ReadonlySet<number>, zone: IC102Zone, lat: number): boolean => {
    const front = c102Cell(board, zone.front, lat);
    const back = c102Cell(board, zone.back, lat);
    if (!front || !back) return false;
    return !taken.has(keyOf(front)) && !taken.has(keyOf(back));
};

const c102Assign = (
    board: IBoard,
    taken: Set<number>,
    seats: IC102Seat[],
    fronts: Set<number>,
    zone: IC102Zone,
    units: readonly Unit[],
    files: readonly number[],
    rank: number,
    onFile?: Set<number>,
): void => {
    const pending = [...units];
    for (const lat of files) {
        if (!pending.length) return;
        if (rank === zone.front && fronts.has(lat)) continue;
        for (let index = 0; index < pending.length; index += 1) {
            const unit = pending[index];
            if (!unit) continue;
            const anchor = c102RankFile(board, unit, taken, rank, lat);
            if (!anchor || !c102Push(board, taken, seats, fronts, zone, unit, anchor)) continue;
            pending.splice(index, 1);
            onFile?.add(lat);
            break;
        }
    }
};

const c102Apply = (board: IBoard, seats: readonly IC102Seat[], forbidden: ReadonlySet<number>): boolean => {
    const snapshot = copyCells(board);
    const still = new Set(
        board.units.filter((unit) => c102Still(unit) && board.cells.has(unit.getId())).map((unit) => unit.getId()),
    );
    const taken = new Set<number>();
    for (const unit of board.units) {
        if (!still.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) taken.add(keyOf(cell));
    }
    const blocked = new Set<number>();
    for (const key of forbidden) {
        if (!taken.has(key)) blocked.add(key);
    }
    const assigned = new Map<string, XY>();
    const claim = (unit: Unit, anchor: XY): boolean => {
        const span = spanAt(unit, anchor, board.geom);
        if (!span || !spanIsLegal(span, board.geom, taken)) return false;
        if (span.cells.some((cell) => blocked.has(keyOf(cell)))) return false;
        for (const cell of span.cells) taken.add(keyOf(cell));
        assigned.set(unit.getId(), { x: anchor.x, y: anchor.y });
        return true;
    };
    const seated = new Set<string>();
    for (const seat of seats) {
        if (still.has(seat.unit.getId()) || !claim(seat.unit, seat.anchor)) {
            restoreCells(board, snapshot);
            return false;
        }
        seated.add(seat.unit.getId());
    }
    const rest = board.units
        .filter((unit) => board.cells.has(unit.getId()) && !still.has(unit.getId()) && !seated.has(unit.getId()))
        .sort((a, b) => byFootprintAreaLargestFirst(a, b) || byId(a, b));
    for (const unit of rest) {
        const current = board.cells.get(unit.getId());
        if (current && claim(unit, current)) continue;
        const nearest = c62Pick(
            unit,
            board,
            taken,
            (span) => !span.cells.some((cell) => blocked.has(keyOf(cell))),
            (span) => (current ? chebyshev(c62Centre(span), current) : span.cells.length),
        );
        if (!nearest || !claim(unit, nearest)) {
            restoreCells(board, snapshot);
            return false;
        }
    }
    for (const [id, anchor] of assigned) board.cells.set(id, { x: anchor.x, y: anchor.y });
    return true;
};

const c102Finish = (
    board: IBoard,
    incumbent: ReadonlyMap<string, XY>,
    seats: readonly IC102Seat[],
    forbidden: ReadonlySet<number>,
): Map<string, XY> => {
    const open = new Set(forbidden);
    for (const seat of seats) {
        const span = spanAt(seat.unit, seat.anchor, board.geom);
        if (!span) continue;
        for (const cell of span.cells) open.delete(keyOf(cell));
    }
    if (!c102Apply(board, seats, open)) return new Map(incumbent);
    return board.cells;
};

const c102ParkBack = (
    board: IBoard,
    taken: Set<number>,
    seats: IC102Seat[],
    fronts: Set<number>,
    zone: IC102Zone,
    unit: Unit,
): boolean => {
    const files = c102Outward(
        zone.files.filter((lat) => !fronts.has(lat)),
        zone.centre,
    );
    for (const lat of files) {
        const anchor = c102RankFile(board, unit, taken, zone.back, lat);
        if (!anchor || !c102Push(board, taken, seats, fronts, zone, unit, anchor)) continue;
        return true;
    }
    return false;
};

/** Front screens from the centre outward. A screen that does not fit takes a back cell one file over. */
const c102BreathOpen = (board: IBoard, zone: IC102Zone): IC102Plan | "abort" => {
    let seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    let taken = locked.taken;
    let fronts = locked.fronts;
    const screenLats = new Set<number>();
    const screens = c102Screens(board).sort(c62ByArmor);
    c102Assign(
        board,
        taken,
        seats,
        fronts,
        zone,
        screens,
        c102Outward(zone.files, zone.centre),
        zone.front,
        screenLats,
    );
    for (const screen of screens) {
        if (c102Seated(seats, screen)) continue;
        if (!c102ParkBack(board, taken, seats, fronts, zone, screen)) return "abort";
    }
    const charger = c102LeadCharger(board, seats);
    if (charger && zone.lane !== undefined) {
        const lane = zone.lane;
        const laneSeat = seats.find((seat) => {
            if (!c102IsScreen(seat.unit)) return false;
            const span = spanAt(seat.unit, seat.anchor, board.geom);
            return (
                !!span && span.minFront === zone.front && span.maxFront === zone.front && span.laterals.includes(lane)
            );
        });
        const kept = laneSeat ? seats.filter((seat) => seat.unit.getId() !== laneSeat.unit.getId()) : seats.slice();
        const replay = c102Replay(board, zone, kept);
        const anchor = c102RankFile(board, charger, replay.taken, zone.front, lane);
        if (anchor && c102Push(board, replay.taken, kept, replay.fronts, zone, charger, anchor)) {
            const parked = !laneSeat || c102ParkBack(board, replay.taken, kept, replay.fronts, zone, laneSeat.unit);
            if (!parked) return "abort";
            seats = kept;
            taken = replay.taken;
            fronts = replay.fronts;
            screenLats.delete(lane);
        }
    }
    const forbidden = new Set<number>();
    for (const lat of screenLats) c102BanCell(board, taken, forbidden, zone.middle, lat);
    if (
        zone.lane !== undefined &&
        seats.some(
            (seat) => isCharger(seat.unit) && c102LatsOf(board, seat.unit, seat.anchor).includes(zone.lane ?? -1),
        )
    ) {
        c102BanExcept(board, taken, forbidden, zone.lane, zone.front);
    }
    c102Assign(
        board,
        taken,
        seats,
        fronts,
        zone,
        c102Movers(board),
        zone.files.filter((lat) => !fronts.has(lat)),
        zone.back,
    );
    for (const seat of seats) {
        if (!seat.unit.canFly() || isCharger(seat.unit)) continue;
        for (const lat of c102LatsOf(board, seat.unit, seat.anchor)) {
            c102BanCell(board, taken, forbidden, zone.front, lat);
        }
    }
    return { seats, forbidden };
};

const c102BreathLarge = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const bodyLats = new Set<number>();
    for (const body of c102Larges(board).sort(c62ByLargest)) {
        const anchor = c102Depth(board, body, locked.taken, zone, "low", bodyLats);
        if (!anchor || !c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor)) continue;
        for (const lat of c102LatsOf(board, body, anchor)) {
            bodyLats.add(lat);
            c102BanCell(board, locked.taken, forbidden, zone.front, lat);
        }
    }
    let chargerLat: number | undefined;
    const lead = c102Chargers(board)[0];
    if (lead && lead.isSmallSize() && !bodyLats.has(zone.high)) {
        const anchor = c102RankFile(board, lead, locked.taken, zone.front, zone.high);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, lead, anchor)) {
            chargerLat = zone.high;
            c102BanExcept(board, locked.taken, forbidden, zone.high, zone.front);
        }
    }
    const screenLats = new Set<number>();
    const other = zone.files.filter((lat) => !bodyLats.has(lat) && lat !== chargerLat);
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        c102Outward(other, zone.centre),
        zone.front,
        screenLats,
    );
    for (const lat of screenLats) c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
    const flyerFiles = zone.files.filter((lat) => !bodyLats.has(lat) && !screenLats.has(lat) && lat !== chargerLat);
    c102Assign(board, locked.taken, seats, locked.fronts, zone, c102Movers(board), flyerFiles, zone.back);
    for (const seat of seats) {
        if (!seat.unit.canFly() || isCharger(seat.unit) || c102IsScreen(seat.unit)) continue;
        if (c102Larges(board).some((body) => body.getId() === seat.unit.getId())) continue;
        for (const lat of c102LatsOf(board, seat.unit, seat.anchor)) {
            if (bodyLats.has(lat) || screenLats.has(lat)) continue;
            c102BanCell(board, locked.taken, forbidden, zone.front, lat);
        }
    }
    return { seats, forbidden };
};

const c102SkewerLarge = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const body = c102Larges(board).sort(c62ByLargest)[0];
    if (body) {
        const anchor = c102FrontLow(board, body, locked.taken, zone);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor)) {
            const span = spanAt(body, anchor, board.geom);
            for (const lat of c102LatsOf(board, body, anchor)) {
                const middle = c102Cell(board, zone.middle, lat);
                if (!middle || !span || span.cells.some((cell) => sameCell(cell, middle))) continue;
                c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
            }
        }
    }
    for (const screen of c102Screens(board).sort(c62ByArmor)) {
        const anchor = c102RankFile(board, screen, locked.taken, zone.front, zone.centre);
        if (!anchor || !c102Push(board, locked.taken, seats, locked.fronts, zone, screen, anchor)) continue;
        c102BanCell(board, locked.taken, forbidden, zone.middle, zone.centre);
        break;
    }
    const charger = c102SmallCharger(board, seats);
    if (charger) {
        const anchor = c102RankFile(board, charger, locked.taken, zone.back, zone.high);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor)) {
            c102BanExcept(board, locked.taken, forbidden, zone.high, zone.back);
        }
    }
    for (const flyer of c102Movers(board)) {
        for (const lat of zone.files) {
            if (!c102EndsOpen(board, locked.taken, zone, lat)) continue;
            const anchor = c102RankFile(board, flyer, locked.taken, zone.middle, lat);
            if (!anchor || !c102Push(board, locked.taken, seats, locked.fronts, zone, flyer, anchor)) continue;
            c102BanCell(board, locked.taken, forbidden, zone.front, lat);
            c102BanCell(board, locked.taken, forbidden, zone.back, lat);
            break;
        }
    }
    return { seats, forbidden };
};

const c102Through = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    c102BanCell(board, locked.taken, forbidden, zone.front, zone.centre);
    const shoulders = c102Outward(c102Shoulders(zone), zone.centre);
    const screenLats = new Set<number>();
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        shoulders,
        zone.front,
        screenLats,
    );
    for (const lat of screenLats) c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
    const bodyLats = new Set<number>();
    const body = c102Larges(board).sort(c62ByLargest)[0];
    if (body) {
        const avoid = new Set(screenLats);
        if (zone.lane !== undefined) avoid.add(zone.lane);
        const anchor = c102Depth(board, body, locked.taken, zone, "high", avoid);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor)) {
            for (const lat of c102LatsOf(board, body, anchor)) bodyLats.add(lat);
        }
    }
    const shoulderSet = new Set(shoulders);
    const flyerLats = new Set<number>();
    for (const flyer of c102Movers(board)) {
        for (const lat of c102HighFirst(zone.files.filter((file) => file !== zone.centre && !shoulderSet.has(file)))) {
            const front = c102Cell(board, zone.front, lat);
            const middle = c102Cell(board, zone.middle, lat);
            if (!front || !middle || locked.taken.has(keyOf(front)) || locked.taken.has(keyOf(middle))) continue;
            const anchor = c102RankFile(board, flyer, locked.taken, zone.back, lat);
            if (!anchor || !c102Push(board, locked.taken, seats, locked.fronts, zone, flyer, anchor)) continue;
            flyerLats.add(lat);
            c102BanCell(board, locked.taken, forbidden, zone.front, lat);
            c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
            break;
        }
    }
    if (zone.lane !== undefined && !flyerLats.has(zone.lane) && !bodyLats.has(zone.lane)) {
        const charger = c102LeadCharger(board, seats);
        const anchor = charger ? c102RankFile(board, charger, locked.taken, zone.front, zone.lane) : undefined;
        if (charger && anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor)) {
            c102BanExcept(board, locked.taken, forbidden, zone.lane, zone.front);
        }
    }
    return { seats, forbidden };
};

const c102HitsPlan = (
    board: IBoard,
    taken: ReadonlySet<number>,
    forbidden: ReadonlySet<number>,
    unit: Unit,
    centreFront: XY | undefined,
): boolean => {
    const anchor = board.cells.get(unit.getId());
    const span = anchor ? spanAt(unit, anchor, board.geom) : undefined;
    if (!span) return false;
    return span.cells.some(
        (cell) =>
            taken.has(keyOf(cell)) ||
            forbidden.has(keyOf(cell)) ||
            (centreFront !== undefined && sameCell(cell, centreFront)),
    );
};

const c102FlyerPocket = (board: IBoard, zone: IC102Zone, movers: readonly Unit[]): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const shoulders = c102Shoulders(zone)
        .filter((lat) => lat !== zone.high)
        .sort((a, b) => a - b);
    const pending = movers.slice(0, 2);
    for (const lat of shoulders) {
        for (let index = 0; index < pending.length; index += 1) {
            const flyer = pending[index];
            if (!flyer) continue;
            const anchor = c102RankFile(board, flyer, locked.taken, zone.middle, lat);
            if (!anchor || !c102Push(board, locked.taken, seats, locked.fronts, zone, flyer, anchor)) continue;
            pending.splice(index, 1);
            c102BanCell(board, locked.taken, forbidden, zone.front, lat);
            c102BanCell(board, locked.taken, forbidden, zone.back, lat);
            break;
        }
    }
    const screenLats = new Set<number>();
    const slots: number[] = [];
    for (const lat of [zone.centre, zone.low, zone.high]) {
        if (!zone.files.includes(lat) || slots.includes(lat)) continue;
        slots.push(lat);
    }
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        slots,
        zone.front,
        screenLats,
    );
    if (screenLats.has(zone.high)) {
        const charger = c102LeadCharger(board, seats);
        const anchor = charger ? c102RankFile(board, charger, locked.taken, zone.back, zone.high) : undefined;
        if (charger && anchor) c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor);
        c102BanCell(board, locked.taken, forbidden, zone.middle, zone.high);
    }
    const avoid = new Set<number>(c102Shoulders(zone));
    if (seats.some((seat) => isCharger(seat.unit) && c102LatsOf(board, seat.unit, seat.anchor).includes(zone.high))) {
        avoid.add(zone.high);
    }
    const centreFront = c102Cell(board, zone.front, zone.centre);
    for (const body of c102Larges(board).sort(c62ByLargest)) {
        if (c102Seated(seats, body) || !c102HitsPlan(board, locked.taken, forbidden, body, centreFront)) continue;
        const anchor = c102BackHome(board, body, locked.taken, zone, avoid);
        if (anchor) c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor);
    }
    return { seats, forbidden };
};

const c102FlyerWall = (board: IBoard, zone: IC102Zone, body: Unit): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const covered = new Set<number>();
    const anchor = c102FrontCentre(board, body, locked.taken, zone);
    const seated = !!anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor);
    const span = seated && anchor ? spanAt(body, anchor, board.geom) : undefined;
    if (span) {
        for (const lat of span.laterals) covered.add(lat);
    } else {
        const current = board.cells.get(body.getId());
        const incumbent = current ? spanAt(body, current, board.geom) : undefined;
        if (incumbent) {
            for (const cell of incumbent.cells) locked.taken.add(keyOf(cell));
            for (const lat of incumbent.laterals) covered.add(lat);
        }
    }
    for (const lat of covered) {
        const middle = c102Cell(board, zone.middle, lat);
        if (!middle || (span && span.cells.some((cell) => sameCell(cell, middle)))) continue;
        c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
    }
    const screenFiles = zone.files.filter((lat) => !covered.has(lat) && lat !== zone.low);
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        c102Outward(screenFiles, zone.centre),
        zone.front,
    );
    const charger = c102SmallCharger(board, seats);
    if (charger && zone.lane !== undefined && !covered.has(zone.lane)) {
        const back = c102RankFile(board, charger, locked.taken, zone.back, zone.lane);
        if (back && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, back)) {
            c102BanExcept(board, locked.taken, forbidden, zone.lane, zone.back);
        }
    }
    return { seats, forbidden };
};

const c102FlyerLoose = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    c102BanCell(board, locked.taken, forbidden, zone.front, zone.centre);
    c102BanCell(board, locked.taken, forbidden, zone.middle, zone.centre);
    const shoulders = c102Outward(c102Shoulders(zone), zone.centre);
    const shoulderSet = new Set(shoulders);
    const outer = c102Outward(
        zone.files.filter((lat) => lat !== zone.centre && lat !== zone.low && !shoulderSet.has(lat)),
        zone.centre,
    );
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        [...shoulders, ...outer],
        zone.front,
    );
    const charger = c102LeadCharger(board, seats);
    if (charger && zone.lane !== undefined) {
        const anchor = c102RankFile(board, charger, locked.taken, zone.back, zone.lane);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor)) {
            c102BanCell(board, locked.taken, forbidden, zone.front, zone.lane);
            c102BanCell(board, locked.taken, forbidden, zone.middle, zone.lane);
        }
    }
    return { seats, forbidden };
};

const c102RangedLarge = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const bodyLats = new Set<number>();
    const body = c102Larges(board).sort(c62ByLargest)[0];
    if (body) {
        const avoid = new Set<number>();
        if (zone.lane !== undefined) avoid.add(zone.lane);
        const anchor = c102Depth(board, body, locked.taken, zone, "high", avoid);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, body, anchor)) {
            for (const lat of c102LatsOf(board, body, anchor)) bodyLats.add(lat);
        }
    }
    const slots = [zone.centre, zone.centre - 1].filter(
        (lat, index, all) => zone.files.includes(lat) && all.indexOf(lat) === index && !bodyLats.has(lat),
    );
    const screenLats = new Set<number>();
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        slots,
        zone.front,
        screenLats,
    );
    for (const lat of screenLats) c102BanCell(board, locked.taken, forbidden, zone.back, lat);
    c102Assign(board, locked.taken, seats, locked.fronts, zone, c102Movers(board), [...screenLats], zone.middle);
    const charger = c102SmallCharger(board, seats);
    if (charger && zone.lane !== undefined && !screenLats.has(zone.lane) && !bodyLats.has(zone.lane)) {
        const anchor = c102RankFile(board, charger, locked.taken, zone.back, zone.lane);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor)) {
            c102BanExcept(board, locked.taken, forbidden, zone.lane, zone.back);
        }
    }
    return { seats, forbidden };
};

const c102RangedOpen = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    c102BanCell(board, locked.taken, forbidden, zone.front, zone.centre);
    const shoulders = c102Outward(c102Shoulders(zone), zone.centre);
    const screenLats = new Set<number>();
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Screens(board).sort(c62ByArmor),
        shoulders,
        zone.front,
        screenLats,
    );
    for (const lat of screenLats) c102BanCell(board, locked.taken, forbidden, zone.middle, lat);
    const flyerLats = new Set<number>();
    c102Assign(
        board,
        locked.taken,
        seats,
        locked.fronts,
        zone,
        c102Movers(board),
        [...screenLats],
        zone.back,
        flyerLats,
    );
    const shoulderSet = new Set(shoulders);
    const outer = zone.files.filter((lat) => lat !== zone.centre && !shoulderSet.has(lat) && !flyerLats.has(lat));
    const lane = outer.sort((a, b) => a - b)[0];
    const charger = c102LeadCharger(board, seats);
    if (charger && lane !== undefined) {
        const anchor = c102RankFile(board, charger, locked.taken, zone.back, lane);
        if (anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor)) {
            c102BanExcept(board, locked.taken, forbidden, lane, zone.back);
        }
    }
    return { seats, forbidden };
};

const c102Calm = (board: IBoard, zone: IC102Zone): IC102Plan => {
    const seats: IC102Seat[] = [];
    const locked = c102Locked(board, zone);
    const forbidden = new Set<number>();
    const slots = c102Outward(
        zone.files.filter((lat) => lat !== zone.low),
        zone.centre,
    );
    c102Assign(board, locked.taken, seats, locked.fronts, zone, c102Screens(board).sort(c102BySlow), slots, zone.front);
    const charger = c102LeadCharger(board, seats);
    let chargerOnBack = false;
    if (charger && zone.lane !== undefined) {
        const anchor = c102RankFile(board, charger, locked.taken, zone.back, zone.lane);
        chargerOnBack = !!anchor && c102Push(board, locked.taken, seats, locked.fronts, zone, charger, anchor);
    }
    c102BanExcept(board, locked.taken, forbidden, zone.low, chargerOnBack ? zone.back : undefined);
    for (const unit of board.units) {
        if (c102Still(unit) || !board.cells.has(unit.getId()) || c102Seated(seats, unit)) continue;
        if (!board.laterals(unit).includes(zone.low)) continue;
        const anchor = c102OffFile(board, unit, locked.taken, zone, zone.low);
        if (anchor) c102Push(board, locked.taken, seats, locked.fronts, zone, unit, anchor);
    }
    return { seats, forbidden };
};

/**
 * r10c2 post-pass. Today's placeArmy has already run. The first public branch is the only one.
 * Straight lines are Fire Breath, Skewer Strike, and Through Shot. Lightning Spin and Chakram are not.
 * An illegal seat keeps the incumbent cell. The zone is not extended.
 */
export function placeArmyR10C2(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow || threats.largeCaliber) return new Map(incumbent);
    const straight = threats.fireBreath || threats.skewerStrike || threats.throughShot;
    if ((threats.lightningSpin || threats.chakram) && !straight) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const zone = c102Zone(board);
    if (!zone) return board.cells;
    const movers = c102Movers(board);
    const larges = c102Larges(board);
    let plan: IC102Plan | "abort";
    if (threats.fireBreath) plan = larges.length > 0 ? c102BreathLarge(board, zone) : c102BreathOpen(board, zone);
    else if (threats.skewerStrike)
        plan = larges.length > 0 ? c102SkewerLarge(board, zone) : c102BreathOpen(board, zone);
    else if (threats.throughShot) plan = c102Through(board, zone);
    else if (threats.flyers > 0)
        plan =
            movers.length > 0
                ? c102FlyerPocket(board, zone, movers)
                : larges[0]
                  ? c102FlyerWall(board, zone, larges[0])
                  : c102FlyerLoose(board, zone);
    else if (threats.rangeCreatures > 0)
        plan = larges.length > 0 ? c102RangedLarge(board, zone) : c102RangedOpen(board, zone);
    else plan = c102Calm(board, zone);
    if (plan === "abort") return new Map(incumbent);
    return c102Finish(board, incumbent, plan.seats, plan.forbidden);
}

const C103_STAY = new Set(["Monk", "Dryad", "Abomination", "Angel", "Arachna Queen"]);

interface IC103Zone {
    readonly back: number;
    readonly middle: number;
    readonly front: number;
    readonly laterals: readonly number[];
    readonly centre: number;
    readonly low: number;
    readonly high: number;
}

interface IC103Choice {
    readonly unit: Unit;
    readonly anchors: readonly XY[];
}

const c103At = (cell: XY): XY => ({ x: cell.x, y: cell.y });

const c103Unit = (board: IBoard, id: string): Unit | undefined => board.units.find((unit) => unit.getId() === id);

const c103Cell = (board: IBoard, rank: number, lat: number): XY | undefined => {
    const cell = r3Cell(board, rank, lat);
    if (!cell || isBoardEdge(cell) || !board.geom.legal.has(keyOf(cell))) return undefined;
    return cell;
};

const c103Zone = (board: IBoard): IC103Zone | undefined => {
    const ranks = ranksOf(board);
    if (!(ranks.middle < ranks.front)) return undefined;
    const laterals: number[] = [];
    for (let lat = ranks.minLat; lat <= ranks.maxLat; lat += 1) {
        if (c103Cell(board, ranks.back, lat)) laterals.push(lat);
    }
    const low = laterals[0];
    const high = laterals[laterals.length - 1];
    if (low === undefined || high === undefined) return undefined;
    let centre = low;
    for (const lat of laterals) {
        const dist = Math.abs(lat - board.geom.centreLat);
        const best = Math.abs(centre - board.geom.centreLat);
        if (dist < best || (dist === best && lat < centre)) centre = lat;
    }
    return { back: ranks.back, middle: ranks.middle, front: ranks.front, laterals, centre, low, high };
};

const c103FullFiles = (board: IBoard, zone: IC103Zone): number[] =>
    zone.laterals.filter(
        (lat) =>
            c103Cell(board, zone.back, lat) !== undefined &&
            c103Cell(board, zone.middle, lat) !== undefined &&
            c103Cell(board, zone.front, lat) !== undefined,
    );

const c103OnRank = (span: ISpan, rank: number): boolean => span.minFront === rank && span.maxFront === rank;

/** Catalog spellbook. Troll's Wild Regeneration is a runtime spell object, and he still counts as a screen. */
const c103SpellCaster = (unit: Unit): boolean =>
    isSpellbookUnit(unit) && unit.getAttackType() !== RANGE && !C103_STAY.has(unit.getName());

const c103Buffer = (unit: Unit): boolean => c103SpellCaster(unit) && c83IsBuffer(unit);

const c103IsScreen = (unit: Unit): boolean =>
    unit.isSmallSize() &&
    !unit.canFly() &&
    unit.getAttackType() !== RANGE &&
    !c103SpellCaster(unit) &&
    !C103_STAY.has(unit.getName());

const c103ByArmor = (a: Unit, b: Unit): number =>
    b.getArmor() - a.getArmor() || b.getCumulativeHp() - a.getCumulativeHp() || byId(a, b);

const c103BySpeed = (a: Unit, b: Unit): number => b.getSteps() - a.getSteps() || c103ByArmor(a, b);

const c103Screens = (board: IBoard): Unit[] =>
    board.units.filter((unit) => c103IsScreen(unit) && board.cells.has(unit.getId())).sort(c103ByArmor);

const c103Protected = (board: IBoard): Unit[] => {
    const casters = board.units
        .filter((unit) => c103SpellCaster(unit) && board.cells.has(unit.getId()))
        .sort((a, b) => medianLat(a, board) - medianLat(b, board) || byId(a, b));
    if (casters.length) return casters;
    return board.units.filter((unit) => unit.getName() === "Monk" && board.cells.has(unit.getId())).sort(byId);
};

const c103Bows = (board: IBoard): Unit[] =>
    board.units.filter((unit) => unit.getAttackType() === RANGE && board.cells.has(unit.getId()));

const c103Lats = (board: IBoard, units: readonly Unit[]): Set<number> => {
    const laterals = new Set<number>();
    for (const unit of units) {
        for (const lat of board.laterals(unit)) laterals.add(lat);
    }
    return laterals;
};

const c103CornerKeys = (board: IBoard, zone: IC103Zone): Set<number> => {
    const keys = new Set<number>();
    const low = c103Cell(board, zone.back, zone.low);
    const high = c103Cell(board, zone.back, zone.high);
    if (low) keys.add(keyOf(low));
    if (high) keys.add(keyOf(high));
    return keys;
};

const c103CoversKey = (cells: readonly XY[], cellKey: number): boolean => cells.some((cell) => keyOf(cell) === cellKey);

const c103AnchorOf = (board: IBoard, seats: ReadonlyMap<string, XY>, unit: Unit): XY | undefined =>
    seats.get(unit.getId()) ?? board.cells.get(unit.getId());

const c103FootOf = (board: IBoard, seats: ReadonlyMap<string, XY>, unit: Unit): XY[] => {
    const anchor = c103AnchorOf(board, seats, unit);
    return anchor ? footprintCellsForAnchor(unit, anchor) : [];
};

const c103Fits = (board: IBoard, seats: ReadonlyMap<string, XY>, empty: ReadonlySet<number>): boolean => {
    const seen = new Set<number>();
    for (const unit of board.units) {
        const current = board.cells.get(unit.getId());
        if (!current) continue;
        const anchor = seats.get(unit.getId()) ?? current;
        const staying = !seats.has(unit.getId()) || sameCell(anchor, current);
        const span = spanAt(unit, anchor, board.geom);
        if (!span) return false;
        if (!staying && !spanIsLegal(span, board.geom, new Set())) return false;
        for (const cell of span.cells) {
            const key = keyOf(cell);
            if (empty.has(key) || seen.has(key)) return false;
            seen.add(key);
        }
    }
    return true;
};

const c103Write = (board: IBoard, seats: ReadonlyMap<string, XY>): void => {
    for (const [id, anchor] of seats) {
        const current = board.cells.get(id);
        if (!current || sameCell(current, anchor)) continue;
        board.cells.set(id, c103At(anchor));
    }
};

const c103Nearest = (board: IBoard, unit: Unit, anchors: readonly XY[], limit: number): XY[] => {
    const current = board.cells.get(unit.getId());
    return [...anchors]
        .sort((a, b) => {
            const aCost = current ? chebyshev(a, current) : 0;
            const bCost = current ? chebyshev(b, current) : 0;
            return aCost - bCost || a.x - b.x || a.y - b.y;
        })
        .slice(0, limit);
};

/** Maximize seated stacks, then minimize travel. A stack with no offered seat keeps its cell. */
const c103Search = (
    board: IBoard,
    choices: readonly IC103Choice[],
    empty: ReadonlySet<number>,
    accept: (seats: ReadonlyMap<string, XY>) => boolean,
): Map<string, XY> | undefined => {
    if (!choices.length) {
        const stays = new Map<string, XY>();
        return c103Fits(board, stays, empty) && accept(stays) ? stays : undefined;
    }
    let best: Map<string, XY> | undefined;
    let bestPlaced = -1;
    let bestCost = Infinity;
    let nodes = 0;
    const walk = (index: number, seats: Map<string, XY>, placed: number, cost: number): void => {
        if (nodes > 100000) return;
        if (bestPlaced === choices.length && bestCost === 0) return;
        nodes += 1;
        if (placed + (choices.length - index) < bestPlaced) return;
        if (index === choices.length) {
            if (!c103Fits(board, seats, empty) || !accept(seats)) return;
            if (placed > bestPlaced || (placed === bestPlaced && cost < bestCost)) {
                best = new Map(seats);
                bestPlaced = placed;
                bestCost = cost;
            }
            return;
        }
        const choice = choices[index];
        if (!choice) return;
        const current = board.cells.get(choice.unit.getId());
        const seen = new Set<string>();
        const consider = (anchor: XY, counts: boolean): void => {
            const token = `${anchor.x},${anchor.y}`;
            if (seen.has(token)) return;
            seen.add(token);
            seats.set(choice.unit.getId(), c103At(anchor));
            const step = current ? chebyshev(anchor, current) : 0;
            walk(index + 1, seats, placed + (counts ? 1 : 0), cost + step);
            seats.delete(choice.unit.getId());
        };
        for (const anchor of choice.anchors) consider(anchor, true);
        if (current && !choice.anchors.some((anchor) => sameCell(anchor, current))) consider(current, false);
    };
    walk(0, new Map(), 0, 0);
    return best;
};

const c103BlockedCells = (board: IBoard, movers: ReadonlySet<string>): Set<number> => {
    const blocked = new Set<number>();
    for (const unit of board.units) {
        if (movers.has(unit.getId())) continue;
        for (const cell of board.footprint(unit)) blocked.add(keyOf(cell));
    }
    return blocked;
};

const c103HitsBlocked = (cells: readonly XY[], blocked: ReadonlySet<number>): boolean =>
    cells.some((cell) => blocked.has(keyOf(cell)));

const c103BetweenLat = (board: IBoard, left: readonly XY[], right: readonly XY[]): number | undefined => {
    if (!left.length || !right.length) return undefined;
    const leftLats = left.map((cell) => board.geom.lateral(cell));
    const rightLats = right.map((cell) => board.geom.lateral(cell));
    const leftMin = Math.min(...leftLats);
    const leftMax = Math.max(...leftLats);
    const rightMin = Math.min(...rightLats);
    const rightMax = Math.max(...rightLats);
    const from = leftMax < rightMin ? leftMax + 1 : rightMax < leftMin ? rightMax + 1 : undefined;
    const to = leftMax < rightMin ? rightMin - 1 : rightMax < leftMin ? leftMin - 1 : undefined;
    if (from === undefined || to === undefined || from !== to) return undefined;
    return from;
};

const c103Seated = (anchors: readonly XY[], anchor: XY | undefined): boolean =>
    anchor !== undefined && anchors.some((seat) => sameCell(seat, anchor));

const c103Area = (board: IBoard): void => {
    const zone = c103Zone(board);
    const protectedUnits = c103Protected(board);
    const protectedFeet = protectedUnits.map((unit) => board.footprint(unit)).filter((foot) => foot.length > 0);
    if (!zone || !protectedFeet.length) return;
    const blockedLats = c103Lats(board, [...c103Bows(board), ...protectedUnits]);
    const screens = c103Screens(board);
    const blocked = c103BlockedCells(board, new Set(screens.map((unit) => unit.getId())));
    const choices: IC103Choice[] = [];
    const offered = new Map<string, XY[]>();
    for (const screen of screens) {
        const anchors: XY[] = [];
        for (const lat of zone.laterals) {
            if (blockedLats.has(lat)) continue;
            const anchor = c103Cell(board, zone.front, lat);
            if (!anchor) continue;
            const span = spanAt(screen, anchor, board.geom);
            // Front centre is eligible only when it is already an exactly-2 seat off the protected file.
            if (!span || !c103OnRank(span, zone.front) || span.laterals.some((value) => blockedLats.has(value))) {
                continue;
            }
            if (c103HitsBlocked(span.cells, blocked)) continue;
            const dist = Math.min(...protectedFeet.map((foot) => minChebyshev(span.cells, foot)));
            if (dist !== 2) continue;
            anchors.push(anchor);
        }
        const nearest = c103Nearest(board, screen, anchors, 12);
        if (!nearest.length) continue;
        offered.set(screen.getId(), nearest);
        choices.push({ unit: screen, anchors: nearest });
    }
    const found = c103Search(board, choices, new Set(), (seats) => {
        for (const screen of screens) {
            const anchors = offered.get(screen.getId()) ?? [];
            if (!c103Seated(anchors, c103AnchorOf(board, seats, screen))) continue;
            const foot = c103FootOf(board, seats, screen);
            for (const other of screens) {
                if (other.getId() === screen.getId()) continue;
                const otherFoot = c103FootOf(board, seats, other);
                if (otherFoot.length && minChebyshev(foot, otherFoot) < 2) return false;
            }
        }
        return true;
    });
    if (found) c103Write(board, found);
};

const c103Caliber = (board: IBoard): void => {
    const zone = c103Zone(board);
    const protectedUnits = c103Protected(board).filter((unit) => board.footprint(unit).length > 0);
    if (!zone || !protectedUnits.length) return;
    const screens = c103Screens(board);
    const blocked = c103BlockedCells(board, new Set(screens.map((unit) => unit.getId())));
    const choices: IC103Choice[] = [];
    const offered = new Map<string, XY[]>();
    for (const screen of screens) {
        const anchors: XY[] = [];
        for (const lat of zone.laterals) {
            const anchor = c103Cell(board, zone.back, lat);
            if (!anchor) continue;
            const span = spanAt(screen, anchor, board.geom);
            if (!span || !c103OnRank(span, zone.back) || c103HitsBlocked(span.cells, blocked)) continue;
            const outside = protectedUnits.every((unit) => minChebyshev(span.cells, board.footprint(unit)) >= 2);
            const gap = protectedUnits.some((unit) => {
                const between = c103BetweenLat(board, span.cells, board.footprint(unit));
                return between !== undefined && c103Cell(board, zone.back, between) !== undefined;
            });
            if (!outside || !gap) continue;
            anchors.push(anchor);
        }
        const nearest = c103Nearest(board, screen, anchors, 12);
        if (!nearest.length) continue;
        offered.set(screen.getId(), nearest);
        choices.push({ unit: screen, anchors: nearest });
    }
    const found = c103Search(board, choices, new Set(), (seats) => {
        for (const screen of screens) {
            const anchors = offered.get(screen.getId()) ?? [];
            const anchor = c103AnchorOf(board, seats, screen);
            if (!c103Seated(anchors, anchor)) continue;
            const foot = c103FootOf(board, seats, screen);
            const partner = protectedUnits.find(
                (unit) => c103BetweenLat(board, foot, board.footprint(unit)) !== undefined,
            );
            const between = partner ? c103BetweenLat(board, foot, board.footprint(partner)) : undefined;
            if (between === undefined) return false;
            const gap = c103Cell(board, zone.back, between);
            if (!gap) return false;
            const gapKey = keyOf(gap);
            for (const unit of board.units) {
                if (c103CoversKey(c103FootOf(board, seats, unit), gapKey)) return false;
            }
        }
        return true;
    });
    if (found) c103Write(board, found);
};

const c103BowFrontKeys = (board: IBoard, bows: readonly Unit[]): Set<number> => {
    const keys = new Set<number>();
    for (const bow of bows) {
        for (const cell of board.footprint(bow)) {
            const ahead = board.geom.towardEnemy(cell, 1);
            if (isBoardEdge(ahead) || !board.geom.legal.has(keyOf(ahead))) continue;
            keys.add(keyOf(ahead));
        }
    }
    return keys;
};

const c103Glued = (board: IBoard, unit: Unit, bowFront: ReadonlySet<number>): boolean =>
    board.footprint(unit).some((cell) => {
        const key = keyOf(cell);
        if (!bowFront.has(key)) return false;
        return !board.units.some(
            (other) => other.getId() !== unit.getId() && c103CoversKey(board.footprint(other), key),
        );
    });

const c103BowFrontKept = (board: IBoard, bowFront: ReadonlySet<number>, seats: ReadonlyMap<string, XY>): boolean => {
    for (const key of bowFront) {
        const occupied = board.units.some((unit) => c103CoversKey(board.footprint(unit), key));
        if (!occupied) continue;
        const covered = board.units.some((unit) => c103CoversKey(c103FootOf(board, seats, unit), key));
        if (!covered) return false;
    }
    return true;
};

const c103BreathDirs = (board: IBoard, zone: IC103Zone, bait: number, threats: readonly Unit[]): number[] => {
    if (bait !== zone.centre) {
        const shift = Math.sign(bait - zone.centre);
        return [-shift, shift];
    }
    const lats: number[] = [];
    for (const unit of threats) lats.push(...board.laterals(unit));
    const median = lats.length ? medianNumber(lats) : zone.centre;
    if (median > bait) return [-1, 1];
    if (median < bait) return [1, -1];
    return [-1, 1];
};

const c103SlideCaster = (
    board: IBoard,
    zone: IC103Zone,
    caster: Unit,
    bait: number,
    reserved: ReadonlySet<number>,
): XY | undefined => {
    const current = board.cells.get(caster.getId());
    const currentLats = board.laterals(caster);
    if (!current || !currentLats.length) return undefined;
    if (lateralDistance(currentLats, [bait]) >= 2) return current;
    let best: XY | undefined;
    let bestCost = Infinity;
    let bestStep = Infinity;
    for (const lat of zone.laterals) {
        const anchor = c103Cell(board, zone.back, lat);
        if (!anchor) continue;
        const span = spanAt(caster, anchor, board.geom);
        if (!span || !c103OnRank(span, zone.back) || lateralDistance(span.laterals, [bait]) < 2) continue;
        if (span.cells.some((cell) => reserved.has(keyOf(cell)))) continue;
        const cost = Math.abs(medianNumber(span.laterals) - medianNumber(currentLats));
        const step = chebyshev(anchor, current);
        const better =
            cost < bestCost ||
            (cost === bestCost &&
                (step < bestStep ||
                    (step === bestStep &&
                        (anchor.x < (best?.x ?? 0) || (anchor.x === best?.x && anchor.y < (best?.y ?? 0))))));
        if (!better) continue;
        best = anchor;
        bestCost = cost;
        bestStep = step;
    }
    return best;
};

const c103Breath = (board: IBoard): void => {
    const zone = c103Zone(board);
    if (!zone) return;
    const files = c103FullFiles(board, zone);
    const bows = c103Bows(board);
    const protectedUnits = c103Protected(board);
    const touched = c103Lats(board, [...protectedUnits, ...bows]);
    const open = files
        .filter((lat) => !touched.has(lat))
        .sort((a, b) => Math.abs(a - zone.centre) - Math.abs(b - zone.centre) || a - b);
    const bowFront = c103BowFrontKeys(board, bows);
    const loose = c103Screens(board).filter((unit) => !c103Glued(board, unit, bowFront));
    const bowLats = c103Lats(board, bows);
    if (!open.length || !loose.length) return;
    const threats = [...protectedUnits, ...bows];
    for (const primary of loose) {
        const secondary = loose.find((unit) => unit.getId() !== primary.getId());
        for (const bait of open) {
            const baitFront = c103Cell(board, zone.front, bait);
            const baitMid = c103Cell(board, zone.middle, bait);
            const baitBack = c103Cell(board, zone.back, bait);
            if (!baitFront || !baitMid || !baitBack) continue;
            const dirs = c103BreathDirs(board, zone, bait, threats);
            const secondLats = secondary
                ? dirs
                      .map((dir) => bait + 2 * dir)
                      .filter((lat) => files.includes(lat) && !bowLats.has(lat) && lat !== bait)
                : [];
            const attempts: (number | undefined)[] = [...secondLats, undefined];
            for (const second of attempts) {
                const secondFront = second === undefined ? undefined : c103Cell(board, zone.front, second);
                const secondMid = second === undefined ? undefined : c103Cell(board, zone.middle, second);
                if (second !== undefined && (!secondFront || !secondMid || !secondary)) continue;
                const moves = new Map<string, XY>();
                moves.set(primary.getId(), c103At(baitFront));
                if (secondary && secondFront) moves.set(secondary.getId(), c103At(secondFront));
                const empty = new Set<number>([keyOf(baitMid), keyOf(baitBack)]);
                if (secondMid) empty.add(keyOf(secondMid));
                const reserved = new Set<number>();
                for (const unit of board.units) {
                    if (moves.has(unit.getId())) continue;
                    if (c103SpellCaster(unit) && lateralDistance(board.laterals(unit), [bait]) < 2) continue;
                    for (const cell of board.footprint(unit)) reserved.add(keyOf(cell));
                }
                let screensLegal = true;
                for (const [id, anchor] of moves) {
                    const unit = c103Unit(board, id);
                    const span = unit ? spanAt(unit, anchor, board.geom) : undefined;
                    if (!unit || !span || !c103OnRank(span, zone.front) || !spanIsLegal(span, board.geom, reserved)) {
                        screensLegal = false;
                        break;
                    }
                    for (const cell of span.cells) reserved.add(keyOf(cell));
                }
                if (!screensLegal || [...empty].some((key) => reserved.has(key))) continue;
                for (const key of empty) reserved.add(key);
                const casters = board.units
                    .filter((unit) => c103SpellCaster(unit) && board.cells.has(unit.getId()))
                    .sort(
                        (a, b) =>
                            lateralDistance(board.laterals(a), [bait]) - lateralDistance(board.laterals(b), [bait]) ||
                            byId(a, b),
                    );
                let castersLegal = true;
                for (const caster of casters) {
                    if (lateralDistance(board.laterals(caster), [bait]) >= 2) continue;
                    const seat = c103SlideCaster(board, zone, caster, bait, reserved);
                    if (!seat) {
                        castersLegal = false;
                        break;
                    }
                    const current = board.cells.get(caster.getId());
                    if (current && sameCell(current, seat)) continue;
                    moves.set(caster.getId(), c103At(seat));
                    const span = spanAt(caster, seat, board.geom);
                    if (!span) {
                        castersLegal = false;
                        break;
                    }
                    for (const cell of span.cells) reserved.add(keyOf(cell));
                }
                if (!castersLegal || !c103BowFrontKept(board, bowFront, moves) || !c103Fits(board, moves, empty)) {
                    continue;
                }
                c103Write(board, moves);
                return;
            }
        }
    }
};

const c103Safe = (board: IBoard, zone: IC103Zone, span: ISpan): boolean => {
    if (!c103OnRank(span, zone.back)) return false;
    const low = c103Cell(board, zone.back, zone.low);
    const high = c103Cell(board, zone.back, zone.high);
    if (!low || !high) return false;
    return span.cells.every((cell) => chebyshev(cell, low) >= 5 && chebyshev(cell, high) >= 5);
};

const c103Flyers = (board: IBoard, threats: IPublicPlacementThreats): void => {
    const zone = c103Zone(board);
    if (!zone) return;
    const corners = c103CornerKeys(board, zone);
    const bows = c103Bows(board);
    const safeMovers: Unit[] = [];
    if (threats.rangeNullField) {
        for (const bow of bows) {
            if (C103_STAY.has(bow.getName())) continue;
            if ([...corners].some((key) => c103CoversKey(board.footprint(bow), key))) continue;
            if (bowReach(bow) > 8) continue;
            safeMovers.push(bow);
        }
        for (const unit of board.units) {
            if (!c103SpellCaster(unit) || !board.cells.has(unit.getId())) continue;
            safeMovers.push(unit);
        }
    }
    const cornerSeats: { readonly anchor: XY; readonly bow: Unit }[] = [];
    for (const lat of [zone.low, zone.high]) {
        const corner = c103Cell(board, zone.back, lat);
        const mid = c103Cell(board, zone.middle, lat);
        if (!corner || !mid) continue;
        const bow = bows.find((unit) => c103CoversKey(board.footprint(unit), keyOf(corner)));
        if (bow) cornerSeats.push({ anchor: mid, bow });
    }
    const screens = c103Screens(board);
    const movers = new Set<string>([...safeMovers, ...screens].map((unit) => unit.getId()));
    const blocked = c103BlockedCells(board, movers);
    const choices: IC103Choice[] = [];
    const offered = new Map<string, XY[]>();
    for (const unit of safeMovers) {
        const anchors: XY[] = [];
        for (const lat of zone.laterals) {
            const anchor = c103Cell(board, zone.back, lat);
            if (!anchor) continue;
            const span = spanAt(unit, anchor, board.geom);
            if (!span || !c103Safe(board, zone, span) || c103HitsBlocked(span.cells, blocked)) continue;
            anchors.push(anchor);
        }
        const nearest = c103Nearest(board, unit, anchors, 8);
        if (!nearest.length) continue;
        offered.set(unit.getId(), nearest);
        choices.push({ unit, anchors: nearest });
    }
    for (const screen of screens) {
        const anchors: XY[] = [];
        for (const seat of cornerSeats) {
            const span = spanAt(screen, seat.anchor, board.geom);
            if (!span || c103HitsBlocked(span.cells, blocked)) continue;
            if (minChebyshev(span.cells, board.footprint(seat.bow)) !== 1) continue;
            if (!anchors.some((anchor) => sameCell(anchor, seat.anchor))) anchors.push(seat.anchor);
        }
        if (!anchors.length) continue;
        offered.set(screen.getId(), anchors);
        choices.push({ unit: screen, anchors });
    }
    const casters = board.units.filter((unit) => c103SpellCaster(unit));
    const found = c103Search(board, choices, new Set(), (seats) => {
        for (const screen of screens) {
            const anchors = offered.get(screen.getId()) ?? [];
            const anchor = c103AnchorOf(board, seats, screen);
            if (!c103Seated(anchors, anchor)) continue;
            const foot = c103FootOf(board, seats, screen);
            const bow = cornerSeats.find((seat) => anchor && sameCell(seat.anchor, anchor))?.bow;
            if (!bow || minChebyshev(foot, board.footprint(bow)) !== 1) return false;
            for (const caster of casters) {
                const casterFoot = c103FootOf(board, seats, caster);
                if (casterFoot.length && minChebyshev(foot, casterFoot) <= 1) return false;
            }
        }
        return true;
    });
    if (found) c103Write(board, found);
};

const c103Shooters = (board: IBoard): void => {
    const zone = c103Zone(board);
    if (!zone) return;
    const screens = [...c103Screens(board)].sort(c103BySpeed);
    const fast = screens[0];
    if (!fast) return;
    const slow = screens.length > 1 ? screens[screens.length - 1] : undefined;
    const otherSlow = slow && slow.getId() !== fast.getId() ? slow : undefined;
    const bows = c103Bows(board);
    const casters = board.units.filter((unit) => c103SpellCaster(unit) && board.cells.has(unit.getId()));
    const blockedLats = c103Lats(board, [...bows, ...casters]);
    const files = c103FullFiles(board, zone)
        .filter((lat) => !blockedLats.has(lat))
        .sort((a, b) => Math.abs(a - zone.centre) - Math.abs(b - zone.centre) || a - b);
    const frontCentre = c103Cell(board, zone.front, zone.centre);
    for (const lat of files) {
        const front = c103Cell(board, zone.front, lat);
        const mid = c103Cell(board, zone.middle, lat);
        const back = c103Cell(board, zone.back, lat);
        if (!front || !mid || !back) continue;
        const empty = new Set<number>([keyOf(mid), keyOf(back)]);
        const vacators = new Set<string>([fast.getId()]);
        if (otherSlow) vacators.add(otherSlow.getId());
        const blocked = [...empty].some((key) =>
            board.units.some((unit) => !vacators.has(unit.getId()) && c103CoversKey(board.footprint(unit), key)),
        );
        if (blocked) continue;
        const slowMust =
            otherSlow !== undefined && [...empty].some((key) => c103CoversKey(board.footprint(otherSlow), key));
        const shifting = casters
            .filter((unit) => c103Buffer(unit) && minChebyshev(board.footprint(unit), [front]) < 4)
            .sort(
                (a, b) =>
                    minChebyshev(board.footprint(a), [front]) - minChebyshev(board.footprint(b), [front]) || byId(a, b),
            );
        // The slow screen stays reserved until it actually moves, so a caster cannot take its cell.
        const movers = new Set<string>([fast.getId(), ...shifting.map((unit) => unit.getId())]);
        const reserved = c103BlockedCells(board, movers);
        for (const key of empty) reserved.add(key);
        const fastSpan = spanAt(fast, front, board.geom);
        if (!fastSpan || !c103OnRank(fastSpan, zone.front) || !spanIsLegal(fastSpan, board.geom, reserved)) continue;
        for (const cell of fastSpan.cells) reserved.add(keyOf(cell));
        const moves = new Map<string, XY>([[fast.getId(), c103At(front)]]);
        let legal = true;
        for (const caster of shifting) {
            let best: XY | undefined;
            let bestCost = Infinity;
            let bestStep = Infinity;
            const current = board.cells.get(caster.getId());
            const currentLats = board.laterals(caster);
            for (const seatLat of zone.laterals) {
                if (seatLat === lat) continue;
                const anchor = c103Cell(board, zone.back, seatLat);
                if (!anchor || !current) continue;
                const span = spanAt(caster, anchor, board.geom);
                if (!span || !c103OnRank(span, zone.back) || span.laterals.includes(lat)) continue;
                if (span.cells.some((cell) => reserved.has(keyOf(cell)))) continue;
                if (minChebyshev(span.cells, fastSpan.cells) < 4) continue;
                const cost = Math.abs(medianNumber(span.laterals) - medianNumber(currentLats));
                const step = chebyshev(anchor, current);
                if (cost < bestCost || (cost === bestCost && step < bestStep)) {
                    best = anchor;
                    bestCost = cost;
                    bestStep = step;
                }
            }
            if (!best) {
                legal = false;
                break;
            }
            moves.set(caster.getId(), c103At(best));
            const span = spanAt(caster, best, board.geom);
            if (!span) {
                legal = false;
                break;
            }
            for (const cell of span.cells) reserved.add(keyOf(cell));
        }
        if (!legal) continue;
        if (otherSlow) {
            const current = board.cells.get(otherSlow.getId());
            const own = new Set(board.footprint(otherSlow).map((cell) => keyOf(cell)));
            let best: XY | undefined;
            let bestStep = Infinity;
            for (const seatLat of zone.laterals) {
                if (seatLat === lat) continue;
                const anchor = c103Cell(board, zone.back, seatLat);
                if (!anchor || !current || (frontCentre && sameCell(anchor, frontCentre))) continue;
                const span = spanAt(otherSlow, anchor, board.geom);
                const hitsOther = span?.cells.some((cell) => reserved.has(keyOf(cell)) && !own.has(keyOf(cell)));
                if (!span || !c103OnRank(span, zone.back) || hitsOther) continue;
                const casterFeet = casters.map((unit) => c103FootOf(board, moves, unit));
                const bowFeet = bows.map((unit) => board.footprint(unit));
                const packsCaster = casterFeet.some((foot) =>
                    foot.some((cell) => span.laterals.includes(board.geom.lateral(cell))),
                );
                const far =
                    !packsCaster &&
                    casterFeet.every((foot) => !foot.length || minChebyshev(span.cells, foot) >= 2) &&
                    bowFeet.every((foot) => !foot.length || minChebyshev(span.cells, foot) >= 2);
                if (!far) continue;
                const step = chebyshev(anchor, current);
                if (
                    step < bestStep ||
                    (step === bestStep &&
                        (best === undefined || anchor.x < best.x || (anchor.x === best.x && anchor.y < best.y)))
                ) {
                    best = anchor;
                    bestStep = step;
                }
            }
            if (!best) {
                if (slowMust) continue;
            } else {
                moves.set(otherSlow.getId(), c103At(best));
            }
        }
        if (!c103Fits(board, moves, empty)) continue;
        const fastFoot = c103FootOf(board, moves, fast);
        const cleared = board.units.every((unit) => {
            const foot = c103FootOf(board, moves, unit);
            return !foot.some((cell) => empty.has(keyOf(cell)));
        });
        const casterFar = shifting.every((unit) => minChebyshev(c103FootOf(board, moves, unit), fastFoot) >= 4);
        if (!cleared || !casterFar || fastFoot.some((cell) => empty.has(keyOf(cell)))) continue;
        c103Write(board, moves);
        return;
    }
};

/**
 * r10c3 post-pass. Today's placeArmy has already run. The first public branch is the only one.
 * Screens finish exactly two off an Area Throw caster, or one empty cell outside Large Caliber.
 * Fire Breath baits an empty file. Short bows and casters leave the null only for two flyers.
 * An illegal seat keeps the incumbent cell. The zone is not extended.
 */
export function placeArmyR10C3(
    incumbent: ReadonlyMap<string, XY>,
    units: readonly Unit[],
    context: IPlacementContext,
): Map<string, XY> {
    const geom = geomFor(context);
    if (!geom) return new Map(incumbent);
    const board = boardFrom(incumbent, units, geom, new Set());
    const threats = publicPlacementThreats(context.publicOpponentCreatureIds);
    if (threats.areaThrow && threats.largeCaliber) return board.cells;
    if (threats.areaThrow) c103Area(board);
    else if (threats.largeCaliber) c103Caliber(board);
    else if (threats.fireBreath) c103Breath(board);
    else if (threats.flyers >= 2) c103Flyers(board, threats);
    else if (threats.rangeCreatures >= 2 && threats.flyers < 2) c103Shooters(board);
    return board.cells;
}

const placeForCandidate = (
    candidateId: PlacementLiftCandidateId,
    base: IAIStrategy,
    units: Unit[],
    context: IPlacementContext,
): Map<string, XY> => {
    const incumbent = base.placeArmy(units, context);
    if (candidateId === "r1c1") return placeArmyR1C1(incumbent, units, context);
    if (candidateId === "r1c2") return placeArmyR1C2(incumbent, units, context);
    if (candidateId === "r1c3") return placeArmyR1C3(incumbent, units, context);
    if (candidateId === "r2c1") return placeArmyR2C1(incumbent, units, context);
    if (candidateId === "r2c2") return placeArmyR2C2(incumbent, units, context);
    if (candidateId === "r2c3") return placeArmyR2C3(incumbent, units, context);
    if (candidateId === "r3c1") return placeArmyR3C1(incumbent, units, context);
    if (candidateId === "r3c2") return placeArmyR3C2(incumbent, units, context);
    if (candidateId === "r3c3") return placeArmyR3C3(incumbent, units, context);
    if (candidateId === "r4c1") return placeArmyR4C1(incumbent, units, context);
    if (candidateId === "r4c2") return placeArmyR4C2(incumbent, units, context);
    if (candidateId === "r4c3") return placeArmyR4C3(incumbent, units, context);
    if (candidateId === "r5c1") return placeArmyR5C1(incumbent, units, context);
    if (candidateId === "r5c2") return placeArmyR5C2(incumbent, units, context);
    if (candidateId === "r5c3") return placeArmyR5C3(incumbent, units, context);
    if (candidateId === "r6c1") return placeArmyR6C1(incumbent, units, context);
    if (candidateId === "r6c2") return placeArmyR6C2(incumbent, units, context);
    if (candidateId === "r6c3") return placeArmyR6C3(incumbent, units, context);
    if (candidateId === "r7c1") return placeArmyR7C1(incumbent, units, context);
    if (candidateId === "r7c2") return placeArmyR7C2(incumbent, units, context);
    if (candidateId === "r7c3") return placeArmyR7C3(incumbent, units, context);
    if (candidateId === "r8c1") return placeArmyR8C1(incumbent, units, context);
    if (candidateId === "r8c2") return placeArmyR8C2(incumbent, units, context);
    if (candidateId === "r8c3") return placeArmyR8C3(incumbent, units, context);
    if (candidateId === "r9c1") return placeArmyR9C1(incumbent, units, context);
    if (candidateId === "r9c2") return placeArmyR9C2(incumbent, units, context);
    if (candidateId === "r9c3") return placeArmyR9C3(incumbent, units, context);
    if (candidateId === "r10c1") return placeArmyR10C1(incumbent, units, context);
    if (candidateId === "r10c2") return placeArmyR10C2(incumbent, units, context);
    if (candidateId === "r10c3") return placeArmyR10C3(incumbent, units, context);
    return incumbent;
};

/** Same combat strategy as the base. Only placeArmy changes. */
export class PlacementLiftStrategy implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly candidateId: PlacementLiftCandidateId,
    ) {
        if (!PLACEMENT_LIFT_CANDIDATES.includes(candidateId)) {
            throw new Error(`Unknown placement lift candidate ${candidateId}`);
        }
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        return placeForCandidate(this.candidateId, this.base, units, context);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}
