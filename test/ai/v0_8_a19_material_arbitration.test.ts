import { describe, expect, it } from "bun:test";

import { buildV08A13SearchEnvironment } from "../../src/ai/versions/v0_8_a13_profile";
import { selectV08A19MaterialCandidateIndex } from "../../src/ai/versions/v0_8_a19_material_arbitration";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import type { GameAction } from "../../src/engine/actions";

const candidates = Array.from({ length: 3 }, (_, index) => ({
    actions: [{ type: "range_attack", attackerId: "shooter", targetId: String(index) }] as GameAction[],
}));

describe("A19 secondary rollout material evidence", () => {
    it("clears the opt-in controls for the a13 rollback", () => {
        const keys = [
            "SEARCH_A19_MATERIAL_ARBITRATION",
            "SEARCH_A19_MATERIAL_LOW_EVIDENCE_WINS",
            "SEARCH_A19_HEALER_OPENING_COHESION",
            "SEARCH_A19_ARTIFACT_BARREL_ATTACK_COVERAGE",
        ];
        const saved = keys.map((key) => process.env[key]);
        try {
            keys.forEach((key) => {
                process.env[key] = "1";
            });
            const environment = buildV08A13SearchEnvironment();
            keys.forEach((key) => expect(environment[key]).toBeUndefined());
        } finally {
            keys.forEach((key, index) => {
                if (saved[index] === undefined) delete process.env[key];
                else process.env[key] = saved[index];
            });
        }
    });

    it("enables the controls only through explicit A19 overrides", () => {
        const key = "V08_A19_SEARCH_ENV_OVERRIDES";
        const saved = process.env[key];
        try {
            delete process.env[key];
            expect(buildV08A19SearchEnvironment().SEARCH_A19_MATERIAL_ARBITRATION).toBeUndefined();
            process.env[key] = JSON.stringify({
                SEARCH_A19_MATERIAL_ARBITRATION: "sample-relative",
                SEARCH_A19_MATERIAL_LOW_EVIDENCE_WINS: "3",
                SEARCH_A19_HEALER_OPENING_COHESION: "1",
            });
            expect(buildV08A19SearchEnvironment()).toMatchObject({
                SEARCH_A19_MATERIAL_ARBITRATION: "sample-relative",
                SEARCH_A19_MATERIAL_LOW_EVIDENCE_WINS: "3",
                SEARCH_A19_HEALER_OPENING_COHESION: "1",
            });
        } finally {
            if (saved === undefined) delete process.env[key];
            else process.env[key] = saved;
        }
    });

    it("prefers surviving material when terminal win forecasts tie", () => {
        expect(selectV08A19MaterialCandidateIndex(candidates, [0.5, 0.5, 0.25], [0.4, 0.8, 0.9], 0, 32, "ties")).toBe(
            1,
        );
    });

    it("keeps a stronger terminal forecast when material alone favors a worse action", () => {
        expect(
            selectV08A19MaterialCandidateIndex(candidates, [0.5, 0.25, 0], [0.1, 0.8, 0.9], 0, 32, "sample-relative"),
        ).toBe(0);
    });

    it("caps forecast loss by both one winning sample and a quarter of the best forecast", () => {
        expect(
            selectV08A19MaterialCandidateIndex(
                candidates,
                [0.0625, 0.03125, 0],
                [0.2, 0.8, 0.9],
                0,
                32,
                "sample-relative",
            ),
        ).toBe(0);
        expect(
            selectV08A19MaterialCandidateIndex(candidates, [0.8, 0.77, 0.7], [0.2, 0.8, 0.9], 0, 32, "sample-relative"),
        ).toBe(1);
    });

    it("widens only explicitly selected low-evidence decisions", () => {
        const means = [2 / 32, 0, -Infinity];
        const materials = [0.2, 0.8, -Infinity];
        expect(selectV08A19MaterialCandidateIndex(candidates, means, materials, 0, 32, "sample-relative")).toBe(0);
        expect(selectV08A19MaterialCandidateIndex(candidates, means, materials, 0, 32, "sample-relative", 3)).toBe(1);
        expect(
            selectV08A19MaterialCandidateIndex(
                candidates,
                [0.15, 0, -Infinity],
                materials,
                0,
                32,
                "sample-relative",
                3,
            ),
        ).toBe(0);
    });

    it("uses material to escape an all-losing forecast without selecting empty or illegal candidates", () => {
        expect(
            selectV08A19MaterialCandidateIndex(candidates, [0, 0, -Infinity], [0.2, 0.8, 1], 0, 32, "loss-edge"),
        ).toBe(1);
        expect(
            selectV08A19MaterialCandidateIndex(
                [candidates[0], { actions: [] }, candidates[2]],
                [0, 0, -Infinity],
                [0.2, 0.9, 1],
                0,
                32,
                "loss-edge",
            ),
        ).toBe(0);
    });

    it("keeps the selected action for incomplete or invalid evidence", () => {
        expect(selectV08A19MaterialCandidateIndex(candidates, [0.5], [0.2], 0, 32, "ties")).toBe(0);
        expect(selectV08A19MaterialCandidateIndex(candidates, [0.5, 0.5, 0.5], [NaN, 0.8, 0.9], 0, 32, "ties")).toBe(0);
        expect(
            selectV08A19MaterialCandidateIndex(
                candidates,
                [0.5, 0.5, 0.5],
                [0.2, 0.8, 0.9],
                0,
                32,
                "sample-relative",
                9,
            ),
        ).toBe(0);
    });
});
