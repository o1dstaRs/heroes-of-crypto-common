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

import { PBTypes } from "../../generated/protobuf/v1/types";
import { GRID_SIZE } from "../../grid/grid_constants";
import { creatureInfo } from "../setup/creature_score";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IPlacementContext } from "../ai_strategy";

/**
 * REVEAL-CONDITIONED PLACEMENT (V07_PLACEMENT_REVEAL=on, DEFAULT OFF — experimental, preregistered
 * A/B in scratchpad w5_placement/preregistration.md + preregistration_amendment1.md).
 *
 * Unlike v0.6's baked splash dispersion (which inspects the ACTUAL enemy holder — information a live
 * seat may not fairly have), these heuristics act only on `IPlacementContext.revealedOpponentCreatures`
 * — the creature ids this seat LEGITIMATELY learned during the pick phase (perk reveals + pick
 * collisions). At most ONE heuristic fires per game, and each degrades gracefully to the packed
 * layout when the zone is full:
 *
 *  (PRECEDENCE GUARD) when the enemy actually fields splash AOE ("Area Throw"/"Large Caliber"), the
 *      reveal layer NO-OPS — the baked v0.6 dispersed placement always wins. A reveal-driven WIDE
 *      (2-cell-gap) dispersion was MEASURED at -14.10pp ±0.89 on the Gargantuan mirror (18k-game
 *      preregistered battery, 2026-07-15): the baked 1-cell gap is already the cohesion optimum, so
 *      splash reveals add nothing and reveal layouts must never override the baked answer.
 *  (b) >= FLYER_SCREEN_THRESHOLD flyers revealed: SHOOTER SCREEN — shooters deep + cornered, one
 *      ground-melee bodyguard adjacent to each shooter (occupies flyer landing cells and punishes
 *      dives) instead of the centre front wall. Measured +20.76pp ±0.84 on the flyer mirror.
 *  (c) a heavy charger revealed ("Rapid Charge" — Champion, Wolf Rider, Nomad): CORNER-SHIFT — the
 *      whole formation compacts toward one x-edge of the zone, denying open straight charge lanes.
 *
 * Gate off / no reveals / no relevant threat => undefined, and the caller's placement is untouched
 * (byte-identical default). All returned cells come from placement.possibleCellHashes() and never
 * overlap; the engine's place_unit validator remains the final legality authority.
 */

export const REVEAL_PLACEMENT_ENV = "V07_PLACEMENT_REVEAL";

export const revealPlacementEnabled = (): boolean => process.env[REVEAL_PLACEMENT_ENV] === "on";

/** Adjacent-splash ranged AOE abilities (same measured set as v0.6's baked dispersion trigger). */
export const SPLASH_AOE_ABILITIES: readonly string[] = ["Area Throw", "Large Caliber"];
/** Damage multiplier scales with charge distance (rapid_charge_ability.ts) — the lane-denial target. */
export const CHARGER_ABILITY = "Rapid Charge";
/** Minimum revealed flyers before the shooter screen re-shapes the whole formation. */
export const FLYER_SCREEN_THRESHOLD = 2;

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;

export interface IRevealedThreats {
    splashAoe: number;
    flyers: number;
    chargers: number;
}

/** Pure classifier: revealed creature ids -> threat counts (unknown ids are ignored). */
export function classifyRevealedThreats(revealed: readonly number[]): IRevealedThreats {
    const threats: IRevealedThreats = { splashAoe: 0, flyers: 0, chargers: 0 };
    for (const creatureId of revealed) {
        const info = creatureInfo(creatureId);
        if (!info) {
            continue;
        }
        if (SPLASH_AOE_ABILITIES.some((ability) => info.abilities.includes(ability))) {
            threats.splashAoe += 1;
        }
        if (info.canFly) {
            threats.flyers += 1;
        }
        if (info.abilities.includes(CHARGER_ABILITY)) {
            threats.chargers += 1;
        }
    }
    return threats;
}

export interface IRevealLayoutOptions {
    /** Minimum empty Chebyshev ring kept around every stack: 0 packed, 1 = baked v0.6 gap, 2 = anti-splash. */
    gap: number;
    /** Bodyguard one ground-melee stack adjacent to each shooter instead of forming the centre front wall. */
    screenShooters: boolean;
    /** Compact every role toward the zone's low-x edge (anti-charge lane denial). */
    cornerShift: boolean;
}

const isRangeUnit = (u: Unit): boolean => u.getAttackType() === RANGE;
const isMeleeUnit = (u: Unit): boolean => u.getAttackType() === MELEE;
const bySizeLargeFirst = (a: Unit, b: Unit): number => (b.isSmallSize() ? 0 : 1) - (a.isSmallSize() ? 0 : 1);

/**
 * Parameterized deployment layout shared by all three reveal heuristics. Role order and comparators
 * mirror v0.6's placeArmyDispersed (ranged deep+cornered, ground melee front wall, flyer wing, support
 * back); the options add the gap ring, the shooter screen, and the corner shift on top. Any unit the
 * zone cannot fit is simply left out of the map (the engine auto-places it, exactly like every other
 * placeArmy implementation).
 */
export function layoutRevealPlacement(
    units: Unit[],
    context: IPlacementContext,
    options: IRevealLayoutOptions,
): Map<string, XY> {
    const placements = new Map<string, XY>();
    const occupied = new Set<number>();
    const legal = context.placement.possibleCellHashes();
    const baseCells = [...legal].map((h) => ({ x: h >> 4, y: h & 0xf }));
    if (!baseCells.length) {
        return placements;
    }
    const key = (c: XY): number => (c.x << 4) | c.y;
    const frontness = (c: XY): number => (context.team === PBTypes.TeamVals.LOWER ? c.y : GRID_SIZE - 1 - c.y);
    const xs = baseCells.map((c) => c.x);
    const minX = Math.min(...xs);
    const centreX = (minX + Math.max(...xs)) / 2;
    /** Default: distance from the zone's x-centre (corner-ness); cornerShift: distance from the low-x edge. */
    const edgeness = options.cornerShift ? (c: XY): number => c.x - minX : (c: XY): number => Math.abs(c.x - centreX);
    const footprintFor = (u: Unit, base: XY): XY[] =>
        u.isSmallSize()
            ? [base]
            : [
                  { x: base.x, y: base.y },
                  { x: base.x - 1, y: base.y },
                  { x: base.x, y: base.y - 1 },
                  { x: base.x - 1, y: base.y - 1 },
              ];
    const footprintFree = (fp: XY[]): boolean => fp.every((c) => legal.has(key(c)) && !occupied.has(key(c)));
    /** True when any already-placed stack sits within the Chebyshev `ring` of any footprint cell. */
    const clusters = (fp: XY[], ring: number): boolean => {
        for (const c of fp) {
            for (let dx = -ring; dx <= ring; dx += 1) {
                for (let dy = -ring; dy <= ring; dy += 1) {
                    if ((dx || dy) && occupied.has(key({ x: c.x + dx, y: c.y + dy }))) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    const commit = (u: Unit, base: XY, fp: XY[]): void => {
        for (const c of fp) {
            occupied.add(key(c));
        }
        placements.set(u.getId(), { x: base.x, y: base.y });
    };
    /** Place on the best cell keeping the widest ring that still fits, degrading gap -> 0 (packed). */
    const placeBy = (u: Unit, compare: (a: XY, b: XY) => number): void => {
        const sorted = [...baseCells].sort(compare);
        for (let ring = options.gap; ring >= 0; ring -= 1) {
            for (const base of sorted) {
                const fp = footprintFor(u, base);
                if (footprintFree(fp) && (ring === 0 || !clusters(fp, ring))) {
                    commit(u, base, fp);
                    return;
                }
            }
        }
    };
    const ranged = units.filter(isRangeUnit).sort(bySizeLargeFirst);
    const melee = units.filter(isMeleeUnit).sort(bySizeLargeFirst);
    const support = units.filter((u) => !isRangeUnit(u) && !isMeleeUnit(u)).sort(bySizeLargeFirst);
    const isFlyer = (u: Unit): boolean => u.canFly();
    const groundMelee = melee.filter((u) => !isFlyer(u));
    const flyers = melee.filter(isFlyer);

    for (const u of ranged) {
        placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(b) - edgeness(a)); // deep + cornered
    }

    // Shooter screen: assign one ground-melee bodyguard per placed shooter (largest guards first, deepest
    // shooters first), on the free legal cell adjacent to the shooter's footprint closest to the enemy.
    const guarded = new Set<string>();
    if (options.screenShooters && ranged.length && groundMelee.length) {
        const guardPool = [...groundMelee];
        for (const shooter of ranged) {
            const base = placements.get(shooter.getId());
            const guard = guardPool[0];
            if (!base || !guard) {
                continue;
            }
            const fp = footprintFor(shooter, base);
            const adjacent = new Map<number, XY>();
            for (const c of fp) {
                for (let dx = -1; dx <= 1; dx += 1) {
                    for (let dy = -1; dy <= 1; dy += 1) {
                        if (dx || dy) {
                            const cell = { x: c.x + dx, y: c.y + dy };
                            adjacent.set(key(cell), cell);
                        }
                    }
                }
            }
            const spots = [...adjacent.values()]
                .filter((cell) => footprintFree(footprintFor(guard, cell)))
                .sort((a, b) => frontness(b) - frontness(a) || edgeness(a) - edgeness(b));
            const spot = spots[0];
            if (spot) {
                commit(guard, spot, footprintFor(guard, spot));
                guarded.add(guard.getId());
                guardPool.shift();
            }
        }
    }

    for (const u of groundMelee.filter((g) => !guarded.has(g.getId()))) {
        placeBy(u, (a, b) => frontness(b) - frontness(a) || edgeness(a) - edgeness(b)); // front wall
    }
    for (const u of flyers) {
        placeBy(u, (a, b) => frontness(b) - frontness(a) || a.x - b.x); // forward wing
    }
    for (const u of support) {
        placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(a) - edgeness(b)); // back, centred
    }
    return placements;
}

/** The baked v0.6 dispersion's omniscient trigger — replicated so reveal layouts can defer to it. */
export function enemyFieldsSplashAoe(context: IPlacementContext): boolean {
    return context.unitsHolder
        .getAllEnemyUnits(context.team)
        .some((u) => !u.isDead() && SPLASH_AOE_ABILITIES.some((ability) => u.hasAbilityActive(ability)));
}

/**
 * Entry point used by StrategyV0_7.placeArmy. Returns a full placement when the env gate is on AND the
 * seat's legitimate reveals justify one heuristic; undefined in every other case (caller keeps today's
 * placement byte-identical).
 */
export function revealConditionedPlacement(units: Unit[], context: IPlacementContext): Map<string, XY> | undefined {
    if (!revealPlacementEnabled()) {
        return undefined;
    }
    const revealed = context.revealedOpponentCreatures;
    if (!revealed?.length || !units.length) {
        return undefined;
    }
    // Precedence guard (measured, amendment 1): vs an actual splash-AOE enemy the baked v0.6 dispersed
    // placement always wins — a reveal-driven wide dispersion LOST -14.10pp on the Gargantuan mirror,
    // and a screen layout here would rebuild exactly the adjacency the baked 1-cell gap removes. This
    // check is the same omniscient one the baked path already performs, so no new information is used.
    if (enemyFieldsSplashAoe(context)) {
        return undefined;
    }
    const threats = classifyRevealedThreats(revealed);
    const hasShooter = units.some(isRangeUnit);
    const hasGroundGuard = units.some((u) => isMeleeUnit(u) && !u.canFly());
    if (threats.flyers >= FLYER_SCREEN_THRESHOLD && hasShooter && hasGroundGuard) {
        return layoutRevealPlacement(units, context, { gap: 0, screenShooters: true, cornerShift: false });
    }
    if (threats.chargers > 0) {
        return layoutRevealPlacement(units, context, { gap: 0, screenShooters: false, cornerShift: true });
    }
    return undefined;
}
