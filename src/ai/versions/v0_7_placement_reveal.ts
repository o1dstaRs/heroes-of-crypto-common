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
import { footprintCellsForAnchor } from "../../simulation/footprint";
import { isSpellUsableByCaster } from "../../spells/spell_helper";
import { creatureIdForName, creatureInfo } from "../setup/creature_score";
import {
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    placementOpponentVisibility,
    type PlacementPolicyVariant,
} from "../setup/setup_ship";
import type { Unit } from "../../units/unit";
import type { XY } from "../../utils/math";
import type { IPlacementContext } from "../ai_strategy";
import { strategyVersionMatchesExperimentScope } from "./experiment_scope";
import { byFootprintAreaLargestFirst } from "./v0_1";

/**
 * REVEAL-CONDITIONED PLACEMENT (V07_PLACEMENT_REVEAL=on, DEFAULT OFF). Optional
 * V07_PLACEMENT_REVEAL_VERSIONS is an exact comma-list seat scope; absent preserves the historical
 * all-v0.7-family experiment behavior. The historical A/B references
 * untracked scratchpad preregistration/result files, so its reported numbers are diagnostic, not admissible
 * release evidence. Keep this experiment default-off until those artifacts and hashes are preserved.
 *
 * Unlike v0.6's baked splash dispersion (which inspects the ACTUAL enemy holder — information a live
 * seat may not fairly have), these heuristics classify only the creature-id list selected by the explicit
 * placement policy. `legitimate-reveal` retains the historical partial pick-phase reveal list;
 * `public-roster` opts into the complete roster that both seats legitimately see before placement. At most
 * ONE heuristic fires per game, and each degrades gracefully to the packed layout when the zone is full:
 *
 *  (PRECEDENCE GUARD) when the enemy actually fields splash AOE ("Area Throw"/"Large Caliber"), the
 *      reveal layer NO-OPS — the baked v0.6 dispersed placement always wins. A reveal-driven WIDE
 *      (2-cell-gap) dispersion was REPORTED at -14.10pp ±0.89 on the Gargantuan mirror (historical
 *      18k-game battery, 2026-07-15): the baked 1-cell gap is already the cohesion optimum, so
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
export const REVEAL_PLACEMENT_VERSIONS_ENV = "V07_PLACEMENT_REVEAL_VERSIONS";

export const revealPlacementEnabled = (policy?: PlacementPolicyVariant, strategyVersion?: string): boolean =>
    policy === undefined
        ? process.env[REVEAL_PLACEMENT_ENV] === "on" &&
          strategyVersionMatchesExperimentScope(strategyVersion, process.env[REVEAL_PLACEMENT_VERSIONS_ENV])
        : policy === "legitimate-reveal" ||
          policy === "public-roster" ||
          policy === COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT;

/** Pure source selector shared by the live placement path and the ranked measurement harness. */
export function selectOpponentCreatureIdsForPlacement(
    policy: PlacementPolicyVariant,
    ownCreatureIds: readonly number[],
    legitimateReveals: readonly number[] | undefined,
    publicOpponentCreatureIds: readonly number[] | undefined,
): readonly number[] | undefined {
    const visibility = placementOpponentVisibility(policy, ownCreatureIds);
    if (visibility === "none") return undefined;
    if (visibility === "public-roster") return publicOpponentCreatureIds ?? legitimateReveals;
    return legitimateReveals;
}

function creatureIdForUnit(unit: Unit): number | undefined {
    return creatureIdForName(unit.getName());
}

/**
 * Select only the opponent identities authorized by the active placement policy. The legacy env gate and
 * shipped `legitimate-reveal` mode intentionally ignore the new full roster. `public-roster` prefers the new
 * field even when it is an explicitly empty list; the legacy alias is only a compatibility fallback when the
 * new field is absent.
 */
export function opponentCreatureIdsForPlacement(
    context: IPlacementContext,
    strategyVersion?: string,
): readonly number[] | undefined {
    if (!revealPlacementEnabled(context.setupPlacementPolicy, strategyVersion)) {
        return undefined;
    }
    if (context.setupPlacementPolicy === undefined) return context.revealedOpponentCreatures;
    const mappedOwnCreatureIds = context.unitsHolder.getAllAllies(context.team).map(creatureIdForUnit);
    const ownCreatureIds = mappedOwnCreatureIds.every((id): id is number => id !== undefined)
        ? [...new Set(mappedOwnCreatureIds)]
        : [];
    return selectOpponentCreatureIdsForPlacement(
        context.setupPlacementPolicy,
        ownCreatureIds,
        context.revealedOpponentCreatures,
        context.publicOpponentCreatureIds,
    );
}

/** Adjacent-splash ranged AOE abilities (same measured set as v0.6's baked dispersion trigger). */
export const SPLASH_AOE_ABILITIES: readonly string[] = ["Area Throw", "Large Caliber"];
/** Damage multiplier scales with charge distance (rapid_charge_ability.ts) — the lane-denial target. */
export const CHARGER_ABILITY = "Rapid Charge";
/** Minimum revealed flyers before the shooter screen re-shapes the whole formation. */
export const FLYER_SCREEN_THRESHOLD = 2;

const RANGE = PBTypes.AttackVals.RANGE;
const MELEE = PBTypes.AttackVals.MELEE;
const MELEE_MAGIC = PBTypes.AttackVals.MELEE_MAGIC;

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
    /** v0.8-only: include live spellcasters and assign named protectors before generic ground melee. */
    screenBacklineProtectors?: boolean;
    /** v0.8-only stable priority order for exact protector unit ids. */
    preferredGuardUnitIds?: readonly string[];
    /** v0.8-only units that must remain offensive instead of filling a generic screen slot. */
    excludedGuardUnitIds?: readonly string[];
    /** v0.8-only stable priority order for the protected assets. */
    preferredBacklineUnitIds?: readonly string[];
    /**
     * A19-only physical-role correction: a MELEE_MAGIC unit without a native spellbook remains a melee body.
     * Direct-cast utility such as Wind Flow, Wild Regeneration, or Castling must not turn a flyer/tank into a
     * rear-line caster. Omitted preserves the historical v0.7 layout byte-for-byte.
     */
    physicalMeleeMagicRoles?: boolean;
}

const isRangeUnit = (u: Unit): boolean => u.getAttackType() === RANGE;
const hasNativeSpellbook = (unit: Unit): boolean => {
    const creatureId = creatureIdForUnit(unit);
    return creatureId !== undefined && creatureInfo(creatureId)?.nativeSpellbook === true;
};
const isMeleeUnit = (unit: Unit): boolean => unit.getAttackType() === MELEE;

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
    // Axis of advance: Y on the classic bottom/top board, X when this seat plays side-oriented
    // (context.sideOrientedPlacement). Frontness = depth toward the enemy; edgeness = LATERAL
    // offset within the zone — the two swap axes together or the layout collapses to one row.
    const sideOriented = context.sideOrientedPlacement === true;
    const along = (c: XY): number => (sideOriented ? c.x : c.y);
    const lateral = (c: XY): number => (sideOriented ? c.y : c.x);
    const frontness = (c: XY): number =>
        context.team === PBTypes.TeamVals.LOWER ? along(c) : GRID_SIZE - 1 - along(c);
    const lats = baseCells.map(lateral);
    const minLat = Math.min(...lats);
    const centreLat = (minLat + Math.max(...lats)) / 2;
    /** Default: distance from the zone's lateral centre (corner-ness); cornerShift: distance from the low edge. */
    const edgeness = options.cornerShift
        ? (c: XY): number => lateral(c) - minLat
        : (c: XY): number => Math.abs(lateral(c) - centreLat);
    // The unit's real body. This one helper backs the gap ring, the shooter screen and the corner shift, so a
    // presumed 2x2 corrupts all three at once — most visibly the screen, whose entire purpose is the
    // `areCellsAdjacent(wardFootprint, guardFootprint)` test a few lines down.
    const footprintFor = (u: Unit, base: XY): XY[] => footprintCellsForAnchor(u, base);
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
    const isPhysicalMelee = (unit: Unit): boolean =>
        unit.getAttackType() === MELEE ||
        (!!options.physicalMeleeMagicRoles && unit.getAttackType() === MELEE_MAGIC && !hasNativeSpellbook(unit));
    const isBackline = (unit: Unit): boolean => {
        if (isRangeUnit(unit)) return true;
        if (options.physicalMeleeMagicRoles && hasNativeSpellbook(unit)) return true;
        return (
            !!options.screenBacklineProtectors &&
            unit.getCanCastSpells() &&
            unit.getSpells().some((spell) => isSpellUsableByCaster(unit, spell))
        );
    };
    const preference = (unit: Unit, ids: readonly string[] | undefined): number => {
        const index = ids?.indexOf(unit.getId()) ?? -1;
        return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    const byGuardPriority = (a: Unit, b: Unit): number =>
        (options.screenBacklineProtectors
            ? preference(a, options.preferredGuardUnitIds) - preference(b, options.preferredGuardUnitIds)
            : 0) || byFootprintAreaLargestFirst(a, b);
    const byBacklinePriority = (a: Unit, b: Unit): number =>
        (options.screenBacklineProtectors
            ? preference(a, options.preferredBacklineUnitIds) - preference(b, options.preferredBacklineUnitIds)
            : 0) || byFootprintAreaLargestFirst(a, b);
    const backline = units.filter(isBackline).sort(byBacklinePriority);
    // When v0.8 treats an exact-MELEE spellcaster as a ward, keep the role partitions disjoint. Otherwise the
    // front-wall pass would place it a second time, overwrite its deep placement, and leave ghost occupancy.
    const melee = units.filter((unit) => isPhysicalMelee(unit) && !isBackline(unit)).sort(byFootprintAreaLargestFirst);
    const support = units.filter((u) => !isBackline(u) && !isPhysicalMelee(u)).sort(byFootprintAreaLargestFirst);
    const isForwardPhysical = (unit: Unit): boolean =>
        unit.canFly() ||
        (!!options.physicalMeleeMagicRoles &&
            unit.getAttackType() === MELEE_MAGIC &&
            !hasNativeSpellbook(unit) &&
            ((unit.isSmallSize() && unit.getSteps() >= 7) ||
                unit.hasAbilityActive("Rapid Charge") ||
                unit.hasAbilityActive("Sky Runner")));
    const groundMelee = melee.filter((unit) => !isForwardPhysical(unit));
    const flyers = melee.filter(isForwardPhysical);

    for (const u of backline) {
        placeBy(u, (a, b) => frontness(a) - frontness(b) || edgeness(b) - edgeness(a)); // deep + cornered
    }

    // Back-line screen: assign one ground-melee bodyguard per placed shooter/spell-bearing stack. Abomination and
    // Arachna Queen are purpose-built protectors and therefore consume the guard slots before generic tanks;
    // their range-1 auras must begin the fight adjacent to the asset they protect.
    const guarded = new Set<string>();
    if (options.screenShooters && backline.length && groundMelee.length) {
        const excludedGuards = new Set(options.excludedGuardUnitIds ?? []);
        const guardPool = groundMelee.filter((unit) => !excludedGuards.has(unit.getId())).sort(byGuardPriority);
        for (const ward of backline) {
            const base = placements.get(ward.getId());
            const guard = guardPool[0];
            if (!base || !guard) {
                continue;
            }
            const fp = footprintFor(ward, base);
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
            // A large guard's base cell can sit two coordinates away while the near edge of its 2x2
            // footprint is still adjacent. The historical shooter screen keeps its exact small-base search;
            // v0.8 protector placement checks every legal base against the real footprints.
            const candidateBases = options.screenBacklineProtectors ? baseCells : [...adjacent.values()];
            const spots = candidateBases
                .filter((cell) => {
                    const guardFootprint = footprintFor(guard, cell);
                    return (
                        footprintFree(guardFootprint) &&
                        (!options.screenBacklineProtectors || context.grid.areCellsAdjacent(fp, guardFootprint))
                    );
                })
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
export function revealConditionedPlacement(
    units: Unit[],
    context: IPlacementContext,
    strategyVersion?: string,
): Map<string, XY> | undefined {
    const opponentCreatureIds = opponentCreatureIdsForPlacement(context, strategyVersion);
    if (!opponentCreatureIds?.length || !units.length) {
        return undefined;
    }
    // Precedence guard (measured, amendment 1): vs an actual splash-AOE enemy the baked v0.6 dispersed
    // placement always wins — a reveal-driven wide dispersion LOST -14.10pp on the Gargantuan mirror,
    // and a screen layout here would rebuild exactly the adjacency the baked 1-cell gap removes. This
    // check is the same omniscient one the baked path already performs, so no new information is used.
    if (enemyFieldsSplashAoe(context)) {
        return undefined;
    }
    const threats = classifyRevealedThreats(opponentCreatureIds);
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
