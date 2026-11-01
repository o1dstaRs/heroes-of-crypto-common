import type { IPlacementContext, IAIStrategy, IDecisionContext } from "../ai/ai_strategy";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { isMindlessAiUnit } from "../ai/unit_ai_overrides";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { footprintCellsForRecord } from "./footprint";

export const FIRST_CONTACT_PLACEMENT_CANDIDATE = "grounded-carry-depth-swap-v1";

export interface IFirstContactBody {
    id: string;
    name: string;
    width: number;
    height: number;
    role: "carry" | "guard" | "other";
    buffAuraRanges: readonly number[];
}

export interface IFirstContactSwap {
    placement: Map<string, XY>;
    eligibleInversions: number;
    swapped: readonly string[];
    retreatCells: number;
}

const hash = (cell: XY): number => (cell.x << 4) | cell.y;
const cells = (body: IFirstContactBody, anchor: XY): XY[] =>
    footprintCellsForRecord(anchor, Math.max(body.width, body.height), body.width, body.height);
const distance = (a: readonly XY[], b: readonly XY[]): number =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y)))));

export function firstContactBodies(units: readonly Unit[], additionalAuraRange = 0): IFirstContactBody[] {
    return units.map((unit) => {
        const id = creatureIdForName(unit.getName());
        const info = id === undefined ? undefined : creatureInfo(id);
        const grounded = unit.getMovementType() !== PBTypes.MovementVals.FLY;
        const eligible = grounded && !isMindlessAiUnit(unit) && unit.getAmountAlive() > 1;
        const carry = eligible && !!info && (info.ranged || info.rangedSpellDamage || info.mage);
        const guard = eligible && !!info?.melee && !carry;
        return {
            id: unit.getId(),
            name: unit.getName(),
            width: unit.getFootprintWidth(),
            height: unit.getFootprintHeight(),
            role: carry ? "carry" : guard ? "guard" : "other",
            buffAuraRanges: unit
                .getAuraEffects()
                .filter((aura) => aura.getProperties().is_buff)
                .map((aura) => aura.getRange() + additionalAuraRange),
        };
    });
}

export function researchGroundedCarryDepthSwap(
    bodies: readonly IFirstContactBody[],
    incumbent: Map<string, XY>,
    legal: ReadonlySet<number>,
    forwardSign: 1 | -1,
    sideAxis: boolean,
    knownFastGroundThreat: boolean,
): IFirstContactSwap {
    const unchanged = (eligibleInversions = 0): IFirstContactSwap => ({
        placement: incumbent,
        eligibleInversions,
        swapped: [],
        retreatCells: 0,
    });
    if (!knownFastGroundThreat || bodies.length !== incumbent.size) return unchanged();
    const occupied = new Set<number>();
    const footprints = new Map<string, XY[]>();
    for (const body of bodies) {
        const anchor = incumbent.get(body.id);
        if (!anchor || !Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) return unchanged();
        const footprint = cells(body, anchor);
        for (const cell of footprint) {
            if (cell.x < 0 || cell.y < 0 || cell.x >= 16 || cell.y >= 16) return unchanged();
            if (!legal.has(hash(cell)) || occupied.has(hash(cell))) return unchanged();
            occupied.add(hash(cell));
        }
        footprints.set(body.id, footprint);
    }
    const center = (footprint: readonly XY[], along: boolean): number =>
        footprint.reduce((sum, cell) => sum + (along === sideAxis ? cell.x : cell.y), 0) / footprint.length;
    const retainedAuras = (candidate: ReadonlyMap<string, XY>): boolean => {
        for (const source of bodies) {
            if (!source.buffAuraRanges.length) continue;
            for (const target of bodies) {
                if (source === target) continue;
                const before = distance(footprints.get(source.id)!, footprints.get(target.id)!);
                const after = distance(
                    cells(source, candidate.get(source.id)!),
                    cells(target, candidate.get(target.id)!),
                );
                if (source.buffAuraRanges.some((radius) => before <= radius && after > radius)) return false;
            }
        }
        return true;
    };
    let eligibleInversions = 0;
    let best: { carry: IFirstContactBody; guard: IFirstContactBody; retreat: number; travel: number } | undefined;
    for (const carry of bodies.filter((body) => body.role === "carry")) {
        for (const guard of bodies.filter((body) => body.role === "guard")) {
            if (carry.width !== guard.width || carry.height !== guard.height) continue;
            const carryCells = footprints.get(carry.id)!;
            const guardCells = footprints.get(guard.id)!;
            const retreat = forwardSign * (center(carryCells, true) - center(guardCells, true));
            const lateral = Math.abs(center(carryCells, false) - center(guardCells, false));
            if (retreat < 1 || lateral > 2) continue;
            eligibleInversions++;
            const candidate = new Map(incumbent);
            candidate.set(carry.id, incumbent.get(guard.id)!);
            candidate.set(guard.id, incumbent.get(carry.id)!);
            if (!retainedAuras(candidate)) continue;
            const travel = retreat + lateral;
            if (
                !best ||
                retreat > best.retreat ||
                (retreat === best.retreat && travel < best.travel) ||
                (retreat === best.retreat && travel === best.travel && carry.name < best.carry.name) ||
                (retreat === best.retreat &&
                    travel === best.travel &&
                    carry.name === best.carry.name &&
                    guard.name < best.guard.name)
            ) {
                best = { carry, guard, retreat, travel };
            }
        }
    }
    if (!best) return unchanged(eligibleInversions);
    const placement = new Map(incumbent);
    placement.set(best.carry.id, incumbent.get(best.guard.id)!);
    placement.set(best.guard.id, incumbent.get(best.carry.id)!);
    return {
        placement,
        eligibleInversions,
        swapped: [best.carry.id, best.guard.id],
        retreatCells: best.retreat,
    };
}

export class FirstContactResearchPlacement implements IAIStrategy {
    public readonly version: string;
    public last: IFirstContactSwap | undefined;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly enabled: boolean,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        const knownFastGroundThreat = (context.publicOpponentCreatureIds ?? []).some((id) => {
            const info = creatureInfo(id);
            return (
                !!info?.melee &&
                !info.canFly &&
                ((info.movementSteps ?? 0) >= 5 || info.abilities.includes("Rapid Charge"))
            );
        });
        this.last = researchGroundedCarryDepthSwap(
            firstContactBodies(
                units,
                FightStateManager.getInstance().getFightProperties().getAdditionalAuraRangePerTeam(context.team),
            ),
            incumbent,
            context.placement.possibleCellHashes(),
            context.team === PBTypes.TeamVals.LEFT ? 1 : -1,
            context.sideOrientedPlacement === true,
            knownFastGroundThreat,
        );
        return this.enabled ? this.last.placement : incumbent;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}
