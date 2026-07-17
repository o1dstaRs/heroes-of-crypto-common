import { afterEach, describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { runMatch, type IPlacementRecord } from "../../src/simulation/battle_engine";
import { FLYER_MIRROR_ROSTER, mirrorRoster } from "../../src/simulation/measure_reveal_placement";

const savedGate = process.env.V07_PLACEMENT_REVEAL;
afterEach(() => {
    if (savedGate === undefined) delete process.env.V07_PLACEMENT_REVEAL;
    else process.env.V07_PLACEMENT_REVEAL = savedGate;
});

const greenPlacement = (policy: "baseline" | "legitimate-reveal", env: "on" | "off"): IPlacementRecord[] => {
    process.env.V07_PLACEMENT_REVEAL = env;
    const roster = mirrorRoster(FLYER_MIRROR_ROSTER);
    return runMatch({
        greenVersion: "v0.7",
        redVersion: "v0.7",
        roster,
        redRoster: roster.map((unit) => ({ ...unit })),
        seed: 82015710,
        gridType: PBTypes.GridVals.NORMAL,
        maxLaps: 1,
        greenRevealedCreatures: [PBTypes.CreatureVals.GRIFFIN, PBTypes.CreatureVals.BLACK_DRAGON],
        redRevealedCreatures: [],
        greenSetupPlacementPolicy: policy,
        redSetupPlacementPolicy: "baseline",
        placementAugmentTiming: "setup-before-placement",
    }).placements.green;
};

describe("battle-engine setup placement policy propagation", () => {
    test("explicit baseline beats env-on and explicit legitimate-reveal beats env-off", () => {
        const baselineEnvOff = greenPlacement("baseline", "off");
        const baselineEnvOn = greenPlacement("baseline", "on");
        const revealEnvOff = greenPlacement("legitimate-reveal", "off");

        expect(baselineEnvOn).toEqual(baselineEnvOff);
        expect(revealEnvOff).not.toEqual(baselineEnvOff);
    });
});
