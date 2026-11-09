/** Offline counter-play experiments. No serving profile imports these policies. */
import type { IAIStrategy, IDecisionContext, IPlacementContext } from "../ai/ai_strategy";
import { decisionPathSource, type IReadonlyWeightedRoute } from "../ai/decision_path_catalog";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { pickRankedLiveDraftCreature } from "../ai/setup/draft_ship";
import type { RankedDraftSynergyVariants } from "../ai/setup/draft_synergy_variants";
import { AbilityPowerType } from "../abilities/ability_properties";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { TeamType } from "../generated/protobuf/v1/types_gen";
import { getFootprintCellsForAnchor } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import { footprintCellsForAnchor } from "./footprint";
import type { ILeagueGenome } from "./league_genome";
import type { IRankedDraftResearchChoices, IRankedDraftResearchContext } from "./ranked_draft_eval";
import type { ISetupAugment } from "./battle_engine";
import { simulationGridSettings } from "./battle_engine";
import { planA19SupportSplits } from "../ai/support_setup";
import { tacticalSplitUnitFromUnit } from "../ai/tactical_split_placement";
import { createCombatFactories, createUnitFromSpec, type IArmyUnitSpec } from "./army";

export const RANGED_COUNTER_RESEARCH_ID = "ranged-counter-play-20261109-v1";

export function rangedCounterThreats(ids: readonly number[]) {
    const infos = [...new Set(ids)].flatMap((id) => {
        const info = creatureInfo(id);
        return info ? [info] : [];
    });
    return {
        nullField: infos.some((info) => info.abilities.includes("Range Null Field")),
        flyers: infos.filter((info) => info.canFly && !info.ranged).length,
        area: infos.some(
            (info) => info.rangedSpellDamage || /Fire Breath|Through Shot|Area Throw/.test(info.abilities),
        ),
    };
}

/** Keep the locked learned choice and its one-use state; adapt only to legally revealed counters. */
export function createRangedCounterDraft(
    genome: ILeagueGenome,
    locked: IRankedDraftResearchChoices,
    synergyVariants: RankedDraftSynergyVariants,
    onChange?: (from: number, to: number, context: IRankedDraftResearchContext) => void,
): IRankedDraftResearchChoices {
    return {
        bundle: locked.bundle,
        creature: (available, context, preferred) => {
            const retained = locked.creature?.(available, context, preferred) ?? preferred;
            const ownShooters = context.ownCreatureIds.filter((id) => creatureInfo(id)?.ranged).length;
            const threats = rangedCounterThreats(context.knownOpponentCreatureIds);
            const limit = threats.nullField ? 2 : threats.flyers >= 2 ? 3 : Infinity;
            if (ownShooters < limit || !creatureInfo(retained)?.ranged) return retained;
            const alternatives = available.filter((id) => creatureInfo(id)?.ranged === false);
            const choice = pickRankedLiveDraftCreature(
                genome,
                alternatives,
                context.ownCreatureIds,
                context.knownOpponentCreatureIds,
                context.tier1ArtifactId,
                context.scouting.map,
                synergyVariants,
                context.tier2ArtifactId,
                context.artifactFitVersion,
                context.scouting,
            );
            if (choice === undefined) return retained;
            onChange?.(retained, choice, context);
            return choice;
        },
    };
}

/** Placement values are paid points: 0 = base, 1 = middle tier, 2 = largest tier. */
export function fundedRangedPlacement(budget: number, placement: 1 | 2, preserve: "sniper" | "armor"): ISetupAugment[] {
    if (![5, 6, 7].includes(budget)) throw new RangeError("Expected a real doctrine budget");
    const first = Math.min(3, budget - placement);
    const second = Math.min(3, budget - placement - first);
    return [
        { kind: "Placement", value: placement },
        { kind: preserve === "sniper" ? "Sniper" : "Armor", value: first },
        ...(second ? [{ kind: preserve === "sniper" ? ("Armor" as const) : ("Sniper" as const), value: second }] : []),
    ];
}

/** Use the serving support planner after funding Placement, retaining real independent spellbooks. */
export function materializeRangedCounterSplits(roster: readonly IArmyUnitSpec[], maximumStacks: number) {
    const { abilityFactory, effectFactory } = createCombatFactories();
    const settings = simulationGridSettings();
    const units = roster.map((spec, index) =>
        createUnitFromSpec(
            spec,
            PBTypes.TeamVals.LEFT,
            settings,
            abilityFactory,
            effectFactory,
            false,
            `counter-source-${index}`,
        ),
    );
    const plans = planA19SupportSplits(units.map(tacticalSplitUnitFromUnit), maximumStacks);
    const result = roster.map((spec) => ({ ...spec }));
    const splitRoles = plans.map((plan, index) => {
        const sourceIndex = units.findIndex((unit) => unit.getId() === plan.sourceUnitId);
        if (sourceIndex < 0 || result[sourceIndex].amount <= plan.amount) throw new Error("Invalid support split");
        const child = createUnitFromSpec(
            { ...roster[sourceIndex], amount: plan.amount },
            PBTypes.TeamVals.LEFT,
            settings,
            abilityFactory,
            effectFactory,
            false,
            `counter-child-${index}`,
        );
        units[sourceIndex].shareResourcesWithSplit(child, plan.amount);
        units[sourceIndex].setAmountAlive(units[sourceIndex].getAmountAlive() - plan.amount);
        result[sourceIndex].amount -= plan.amount;
        result[sourceIndex].initialSpellEntries = [...units[sourceIndex].getUnitProperties().spells];
        result.push({
            ...roster[sourceIndex],
            amount: plan.amount,
            initialSpellEntries: [...child.getUnitProperties().spells],
        });
        return { rosterIndex: result.length - 1, role: plan.role };
    });
    return { roster: result, splitRoles };
}

export interface IRangedCounterBody {
    id: string;
    width: number;
    height: number;
    ranged: boolean;
    caster: boolean;
    value: number;
    buffRanges: readonly number[];
}

const cellKey = (cell: XY): number => cell.x * 16 + cell.y;
const bodyCells = (body: IRangedCounterBody, cell: XY): XY[] =>
    getFootprintCellsForAnchor(cell, body.width, body.height);
const gap = (a: readonly XY[], b: readonly XY[]): number =>
    Math.min(...a.flatMap((x) => b.map((y) => Math.max(Math.abs(x.x - y.x), Math.abs(x.y - y.y)))));

export function rangedCounterBodies(units: readonly Unit[], extraAuraRange: number): IRangedCounterBody[] {
    return units.map((unit) => {
        const id = creatureIdForName(unit.getName());
        const info = id === undefined ? undefined : creatureInfo(id);
        return {
            id: unit.getId(),
            width: unit.getFootprintWidth(),
            height: unit.getFootprintHeight(),
            ranged: info?.ranged ?? false,
            caster: info?.caster ?? false,
            value: Math.min(1.5, Math.max(0, ((info?.exp ?? 0) * unit.getAmountAlive()) / 1000)),
            buffRanges: unit
                .getAuraEffects()
                .filter((aura) => aura.getProperties().is_buff)
                .map((aura) => aura.getRange() + extraAuraRange),
        };
    });
}

export function validRangedCounterFormation(
    bodies: readonly IRangedCounterBody[],
    positions: ReadonlyMap<string, XY>,
    legal: ReadonlySet<number>,
): boolean {
    if (
        !bodies.length ||
        positions.size !== bodies.length ||
        new Set(bodies.map((body) => body.id)).size !== bodies.length
    )
        return false;
    const occupied = new Set<number>();
    for (const body of bodies) {
        const point = positions.get(body.id);
        if (
            !point ||
            !Number.isInteger(point.x) ||
            !Number.isInteger(point.y) ||
            !Number.isInteger(body.width) ||
            !Number.isInteger(body.height) ||
            body.width < 1 ||
            body.height < 1 ||
            body.width > 16 ||
            body.height > 16 ||
            !Number.isFinite(body.value) ||
            body.value < 0
        )
            return false;
        for (const cell of bodyCells(body, point)) {
            const key = cellKey(cell);
            if (cell.x < 0 || cell.y < 0 || cell.x >= 16 || cell.y >= 16 || !legal.has(key) || occupied.has(key))
                return false;
            occupied.add(key);
        }
    }
    return true;
}

/** A geometric diagnostic, not a win prediction. Only own geometry and public creature identities enter. */
export function rangedCounterFormationRisk(
    bodies: readonly IRangedCounterBody[],
    positions: ReadonlyMap<string, XY>,
    team: TeamType,
    sideAxis: boolean,
    enemyIds: readonly number[],
): number {
    const threats = rangedCounterThreats(enemyIds);
    const footprints = bodies.map((body) => bodyCells(body, positions.get(body.id)!));
    let risk = 0;
    bodies.forEach((body, i) => {
        if (!body.ranged && !body.caster) return;
        const forward =
            footprints[i].reduce((total, cell) => total + (sideAxis ? cell.x : cell.y), 0) / footprints[i].length;
        const depth = team === PBTypes.TeamVals.LEFT ? forward : 15 - forward;
        risk += 0.06 * body.value * depth;
    });
    for (let i = 0; i < bodies.length; i++) {
        for (let j = i + 1; j < bodies.length; j++) {
            const distance = gap(footprints[i], footprints[j]);
            const value = Math.min(bodies[i].value, bodies[j].value);
            if (threats.area) risk += (value * Math.max(0, 3 - distance)) / 3;
            if (threats.nullField && bodies[i].ranged && bodies[j].ranged)
                risk += (value * Math.max(0, 6 - distance)) / 6;
        }
    }
    return risk;
}

/** Two deterministic coordinate sweeps, retaining every existing friendly aura link and every legal footprint. */
export function spreadRangedCounterFormation(
    bodies: readonly IRangedCounterBody[],
    incumbent: ReadonlyMap<string, XY>,
    context: {
        legal: ReadonlySet<number>;
        team: TeamType;
        sideAxis: boolean;
        enemyIds: readonly number[];
    },
): Map<string, XY> {
    const result = new Map([...incumbent].map(([id, cell]) => [id, { ...cell }]));
    const threats = rangedCounterThreats(context.enemyIds);
    if ((!threats.area && !threats.nullField) || !validRangedCounterFormation(bodies, result, context.legal))
        return result;
    const links = bodies.flatMap((source) =>
        bodies.flatMap((target) => {
            if (source.id === target.id) return [];
            const before = gap(bodyCells(source, result.get(source.id)!), bodyCells(target, result.get(target.id)!));
            return source.buffRanges
                .filter((range) => Number.isFinite(range) && before <= range)
                .map((range) => ({ source, target, range }));
        }),
    );
    const retainsAuras = (): boolean =>
        links.every(
            ({ source, target, range }) =>
                gap(bodyCells(source, result.get(source.id)!), bodyCells(target, result.get(target.id)!)) <= range,
        );
    const score = (): number =>
        rangedCounterFormationRisk(bodies, result, context.team, context.sideAxis, context.enemyIds);
    const anchors = [...context.legal].sort((a, b) => a - b).map((key) => ({ x: key >> 4, y: key & 15 }));
    const movable = bodies
        .filter((body) => body.ranged || body.caster)
        .sort((a, b) => b.value - a.value || bodies.indexOf(a) - bodies.indexOf(b));
    for (let sweep = 0; sweep < 2; sweep++) {
        let changed = false;
        for (const body of movable) {
            const original = result.get(body.id)!;
            let best = original;
            let bestScore = score();
            for (const anchor of anchors) {
                result.set(body.id, anchor);
                if (!validRangedCounterFormation(bodies, result, context.legal) || !retainsAuras()) continue;
                const proposed = score();
                if (proposed < bestScore - 1e-9) {
                    bestScore = proposed;
                    best = anchor;
                }
            }
            result.set(body.id, best);
            changed ||= best.x !== original.x || best.y !== original.y;
        }
        if (!changed) break;
    }
    return result;
}

/** Search may compare this escape as its incumbent; it is never a forced live action. */
export function rangeNullEscapeProposal(unit: Unit, context: IDecisionContext, incumbent: GameAction[]): GameAction[] {
    if (
        !unit.isRangeCapable() ||
        !unit.canMove() ||
        unit.getRangeShots() <= 0 ||
        !unit.hasDebuffActive("Range Null Field Aura") ||
        unit.hasStatusApplied("Rangebane") ||
        incumbent.some(
            (action) => !["melee_attack", "select_attack_type", "move_unit", "end_turn", "wait"].includes(action.type),
        )
    )
        return incumbent;
    const enemies = context.unitsHolder.getAllAllies(unit.getOppositeTeam()).filter((enemy) => !enemy.isDead());
    const nullFields = enemies.flatMap((enemy) =>
        enemy.getAuraEffects().flatMap((aura) => {
            if (aura.getPowerType() !== AbilityPowerType.DISABLE_RANGE_ATTACK) return [];
            return [
                {
                    cells: enemy.getCells(),
                    range:
                        aura.getRange() +
                        (context.fightProperties?.getAdditionalAuraRangePerTeam(enemy.getTeam()) ?? 0),
                },
            ];
        }),
    );
    if (!nullFields.length) return incumbent;
    const melee = incumbent.find((action) => action.type === "melee_attack");
    if (melee?.type === "melee_attack") {
        const target = context.unitsHolder.getAllUnits().get(melee.targetId);
        if (target && unit.calculateAttackDamageMin(unit.getAttack(), target, false, 0, 1) >= target.getCumulativeHp())
            return incumbent;
    }
    const path = decisionPathSource(context).getMovePath(
        unit.getBaseCell(),
        context.matrix,
        unit.getSteps(),
        context.grid.getEnemyAggrMatrixByUnitId(unit.getId()),
        unit.canFly(),
        unit.isSmallSize(),
        unit.canTraverseLava(),
        unit.hasAbilityActive("In Its Own World"),
        unit.getFootprintWidth(),
        unit.getFootprintHeight(),
    );
    let best: { route: IReadonlyWeightedRoute; score: number } | undefined;
    for (const routes of path.knownPaths.values()) {
        const route = routes[0];
        if (!route?.route.length || route.hasLavaCell || route.hasWaterCell) continue;
        const cells = footprintCellsForAnchor(unit, route.cell);
        if (
            !context.grid.canOccupyCells(
                cells,
                unit.canTraverseLava(),
                unit.hasAbilityActive("Made of Water"),
                unit.getId(),
            ) ||
            enemies.some((enemy) => gap(cells, enemy.getCells()) <= 1) ||
            nullFields.some((field) => gap(cells, field.cells) <= field.range)
        )
            continue;
        const nearest = Math.min(...enemies.map((enemy) => gap(cells, enemy.getCells())));
        const score = nearest - 0.25 * route.weight;
        if (!best || score > best.score) best = { route, score };
    }
    if (!best) return incumbent;
    return [
        {
            type: "move_unit",
            unitId: unit.getId(),
            path: best.route.route.map((cell) => ({ ...cell })),
            targetCells: footprintCellsForAnchor(unit, best.route.cell),
            hasLavaCell: false,
            hasWaterCell: false,
        },
        { type: "end_turn", unitId: unit.getId(), reason: "manual" },
    ];
}

export class RangedCounterCombatResearch implements IAIStrategy {
    public readonly version: string;
    public changed = 0;
    public rolloutChanged = 0;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly enabled = true,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        return this.base.placeArmy(units, context);
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        const incumbent = this.base.decideTurn(unit, context);
        if (!this.enabled) return incumbent;
        const proposal = rangeNullEscapeProposal(unit, context, incumbent);
        if (proposal !== incumbent && context.decisionOrigin !== "rollout") this.changed++;
        if (proposal !== incumbent && context.decisionOrigin === "rollout") this.rolloutChanged++;
        return proposal;
    }
}
