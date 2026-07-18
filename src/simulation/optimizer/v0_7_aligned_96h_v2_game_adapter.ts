/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { LEAGUE_ROUND1_DRAFT_SPEC } from "../../ai/setup/draft_ship";
import { conditionalAugments, conditionalSynergies, parseConditionalRules } from "../../ai/setup/setup_conditional";
import { SETUP_POLICY_V0 } from "../../ai/setup/setup_v0";
import { FightStateManager } from "../../fights/fight_state_manager";
import { PBTypes } from "../../generated/protobuf/v1/types";
import { getUpgradePoints } from "../../perks/perk_properties";
import { runMatch, type IMatchConfig, type IMatchResult } from "../battle_engine";
import { creatureIdForName } from "../draft";
import { runRankedConditionalPickGame, shippedLeagueGenome, type IConditionalArmy } from "../measure_setup_conditional";
import { rosterSignature, v07ArchetypeTemplate, V07_ARCHETYPE_TAXONOMY } from "../v0_7_archetype_battery";
import type { IV07ComposedAuditRow } from "../v0_7_composed_ranked_ladder";
import type { IV07AlignedV2GameObservation, V07AlignedV2Outcome } from "./v0_7_aligned_96h_v2_core";
import {
    evaluatorCellV07AlignedV2,
    fingerprintV07AlignedV2,
    V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS,
    validateV07AlignedV2CandidateBinding,
    v07AlignedV2TaskKey,
    type IAligned96hCandidateBinding,
    type IV07AlignedV2CandidateBinding,
    type IV07AlignedV2ExecutionTask,
} from "./v0_7_aligned_96h_v2_protocol";
import {
    validateV08AlignedV1CandidateBinding,
    type IV08AlignedV1CandidateBinding,
} from "./v0_8_aligned_96h_v1_protocol";

interface IV07AlignedV2ArmySetup {
    creatureIds: number[];
    revealedOpponentCreatures: number[];
    roster: IMatchConfig["roster"];
    perk: number;
    augments: NonNullable<IMatchConfig["greenAugments"]>;
    synergies: NonNullable<IMatchConfig["greenSynergies"]>;
    tier1Artifact: number;
    tier2Artifact: number;
}

export interface IV07AlignedV2BattleRecord {
    schemaVersion: 1;
    taskKey: string;
    panelId: string;
    cellId: IV07AlignedV2ExecutionTask["cellId"];
    scenarioOrdinal: number;
    scenarioId: string;
    candidateSeat: IV07AlignedV2ExecutionTask["candidateSeat"];
    setupSeed: number;
    setupAttempt: number;
    combatSeed: number;
    candidateIsGreen: boolean;
    greenVersion: "v0.7s" | "v0.6";
    redVersion: "v0.7s" | "v0.6";
    physicalSetupSha256: string;
    lowerRoster: string;
    upperRoster: string;
    winner: "green" | "red" | "draw";
    winnerSlot: "candidate" | "opponent" | "draw";
    laps: number;
    endReason: IMatchResult["endReason"];
    reachedArmageddon: boolean;
    decidedByArmageddon: boolean;
    rejectedGreen?: number;
    rejectedRed?: number;
    resultFingerprint: string;
}

export type IAligned96hBattleRecord<Binding extends IAligned96hCandidateBinding> = Omit<
    IV07AlignedV2BattleRecord,
    "greenVersion" | "redVersion"
> & {
    greenVersion: Binding["candidate"] | Binding["opponent"];
    redVersion: Binding["candidate"] | Binding["opponent"];
};

export interface IV07AlignedV2GameDependencies {
    matchRunner?: (config: IMatchConfig) => IMatchResult;
    pickRunner?: (seed: number) => { lower: IConditionalArmy; upper: IConditionalArmy };
}

function requireUint32(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError(`${label} must be a uint32`);
    }
}

function requireCount(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new RangeError(`${label} must be a nonnegative integer`);
    }
    return value as number;
}

function rankedArmy(army: IConditionalArmy): IV07AlignedV2ArmySetup {
    return {
        creatureIds: [...army.creatureIds],
        revealedOpponentCreatures: [...army.revealedOpponentCreatures],
        roster: army.roster.map((unit) => ({ ...unit })),
        perk: army.perk,
        augments: army.augments.map((augment) => ({ ...augment })),
        synergies: army.synergies.map((synergy) => ({ ...synergy })),
        tier1Artifact: army.tier1Artifact,
        tier2Artifact: army.tier2Artifact,
    };
}

function fixedArmy(
    templateName: NonNullable<ReturnType<typeof evaluatorCellV07AlignedV2>["template"]>,
): IV07AlignedV2ArmySetup {
    const template = v07ArchetypeTemplate(templateName);
    const creatureIds = template.roster.map((unit) => creatureIdForName(unit.creatureName));
    const perk = SETUP_POLICY_V0.pickPerk();
    const rules = parseConditionalRules("all");
    return {
        creatureIds,
        revealedOpponentCreatures: [],
        roster: template.roster.map((unit) => ({ ...unit })),
        perk,
        augments: conditionalAugments(getUpgradePoints(perk), creatureIds, rules),
        synergies: conditionalSynergies(creatureIds),
        tier1Artifact: 0,
        tier2Artifact: 0,
    };
}

function taxonomyMembers(
    archetype: ReturnType<typeof evaluatorCellV07AlignedV2>["archetype"],
    army: IV07AlignedV2ArmySetup,
): string[] {
    const taxonomy = new Set(V07_ARCHETYPE_TAXONOMY[archetype]);
    return army.roster.map((unit) => unit.creatureName).filter((name) => taxonomy.has(name));
}

function selectSetup(
    task: IV07AlignedV2ExecutionTask,
    dependencies: IV07AlignedV2GameDependencies,
): { lower: IV07AlignedV2ArmySetup; upper: IV07AlignedV2ArmySetup; setupSeed: number; setupAttempt: number } {
    const cell = evaluatorCellV07AlignedV2(task.cellId);
    if (cell.distribution === "fixed_template") {
        if (!cell.template || task.setupSeeds.length !== 1) {
            throw new Error(`${cell.id}: fixed-template execution requires one setup seed and a template`);
        }
        const lower = fixedArmy(cell.template);
        const upper = fixedArmy(cell.template);
        return { lower, upper, setupSeed: task.setupSeeds[0], setupAttempt: 0 };
    }
    if (task.setupSeeds.length !== V07_ALIGNED_V2_TAXONOMY_SETUP_ATTEMPTS) {
        throw new Error(`${cell.id}: taxonomy execution requires 128 preregistered setup proposals`);
    }
    const pickRunner =
        dependencies.pickRunner ??
        ((seed: number) =>
            runRankedConditionalPickGame(
                seed,
                parseConditionalRules("all"),
                shippedLeagueGenome(LEAGUE_ROUND1_DRAFT_SPEC),
            ));
    const candidateIsGreen = task.candidateSeat === "candidate_green";
    for (const [setupAttempt, setupSeed] of task.setupSeeds.entries()) {
        const pick = pickRunner(setupSeed);
        const lower = rankedArmy(pick.lower);
        const upper = rankedArmy(pick.upper);
        const candidate = candidateIsGreen ? lower : upper;
        if (taxonomyMembers(cell.archetype, candidate).length > 0) {
            return { lower, upper, setupSeed, setupAttempt };
        }
    }
    throw new Error(`${cell.id}/${task.scenarioId}/${task.candidateSeat}: no candidate-side taxonomy first hit`);
}

function validateExecutionTask(task: IV07AlignedV2ExecutionTask): void {
    evaluatorCellV07AlignedV2(task.cellId);
    if (!task.panelId.trim() || !task.scenarioId.trim()) throw new Error("execution task ids must not be empty");
    if (!(["train", "confirm", "final"] as const).includes(task.purpose)) {
        throw new Error("execution task purpose is invalid");
    }
    if (!Number.isSafeInteger(task.scenarioOrdinal) || task.scenarioOrdinal < 0) {
        throw new RangeError("scenarioOrdinal must be a nonnegative integer");
    }
    if (!(["candidate_green", "candidate_red"] as const).includes(task.candidateSeat)) {
        throw new Error("execution task candidate seat is invalid");
    }
    task.setupSeeds.forEach((seed, index) => requireUint32(seed, `setupSeeds[${index}]`));
    requireUint32(task.combatSeed, "combatSeed");
    if (new Set([...task.setupSeeds, task.combatSeed]).size !== task.setupSeeds.length + 1) {
        throw new Error("execution task contains an internal setup/combat seed collision");
    }
}

function resultFingerprint(result: IMatchResult): string {
    const outcomeWithoutVersion = (outcome: IMatchResult["outcome"]["green"]): Omit<typeof outcome, "version"> => ({
        unitsAlive: outcome.unitsAlive,
        creaturesAlive: outcome.creaturesAlive,
        hpRemaining: outcome.hpRemaining,
    });
    return createHash("sha256")
        .update(
            JSON.stringify({
                seed: result.seed,
                gridType: result.gridType,
                winner: result.winner,
                endReason: result.endReason,
                laps: result.laps,
                totalActions: result.totalActions,
                placements: result.placements,
                actions: result.actions,
                outcome: {
                    green: outcomeWithoutVersion(result.outcome.green),
                    red: outcomeWithoutVersion(result.outcome.red),
                },
                attrition: result.attrition,
                rejectedGreen: result.rejectedGreen,
                rejectedRed: result.rejectedRed,
                rejectedDetails: result.rejectedDetails,
                greenArtifactT1: result.greenArtifactT1 ?? 0,
                redArtifactT1: result.redArtifactT1 ?? 0,
                greenArtifactT2: result.greenArtifactT2 ?? 0,
                redArtifactT2: result.redArtifactT2 ?? 0,
            }),
        )
        .digest("hex");
}

type Aligned96hGameAdapterBinding = IV07AlignedV2CandidateBinding | IV08AlignedV1CandidateBinding;

function validateAligned96hGameAdapterBinding(binding: IAligned96hCandidateBinding): Aligned96hGameAdapterBinding {
    if (binding.candidate === "v0.7s") {
        return validateV07AlignedV2CandidateBinding(binding as IV07AlignedV2CandidateBinding);
    }
    if (binding.candidate === "v0.8s") {
        return validateV08AlignedV1CandidateBinding(binding as IV08AlignedV1CandidateBinding);
    }
    throw new Error(`unsupported aligned game-adapter candidate ${binding.candidate}`);
}

export function playV07AlignedV2Task(
    task: IV07AlignedV2ExecutionTask,
    dependencies?: IV07AlignedV2GameDependencies,
): IV07AlignedV2BattleRecord;
export function playV07AlignedV2Task<Binding extends IAligned96hCandidateBinding>(
    task: IV07AlignedV2ExecutionTask,
    dependencies: IV07AlignedV2GameDependencies | undefined,
    binding: Binding,
): IAligned96hBattleRecord<Binding>;
export function playV07AlignedV2Task<Binding extends IAligned96hCandidateBinding>(
    task: IV07AlignedV2ExecutionTask,
    dependencies: IV07AlignedV2GameDependencies = {},
    binding?: Binding,
): IV07AlignedV2BattleRecord | IAligned96hBattleRecord<Binding> {
    validateExecutionTask(task);
    const cell = evaluatorCellV07AlignedV2(task.cellId);
    if (!binding && (cell.candidate !== "v0.7s" || cell.opponent !== "v0.6")) {
        throw new Error(`${cell.id}: aligned evaluator version isolation drifted`);
    }
    const validatedBinding = binding ? validateAligned96hGameAdapterBinding(binding) : undefined;
    const candidateVersion = validatedBinding?.candidate ?? cell.candidate;
    const opponentVersion = validatedBinding?.opponent ?? cell.opponent;
    const selected = selectSetup(task, dependencies);
    const candidateIsGreen = task.candidateSeat === "candidate_green";
    const greenVersion = candidateIsGreen ? candidateVersion : opponentVersion;
    const redVersion = candidateIsGreen ? opponentVersion : candidateVersion;
    const matchRunner =
        dependencies.matchRunner ??
        ((config: IMatchConfig): IMatchResult => {
            FightStateManager.getInstance();
            return runMatch(config);
        });
    const result = matchRunner({
        greenVersion,
        redVersion,
        roster: selected.lower.roster,
        redRoster: selected.upper.roster,
        seed: task.combatSeed,
        gridType: PBTypes.GridVals.NORMAL,
        greenPerk: selected.lower.perk,
        redPerk: selected.upper.perk,
        greenAugments: selected.lower.augments,
        redAugments: selected.upper.augments,
        greenArtifactT1: selected.lower.tier1Artifact,
        redArtifactT1: selected.upper.tier1Artifact,
        greenArtifactT2: selected.lower.tier2Artifact,
        redArtifactT2: selected.upper.tier2Artifact,
        greenSynergies: selected.lower.synergies,
        redSynergies: selected.upper.synergies,
        greenRevealedCreatures: selected.lower.revealedOpponentCreatures,
        redRevealedCreatures: selected.upper.revealedOpponentCreatures,
    });
    if (
        result.seed !== task.combatSeed ||
        result.outcome.green.version !== greenVersion ||
        result.outcome.red.version !== redVersion
    ) {
        throw new Error(`${v07AlignedV2TaskKey(task)}: match result does not bind the requested seed and versions`);
    }
    const candidateSide = candidateIsGreen ? "green" : "red";
    return {
        schemaVersion: 1,
        taskKey: v07AlignedV2TaskKey(task),
        panelId: task.panelId,
        cellId: task.cellId,
        scenarioOrdinal: task.scenarioOrdinal,
        scenarioId: task.scenarioId,
        candidateSeat: task.candidateSeat,
        setupSeed: selected.setupSeed,
        setupAttempt: selected.setupAttempt,
        combatSeed: task.combatSeed,
        candidateIsGreen,
        greenVersion,
        redVersion,
        physicalSetupSha256: fingerprintV07AlignedV2({
            lower: selected.lower,
            upper: selected.upper,
            map: PBTypes.GridVals.NORMAL,
        }),
        lowerRoster: rosterSignature(selected.lower.roster),
        upperRoster: rosterSignature(selected.upper.roster),
        winner: result.winner,
        winnerSlot: result.winner === "draw" ? "draw" : result.winner === candidateSide ? "candidate" : "opponent",
        laps: result.laps,
        endReason: result.endReason,
        reachedArmageddon: result.attrition.reachedArmageddon,
        decidedByArmageddon: result.attrition.decidedByArmageddon,
        rejectedGreen: result.rejectedGreen,
        rejectedRed: result.rejectedRed,
        resultFingerprint: resultFingerprint(result),
    };
}

function expectedAuditLeaf(binding: IAligned96hCandidateBinding): "learned_v2" | "material" {
    if (binding.genome.search.leafMode === "off") throw new Error("search-off binding has no search audit leaf");
    return binding.genome.search.leafMode === "model" ? "learned_v2" : "material";
}

function validateAudit(
    record: IAligned96hBattleRecord<IAligned96hCandidateBinding>,
    audit: IV07ComposedAuditRow,
    binding: IAligned96hCandidateBinding,
): void {
    if (
        audit.t !== "game" ||
        audit.mode !== "search" ||
        audit.seed !== record.combatSeed ||
        audit.green !== record.greenVersion ||
        audit.red !== record.redVersion ||
        audit.winner !== record.winner ||
        audit.endReason !== record.endReason ||
        audit.gate !== binding.genome.search.gate ||
        audit.horizon !== binding.genome.search.horizon ||
        audit.rollouts !== binding.genome.search.rollouts ||
        audit.leaf !== expectedAuditLeaf(binding) ||
        audit.oppModel !== undefined ||
        audit.shortlist !== binding.genome.controls.shortlist ||
        audit.decisionDeadlineMs !== binding.genome.controls.decisionDeadlineMs ||
        audit.circuitBreakerMs !== 275 ||
        audit.lateRangedFinishWeight !== binding.genome.controls.lateRangedFinishWeight ||
        audit.pureRangedTerminalWeight !== binding.genome.controls.pureRangedTerminalWeight
    ) {
        throw new Error(`${record.taskKey}: search audit does not match the candidate binding`);
    }
    const decisions = requireCount(audit.decisions, "audit.decisions");
    const searched = requireCount(audit.searched, "audit.searched");
    const overrides = requireCount(audit.overrides, "audit.overrides");
    const illegalIncumbent = requireCount(audit.illegalIncumbent, "audit.illegalIncumbent");
    const deadlineFallbacks = requireCount(audit.deadlineFallbacks, "audit.deadlineFallbacks");
    const circuitSkipped = requireCount(audit.circuitSkipped, "audit.circuitSkipped");
    if (
        decisions < 1 ||
        searched > decisions ||
        overrides > searched ||
        illegalIncumbent > searched ||
        deadlineFallbacks > searched
    ) {
        throw new Error(`${record.taskKey}: search audit counter totals are inconsistent`);
    }
    if (typeof audit.circuitOpened !== "boolean" || (!audit.circuitOpened && circuitSkipped > 0)) {
        throw new Error(`${record.taskKey}: search audit circuit telemetry is inconsistent`);
    }
    if (!Number.isFinite(audit.msTotal) || audit.msTotal < 0) {
        throw new Error(`${record.taskKey}: search audit msTotal must be finite and nonnegative`);
    }
}

export function compactV07AlignedV2Observation(
    record: IV07AlignedV2BattleRecord,
    binding: IV07AlignedV2CandidateBinding,
    audit?: IV07ComposedAuditRow,
): IV07AlignedV2GameObservation;
export function compactV07AlignedV2Observation<Binding extends IAligned96hCandidateBinding>(
    record: IAligned96hBattleRecord<Binding>,
    binding: Binding,
    audit?: IV07ComposedAuditRow,
): IV07AlignedV2GameObservation;
export function compactV07AlignedV2Observation<Binding extends IAligned96hCandidateBinding>(
    record: IV07AlignedV2BattleRecord | IAligned96hBattleRecord<Binding>,
    binding: IV07AlignedV2CandidateBinding | Binding,
    audit?: IV07ComposedAuditRow,
): IV07AlignedV2GameObservation {
    const validatedBinding = validateAligned96hGameAdapterBinding(binding);
    const candidateIsGreen = record.candidateSeat === "candidate_green";
    const expectedGreenVersion = candidateIsGreen ? validatedBinding.candidate : validatedBinding.opponent;
    const expectedRedVersion = candidateIsGreen ? validatedBinding.opponent : validatedBinding.candidate;
    const expectedWinnerSlot =
        record.winner === "draw"
            ? "draw"
            : record.winner === (candidateIsGreen ? "green" : "red")
              ? "candidate"
              : "opponent";
    if (
        record.schemaVersion !== 1 ||
        record.candidateIsGreen !== candidateIsGreen ||
        record.greenVersion !== expectedGreenVersion ||
        record.redVersion !== expectedRedVersion ||
        record.winnerSlot !== expectedWinnerSlot
    ) {
        throw new Error(
            `${record.taskKey}: battle record is not an exact ${validatedBinding.candidate} versus ${validatedBinding.opponent} candidate-seat result`,
        );
    }
    if (validatedBinding.searchEnabled !== (audit !== undefined)) {
        throw new Error(`${record.taskKey}: audit presence disagrees with candidate search mode`);
    }
    if (audit) validateAudit(record, audit, validatedBinding);
    if ((record.rejectedGreen === undefined) !== (record.rejectedRed === undefined)) {
        throw new Error(`${record.taskKey}: match result provided only one side's rejection count`);
    }
    if (record.rejectedGreen !== undefined) requireCount(record.rejectedGreen, "rejectedGreen");
    if (record.rejectedRed !== undefined) requireCount(record.rejectedRed, "rejectedRed");
    const outcome: V07AlignedV2Outcome =
        record.winnerSlot === "candidate"
            ? "candidate_win"
            : record.winnerSlot === "opponent"
              ? "opponent_win"
              : "draw";
    const candidateRejections = record.candidateIsGreen ? record.rejectedGreen : record.rejectedRed;
    const opponentRejections = record.candidateIsGreen ? record.rejectedRed : record.rejectedGreen;
    return {
        cellId: record.cellId,
        candidateSeat: record.candidateSeat,
        scenarioId: record.scenarioId,
        outcome,
        reachedArmageddon: record.reachedArmageddon,
        ...(candidateRejections === undefined || opponentRejections === undefined
            ? {}
            : { candidateRejections, opponentRejections }),
        ...(audit
            ? {
                  searchAudit: {
                      decisions: audit.decisions,
                      searchedDecisions: audit.searched,
                      deadlineFallbacks: audit.deadlineFallbacks,
                      illegalIncumbents: audit.illegalIncumbent,
                      circuitOpened: audit.circuitOpened,
                      circuitSkippedDecisions: audit.circuitSkipped,
                      msTotal: audit.msTotal,
                  },
              }
            : {}),
    };
}

export function readV07AlignedV2AuditAppend(
    path: string,
    byteOffset: number,
): { nextByteOffset: number; rows: IV07ComposedAuditRow[] } {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) throw new RangeError("byteOffset must be nonnegative");
    const bytes = readFileSync(path);
    if (byteOffset > bytes.length) throw new Error("search audit file shrank while a worker was active");
    const appendedBytes = bytes.subarray(byteOffset);
    let appended: string;
    try {
        appended = new TextDecoder("utf-8", { fatal: true }).decode(appendedBytes);
    } catch {
        throw new Error("search audit append is not valid UTF-8");
    }
    if (!Buffer.from(appended, "utf8").equals(appendedBytes)) {
        throw new Error("search audit append is not canonical UTF-8");
    }
    if (appended && !appended.endsWith("\n")) throw new Error("search audit append lacks a terminal newline");
    const rows = appended
        .split("\n")
        .filter(Boolean)
        .map((line, index) => {
            try {
                return JSON.parse(line) as IV07ComposedAuditRow;
            } catch (error) {
                throw new Error(`malformed search audit append row ${index + 1}: ${String(error)}`);
            }
        });
    return { nextByteOffset: bytes.length, rows };
}
