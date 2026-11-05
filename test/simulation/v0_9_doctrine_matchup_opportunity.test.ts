import { describe, expect, test } from "bun:test";
import { Doctrine } from "../../src/doctrines/doctrine_properties";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { LIVE_PICK_PHASES, type PickTeam } from "../../src/picks/pick_sim";
import {
    DOCTRINE_MATCHUP_ADVANTAGE_FEATURES,
    doctrineMatchupAdvantageFeatures,
    type IDoctrineMatchupObservation,
} from "../../src/simulation/v0_9/doctrine_matchup_advantage";
import {
    DOCTRINE_MATCHUP_OPPORTUNITY_FEATURES,
    doctrineMatchupOpportunityFeatures,
    pendingOpponentDraftLevels,
} from "../../src/simulation/v0_9/doctrine_matchup_opportunity";

const c = PBTypes.CreatureVals,
    team = PBTypes.TeamVals;
const observation: IDoctrineMatchupObservation = {
    level: 2,
    doctrine: Doctrine.THREE_REVEALS,
    synergyVariants: { Chaos: 1, Life: 2, Nature: 1, Might: 2 },
    context: {
        ownCreatureIds: [c.PEASANT, c.CENTAUR, c.NOMAD],
        knownOpponentCreatureIds: [c.ORC, c.DRYAD, c.VALKYRIE],
        artifactFitVersion: 6,
        scouting: { bannedCreatureIds: [], knownBanLevels: [1, 2, 3, 4], remainingPickLevels: [2, 3, 4] },
    },
};
const phase = (level: number, actingTeam: PickTeam) => ({
    actingTeam,
    phaseSequence: LIVE_PICK_PHASES.findIndex(
        (entry) =>
            entry.phase === PBTypes.PickPhaseVals.PICK &&
            entry.creatureLevel === level &&
            entry.actors[0] === actingTeam,
    ),
});
const medusa = { creatureIds: [c.MEDUSA] },
    elf = { creatureIds: [c.ELF] };
const features = (actingTeam = team.RIGHT, o = observation) =>
    doctrineMatchupOpportunityFeatures(o, medusa, elf, phase(2, actingTeam));
const values = (vector: number[]) =>
    Object.fromEntries(DOCTRINE_MATCHUP_OPPORTUNITY_FEATURES.map((name, i) => [name, vector[i]]));

describe("public draft-turn opportunity research", () => {
    test("the future same-level opportunity follows the snake draft, not physical side", () => {
        expect(pendingOpponentDraftLevels(phase(1, team.LEFT))).toContain(1);
        expect(pendingOpponentDraftLevels(phase(1, team.RIGHT))).not.toContain(1);
        expect(pendingOpponentDraftLevels(phase(2, team.RIGHT))).toContain(2);
        expect(pendingOpponentDraftLevels(phase(2, team.LEFT))).not.toContain(2);
        expect(pendingOpponentDraftLevels(phase(3, team.LEFT))).toContain(3);
        expect(pendingOpponentDraftLevels(phase(4, team.RIGHT))).toContain(4);
        expect(pendingOpponentDraftLevels(phase(4, team.LEFT))).toEqual([]);
    });

    test("Medusa -> Elf leaves a different opportunity only before the enemy level-2 pick", () => {
        const first = values(features()),
            second = values(features(team.LEFT));
        expect(first[`pending_opponent_denied_unit_${c.MEDUSA}`]).toBe(-1);
        expect(first[`pending_opponent_denied_unit_${c.ELF}`]).toBe(1);
        expect(second[`pending_opponent_denied_unit_${c.MEDUSA}`]).toBe(0);
        expect(second[`pending_opponent_denied_unit_${c.ELF}`]).toBe(0);
        expect(features().slice(0, DOCTRINE_MATCHUP_ADVANTAGE_FEATURES.length)).toEqual(
            doctrineMatchupAdvantageFeatures(observation, medusa, elf),
        );
    });

    test("visible Orc plus a passed Medusa can complete enemy Chaos movement", () => {
        const movement = values(features());
        const otherVariant = values(
            features(team.RIGHT, { ...observation, synergyVariants: { ...observation.synergyVariants, Chaos: 2 } }),
        );
        expect(movement.pending_opponent_visible_chaos_movement).toBeLessThan(0);
        expect(otherVariant.pending_opponent_visible_chaos_movement).toBe(0);
    });

    test("already revealed or banned enemy-owned units cannot be denied again", () => {
        const discovered = {
            ...observation,
            context: {
                ...observation.context,
                knownOpponentCreatureIds: [...observation.context.knownOpponentCreatureIds, c.MEDUSA],
            },
        };
        expect(values(features(team.RIGHT, discovered))[`pending_opponent_denied_unit_${c.MEDUSA}`]).toBe(0);
        const banned = {
            ...observation,
            context: {
                ...observation.context,
                scouting: { ...observation.context.scouting, bannedCreatureIds: [c.MEDUSA] },
            },
        };
        expect(values(features(team.RIGHT, banned))[`pending_opponent_denied_unit_${c.MEDUSA}`]).toBe(0);
    });

    test("empty enemy vision preserves potential availability without fabricating enemy synergy", () => {
        const hidden = {
            ...observation,
            doctrine: Doctrine.SEE_NONE,
            context: { ...observation.context, knownOpponentCreatureIds: [] },
        };
        const x = values(features(team.RIGHT, hidden));
        expect(x[`pending_opponent_denied_unit_${c.MEDUSA}`]).toBe(-1);
        expect(x.pending_opponent_visible_chaos_movement).toBe(0);
        expect(x.pending_opponent_visible_build_fit).toBe(0);
    });

    test("the vector is antisymmetric and public progress is stable through retries", () => {
        const turn = Object.freeze(phase(2, team.RIGHT));
        const a = doctrineMatchupOpportunityFeatures(observation, medusa, elf, turn);
        const b = doctrineMatchupOpportunityFeatures(observation, elf, medusa, turn);
        expect(a.every((v, i) => v === -b[i])).toBe(true);
        expect(doctrineMatchupOpportunityFeatures(observation, medusa, medusa, turn).every((v) => v === 0)).toBe(true);
        expect(pendingOpponentDraftLevels(turn)).toEqual(pendingOpponentDraftLevels(turn));
    });

    test("private opponent artifacts, future replies and physical-side metadata are not read", () => {
        const o = { ...observation, context: { ...observation.context } };
        const turn = { ...phase(2, team.RIGHT) };
        for (const object of [o, o.context, turn])
            for (const key of ["opponentArtifact", "hiddenOpponentCreatureIds", "actualNextReply", "battleSide"])
                Object.defineProperty(object, key, {
                    enumerable: true,
                    get() {
                        throw new Error(`Private read ${key}`);
                    },
                });
        expect(doctrineMatchupOpportunityFeatures(o, medusa, elf, turn)).toEqual(features());
    });

    test("bundle inputs retain the old basis and make no sequential denial claim", () => {
        const o = { ...observation, level: 0, context: { ...observation.context, ownCreatureIds: [] } };
        const a = { creatureIds: [c.ORC, c.TROLL], tier1ArtifactId: 3 };
        const b = { creatureIds: [c.PEASANT, c.ELF], tier1ArtifactId: 6 };
        const x = doctrineMatchupOpportunityFeatures(o, a, b, { phaseSequence: 1, actingTeam: team.RIGHT });
        expect(x.slice(0, DOCTRINE_MATCHUP_ADVANTAGE_FEATURES.length)).toEqual(
            doctrineMatchupAdvantageFeatures(o, a, b),
        );
        expect(x.slice(DOCTRINE_MATCHUP_ADVANTAGE_FEATURES.length).every((v) => v === 0)).toBe(true);
    });

    test("rejects malformed, wrong-actor, wrong-level and non-pick phases", () => {
        for (const turn of [
            { phaseSequence: -1, actingTeam: team.RIGHT },
            { phaseSequence: 4.5, actingTeam: team.RIGHT },
            { phaseSequence: 99, actingTeam: team.RIGHT },
            { phaseSequence: 4, actingTeam: team.LEFT },
            { phaseSequence: 8, actingTeam: team.RIGHT },
        ])
            expect(() => doctrineMatchupOpportunityFeatures(observation, medusa, elf, turn)).toThrow();
        expect(() => doctrineMatchupOpportunityFeatures(observation, medusa, elf, phase(4, team.RIGHT))).toThrow();
    });
});
