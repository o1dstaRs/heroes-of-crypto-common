import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { applyTacticalSplitPlacement, type TacticalSplitRole } from "../ai/tactical_split_placement";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { PathHelper } from "../grid/path_helper";
import { ObstacleType } from "../obstacles/obstacle_type";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { firstContactBodies, type IFirstContactBody } from "./first_contact_placement_research";
import { footprintCellsForRecord } from "./footprint";

export const BLOCKED_APPROACH_PLACEMENT_CANDIDATE = "blocked-melee-lateral-egress-v2";
export const TRAPPED_MELEE_RESCUE_CANDIDATE = "trapped-melee-rescue-v1";
export type BlockedApproachPolicy = "broad" | "trapped";

export interface IApproachBody extends IFirstContactBody {
    walkMelee: boolean;
    steps: number;
    canTraverseLava: boolean;
    vineStride: boolean;
    nativeSpellbook?: boolean;
}

export interface IBlockedApproachProposal {
    placement: Map<string, XY>;
    movedIds: readonly string[];
    blockedMelee: number;
    forwardReachGain: number;
    beforeReach: Readonly<Record<string, number>>;
    afterReach: Readonly<Record<string, number>>;
}

const hash = (cell: XY): number => (cell.x << 4) | cell.y;
const cells = (body: IFirstContactBody, anchor: XY): XY[] =>
    footprintCellsForRecord(anchor, Math.max(body.width, body.height), body.width, body.height);
const distance = (a: readonly XY[], b: readonly XY[]): number =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y)))));

export function completeApproachPlacement(
    bodies: readonly IFirstContactBody[],
    placement: ReadonlyMap<string, XY>,
    legal: ReadonlySet<number>,
    terrain: number[][],
): boolean {
    if (placement.size !== bodies.length) return false;
    const occupied = new Set<number>();
    for (const body of bodies) {
        const anchor = placement.get(body.id);
        if (!anchor || !Number.isInteger(anchor.x) || !Number.isInteger(anchor.y)) return false;
        for (const cell of cells(body, anchor)) {
            if (cell.x < 0 || cell.y < 0 || cell.x >= 16 || cell.y >= 16) return false;
            if (!legal.has(hash(cell)) || occupied.has(hash(cell)) || terrain[cell.y]?.[cell.x]) return false;
            occupied.add(hash(cell));
        }
    }
    return true;
}

export function blockedApproachBodies(units: readonly Unit[], additionalAuraRange = 0): IApproachBody[] {
    const roles = firstContactBodies(units, additionalAuraRange);
    return roles.map((body, i) => ({
        ...body,
        walkMelee: body.role === "guard" && units[i].getMovementType() === PBTypes.MovementVals.WALK,
        steps: units[i].getSteps(),
        canTraverseLava: units[i].canTraverseLava(),
        vineStride: units[i].hasAbilityActive("In Its Own World"),
        nativeSpellbook: creatureInfo(creatureIdForName(units[i].getName()) ?? -1)?.nativeSpellbook ?? false,
    }));
}

/** Rebuild public terrain without reading enemy occupancy, aggression, or hidden deployment barrels. */
export function blockedApproachTerrain(context: IPlacementContext): number[][] {
    const matrix: number[][] = Array.from({ length: 16 }, () => Array<number>(16).fill(0));
    const kind = context.grid.getGridType();
    const obstacle =
        kind === PBTypes.GridVals.BLOCK_CENTER
            ? ObstacleType.BLOCK
            : kind === PBTypes.GridVals.LAVA_CENTER
              ? ObstacleType.LAVA
              : kind === PBTypes.GridVals.WATER_CENTER
                ? ObstacleType.WATER
                : 0;
    if (obstacle) for (const cell of context.grid.getCenterCells()) matrix[cell.y][cell.x] = obstacle;
    for (const barrel of context.grid.getArtifactBarrels(context.team))
        matrix[barrel.cell.y][barrel.cell.x] = ObstacleType.BLOCK;
    return matrix;
}

/** A single sideways move; friendly bodies are static only for this opening-route diagnostic. */
export function researchBlockedMeleeApproach(
    bodies: readonly IApproachBody[],
    incumbent: Map<string, XY>,
    legal: ReadonlySet<number>,
    terrain: number[][],
    pathHelper: PathHelper,
    forwardSign: 1 | -1,
    sideAxis: boolean,
    finalPlacementAccepted: (placement: ReadonlyMap<string, XY>) => boolean = () => true,
    policy: BlockedApproachPolicy = "broad",
): IBlockedApproachProposal {
    const unchanged = (beforeReach: Record<string, number> = {}, blockedMelee = 0): IBlockedApproachProposal => ({
        placement: incumbent,
        movedIds: [],
        blockedMelee,
        forwardReachGain: 0,
        beforeReach,
        afterReach: beforeReach,
    });
    const guards = bodies.filter((body) => body.walkMelee && body.steps > 0);
    if (
        guards.length < 2 ||
        bodies.length !== incumbent.size ||
        new Set(bodies.map((b) => b.id)).size !== bodies.length
    )
        return unchanged();
    const valid = (placement: ReadonlyMap<string, XY>): boolean =>
        completeApproachPlacement(bodies, placement, legal, terrain);
    if (!valid(incumbent)) return unchanged();
    const reach = (body: IApproachBody, placement: ReadonlyMap<string, XY>, ignoreAllies = false): number => {
        const matrix = terrain.map((row) => row.slice());
        if (!ignoreAllies)
            for (const other of bodies) {
                if (other.id === body.id) continue;
                for (const cell of cells(other, placement.get(other.id)!)) matrix[cell.y][cell.x] = 1;
            }
        const anchor = placement.get(body.id)!;
        const origin = sideAxis ? anchor.x : anchor.y;
        const paths = pathHelper.getMovePath(
            anchor,
            matrix,
            body.steps,
            undefined,
            false,
            body.width === 1 && body.height === 1,
            body.canTraverseLava,
            body.vineStride,
            body.width,
            body.height,
        );
        let furthest = 0;
        for (const routes of paths.knownPaths.values()) {
            const destination = routes[0]?.cell;
            if (destination)
                furthest = Math.max(furthest, forwardSign * ((sideAxis ? destination.x : destination.y) - origin));
        }
        return furthest;
    };
    const beforeReach = Object.fromEntries(guards.map((body) => [body.id, reach(body, incumbent)]));
    const blocked = guards.filter(
        (body) =>
            (policy === "broad" || (beforeReach[body.id] === 0 && !body.nativeSpellbook)) &&
            reach(body, incumbent, true) - beforeReach[body.id] >= 1,
    );
    if (!blocked.length) return unchanged(beforeReach);
    const aurasRetained = (placement: ReadonlyMap<string, XY>): boolean => {
        for (const source of bodies) {
            if (!source.buffAuraRanges.length) continue;
            for (const target of bodies) {
                if (source.id === target.id) continue;
                const before = distance(
                    cells(source, incumbent.get(source.id)!),
                    cells(target, incumbent.get(target.id)!),
                );
                const after = distance(
                    cells(source, placement.get(source.id)!),
                    cells(target, placement.get(target.id)!),
                );
                if (source.buffAuraRanges.some((radius) => before <= radius && after > radius)) return false;
            }
        }
        return true;
    };
    let best:
        | {
              body: IApproachBody;
              placement: Map<string, XY>;
              gain: number;
              travel: number;
              reach: Record<string, number>;
          }
        | undefined;
    // Native order is the final tie break, so random runtime UUIDs never decide between identical splits.
    for (const body of [...blocked].sort((a, b) => a.name.localeCompare(b.name))) {
        const anchor = incumbent.get(body.id)!;
        for (const offset of [-1, 1, -2, 2]) {
            const destination = { x: anchor.x + (sideAxis ? 0 : offset), y: anchor.y + (sideAxis ? offset : 0) };
            const placement = new Map(incumbent);
            placement.set(body.id, destination);
            if (!valid(placement) || !aurasRetained(placement) || !finalPlacementAccepted(placement)) continue;
            const improved = reach(body, placement);
            const gain = improved - beforeReach[body.id];
            if (gain < 1 || (best && (gain < best.gain || (gain === best.gain && Math.abs(offset) >= best.travel))))
                continue;
            const afterReach = { ...beforeReach, [body.id]: improved };
            let worsened = false;
            for (const other of guards) {
                if (other.id === body.id) continue;
                afterReach[other.id] = reach(other, placement);
                if (afterReach[other.id] < beforeReach[other.id]) {
                    worsened = true;
                    break;
                }
            }
            if (!worsened) best = { body, placement, gain, travel: Math.abs(offset), reach: afterReach };
        }
    }
    return best
        ? {
              placement: best.placement,
              movedIds: [best.body.id],
              blockedMelee: blocked.length,
              forwardReachGain: best.gain,
              beforeReach,
              afterReach: best.reach,
          }
        : unchanged(beforeReach, blocked.length);
}

export class BlockedApproachResearchPlacement implements IAIStrategy {
    public readonly version: string;
    public last: IBlockedApproachProposal | undefined;
    public expectedPlacement: ReadonlyMap<string, XY> | undefined;
    public incumbentFallback = false;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly enabled: boolean,
        private readonly splitRoles: readonly { rosterIndex: number; role: TacticalSplitRole }[] = [],
        private readonly policy: BlockedApproachPolicy = "broad",
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const rawIncumbent = this.base.placeArmy(units, context);
        const splitUnits = units.map((unit) => ({
            id: unit.getId(),
            small: unit.isSmallSize(),
            footprintWidth: unit.getFootprintWidth(),
            footprintHeight: unit.getFootprintHeight(),
        }));
        const splitStacks = this.splitRoles.map((split) => ({
            unitId: units[split.rosterIndex].getId(),
            role: split.role,
        }));
        const finish = (placement: ReadonlyMap<string, XY>): Map<string, XY> =>
            splitStacks.length
                ? applyTacticalSplitPlacement(placement, splitUnits, {
                      team: context.team,
                      gridType: context.grid.getGridType(),
                      legalCellHashes: context.placement.possibleCellHashes(),
                      sideOrientedPlacement: context.sideOrientedPlacement,
                      splitStacks,
                  })
                : new Map(placement);
        // Match the engine's ONE normal post-placement pass. Applying that pass twice need not be idempotent.
        const incumbent = finish(rawIncumbent);
        const bodies = blockedApproachBodies(
            units,
            FightStateManager.getInstance().getFightProperties().getAdditionalAuraRangePerTeam(context.team),
        );
        const legal = context.placement.possibleCellHashes();
        const terrain = blockedApproachTerrain(context);
        this.incumbentFallback = !completeApproachPlacement(bodies, incumbent, legal, terrain);
        const rawFor = (proposal: ReadonlyMap<string, XY>): Map<string, XY> => {
            const raw = new Map(rawIncumbent);
            for (const [id, cell] of proposal) {
                const before = incumbent.get(id);
                if (!before || cell.x !== before.x || cell.y !== before.y) raw.set(id, cell);
            }
            return raw;
        };
        this.last = researchBlockedMeleeApproach(
            bodies,
            incumbent,
            context.placement.possibleCellHashes(),
            terrain,
            context.pathHelper,
            context.team === PBTypes.TeamVals.LEFT ? 1 : -1,
            context.sideOrientedPlacement === true,
            (proposal) => {
                const actual = finish(rawFor(proposal));
                return (
                    actual.size === proposal.size &&
                    [...proposal].every(([id, cell]) => {
                        const selected = actual.get(id);
                        return selected?.x === cell.x && selected.y === cell.y;
                    })
                );
            },
            this.policy,
        );
        this.expectedPlacement = this.incumbentFallback ? undefined : this.enabled ? this.last.placement : incumbent;
        return this.enabled && this.last.movedIds.length ? rawFor(this.last.placement) : rawIncumbent;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}
