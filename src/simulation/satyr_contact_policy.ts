/**
 * Unqualified Satyr research policy. No production strategy imports this module.
 * Contact means an enumerated melee delivery (including a legal move), or incoming
 * physical fire whose resolved primary target is the ally. It is not a distance test.
 */
import type { IDecisionContext } from "../ai/ai_strategy";
import { enumerateCandidates, type IEnumeratedCandidate } from "../ai/candidates";
import { isMindlessAiUnit } from "../ai/unit_ai_overrides";
import type { GameAction } from "../engine/actions";
import { FightStateManager } from "../fights/fight_state_manager";
import { PBTypes } from "../generated/protobuf/v1/types";
import { advanceDeltaBetween } from "../grid/grid_math";
import type { Unit } from "../units/unit";
import {
    captureDeterministicRandomState,
    restoreDeterministicRandomState,
    setDeterministicRandomSource,
} from "../utils/lib";
import { makeRng } from "./army";
import { restoreBattle, snapshotBattle } from "./battle_snapshot";
import type { ILookaheadDeps } from "./lookahead";

export const SATYR_CONTACT_POLICY_ID = "satyr-contact-support-research-v1";

export interface ISatyrUnitContact {
    id: string;
    name: string;
    amount: number;
    hp: number;
    armor: number;
    meleeTargets: string[];
    incomingMelee: number;
    incomingRanged: number;
    /** Sum of each enemy's best physical delivery, not a prediction of chosen attacks. */
    exposure: number;
    mainLevelOne: boolean;
    engaged: boolean;
    helpingHandCaster?: string;
    helpingHandPenalty?: string;
}

export interface ISatyrContactDecision {
    actions: GameAction[];
    reason:
        "ineligible" | "keep-attack" | "help-engaged-ally" | "summon-before-contact" | "safer-backline" | "keep-stock";
    before?: ISatyrUnitContact[];
    proposals: Array<{
        actions: GameAction[];
        failure: string | null;
        value?: number;
        casterExposure?: number;
        casterHp?: number;
        blockedMainStacks?: number;
    }>;
}

const physical = (candidate: IEnumeratedCandidate): boolean =>
    candidate.actions.some((a) => a.type === "melee_attack" || a.type === "range_attack");
const attacks = (actions: readonly GameAction[]): boolean =>
    actions.some((a) => a.type === "melee_attack" || a.type === "range_attack" || a.type === "area_throw_attack");
const hidden = (unit: Unit): boolean => unit.hasBuffActive("Hidden") || unit.hasAbilityActive("Hidden");
const catalog = (unit: Unit, context: IDecisionContext, moves = 1): IEnumeratedCandidate[] =>
    enumerateCandidates(unit, { ...context, matrix: context.grid.getMatrix(), decisionPathCatalog: undefined }, [], {
        maxMoveDestinations: moves,
    }).candidates;

/** The quarter-largest count excludes one-creature tactical splits from the main-line timing signal. */
export function observeSatyrContact(caster: Unit, context: IDecisionContext): ISatyrUnitContact[] {
    const own = context.unitsHolder.getAllAllies(caster.getTeam()).filter((u) => !u.isDead());
    const enemies = context.unitsHolder.getAllEnemyUnits(caster.getTeam()).filter((u) => !u.isDead() && !hidden(u));
    const levelOne = own.filter(
        (u) => u.getId() !== caster.getId() && !u.isSummoned() && u.getLevel() === PBTypes.UnitLevelVals.FIRST,
    );
    const mainMinimum = Math.max(1, ...levelOne.map((u) => u.getAmountAlive())) / 4;
    const incoming = new Map<string, { melee: number; ranged: number; total: number }>();
    for (const enemy of enemies) {
        const best = new Map<string, { melee: number; ranged: number }>();
        for (const candidate of catalog(enemy, context)) {
            if (!physical(candidate) || !candidate.targetId || candidate.features.expectedDamage <= 0) continue;
            const current = best.get(candidate.targetId) ?? { melee: 0, ranged: 0 };
            const kind = candidate.actions.some((a) => a.type === "melee_attack") ? "melee" : "ranged";
            current[kind] = Math.max(current[kind], candidate.features.expectedDamage);
            best.set(candidate.targetId, current);
        }
        for (const [id, damage] of best) {
            const sum = incoming.get(id) ?? { melee: 0, ranged: 0, total: 0 };
            sum.melee += damage.melee;
            sum.ranged += damage.ranged;
            sum.total += Math.max(damage.melee, damage.ranged);
            incoming.set(id, sum);
        }
    }
    return own.map((u) => {
        const mainLevelOne = levelOne.includes(u) && u.getAmountAlive() >= mainMinimum;
        const meleeTargets = mainLevelOne
            ? [
                  ...new Set(
                      catalog(u, context)
                          .filter((c) => c.kind === "melee" && c.targetId)
                          .map((c) => c.targetId!),
                  ),
              ]
            : [];
        const pressure = incoming.get(u.getId()) ?? { melee: 0, ranged: 0, total: 0 };
        return {
            id: u.getId(),
            name: u.getName(),
            amount: u.getAmountAlive(),
            hp: u.getCumulativeHp(),
            armor: u.getBaseArmor(),
            meleeTargets,
            incomingMelee: pressure.melee,
            incomingRanged: pressure.ranged,
            exposure: pressure.total,
            mainLevelOne,
            engaged: mainLevelOne && (meleeTargets.length > 0 || pressure.total > 0),
            helpingHandCaster: u.getUnitProperties().helping_hand_caster_id || undefined,
            helpingHandPenalty: u.getUnitProperties().helping_hand_penalty_id || undefined,
        };
    });
}

/**
 * Exact engine application for the gift, donor penalty, reinforcement and move geometry.
 * Enemy physical deliveries remain a one-activation envelope: they omit spells, AOE
 * secondary targets, later movement and chosen opponent policy. No win-probability claim.
 */
export function chooseSatyrContactDecision(
    caster: Unit,
    context: IDecisionContext,
    incumbent: GameAction[],
    deps: ILookaheadDeps,
): ISatyrContactDecision {
    const result: ISatyrContactDecision = { actions: incumbent, reason: "ineligible", proposals: [] };
    if (
        caster.getName() !== "Satyr" ||
        caster.isDead() ||
        isMindlessAiUnit(caster) ||
        context.decisionOrigin === "rollout"
    )
        return result;
    // The previous loss audit found surrendered real kills. This hypothesis does not replace attacks.
    if (attacks(incumbent)) return { ...result, reason: "keep-attack" };
    const random = captureDeterministicRandomState();
    const snapshot = snapshotBattle(deps.unitsHolder, deps.grid, deps.fightProperties);
    const stats = deps.captureDamageStats();
    const active = deps.getActiveUnitId();
    const restoreAuxiliary = deps.captureAuxiliaryState?.();
    const restore = () => {
        restoreBattle(snapshot, deps.unitsHolder, deps.grid, deps.fightProperties);
        deps.restoreDamageStats(stats);
        restoreAuxiliary?.();
        deps.setActiveUnitId(active);
        FightStateManager.getInstance().setFightProperties(deps.fightProperties);
        restoreDeterministicRandomState(random);
    };
    try {
        setDeterministicRandomSource(makeRng(811_818_031));
        const before = observeSatyrContact(caster, context);
        result.before = before;
        result.reason = "keep-stock";
        const casterBefore = before.find((u) => u.id === caster.getId())!;
        const engaged = before.filter((u) => u.engaged);
        const choices = catalog(caster, context, 0);
        const project = (choice: IEnumeratedCandidate) => {
            restore();
            setDeterministicRandomSource(makeRng(811_818_031));
            let failure: string | null = null;
            let completed = false;
            try {
                for (const action of choice.actions) {
                    const applied = deps.engine.apply(action);
                    if (!applied.completed) {
                        if (action.type === "select_attack_type") continue;
                        failure = applied.rejectionReason ?? "declined";
                        break;
                    }
                    if (action.type !== "select_attack_type") completed = true;
                    if (applied.events.some((e) => e.type === "turn_completed" || e.type === "fight_finished")) break;
                }
                if (!completed) failure ??= "no productive action";
                const after = failure ? undefined : observeSatyrContact(caster, context);
                const self = after?.find((u) => u.id === caster.getId());
                const receipt: ISatyrContactDecision["proposals"][number] = {
                    actions: choice.actions,
                    failure,
                    casterExposure: self?.exposure,
                    casterHp: self?.hp,
                };
                result.proposals.push(receipt);
                return { after, self, receipt };
            } finally {
                restore();
            }
        };
        // Penalty absorption is stochastic. Do not choose a gift using one lucky sampled recipient.
        const absorption = caster.hasBuffActive("Absorb Penalties Aura");
        let bestHelp: { choice: IEnumeratedCandidate; value: number } | undefined;
        if (engaged.length && !absorption) {
            for (const choice of choices) {
                if (choice.spellName !== "Helping Hand" || !engaged.some((u) => u.id === choice.targetId)) continue;
                const { after, self, receipt } = project(choice);
                const targetBefore = before.find((u) => u.id === choice.targetId)!;
                const targetAfter = after?.find((u) => u.id === choice.targetId);
                if (
                    !self ||
                    !targetAfter ||
                    targetAfter.helpingHandCaster !== caster.getId() ||
                    self.exposure >= self.hp
                )
                    continue;
                let donorCost = 0;
                for (const prior of before) {
                    if (prior.id === targetBefore.id) continue;
                    const next = after!.find((u) => u.id === prior.id);
                    donorCost += Math.max(0, prior.hp - (next?.hp ?? 0));
                    donorCost += Math.max(0, (next?.exposure ?? 0) - prior.exposure);
                }
                const value =
                    targetAfter.hp -
                    targetBefore.hp +
                    Math.max(0, targetBefore.exposure - targetAfter.exposure) -
                    donorCost;
                receipt.value = value;
                if (value > (bestHelp?.value ?? 0)) bestHelp = { choice, value };
            }
        }
        if (bestHelp) return { ...result, actions: bestHelp.choice.actions, reason: "help-engaged-ally" };

        if (!engaged.length) {
            let bestWolf: { choice: IEnumeratedCandidate; risk: number; blocked: number; forward: number } | undefined;
            const side = deps.fightProperties.isSideAxisPolicyTeam(caster.getTeam());
            for (const choice of choices) {
                if (choice.spellName !== "Summon Wolves") continue;
                const { after, self, receipt } = project(choice);
                if (!after || !self) continue;
                const blocked = before.filter(
                    (u) =>
                        u.mainLevelOne &&
                        u.meleeTargets.length &&
                        !after.find((v) => v.id === u.id)?.meleeTargets.length,
                ).length;
                receipt.blockedMainStacks = blocked;
                const risk = self.exposure / Math.max(1, self.hp);
                const existing = deps.unitsHolder
                    .getAllAllies(caster.getTeam())
                    .find((u) => u.isSummoned() && u.getName() === "Wolf" && !u.isDead());
                // A reinforcement stays at the existing Wolf. A placement hint never moves Satyr.
                const cell = existing?.getBaseCell() ?? choice.targetCell ?? caster.getBaseCell();
                const forward = advanceDeltaBetween(caster.getTeam(), caster.getBaseCell(), cell, side);
                if (risk >= 1) continue;
                if (
                    !bestWolf ||
                    blocked < bestWolf.blocked ||
                    (blocked === bestWolf.blocked &&
                        (risk < bestWolf.risk || (risk === bestWolf.risk && forward > bestWolf.forward)))
                )
                    bestWolf = { choice, risk, blocked, forward };
            }
            if (bestWolf) return { ...result, actions: bestWolf.choice.actions, reason: "summon-before-contact" };
        }

        const pureMove =
            incumbent.some((a) => a.type === "move_unit") &&
            incumbent.every((a) => ["move_unit", "select_attack_type", "end_turn"].includes(a.type));
        if (pureMove || casterBefore.exposure >= casterBefore.hp / 2) {
            const side = deps.fightProperties.isSideAxisPolicyTeam(caster.getTeam());
            const frontline = before
                .filter((u) => u.mainLevelOne)
                .map((u) => deps.unitsHolder.getAllUnits().get(u.id)!);
            const forwardOf = (cell: { x: number; y: number }) =>
                advanceDeltaBetween(caster.getTeam(), caster.getBaseCell(), cell, side);
            const front = Math.max(...frontline.map((u) => forwardOf(u.getBaseCell())));
            const moves = choices
                .filter((c) => c.kind === "move" && c.targetCell && forwardOf(c.targetCell) < front)
                .sort((a, b) => forwardOf(a.targetCell!) - forwardOf(b.targetCell!))
                .slice(0, 6);
            const holds = choices.filter((c) => c.kind === "wait" || c.kind === "defend");
            const stock = { actions: incumbent } as IEnumeratedCandidate;
            const base = project(stock).self;
            let bestRisk = base ? base.exposure / Math.max(1, base.hp) : Infinity;
            const stockMove = incumbent.find((a) => a.type === "move_unit");
            let bestAhead =
                pureMove &&
                stockMove?.type === "move_unit" &&
                forwardOf(stockMove.path.at(-1) ?? caster.getBaseCell()) >= front;
            let best: IEnumeratedCandidate | undefined;
            for (const choice of [...holds, ...moves]) {
                const { self } = project(choice);
                if (!self) continue;
                const risk = self.exposure / Math.max(1, self.hp);
                const ahead = forwardOf(choice.targetCell ?? caster.getBaseCell()) >= front;
                if (risk < bestRisk || (risk === bestRisk && bestAhead && !ahead)) {
                    bestRisk = risk;
                    bestAhead = ahead;
                    best = choice;
                }
            }
            if (best) return { ...result, actions: best.actions, reason: "safer-backline" };
        }
        return result;
    } finally {
        restore();
    }
}
