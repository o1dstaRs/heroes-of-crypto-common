import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";

import type { IAIStrategy, IPlacementContext, IDecisionContext } from "../ai/ai_strategy";
import { creatureIdForName, creatureInfo } from "../ai/setup/creature_score";
import { createV08A19Strategy } from "../ai/versions/v0_8_a19_profile";
import { layoutRevealPlacement } from "../ai/versions/v0_7_placement_reveal";
import { Doctrine } from "../doctrines/doctrine_properties";
import type { GameAction } from "../engine/actions";
import { PBTypes } from "../generated/protobuf/v1/types";
import type { Unit } from "../units/unit";
import type { XY } from "../utils/math";
import {
    AI_META_COHORTS,
    prepareMetaPair,
    aiMetaSynergyVariantsForPair,
    type AiMetaCohort,
} from "./ai_meta_cohorts_core";
import {
    runMatch,
    type IMatchConfig,
    type ISetupAugment,
    type IStrategyActionExecution,
    type Side,
} from "./battle_engine";
import { exitCompletedWorkerCli } from "./completed_worker_cli";
import {
    BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
    TRAPPED_MELEE_RESCUE_CANDIDATE,
    BlockedApproachResearchPlacement,
    blockedApproachBodies,
} from "./blocked_approach_placement_research";
import {
    FirstContactResearchPlacement,
    firstContactBodies,
    FIRST_CONTACT_PLACEMENT_CANDIDATE,
} from "./first_contact_placement_research";
import { footprintCellsForAnchor } from "./footprint";
import { PersistentWorkerPool, startPersistentWorker } from "./persistent_worker_pool";
import { materializeReplayAbSplits } from "./ranked_replay_tactics_ab_core";

export type FirstContactMode = "audit" | "heuristic" | "production";
export type OpponentFormation = "current" | "compact" | "spread";
export type FirstContactCandidate =
    | typeof FIRST_CONTACT_PLACEMENT_CANDIDATE
    | typeof BLOCKED_APPROACH_PLACEMENT_CANDIDATE
    | typeof TRAPPED_MELEE_RESCUE_CANDIDATE;
type Arm = "control" | "candidate";
export interface IFirstContactJob {
    candidate?: FirstContactCandidate;
    cohort: AiMetaCohort;
    pair: number;
    map: 1 | 3 | 4;
    side: Side;
    formation: OpponentFormation;
    arm: Arm;
    mode: FirstContactMode;
    baseSeed: number;
    maxLaps: number;
}
export interface IFirstContactRecord extends IFirstContactJob {
    seed: number;
    budget: number;
    opponentBudget: number;
    proposedSwap: boolean;
    actualSwap: boolean;
    proposedChange: boolean;
    actualChange: boolean;
    blockedMelee: number;
    forwardReachGain: number;
    incumbentFallback: boolean;
    inversions: number;
    retreatCells: number;
    score: number | null;
    winner: Side | "draw" | null;
    endReason: string;
    laps: number;
    rejected: number;
    opponentRejected: number;
    ownNames: string[];
    opponentNames: string[];
    carryUsefulActionsBeforeContact: number;
    firstCarryContactLap: number | null;
    carryHpLossByRound2: number;
    inactiveStacksByRound2: number;
    firstUsefulActionLap: number | null;
    earlyMoves: number;
    earlyObstacleAttacks: number;
    groundMeleeStacks: number;
    groundMeleeAttacksByRound2: number;
    groundMeleeInactiveByRound2: number;
    groundMeleeAttackDelay: number;
    groundMeleeFirstAttacks: { name: string; lap: number | null }[];
    openingRoutes: { name: string; amount: number; before: number; after: number; moved: boolean }[];
    ownPlacement: { name: string; amount: number; x: number; y: number }[];
    elapsedMs: number;
}

class OpponentPlacement implements IAIStrategy {
    public readonly version: string;
    public constructor(
        private readonly base: IAIStrategy,
        private readonly formation: OpponentFormation,
    ) {
        this.version = base.version;
    }
    public placeArmy(units: Unit[], context: IPlacementContext): Map<string, XY> {
        const incumbent = this.base.placeArmy(units, context);
        if (this.formation === "current") return incumbent;
        const candidate = layoutRevealPlacement(units, context, {
            gap: this.formation === "spread" ? 2 : 0,
            screenShooters: true,
            cornerShift: this.formation === "compact",
            physicalMeleeMagicRoles: true,
        });
        const legal = context.placement.possibleCellHashes();
        const occupied = new Set<number>();
        if (candidate.size !== units.length) return incumbent;
        for (const unit of units) {
            const anchor = candidate.get(unit.getId());
            if (!anchor) return incumbent;
            for (const cell of footprintCellsForAnchor(unit, anchor)) {
                const key = (cell.x << 4) | cell.y;
                if (!legal.has(key) || occupied.has(key)) return incumbent;
                occupied.add(key);
            }
        }
        return candidate;
    }
    public decideTurn(unit: Unit, context: IDecisionContext): GameAction[] {
        return this.base.decideTurn(unit, context);
    }
}

export function firstContactAugments(names: readonly string[], budget: number, fastOpponent: boolean): ISetupAugment[] {
    const infos = names.map(creatureIdForName).map((id) => (id === undefined ? undefined : creatureInfo(id)));
    if (infos.filter((info) => info?.ranged).length >= 2) {
        return [
            { kind: "Sniper", value: 3 },
            { kind: "Armor", value: Math.min(3, budget - 3) },
            ...(budget === 7 ? [{ kind: "Might" as const, value: 1 }] : []),
        ];
    }
    if (infos.filter((info) => info?.rangedSpellDamage).length >= 2) {
        return [
            { kind: "Empower", value: 3 },
            { kind: "Armor", value: Math.min(3, budget - 3) },
            ...(budget === 7 ? [{ kind: "Might" as const, value: 1 }] : []),
        ];
    }
    if (fastOpponent) {
        return [
            { kind: "Armor", value: Math.min(3, budget - 3) },
            { kind: "Might", value: budget - Math.min(3, budget - 3) - 2 },
            { kind: "Movement", value: 2 },
        ];
    }
    return [
        { kind: "Armor", value: 3 },
        { kind: "Might", value: Math.min(3, budget - 3) },
        ...(budget === 7 ? [{ kind: "Movement" as const, value: 1 }] : []),
    ];
}
export function firstContactMeleeTargets(
    actions: readonly IStrategyActionExecution[],
    wards: ReadonlySet<string>,
): string[] {
    const targets: string[] = [];
    for (const execution of actions) {
        if (execution.completed && execution.action.type === "melee_attack" && wards.has(execution.action.targetId)) {
            targets.push(execution.action.targetId);
        }
    }
    return targets;
}

const doctrine = (budget: number): Doctrine =>
    budget === 5 ? Doctrine.SEE_ALL : budget === 6 ? Doctrine.THREE_REVEALS : Doctrine.SEE_NONE;

export function firstContactBudgets(pair: number, candidate: FirstContactCandidate): [number, number] {
    return [
        5 + (pair % 3),
        5 + (candidate !== FIRST_CONTACT_PLACEMENT_CANDIDATE ? Math.floor(pair / 3) % 3 : (pair + 1) % 3),
    ];
}

export type FirstContactProbe = Pick<IMatchConfig, "beforeFightStart" | "decisionObserver" | "turnExecutionObserver">;

export function playFirstContactJob(job: IFirstContactJob, probe: FirstContactProbe = {}): IFirstContactRecord {
    const candidate = job.candidate ?? FIRST_CONTACT_PLACEMENT_CANDIDATE;
    process.env.SIM_NO_ACTIONS = "1";
    process.env.LIVETWIN = "1";
    process.env.FIGHT_MELEE_ROSTERS = "0";
    process.env.V08_A19_SEARCH = job.mode === "production" ? "1" : "0";
    process.env.V08_A13_SEARCH = "0";
    if (job.mode === "production") delete process.env.V08_A13_SEARCH;
    const started = performance.now();
    const prepared = prepareMetaPair(
        { cohort: job.cohort, games: 2 * (job.pair + 1), baseSeed: job.baseSeed },
        job.pair,
        job.map,
    );
    const [budget, opponentBudget] = firstContactBudgets(job.pair, candidate);
    const ownNames = prepared.armyA.roster.map((u) => u.creatureName);
    const opponentNames = prepared.armyB.roster.map((u) => u.creatureName);
    const ownAugments = firstContactAugments(ownNames, budget, false);
    const opponentAugments = firstContactAugments(opponentNames, opponentBudget, job.pair % 2 === 0);
    const own = materializeReplayAbSplits(
        prepared.armyA.roster,
        prepared.armyA.creatureIds,
        ownAugments,
        prepared.armyA.synergies,
    );
    const opponent = materializeReplayAbSplits(
        prepared.armyB.roster,
        prepared.armyB.creatureIds,
        opponentAugments,
        prepared.armyB.synergies,
    );
    const ownGreen = job.side === "green";
    const ownTeam = ownGreen ? PBTypes.TeamVals.LEFT : PBTypes.TeamVals.RIGHT;
    const clearance =
        candidate === BLOCKED_APPROACH_PLACEMENT_CANDIDATE || candidate === TRAPPED_MELEE_RESCUE_CANDIDATE
            ? new BlockedApproachResearchPlacement(
                  createV08A19Strategy(),
                  job.arm === "candidate",
                  own.splitRoles,
                  candidate === TRAPPED_MELEE_RESCUE_CANDIDATE ? "trapped" : "broad",
              )
            : undefined;
    const depthSwap = clearance
        ? undefined
        : new FirstContactResearchPlacement(createV08A19Strategy(), job.arm === "candidate");
    const treated = clearance ?? depthSwap!;
    const opposing = new OpponentPlacement(createV08A19Strategy(), job.formation);
    let lapNow = 1;
    let carryUsefulActionsBeforeContact = 0;
    let firstCarryContactLap: number | null = null;
    let firstUsefulActionLap: number | null = null;
    let earlyMoves = 0;
    let earlyObstacleAttacks = 0;
    let carryHpLossByRound2 = 0;
    let initialUnits: Unit[] = [];
    let wards = new Set<string>();
    let groundMelee = new Set<string>();
    let groundMeleeAttacksByRound2 = 0;
    const groundMeleeFirstAttacks = new Map<string, number>();
    const contacted = new Set<string>();
    const useful = new Set<string>();
    const initialHp = new Map<string, number>();
    let ownPlacement: IFirstContactRecord["ownPlacement"] = [];
    const stop = new Error("first-contact-placement-audit-stop");
    const config: IMatchConfig = {
        greenVersion: "v0.8",
        redVersion: "v0.8",
        roster: ownGreen ? own.roster : opponent.roster,
        redRoster: ownGreen ? opponent.roster : own.roster,
        seed: prepared.combatSeed,
        maxLaps: job.maxLaps,
        gridType: job.map,
        greenDoctrine: doctrine(ownGreen ? budget : opponentBudget),
        redDoctrine: doctrine(ownGreen ? opponentBudget : budget),
        greenAugments: ownGreen ? ownAugments : opponentAugments,
        redAugments: ownGreen ? opponentAugments : ownAugments,
        greenArtifactT1: (ownGreen ? prepared.armyA : prepared.armyB).artifactT1.id,
        redArtifactT1: (ownGreen ? prepared.armyB : prepared.armyA).artifactT1.id,
        greenArtifactT2: (ownGreen ? prepared.armyA : prepared.armyB).artifactT2.id,
        redArtifactT2: (ownGreen ? prepared.armyB : prepared.armyA).artifactT2.id,
        greenSynergies: (ownGreen ? prepared.armyA : prepared.armyB).synergies,
        redSynergies: (ownGreen ? prepared.armyB : prepared.armyA).synergies,
        synergyVariants: aiMetaSynergyVariantsForPair(prepared.setupSeed, prepared.combatSeed),
        greenTacticalSplitStacks: ownGreen ? own.splitRoles : opponent.splitRoles,
        redTacticalSplitStacks: ownGreen ? opponent.splitRoles : own.splitRoles,
        placementAugmentTiming: "setup-before-placement",
        headlessEvents: true,
        searchOfflineDeterministicWork: true,
        sideOrientedPlacement: true,
        greenSetupPlacementPolicy: "public-roster",
        redSetupPlacementPolicy: "public-roster",
        greenStrategyOverride: ownGreen ? treated : opposing,
        redStrategyOverride: ownGreen ? opposing : treated,
        beforeFightStart: (context) => {
            initialUnits = context.unitsHolder.getAllAllies(ownTeam);
            if (clearance && !clearance.incumbentFallback) {
                const expected = clearance.expectedPlacement;
                if (
                    !expected ||
                    expected.size !== initialUnits.length ||
                    initialUnits.some((unit) => {
                        const cell = expected.get(unit.getId());
                        const actual = unit.getBaseCell();
                        return !cell || cell.x !== actual.x || cell.y !== actual.y;
                    })
                )
                    throw new Error(
                        "Final placement differs from the split-aware research proposal: " +
                            JSON.stringify({
                                job,
                                expected: initialUnits.map((unit) => ({
                                    name: unit.getName(),
                                    amount: unit.getAmountAlive(),
                                    ...expected?.get(unit.getId()),
                                })),
                                actual: initialUnits.map((unit) => ({
                                    name: unit.getName(),
                                    amount: unit.getAmountAlive(),
                                    ...unit.getBaseCell(),
                                })),
                            }),
                    );
            }
            wards = new Set(
                firstContactBodies(initialUnits)
                    .filter((b) => b.role === "carry")
                    .map((b) => b.id),
            );
            groundMelee = new Set(
                blockedApproachBodies(initialUnits)
                    .filter((body) => body.walkMelee)
                    .map((body) => body.id),
            );
            initialUnits.forEach((u) => initialHp.set(u.getId(), u.getCumulativeHp()));
            ownPlacement = initialUnits.map((u) => ({
                name: u.getName(),
                amount: u.getAmountAlive(),
                ...u.getBaseCell(),
            }));
            probe.beforeFightStart?.(context);
            if (job.mode === "audit") throw stop;
        },
        decisionObserver: (observation) => {
            lapNow = observation.context.fightProperties?.getCurrentLap() ?? lapNow;
            probe.decisionObserver?.(observation);
        },
        turnExecutionObserver: (observation) => {
            if (observation.side === job.side) {
                const actions = observation.strategyActions.filter((a) => a.completed).map((a) => a.action);
                if (groundMelee.has(observation.unitId) && actions.some((a) => a.type === "melee_attack")) {
                    if (!groundMeleeFirstAttacks.has(observation.unitId))
                        groundMeleeFirstAttacks.set(observation.unitId, lapNow);
                    if (lapNow <= 2)
                        groundMeleeAttacksByRound2 += actions.filter((a) => a.type === "melee_attack").length;
                }
                const usefulAction = actions.some((a) =>
                    ["melee_attack", "range_attack", "area_throw_attack", "cast_spell"].includes(a.type),
                );
                if (usefulAction) {
                    if (firstUsefulActionLap === null) firstUsefulActionLap = lapNow;
                    if (wards.has(observation.unitId) && !contacted.has(observation.unitId))
                        carryUsefulActionsBeforeContact++;
                    if (lapNow <= 2) useful.add(observation.unitId);
                }
                if (lapNow <= 2) {
                    earlyMoves += actions.filter((a) => a.type === "move_unit").length;
                    earlyObstacleAttacks += actions.filter((a) => a.type === "obstacle_attack").length;
                }
            }
            if (observation.side !== job.side) {
                for (const targetId of firstContactMeleeTargets(observation.strategyActions, wards)) {
                    contacted.add(targetId);
                    if (firstCarryContactLap === null) firstCarryContactLap = lapNow;
                }
            }
            if (lapNow <= 2)
                carryHpLossByRound2 = initialUnits
                    .filter((u) => wards.has(u.getId()))
                    .reduce((sum, u) => sum + Math.max(0, initialHp.get(u.getId())! - u.getCumulativeHp()), 0);
            probe.turnExecutionObserver?.(observation);
        },
    };
    let result: ReturnType<typeof runMatch> | undefined;
    try {
        result = runMatch(config);
    } catch (error) {
        if (error !== stop) throw error;
    }
    return {
        ...job,
        candidate,
        seed: prepared.combatSeed,
        budget,
        opponentBudget,
        proposedSwap: Boolean(depthSwap?.last?.swapped.length),
        actualSwap: job.arm === "candidate" && Boolean(depthSwap?.last?.swapped.length),
        proposedChange: Boolean(clearance?.last?.movedIds.length || depthSwap?.last?.swapped.length),
        actualChange:
            job.arm === "candidate" && Boolean(clearance?.last?.movedIds.length || depthSwap?.last?.swapped.length),
        blockedMelee: clearance?.last?.blockedMelee ?? 0,
        forwardReachGain: clearance?.last?.forwardReachGain ?? 0,
        incumbentFallback: clearance?.incumbentFallback ?? false,
        inversions: depthSwap?.last?.eligibleInversions ?? 0,
        retreatCells: depthSwap?.last?.retreatCells ?? 0,
        score: result ? (result.winner === "draw" ? 0.5 : result.winner === job.side ? 1 : 0) : null,
        winner: result?.winner ?? null,
        endReason: result?.endReason ?? "audit",
        laps: result?.laps ?? 0,
        rejected: (ownGreen ? result?.rejectedGreen : result?.rejectedRed) ?? 0,
        opponentRejected: (ownGreen ? result?.rejectedRed : result?.rejectedGreen) ?? 0,
        ownNames,
        opponentNames,
        carryUsefulActionsBeforeContact,
        firstCarryContactLap,
        carryHpLossByRound2,
        inactiveStacksByRound2: initialUnits.filter(
            (u) => (initialHp.get(u.getId()) ?? 0) > u.getMaxHp() && !useful.has(u.getId()),
        ).length,
        firstUsefulActionLap,
        earlyMoves,
        earlyObstacleAttacks,
        groundMeleeStacks: groundMelee.size,
        groundMeleeAttacksByRound2,
        groundMeleeInactiveByRound2: [...groundMelee].filter((id) => (groundMeleeFirstAttacks.get(id) ?? 3) > 2).length,
        groundMeleeAttackDelay: [...groundMelee].reduce(
            (sum, id) => sum + Math.min(groundMeleeFirstAttacks.get(id) ?? 3, 3) - 1,
            0,
        ),
        groundMeleeFirstAttacks: initialUnits
            .filter((unit) => groundMelee.has(unit.getId()))
            .map((unit) => ({ name: unit.getName(), lap: groundMeleeFirstAttacks.get(unit.getId()) ?? null })),
        openingRoutes: initialUnits.flatMap((unit, index) => {
            const before = clearance?.last?.beforeReach[unit.getId()];
            if (before === undefined) return [];
            return [
                {
                    name: unit.getName(),
                    amount: ownPlacement[index].amount,
                    before,
                    after: clearance!.last!.afterReach[unit.getId()],
                    moved: clearance!.last!.movedIds.includes(unit.getId()),
                },
            ];
        }),
        ownPlacement,
        elapsedMs: performance.now() - started,
    };
}

export function firstContactJobs(
    pairs: number,
    baseSeed: number,
    mode: FirstContactMode,
    candidate?: FirstContactCandidate,
): IFirstContactJob[] {
    const jobs: IFirstContactJob[] = [];
    for (const cohort of AI_META_COHORTS)
        for (let pair = 0; pair < pairs; pair++)
            for (const map of [1, 3, 4] as const)
                for (const side of ["green", "red"] as const)
                    for (const formation of ["current", "compact", "spread"] as const)
                        for (const arm of mode === "audit"
                            ? (["control"] as const)
                            : (["control", "candidate"] as const))
                            jobs.push({
                                cohort,
                                pair,
                                map,
                                side,
                                formation,
                                arm,
                                mode,
                                baseSeed,
                                maxLaps: 60,
                                ...(candidate ? { candidate } : {}),
                            });
    return jobs;
}

const average = (values: readonly number[]): number =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const interval = (values: readonly number[], z = 1.96) => {
    const mean = average(values);
    const se =
        values.length > 1
            ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1) / values.length)
            : 0;
    return {
        clusters: values.length,
        deltaPp: mean * 100,
        sePp: se * 100,
        lowPp: (mean - z * se) * 100,
        highPp: (mean + z * se) * 100,
    };
};
export function summarizeFirstContact(records: readonly IFirstContactRecord[]) {
    const candidateIds = new Set(records.map((r) => r.candidate ?? FIRST_CONTACT_PLACEMENT_CANDIDATE));
    if (candidateIds.size > 1) throw new Error("Cannot pool different research candidates");
    const changed = (r: IFirstContactRecord) => r.proposedChange ?? r.proposedSwap;
    const controls = records.filter((r) => r.arm === "control");
    const candidates = records.filter((r) => r.arm === "candidate");
    const key = (r: IFirstContactRecord) => [r.cohort, r.pair, r.map, r.side, r.formation].join("/");
    const controlByKey = new Map(controls.map((r) => [key(r), r]));
    const paired = candidates.map((candidate) => {
        const control = controlByKey.get(key(candidate));
        if (!control || control.score === null || candidate.score === null)
            throw new Error("Incomplete paired outcome");
        return { control, candidate, delta: candidate.score - control.score };
    });
    const clusters = new Map<string, number[]>();
    for (const p of paired) {
        const k = p.control.cohort + "/" + p.control.pair;
        const list = clusters.get(k) ?? [];
        list.push(p.delta);
        clusters.set(k, list);
    }
    const byCohort = AI_META_COHORTS.map((cohort) => ({
        cohort,
        audited: controls.filter((r) => r.cohort === cohort).length,
        proposed: controls.filter((r) => r.cohort === cohort && changed(r)).length,
        ...interval(
            [...clusters].filter(([key]) => key.startsWith(cohort + "/")).map(([, x]) => average(x)),
            2.69,
        ),
    }));
    const changes = paired.filter((p) => changed(p.control));
    const unchangedMismatches = paired.filter(
        (p) =>
            !changed(p.control) &&
            JSON.stringify(p.control.ownPlacement) === JSON.stringify(p.candidate.ownPlacement) &&
            (p.control.score !== p.candidate.score || p.control.laps !== p.candidate.laps),
    ).length;
    const changeClusters = new Map<string, number[]>();
    for (const p of changes) {
        const k = p.control.cohort + "/" + p.control.pair;
        const x = changeClusters.get(k) ?? [];
        x.push(p.delta);
        changeClusters.set(k, x);
    }
    return {
        candidate: [...candidateIds][0] ?? FIRST_CONTACT_PLACEMENT_CANDIDATE,
        mode: records[0]?.mode,
        auditedFormations: records.length,
        games: records[0]?.mode === "audit" ? 0 : records.length,
        independentArmyPairs: new Set(controls.map((r) => r.cohort + "/" + r.pair)).size,
        proposedFormations: controls.filter(changed).length,
        outcomePairs: paired.length,
        overall: interval([...clusters.values()].map(average)),
        applicable: interval([...changeClusters.values()].map(average)),
        byCohort,
        unchangedMismatches,
        rejected: records.reduce((sum, r) => sum + r.rejected + r.opponentRejected, 0),
        candidateScore: candidates.length ? average(candidates.map((r) => r.score ?? 0)) : null,
        controlScore: controls.some((r) => r.score !== null) ? average(controls.map((r) => r.score ?? 0)) : null,
        earlyCarryHpLossDelta: average(
            changes.map((p) => p.candidate.carryHpLossByRound2 - p.control.carryHpLossByRound2),
        ),
        carryActionsBeforeContactDelta: average(
            changes.map((p) => p.candidate.carryUsefulActionsBeforeContact - p.control.carryUsefulActionsBeforeContact),
        ),
        earlyMovesDelta: average(changes.map((p) => p.candidate.earlyMoves - p.control.earlyMoves)),
        inactiveStacksDelta: average(
            changes.map((p) => p.candidate.inactiveStacksByRound2 - p.control.inactiveStacksByRound2),
        ),
        groundMeleeAttacksDelta: average(
            changes.map((p) => p.candidate.groundMeleeAttacksByRound2 - p.control.groundMeleeAttacksByRound2),
        ),
        groundMeleeInactiveDelta: average(
            changes.map((p) => p.candidate.groundMeleeInactiveByRound2 - p.control.groundMeleeInactiveByRound2),
        ),
        groundMeleeAttackDelayDelta: average(
            changes.map((p) => p.candidate.groundMeleeAttackDelay - p.control.groundMeleeAttackDelay),
        ),
    };
}

const WORKER = "firstContactPlacementWorker";
if (!isMainThread && workerData?.[WORKER]) {
    startPersistentWorker<IFirstContactJob, IFirstContactRecord>(playFirstContactJob);
} else if (import.meta.main) {
    const { values } = parseArgs({
        options: {
            pairs: { type: "string", default: "32" },
            workers: { type: "string", default: "12" },
            seed: { type: "string", default: "102520261" },
            mode: { type: "string", default: "audit" },
            output: { type: "string" },
            candidate: { type: "string", default: FIRST_CONTACT_PLACEMENT_CANDIDATE },
        },
        strict: true,
    });
    const pairs = Number(values.pairs),
        baseSeed = Number(values.seed),
        workers = Number(values.workers);
    const mode = values.mode as FirstContactMode;
    if (!Number.isInteger(pairs) || pairs < 1 || !Number.isInteger(baseSeed)) throw new Error("Invalid pairs or seed");
    if (!["audit", "heuristic", "production"].includes(mode)) throw new Error("Invalid mode");
    const candidate = values.candidate as FirstContactCandidate;
    if (
        ![
            FIRST_CONTACT_PLACEMENT_CANDIDATE,
            BLOCKED_APPROACH_PLACEMENT_CANDIDATE,
            TRAPPED_MELEE_RESCUE_CANDIDATE,
        ].includes(candidate)
    )
        throw new Error("Invalid candidate");
    const jobs = firstContactJobs(pairs, baseSeed, mode, candidate);
    const output = resolve(values.output ?? "sim-out/first-contact-" + mode + ".json");
    mkdirSync(dirname(output), { recursive: true });
    const pool = new PersistentWorkerPool<IFirstContactJob, IFirstContactRecord>({
        concurrency: Math.max(1, Math.min(12, workers)),
        workerUrl: new URL(import.meta.url),
        workerOptions: { workerData: { [WORKER]: true } },
    });
    const started = performance.now();
    try {
        const records = await pool.runBatch(jobs, ({ completed, total }) => {
            if (completed % 64 === 0 || completed === total)
                console.error(
                    JSON.stringify({ completed, total, seconds: Math.round((performance.now() - started) / 1000) }),
                );
        });
        writeFileSync(
            output.replace(/\.json$/, ".records.jsonl"),
            records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        );
        const summary = {
            ...summarizeFirstContact(records),
            baseSeed,
            elapsedSeconds: (performance.now() - started) / 1000,
        };
        writeFileSync(output, JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary));
        await pool.close();
        await exitCompletedWorkerCli();
    } catch (error) {
        await pool.close();
        throw error;
    }
}
