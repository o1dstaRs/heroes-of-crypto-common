/** Offline offensive-rush candidates. Nothing in this file is a serving policy. */
import { creatureInfo } from "../ai/setup/creature_score";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { IRankedDraftResearchContext } from "./ranked_draft_eval";

export type RushDraft = "current" | "mobile" | "chaos-mobile";
export type RushAugment = { kind: "Placement" | "Movement" | "Armor" | "Might" | "Sniper" | "Empower"; value: number };
export const RUSH_RECIPES = [
    { id: "current", forward: false },
    { id: "current-forward", forward: true },
    { id: "p0-m1-armor", forward: true, placement: 0, movement: 1, offenseFirst: false },
    { id: "p0-m2-armor", forward: true, placement: 0, movement: 2, offenseFirst: false },
    { id: "p0-m2-offense", forward: true, placement: 0, movement: 2, offenseFirst: true },
    { id: "p1-m1-armor", forward: true, placement: 1, movement: 1, offenseFirst: false },
    { id: "p1-m2-armor", forward: true, placement: 1, movement: 2, offenseFirst: false },
    { id: "p2-m1-armor", forward: true, placement: 2, movement: 1, offenseFirst: false },
    { id: "p2-m2-armor", forward: true, placement: 2, movement: 2, offenseFirst: false },
    { id: "p2-m2-offense", forward: true, placement: 2, movement: 2, offenseFirst: true },
    { id: "p0-m2-armor-native", forward: false, placement: 0, movement: 2, offenseFirst: false },
    { id: "p2-m2-armor-native", forward: false, placement: 2, movement: 2, offenseFirst: false },
    { id: "p0-m0-armor", forward: true, placement: 0, movement: 0, offenseFirst: false },
] as const;
export type RushRecipe = (typeof RUSH_RECIPES)[number];

export const isRushBackliner = (id: number): boolean => {
    const info = creatureInfo(id);
    return !!info && (info.ranged || info.rangedSpellDamage);
};
export const isRushMelee = (id: number): boolean => {
    const info = creatureInfo(id);
    return !!info && info.melee && !info.ranged && !info.rangedSpellDamage;
};
export const isRushMobile = (id: number): boolean => {
    const info = creatureInfo(id);
    // Flight admits Griffin without mistaking its printed speed for Sky Runner's adjusted speed.
    return !!info && isRushMelee(id) && (info.canFly || (info.movementSteps ?? 0) >= 5);
};
export const hasRushTarget = (knownEnemy: readonly number[]): boolean => {
    const targets = [...new Set(knownEnemy)].filter(isRushBackliner);
    return targets.length >= 2 || targets.some((id) => (creatureInfo(id)?.level ?? 0) >= 3);
};
export const chaosTypes = (own: readonly number[]): number =>
    [...new Set(own)].filter((id) => creatureInfo(id)?.faction === PBTypes.FactionVals.CHAOS).length;

/** Called with the projected draft context, never the eventual enemy roster or hidden upgrades. */
export function rushCreaturePool(
    mode: RushDraft,
    available: readonly number[],
    context: Pick<IRankedDraftResearchContext, "ownCreatureIds" | "knownOpponentCreatureIds">,
    chaosMovementVariant: boolean,
): readonly number[] {
    if (mode === "current" || !hasRushTarget(context.knownOpponentCreatureIds)) return available;
    const count = chaosTypes(context.ownCreatureIds);
    if (mode === "chaos-mobile" && chaosMovementVariant && count % 2 === 1) {
        const completion = available.filter(
            (id) => !context.ownCreatureIds.includes(id) && creatureInfo(id)?.faction === PBTypes.FactionVals.CHAOS,
        );
        if (completion.length) return completion;
    }
    const mobile = available.filter(isRushMobile);
    return mobile.length ? mobile : available;
}

/** Every recipe spends the real doctrine budget, including the opportunity cost of Placement. */
export function fundRushPlan(recipe: RushRecipe, budget: number, own: readonly number[]): RushAugment[] {
    if (!("placement" in recipe) || ![5, 6, 7].includes(budget)) throw new Error("Invalid rush spending request");
    const levels = {
        Placement: recipe.placement,
        Movement: recipe.movement,
        Armor: 0,
        Might: 0,
        Sniper: 0,
        Empower: 0,
    };
    let remaining = budget - levels.Placement - levels.Movement;
    for (const kind of recipe.offenseFirst ? (["Might", "Armor"] as const) : (["Armor", "Might"] as const)) {
        levels[kind] = Math.min(3, remaining);
        remaining -= levels[kind];
    }
    const last = own.some((id) => creatureInfo(id)?.ranged) ? "Sniper" : "Empower";
    levels[last] = remaining;
    if (remaining < 0 || remaining > 3) throw new Error("Unfunded rush spending");
    return Object.entries(levels).map(([kind, value]) => ({ kind: kind as RushAugment["kind"], value }));
}

export interface RushBody {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    eligible: boolean;
}
const key = (x: number, y: number) => `${x},${y}`;
export function rushFootprint(body: RushBody, x = body.x, y = body.y): { x: number; y: number }[] {
    return Array.from({ length: body.width * body.height }, (_, index) => ({
        x: x - (index % body.width),
        y: y - Math.floor(index / body.width),
    }));
}

/** Monotone movement toward the enemy edge, within two lateral cells of the native formation.
 * Occupancy and rectangular footprints are retained; enemy positions are not inputs. */
export function rushForwardFormation(
    input: readonly RushBody[],
    allowed: readonly { x: number; y: number }[],
    blocked: readonly { x: number; y: number }[],
    direction: 1 | -1,
): RushBody[] {
    const bodies = input.map((body) => ({ ...body }));
    const legal = new Set(allowed.map((cell) => key(cell.x, cell.y)));
    const occupied = new Set(blocked.map((cell) => key(cell.x, cell.y)));
    for (const body of bodies)
        for (const cell of rushFootprint(body)) {
            const cellKey = key(cell.x, cell.y);
            if (!legal.has(cellKey) || occupied.has(cellKey)) throw new Error("Invalid native rush formation");
            occupied.add(cellKey);
        }
    const ordered = bodies
        .filter((body) => body.eligible)
        .sort((a, b) => direction * (b.x - a.x) || b.width * b.height - a.width * a.height || a.id.localeCompare(b.id));
    for (let pass = 0; pass < 3; pass++)
        for (const body of ordered) {
            const original = input.find((unit) => unit.id === body.id)!;
            for (const cell of rushFootprint(body)) occupied.delete(key(cell.x, cell.y));
            const options = allowed
                .filter(
                    (cell) =>
                        direction * (cell.x - body.x) > 0 &&
                        Math.abs(cell.y - original.y) <= 2 &&
                        rushFootprint(body, cell.x, cell.y).every(
                            (part) => legal.has(key(part.x, part.y)) && !occupied.has(key(part.x, part.y)),
                        ),
                )
                .sort(
                    (a, b) =>
                        direction * (b.x - a.x) || Math.abs(a.y - original.y) - Math.abs(b.y - original.y) || a.y - b.y,
                );
            if (options.length) {
                body.x = options[0].x;
                body.y = options[0].y;
            }
            for (const cell of rushFootprint(body)) occupied.add(key(cell.x, cell.y));
        }
    return bodies;
}
