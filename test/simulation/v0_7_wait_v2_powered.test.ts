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

import { describe, expect, it } from "bun:test";

import {
    WAIT_V2_PAIR_SEED_STEP,
    WAIT_V2_WEIGHT_JSON,
    analyzeWaitV2Cell,
    assessWaitV2Run,
    readWaitV2ProtocolManifest,
    validateWaitV2ProtocolManifest,
    waitV2ArmEnvironment,
    type IWaitV2Cell,
    type IWaitV2Observation,
    type IWaitV2ProtocolManifest,
} from "../../src/simulation/v0_7_wait_v2_powered";
import type { IRevisionProvenance } from "../../src/simulation/v0_7_acceptance";

const cleanMain: IRevisionProvenance = {
    commit: "0123456789abcdef0123456789abcdef01234567",
    commitDate: "2026-07-15T00:00:00Z",
    branch: "main",
    remote: "git@example.invalid:common.git",
    trackedClean: true,
    trackedDiffSha256: null,
};

function cloneProtocol(): IWaitV2ProtocolManifest {
    return JSON.parse(JSON.stringify(readWaitV2ProtocolManifest().manifest)) as IWaitV2ProtocolManifest;
}

function observations(
    cell: IWaitV2Cell,
    scores: readonly (0 | 0.5 | 1)[],
    options: { armageddon?: boolean; missingRejections?: boolean } = {},
): IWaitV2Observation[] {
    return scores.map((score, game) => ({
        game,
        seed: (cell.baseSeed + Math.floor(game / 2) * WAIT_V2_PAIR_SEED_STEP) >>> 0,
        score,
        draw: score === 0.5,
        armageddon: options.armageddon ?? false,
        candidateRejections: options.missingRejections ? null : 0,
        opponentRejections: 0,
    }));
}

describe("powered wait-V2 protocol manifest", () => {
    it("freezes the seven cells, powered size, seeds, and exact V2 vector", () => {
        const { manifest } = readWaitV2ProtocolManifest();
        expect(manifest.gamesPerArm).toBe(12_000);
        expect(manifest.cells.map((cell) => [cell.id, cell.baseSeed])).toEqual([
            ["mirror_melee_coevo", 819_284_410],
            ["mirror_hybrid", 2_881_327_399],
            ["mirror_ranged_max_sniper3", 903_810_739],
            ["mirror_pure_ranged", 1_535_948_976],
            ["draft_melee", 3_175_082_463],
            ["draft_mixed", 413_096_782],
            ["draft_random", 455_875_959],
        ]);
        expect(manifest.cells.filter((cell) => cell.primaryPool).map((cell) => cell.id)).toEqual([
            "mirror_hybrid",
            "mirror_ranged_max_sniper3",
            "mirror_pure_ranged",
            "draft_mixed",
            "draft_random",
        ]);
        expect(JSON.parse(WAIT_V2_WEIGHT_JSON).w).toHaveLength(98);

        const seeds = new Set<number>();
        for (const cell of manifest.cells) {
            for (let pair = 0; pair < manifest.gamesPerArm / 2; pair += 1) {
                seeds.add((cell.baseSeed + pair * WAIT_V2_PAIR_SEED_STEP) >>> 0);
            }
        }
        expect(seeds.size).toBe(84_000 / 2);
    });

    it("fails closed when the frozen vector hash or a derived seed stream changes", () => {
        const badWeights = cloneProtocol();
        badWeights.v2WeightsSha256 = "0".repeat(64);
        expect(() => validateWaitV2ProtocolManifest(badWeights)).toThrow("weight hash mismatch");

        const collision = cloneProtocol();
        collision.cells[1].baseSeed = collision.cells[0].baseSeed;
        expect(() => validateWaitV2ProtocolManifest(collision)).toThrow("frozen seven-cell panel");
    });
});

describe("powered wait-V2 environment isolation", () => {
    it("strips ambient behavior knobs and leaves the control V2 variable absent", () => {
        const cell = cloneProtocol().cells.find((entry) => entry.id === "draft_mixed")!;
        const source = {
            PATH: "/bin",
            HOME: "/tmp/home",
            V06_CANDIDATE: "ambient",
            V07_WAIT_WEIGHTS_V2: "ambient",
            SEARCH_MODE: "ambient",
            FORCE_CREATURES: "1:Peasant",
            FIGHT_MELEE_ROSTERS: "ambient",
            SIM_NO_ACTIONS: "0",
        };
        const environment = waitV2ArmEnvironment(source, cell, "control");
        expect(environment.PATH).toBe("/bin");
        expect(environment.HOME).toBe("/tmp/home");
        expect(environment.LIVETWIN).toBe("1");
        expect(environment.SIM_NO_ACTIONS).toBe("1");
        expect(environment.FIGHT_MELEE_ROSTERS).toBe("0.5");
        expect(environment.V07_WAIT_WEIGHTS_V2).toBeUndefined();
        expect(environment.V06_CANDIDATE).toBeUndefined();
        expect(environment.SEARCH_MODE).toBeUndefined();
        expect(environment.FORCE_CREATURES).toBeUndefined();
    });

    it("injects only the exact V2 vector and leaves forced mirrors outside draft controls", () => {
        const cell = cloneProtocol().cells.find((entry) => entry.id === "mirror_hybrid")!;
        const environment = waitV2ArmEnvironment({ PATH: "/bin" }, cell, "v2");
        expect(environment.V07_WAIT_WEIGHTS_V2).toBe(WAIT_V2_WEIGHT_JSON);
        expect(environment.FIGHT_MELEE_ROSTERS).toBeUndefined();
        expect(Object.keys(environment).sort()).toEqual(["LIVETWIN", "PATH", "SIM_NO_ACTIONS", "V07_WAIT_WEIGHTS_V2"]);
    });
});

describe("powered wait-V2 matched analysis", () => {
    it("counts draws as half, clusters side swaps, and cannot promote a small-game smoke", () => {
        const protocol = cloneProtocol();
        const analyses = protocol.cells.map((cell) =>
            analyzeWaitV2Cell(
                cell,
                observations(cell, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
                observations(cell, [1, 1, 1, 1, 1, 1, 1, 1]),
                8,
            ),
        );
        expect(analyses[0].control.scoreRate).toBe(0.5);
        expect(analyses[0].control.draws).toBe(8);
        expect(analyses[0].v2.scoreRate).toBe(1);
        expect(analyses[0].matchedScoreDelta.mean).toBe(0.5);
        expect(analyses[0].matchedScoreDelta.clusters).toBe(4);

        const assessment = assessWaitV2Run(protocol, analyses, 8, cleanMain, true);
        expect(assessment.evidenceVerdict).toBe("INCONCLUSIVE");
        expect(assessment.protocolPowered).toBe(false);
        expect(assessment.completenessReasons.join(" ")).toContain("gamesPerArm=8");
        expect(assessment.gates.filter((gate) => gate.tier === "research").every((gate) => gate.passed)).toBe(true);
        expect(assessment.verdictScope).toBe("POWERED_RESEARCH_AB_ONLY");
        expect(assessment.promotionEvidenceComplete).toBe(false);
        expect(assessment.promotionCompletenessReasons).toHaveLength(3);
        expect(assessment.releaseEligibleOnResearchMetrics).toBe(false);
        expect(assessment.releaseInstruction).toBe("RESEARCH_ONLY_NO_BAKE");
    });

    it("rejects missing games, wrong seeds, and missing rejection accounting", () => {
        const cell = cloneProtocol().cells[0];
        const valid = observations(cell, [1, 0, 1, 0]);
        expect(() => analyzeWaitV2Cell(cell, valid.slice(1), valid, 4)).toThrow("3/4 games");

        const wrongSeed = observations(cell, [1, 0, 1, 0]);
        wrongSeed[2].seed += 1;
        expect(() => analyzeWaitV2Cell(cell, valid, wrongSeed, 4)).toThrow("seed");

        const missing = observations(cell, [1, 0, 1, 0], { missingRejections: true });
        expect(() => analyzeWaitV2Cell(cell, valid, missing, 4)).toThrow("missing engine rejection counts");
    });

    it("fails the matched draw-or-Armageddon gate when V2 increases attrition", () => {
        const protocol = cloneProtocol();
        const analyses = protocol.cells.map((cell) =>
            analyzeWaitV2Cell(
                cell,
                observations(cell, [1, 0, 1, 0]),
                observations(cell, [1, 1, 1, 1], { armageddon: true }),
                4,
            ),
        );
        const assessment = assessWaitV2Run(protocol, analyses, 4, cleanMain, true);
        const attrition = assessment.gates.find((gate) => gate.name === "pooled-draw-or-armageddon-non-regression")!;
        expect(attrition.passed).toBe(false);
        expect(assessment.releaseEligibleOnResearchMetrics).toBe(false);
    });
});
