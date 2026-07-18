import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    compileNonFightSetupPolicy,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
} from "../../src/ai/setup/setup_ship";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { ChaosSynergy } from "../../src/synergies/synergy_properties";
import {
    buildPublicSetupBoardPlan,
    evaluatePublicSetupCluster,
    loadPublicSetupLedger,
    publicSetupLedgerEnvelope,
} from "../../src/simulation/optimizer/v0_7_public_setup_search_runner";
import {
    PUBLIC_SETUP_CANDIDATES,
    publicSetupAugmentActionableCohorts,
    publicSetupBoard,
    publicSetupCandidate,
    publicSetupCompositeCandidate,
    publicSetupDiagnosticTags,
    publicSetupOpponentSignalMatches,
    publicSetupOwnGroup,
    publicSetupPromotionGate,
    selectPublicSetupChoices,
    shiftPublicSetupAugmentPlan,
    summarizePublicSetup,
    validatePublicSetupControlParity,
    type IPublicSetupOutcomeRecord,
} from "../../src/simulation/optimizer/v0_7_public_setup_search_core";

const C = PBTypes.CreatureVals;
const SHIPPED = compileNonFightSetupPolicy(V07_NONFIGHT_SETUP_ARTIFACT.policy, V07_NONFIGHT_SETUP_SPEC);
const augmentCandidateForTest = (id: string) => {
    const candidate = publicSetupCandidate(id);
    if (candidate.family !== "augment") throw new Error(`${id} is not an augment candidate`);
    return candidate;
};

describe("v0.7 public-roster setup search", () => {
    test("control is exactly the frozen shipped augment and synergy policy", () => {
        const own = [C.ARBALESTER, C.ELF, C.SQUIRE, C.PIKEMAN, C.GRIFFIN, C.PEASANT];
        const opponent = [C.ORC, C.SCAVENGER, C.TROGLODYTE, C.TROLL, C.MEDUSA, C.BEHOLDER];
        const choices = selectPublicSetupChoices(publicSetupCandidate("control/shipped-v07"), own, opponent);

        expect(choices.augments).toEqual(SHIPPED.pickAugments(7, own));
        expect(choices.synergies).toEqual(SHIPPED.pickSynergies(own));
        expect(choices.candidateAugmentPlanId).toBe(choices.controlAugmentPlanId);
        expect(choices.actionApplied).toBe(false);
    });

    test("guards Aura independently and follows the shipped cohort precedence", () => {
        expect(publicSetupOwnGroup([C.ARBALESTER])).toBe("ranged");
        expect(publicSetupOwnGroup([C.SATYR, C.PEASANT])).toBe("mage");
        expect(publicSetupOwnGroup([C.ANGEL, C.PEASANT])).toBe("melee-magic");
        expect(publicSetupOwnGroup([C.PEASANT])).toBe("aura-heavy");
        expect(publicSetupOwnGroup([C.SCAVENGER])).toBe("melee-other");
        expect(publicSetupDiagnosticTags([C.ARBALESTER, C.SATYR, C.ANGEL, C.PEASANT, C.SQUIRE])).toEqual([
            "ranged",
            "mage",
            "melee-magic",
            "aura-heavy",
            "melee-other",
        ]);
    });

    test("public opponent identities are deduplicated before a matchup rule is evaluated", () => {
        const oneRangedIdentity = [C.ARBALESTER, C.ARBALESTER, C.ARBALESTER];
        expect(publicSetupOpponentSignalMatches("ranged-2plus", oneRangedIdentity)).toBe(false);
        expect(publicSetupOpponentSignalMatches("ranged-2plus", [C.ARBALESTER, C.ELF])).toBe(true);

        const candidate = publicSetupCandidate("augment/ranged/ranged-2plus/armor-to-movement");
        const own = [C.ARBALESTER, C.ELF];
        const duplicated = selectPublicSetupChoices(candidate, own, [C.ARBALESTER, C.ELF, C.ELF]);
        const unique = selectPublicSetupChoices(candidate, own, [C.ARBALESTER, C.ELF]);
        expect(duplicated).toEqual(unique);
        expect(unique.actionApplied).toBe(true);
        expect(unique.controlAugmentPlanId).toBe("P0-A2-M2-S3-V0");
        expect(unique.candidateAugmentPlanId).toBe("P0-A1-M2-S3-V1");
    });

    test("augment candidates remain a one-point legal full-budget shift", () => {
        const shifted = shiftPublicSetupAugmentPlan(
            { placement: 0, armor: 3, might: 1, sniper: 3, movement: 0 },
            "might-to-movement",
        );
        expect(shifted).toEqual({ placement: 0, armor: 3, might: 0, sniper: 3, movement: 1 });
        expect(shiftPublicSetupAugmentPlan({ ...shifted!, movement: 2 }, "armor-to-movement")).toBeUndefined();
        expect(
            publicSetupAugmentActionableCohorts(augmentCandidateForTest("augment/ranged/ranged-2plus/might-to-armor")),
        ).toEqual(["ranged-2to3"]);
        expect(
            publicSetupAugmentActionableCohorts(augmentCandidateForTest("augment/ranged/ranged-2plus/might-to-sniper")),
        ).toEqual(["ranged-1"]);
        expect(
            PUBLIC_SETUP_CANDIDATES.filter((candidate) => candidate.family === "augment").every(
                (candidate) => publicSetupAugmentActionableCohorts(candidate).length > 0,
            ),
        ).toBe(true);
    });

    test("synergy candidates flip only an active faction under their public signal", () => {
        const own = [C.ORC, C.SCAVENGER];
        const candidate = publicSetupCandidate("synergy/chaos/ranged-2plus/flip");
        const inactive = selectPublicSetupChoices(candidate, own, [C.ARBALESTER]);
        const active = selectPublicSetupChoices(candidate, own, [C.ARBALESTER, C.ELF]);

        expect(inactive.synergies).toEqual(SHIPPED.pickSynergies(own));
        expect(inactive.actionApplied).toBe(false);
        expect(SHIPPED.pickSynergies(own)).toContainEqual({
            faction: PBTypes.FactionVals.CHAOS,
            synergy: ChaosSynergy.BREAK_ON_ATTACK,
        });
        expect(active.synergies).toContainEqual({
            faction: PBTypes.FactionVals.CHAOS,
            synergy: ChaosSynergy.MOVEMENT,
        });
        expect(active.actionApplied).toBe(true);
    });

    test("canonical composites are explicit and reject ambiguous winner combinations", () => {
        const rules = ["augment/mage/ranged-any/movement-to-sniper", "synergy/chaos/ranged-any/flip"];
        const forward = publicSetupCompositeCandidate(rules);
        const reverse = publicSetupCompositeCandidate([...rules].reverse());
        expect(forward.id).toBe(reverse.id);
        expect(forward.ruleIds).toEqual([...rules].sort());
        expect(() =>
            publicSetupCompositeCandidate([
                "augment/ranged/ranged-any/might-to-armor",
                "augment/ranged/ranged-any/might-to-sniper",
            ]),
        ).toThrow("at most one augment rule per own setup group");
        expect(Object.isFrozen(forward)).toBe(true);
    });

    test("board streams separate identity, pick, combat, and holdout panels", () => {
        const panels = ["train", "selection", "guard"] as const;
        const boards = panels.flatMap((panel) =>
            Array.from({ length: 100 }, (_, index) => publicSetupBoard(97_072_710, panel, index)),
        );
        const allSeeds = boards.flatMap((board) => [board.pairSeed, board.pickSeed, board.battleSeed]);
        expect(new Set(allSeeds)).toHaveLength(allSeeds.length);
        expect(publicSetupBoard(97_072_710, "guard", 7)).toEqual(publicSetupBoard(97_072_710, "guard", 7));
        expect(
            boards.every((board) =>
                [PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER].includes(
                    board.gridType,
                ),
            ),
        ).toBe(true);
        expect(new Set(boards.map((board) => board.gridType))).toEqual(
            new Set([PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER]),
        );
    });

    test("draft-only preflight freezes fixed pick-seat x map x tag x signal quotas", () => {
        const candidate = publicSetupCandidate("augment/melee-magic/ranged-any/armor-to-movement");
        const plan = buildPublicSetupBoardPlan({
            candidates: [publicSetupCandidate("control/shipped-v07"), candidate],
            panel: "train",
            baseSeed: 97_072_710,
            naturalBoards: 3,
            stratumBoards: 1,
            stratifiedScanCap: 5_000,
        });
        const candidatePlan = plan.candidates[0];

        expect(Object.isFrozen(plan)).toBe(true);
        expect(plan.naturalBoards).toHaveLength(3);
        expect(candidatePlan.supported).toBe(true);
        expect(candidatePlan.unfilledStrata).toEqual([]);
        expect(candidatePlan.strata).toHaveLength(24);
        expect(candidatePlan.stratifiedBoards).toHaveLength(24);
        expect(new Set(candidatePlan.stratifiedBoards.map(({ stratum }) => stratum.pickSeat))).toEqual(
            new Set(["lower", "upper"]),
        );
        expect(new Set(candidatePlan.stratifiedBoards.map(({ stratum }) => stratum.gridType))).toEqual(
            new Set([PBTypes.GridVals.NORMAL, PBTypes.GridVals.LAVA_CENTER, PBTypes.GridVals.BLOCK_CENTER]),
        );
        expect(new Set(candidatePlan.stratifiedBoards.map(({ stratum }) => stratum.ownTag))).toEqual(
            new Set(["mage", "melee-magic", "aura-heavy", "melee-other"]),
        );
        expect(candidatePlan.stratifiedBoards.every(({ stratum }) => stratum.opponentSignal === "ranged-any")).toBe(
            true,
        );
        const naturalIndices = new Set(plan.naturalBoards.map((board) => board.index));
        expect(candidatePlan.stratifiedBoards.every(({ board }) => !naturalIndices.has(board.index))).toBe(true);
    });

    test("cohort slices score the identical control games instead of comparing composition to 50%", () => {
        const record = (
            pairSeed: number,
            game: number,
            candidateResult: IPublicSetupOutcomeRecord["candidateResult"],
        ): IPublicSetupOutcomeRecord => ({
            pairSeed,
            game,
            gridType: PBTypes.GridVals.NORMAL,
            candidateResult,
            ownGroup: "ranged",
            ownTags: ["ranged", "mage"],
            actionApplied: true,
            candidateRejections: 0,
            baselineRejections: 0,
            laps: 3,
            totalActions: 12,
            endReason: "elimination",
            decidedByArmageddon: false,
            behaviorTraceSha256: `${pairSeed}-${game}`,
        });
        const candidate = [record(1, 0, "win"), record(2, 0, "win")];
        const sameBoardControl = [record(1, 0, "win"), record(2, 0, "win")];
        const summary = summarizePublicSetup(candidate, candidate, sameBoardControl);

        expect(summary.byOwnTag.ranged.candidateDecisiveWinRate).toBe(1);
        expect(summary.byOwnTag.ranged.controlDecisiveWinRate).toBe(1);
        expect(summary.byOwnTag.ranged.matchedGainPp).toBe(0);
        expect(summary.byOwnTag.mage.games).toBe(2);
        expect(summary.byOwnTag.ranged.confidence95GainPp).toEqual({ low: 0, high: 0 });
        const noActionSummary = summarizePublicSetup(
            candidate,
            candidate.map((entry) => ({ ...entry, actionApplied: false })),
            sameBoardControl,
        );
        const gate = publicSetupPromotionGate(
            publicSetupCandidate("augment/ranged/ranged-2plus/might-to-armor"),
            noActionSummary,
            {
                panel: "train",
                runComplete: true,
                candidateFrozen: true,
                nonControlCandidateCount: 1,
                candidateSupported: true,
                sourceClean: true,
                allCandidateRejections: 0,
                plannedNaturalGames: 2,
                plannedStratifiedActionableGames: 2,
                controlParity: { ok: true, failures: [] },
            },
        );
        expect(gate.promotable).toBe(false);
        expect(gate.failures).toContain("train is exploratory and can never promote");
        expect(gate.failures).toContain("stratified plan contains no-op candidate games");

        const actionableRegression = summarizePublicSetup(
            candidate,
            candidate.map((entry) => ({
                ...entry,
                totalActions: entry.totalActions + 1,
                baselineRejections: 1,
            })),
            sameBoardControl,
        );
        const regressionGate = publicSetupPromotionGate(
            publicSetupCandidate("augment/ranged/ranged-2plus/might-to-armor"),
            actionableRegression,
            {
                panel: "guard",
                runComplete: true,
                candidateFrozen: true,
                nonControlCandidateCount: 1,
                candidateSupported: true,
                sourceClean: false,
                allCandidateRejections: 2,
                plannedNaturalGames: 2,
                plannedStratifiedActionableGames: 2,
                controlParity: { ok: true, failures: [] },
            },
        );
        expect(regressionGate.failures).toContain(
            "guard source tree is dirty; commit the exact evaluated sources first",
        );
        expect(regressionGate.failures).toContain("candidate has rejections outside the scored slices");
        expect(regressionGate.failures).toContain("stratified actionable average action count regressed");
        expect(regressionGate.failures).toContain("candidate games have opponent-side rejected actions");
    });

    test("four-game shipped control crosses both pick seats and battle sides at exact parity", () => {
        const cluster = evaluatePublicSetupCluster(
            publicSetupCandidate("control/shipped-v07"),
            publicSetupBoard(97_072_710, "train", 0),
            12,
        );
        const wins = cluster.records.filter((record) => record.candidateResult === "win").length;
        const losses = cluster.records.filter((record) => record.candidateResult === "loss").length;

        expect(cluster.records).toHaveLength(4);
        expect(new Set(cluster.records.map((record) => record.pickSeat))).toEqual(
            new Set(["candidate-lower", "candidate-upper"]),
        );
        expect(new Set(cluster.records.map((record) => record.candidateSide))).toEqual(new Set(["green", "red"]));
        expect(cluster.records.every((record) => !record.actionApplied)).toBe(true);
        expect(wins).toBe(losses);
        expect(validatePublicSetupControlParity(cluster.records, 4)).toEqual({ ok: true, failures: [] });
        const rejectedControl = cluster.records.map((record, index) =>
            index === 0 ? { ...record, baselineRejections: 1 } : record,
        );
        expect(validatePublicSetupControlParity(rejectedControl, 4).failures).toContain("control has rejected actions");

        const directory = mkdtempSync(join(tmpdir(), "hoc-public-setup-ledger-"));
        const ledger = join(directory, "clusters.jsonl");
        const envelope = publicSetupLedgerEnvelope(cluster);
        const line = JSON.stringify(envelope);
        const expected = new Map([
            [
                `${cluster.candidateId}\u0000${cluster.board.index}`,
                { candidate: publicSetupCandidate("control/shipped-v07"), board: cluster.board },
            ],
        ]);
        try {
            writeFileSync(ledger, `${line}\n`);
            expect(loadPublicSetupLedger(ledger, expected).size).toBe(1);

            writeFileSync(ledger, line);
            expect(loadPublicSetupLedger(ledger, expected).size).toBe(1);
            expect(readFileSync(ledger, "utf8")).toBe(`${line}\n`);

            const wrongBoard = { ...cluster, board: { ...cluster.board, battleSeed: cluster.board.battleSeed + 1 } };
            writeFileSync(ledger, `${JSON.stringify(publicSetupLedgerEnvelope(wrongBoard))}\n`);
            expect(() => loadPublicSetupLedger(ledger, expected)).toThrow("frozen candidate/board plan");

            writeFileSync(ledger, `${JSON.stringify({ ...envelope, payloadSha256: "0".repeat(64) })}\n`);
            expect(() => loadPublicSetupLedger(ledger, expected)).toThrow("checksum failure");

            writeFileSync(ledger, `${line}\n{\"partial\"`);
            expect(loadPublicSetupLedger(ledger, expected).size).toBe(1);
            expect(readFileSync(ledger, "utf8")).toBe(`${line}\n`);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
