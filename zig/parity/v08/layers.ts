/**
 * The v0.8 layer log (RECORD_LAYERS=1 in zig/parity/v08/record.ts): every v0.8 decision also records what each level
 * of the inheritance chain (v0.1 ... v0.7 decideTurn) and each v0.8 pass after super.decideTurn returned, so the Zig
 * port of the flattened v0.8 policy can be checked layer by layer inside real v0.8 battles.
 *
 * The super chain is logged by wrapping each StrategyV0_N.prototype.decideTurn (a `super.decideTurn` call looks the
 * method up at call time). The v0.8 passes are module functions, so StrategyV0_8.prototype.decideTurn is replaced by
 * a copy of its body that logs after each pass. The copy is guarded by the hash of the original's source: when
 * src/ai/versions/v0_8.ts changes decideTurn, installLayerLog throws until this copy is updated to match. A recording
 * made with the layer log must be step-identical to one made without it (check with `cmp` after dropping layers).
 */

import { createHash } from "node:crypto";
import type { GameAction } from "../../../src/engine/actions";
import { a19CoherentMeleeApproach, a19CoherentMeleeApproachEnabled } from "../../../src/ai/coherent_melee_approach";
import { strategyVersionMatchesExperimentScope } from "../../../src/ai/versions/experiment_scope";
import {
    ensureExplicitV08Action,
    prioritizeV08CemeteryObstacleAttack,
    prioritizeV08DamageSpell,
    prioritizeV08Decision,
    prioritizeV08SplashRangedDecision,
    prioritizeV08VineThrow,
    repairV08BacklineWardDecision,
    repairV08ForbiddenTargetDecision,
    StrategyV0_8,
    V08_BLACKSMITH_ROLE_VERSIONS_ENV,
    V08_NIGHTMARE_ROLE_VERSIONS_ENV,
    V08_SUPPORT_ROLE_VERSIONS_ENV,
} from "../../../src/ai/versions/v0_8";
import { prioritizeV08BacklineProtector } from "../../../src/ai/versions/v0_8_backline_protector";
import { prioritizeV08BlacksmithCraft } from "../../../src/ai/versions/v0_8_blacksmith";
import { prioritizeV08RangedPositioning } from "../../../src/ai/versions/v0_8_ranged_positioning";
import {
    prioritizeV08RankedReplayCombatTactics,
    V08_RANKED_REPLAY_TACTICS_VERSIONS_ENV,
} from "../../../src/ai/versions/v0_8_ranked_replay_tactics";
import {
    prioritizeV08HealerSustain,
    prioritizeV08NightmareFireWall,
    prioritizeV08WanderingMageSmoke,
} from "../../../src/ai/versions/v0_8_support_roles";
import { prioritizeV08A13FinishDecision, V08S_URGENT_FINISH_START_LAP } from "../../../src/ai/versions/v0_8s_finish";
import { enumerateCandidates, type IEnumeratedCandidate } from "../../../src/ai/candidates";
import { battleMageTargetsEnabled } from "../../../src/ai/battle_mage_targets";
import { v08DominantFinishState } from "../../../src/ai/versions/v0_8_dominant_finish";

/** sha256 of StrategyV0_8.prototype.decideTurn.toString() that the copy below reproduces. */
const V08_DECIDE_TURN_SOURCE_SHA256 = "200fc55671dbf23d215721daaaccf2f6a09952263c5bf654a9606eb991695b6a";

/**
 * One layer: its name, its output (null when it equals the previous layer's), and the random state when it was
 * entered and when it returned. A v0.8 pass is entered where the previous layer returned.
 */
export type Layer = [string, GameAction[] | null, number, number];

let log: Layer[] | undefined;

/**
 * The candidate lists v0.8's passes enumerate (the oracle for the Zig enumerateCandidates): where ("boundary" for
 * prioritizeV08Decision, "finish" for prioritizeV08A13FinishDecision), and per candidate its kind, actions, target,
 * stand / target cell and the expected damage and kill the passes rank by. Logged only where the pass enumerates.
 */
export interface ICandidateLog {
    at: "boundary" | "finish";
    list: unknown[];
}
let candidateLog: ICandidateLog[] | undefined;

function noteCandidates(at: ICandidateLog["at"], candidates: readonly IEnumeratedCandidate[]): void {
    candidateLog?.push({
        at,
        list: candidates.map((c) => ({
            kind: c.kind,
            actions: JSON.parse(JSON.stringify(c.actions)),
            targetId: c.targetId ?? null,
            standCell: c.standCell ?? null,
            targetCell: c.targetCell ?? null,
            ed: c.features.expectedDamage,
            ek: c.features.expectedKill,
        })),
    });
}

const V08_PASSIVE = new Set(["defend_turn", "obstacle_attack", "end_turn"]);
const V08_PRODUCTIVE = new Set(["move_unit", "melee_attack", "range_attack", "area_throw_attack", "cast_spell"]);

/** prioritizeV08Decision enumerates when the finish window is active or the incumbent is passive (v0_8.ts). */
function logBoundaryCandidates(unit: any, context: any, decision: GameAction[]): void {
    if (!candidateLog) return;
    const finish = v08DominantFinishState(
        context.unitsHolder,
        unit.getTeam(),
        context.fightProperties?.getCurrentLap() ?? 0,
    );
    const passive = decision.some((a) => V08_PASSIVE.has(a.type));
    const productive = decision.some((a) => V08_PRODUCTIVE.has(a.type));
    const obstacle = decision.some((a) => a.type === "obstacle_attack");
    if (!finish.active && !(passive && (!productive || obstacle))) return;
    noteCandidates(
        "boundary",
        enumerateCandidates(unit, context, decision, {
            maxMoveDestinations: 1,
            maxMeleePairs: 8,
            maxShotAims: 6,
            maxAreaThrowCells: 4,
            includeMountainAttacks: false,
            preserveMeteoriteTargetCoverage: battleMageTargetsEnabled(unit),
            enrichIncumbentMetadata: true,
        }).candidates,
    );
}

/** prioritizeV08A13FinishDecision enumerates from V08S_URGENT_FINISH_START_LAP (v0_8s_finish.ts). */
function logFinishCandidates(unit: any, context: any, decision: GameAction[]): void {
    if (!candidateLog) return;
    const lap = context.fightProperties?.getCurrentLap() ?? 0;
    if (!Number.isFinite(lap) || lap < V08S_URGENT_FINISH_START_LAP) return;
    noteCandidates(
        "finish",
        enumerateCandidates(unit, context, decision, {
            maxMoveDestinations: 1,
            maxMeleePairs: 8,
            maxShotAims: 6,
            maxAreaThrowCells: 4,
            maxMoveShotComposites: context.decisionOrigin === "rollout" ? 0 : 1,
            discoverMoveShotTargetsAfterMove: context.decisionOrigin !== "rollout",
            enrichIncumbentMetadata: true,
            preserveAttackTargetCoverage: true,
        }).candidates,
    );
}
let previous = "";
let previousExit = 0;
let rngState: () => number = () => 0;

function note(name: string, actions: GameAction[], entered = previousExit): void {
    if (!log) return;
    const text = JSON.stringify(actions);
    const exit = rngState();
    log.push([name, text === previous ? null : JSON.parse(text), entered, exit]);
    previous = text;
    previousExit = exit;
}

/** RECORD_CANDIDATES=1 also logs the candidate lists (they do not change the battle; check with a plain recording). */
const CANDIDATES = process.env.RECORD_CANDIDATES === "1";

export function beginDecision(): void {
    log = [];
    candidateLog = CANDIDATES ? [] : undefined;
    previous = "";
    previousExit = rngState();
}

export function endDecision(): Layer[] {
    const out = log ?? [];
    log = undefined;
    return out;
}

/** The candidate lists of the decision that just ended (call after endDecision). */
export function endCandidates(): ICandidateLog[] {
    const out = candidateLog ?? [];
    candidateLog = undefined;
    return out;
}

function versionName(proto: object): string {
    const name = (proto as { constructor: { name: string } }).constructor.name;
    const m = /^StrategyV0_(\d+)$/.exec(name);
    return m ? `v0.${m[1]}` : name;
}

export function installLayerLog(state: () => number): string {
    rngState = state;
    const original = StrategyV0_8.prototype.decideTurn;
    const sha = createHash("sha256").update(original.toString()).digest("hex");
    if (sha !== V08_DECIDE_TURN_SOURCE_SHA256 && process.env.RECORD_LAYERS_ANY_SOURCE !== "1") {
        throw new Error(`StrategyV0_8.decideTurn changed (sha256 ${sha}); update zig/parity/v08/layers.ts to match it`);
    }

    // The super chain: v0.7 ... v0.1, each logged when it returns.
    let proto = Object.getPrototypeOf(StrategyV0_8.prototype);
    const parent = proto;
    while (proto && proto !== Object.prototype) {
        if (Object.prototype.hasOwnProperty.call(proto, "decideTurn")) {
            const name = versionName(proto);
            const decide = proto.decideTurn;
            proto.decideTurn = function (this: unknown, unit: unknown, context: unknown) {
                const entered = rngState();
                const out = decide.call(this, unit, context);
                note(name, out, entered);
                return out;
            };
        }
        proto = Object.getPrototypeOf(proto);
    }

    // StrategyV0_8.decideTurn, pass by pass (src/ai/versions/v0_8.ts).
    StrategyV0_8.prototype.decideTurn = function (this: StrategyV0_8, unit: any, context: any): GameAction[] {
        const self = this as any;
        const explicit = ensureExplicitV08Action(unit.getId(), parent.decideTurn.call(this, unit, context));
        note("explicit", explicit);
        logBoundaryCandidates(unit, context, explicit);
        const prioritized = prioritizeV08Decision(unit, context, explicit);
        note("prioritize", prioritized);
        const onlyForcedFallback =
            prioritized.some((action) => action.type === "defend_turn") &&
            !prioritized.some(
                (action) =>
                    action.type === "move_unit" ||
                    action.type === "melee_attack" ||
                    action.type === "range_attack" ||
                    action.type === "area_throw_attack" ||
                    action.type === "cast_spell",
            );
        const active: GameAction[] =
            onlyForcedFallback && self.canHourglass(unit, context)
                ? [{ type: "wait_turn", unitId: unit.getId() }]
                : prioritized;
        note("defend-to-wait", active);
        logFinishCandidates(unit, context, active);
        const finished = prioritizeV08A13FinishDecision(unit, context, active);
        note("finish", finished);
        const positioned = prioritizeV08RangedPositioning(unit, context, finished, this.version);
        note("ranged-positioning", positioned);
        const legalDecision = repairV08ForbiddenTargetDecision(unit, context, positioned);
        note("forbidden-target", legalDecision);
        const splashDecision = prioritizeV08SplashRangedDecision(unit, context, legalDecision);
        note("splash", splashDecision);
        const spellDecision = prioritizeV08DamageSpell(unit, context, splashDecision);
        note("damage-spell", spellDecision);
        const vineDecision = prioritizeV08VineThrow(unit, context, spellDecision);
        note("vine", vineDecision);
        const supportRolesEnabled = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_SUPPORT_ROLE_VERSIONS_ENV],
        );
        const smokeDecision = supportRolesEnabled
            ? prioritizeV08WanderingMageSmoke(unit, context, vineDecision)
            : vineDecision;
        note("smoke", smokeDecision);
        const nightmareRolesEnabled = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_NIGHTMARE_ROLE_VERSIONS_ENV],
        );
        const nightmareDecision = nightmareRolesEnabled
            ? prioritizeV08NightmareFireWall(unit, context, smokeDecision)
            : smokeDecision;
        note("nightmare", nightmareDecision);
        const supportDecision = supportRolesEnabled
            ? prioritizeV08HealerSustain(unit, context, nightmareDecision)
            : nightmareDecision;
        note("healer", supportDecision);
        const craftDecision = strategyVersionMatchesExperimentScope(
            this.version,
            process.env[V08_BLACKSMITH_ROLE_VERSIONS_ENV],
        )
            ? prioritizeV08BlacksmithCraft(unit, context, supportDecision)
            : supportDecision;
        note("blacksmith", craftDecision);
        const rankedReplayTacticsScope = process.env[V08_RANKED_REPLAY_TACTICS_VERSIONS_ENV];
        const rankedReplayDecision =
            rankedReplayTacticsScope !== undefined &&
            strategyVersionMatchesExperimentScope(this.version, rankedReplayTacticsScope)
                ? prioritizeV08RankedReplayCombatTactics(unit, context, craftDecision)
                : craftDecision;
        note("ranked-replay", rankedReplayDecision);
        const protectedDecision = prioritizeV08BacklineProtector(
            unit,
            context,
            rankedReplayDecision,
            self.canHourglass(unit, context),
        );
        note("backline-protector", protectedDecision);
        const wardDecision = repairV08BacklineWardDecision(unit, context, protectedDecision);
        note("backline-ward", wardDecision);
        const final = prioritizeV08CemeteryObstacleAttack(unit, context, wardDecision);
        note("cemetery", final);
        const coherent = a19CoherentMeleeApproachEnabled(unit.getTeam())
            ? a19CoherentMeleeApproach(unit, context, final).actions
            : final;
        note("coherent-melee", coherent);
        return coherent;
    };
    return sha;
}
