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

import { describe, expect, test } from "bun:test";

import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { runTournamentConcurrent } from "../../src/simulation/concurrent_tournament";
import { SearchDriver } from "../../src/simulation/search_driver";
import {
    playGame,
    TOURNAMENT_RESEARCH_ENTRANT_A_SEARCH_TEAM_SCOPE_POLICY_ID,
    TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
    TOURNAMENT_RESEARCH_A19_H64_F184_LEFT_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED,
    type IGameRecord,
    type ITournamentOptions,
} from "../../src/simulation/tournament";

const BOAR_ROSTER_SEED = 857_604_396;
const baseOptions = (): ITournamentOptions => ({
    versionA: "v0.8",
    versionB: "v0.8",
    games: 2,
    baseSeed: BOAR_ROSTER_SEED,
    maxLaps: 1,
});

const cellFor = (record: IGameRecord, side: "green" | "red", creatureName: string) =>
    record.result.placements[side].find((placement) => placement.creatureName === creatureName)?.cell;

describe("tournament entrant-A research strategy profile", () => {
    test("keeps the omitted selector byte-identical to an explicit undefined selector", () => {
        const options = baseOptions();
        const omitted = playGame(options, 0);
        const explicitUndefined = playGame({ ...options, researchEntrantAStrategyProfile: undefined }, 0);

        expect(explicitUndefined).toEqual(omitted);
    });

    test("survives worker structured cloning and follows entrant A across the mirrored side swap", async () => {
        const options: ITournamentOptions = {
            ...baseOptions(),
            researchEntrantAStrategyProfile: TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
        };
        expect(structuredClone(options)).toEqual(options);

        const records: IGameRecord[] = [];
        const summary = await runTournamentConcurrent(options, 2, (record) => records.push(record));
        records.sort((left, right) => left.game - right.game);

        expect(records.map((record) => record.greenEntrant)).toEqual(["a", "b"]);
        expect(summary.entrantAResearchProfile).toEqual(records[0].entrantAResearchProfile);
        expect(records[0].entrantAResearchProfile).toMatchObject({
            selector: TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
            schema: "hoc.v0_8_a19_h64_paired_safe_compact_terminal_flank_research_profile.v6",
            candidateId: "a19-h64-paired-safe-compact-sole-abom-boar-flank-v6-research",
            searchTeamScopePolicyId: TOURNAMENT_RESEARCH_ENTRANT_A_SEARCH_TEAM_SCOPE_POLICY_ID,
        });
        expect(records[1].entrantAResearchProfile).toEqual(records[0].entrantAResearchProfile);
        expect(records[0].entrantAResearchProfile?.runtimeSourceLedger?.map(({ role }) => role)).toEqual([
            "search-driver",
            "armageddon-endgame",
            "boar-battle-mage-flank-placement",
            "compact-placement",
            "tournament-entrant-a-router",
            "battle-engine-search-team-scope",
        ]);

        // Game 0: entrant A owns GREEN and receives the scoped compact placement; B remains native v0.8.
        // Entrant A's compact cells are unchanged by the 2026-08-25 mounted-class 2x1 catalog change; the
        // NATIVE seat's layout re-packs around the wider bodies (and the size-2 stat feeds the seeded
        // draw), so only B's cells were re-pinned. Two isolated runs reproduced all four.
        expect(cellFor(records[0], "green", "Arbalester")).toEqual({ x: 1, y: 1 });
        expect(cellFor(records[0], "red", "Arbalester")).toEqual({ x: 8, y: 14 });

        // Game 1: the same fresh composite follows entrant A to RED; GREEN is now the unchanged B entrant.
        expect(cellFor(records[1], "green", "Arbalester")).toEqual({ x: 8, y: 2 });
        expect(cellFor(records[1], "red", "Arbalester")).toEqual({ x: 1, y: 14 });
    });

    test("keeps research search on entrant A when both entrants share the v0.8 version label", () => {
        const originalChooseDecision = SearchDriver.prototype.chooseDecision;
        const searchedTeams: number[] = [];
        SearchDriver.prototype.chooseDecision = function (unit, _version, incumbent) {
            searchedTeams.push(unit.getTeam());
            return incumbent;
        };

        try {
            const options: ITournamentOptions = {
                ...baseOptions(),
                researchEntrantAStrategyProfile: TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
            };
            playGame(options, 0);
            expect(searchedTeams.length).toBeGreaterThan(0);
            expect(new Set(searchedTeams)).toEqual(new Set([PBTypes.TeamVals.LEFT]));

            searchedTeams.length = 0;
            playGame(options, 1);
            expect(searchedTeams.length).toBeGreaterThan(0);
            expect(new Set(searchedTeams)).toEqual(new Set([PBTypes.TeamVals.RIGHT]));
        } finally {
            SearchDriver.prototype.chooseDecision = originalChooseDecision;
        }
    });

    test("rejects a v0.8 research selector when entrant A is labeled as another version", () => {
        expect(() =>
            playGame(
                {
                    ...baseOptions(),
                    versionA: "v0.1",
                    researchEntrantAStrategyProfile: TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
                },
                0,
            ),
        ).toThrow("requires entrant A version v0.8");
    });

    test("rejects a native-v0.8 control when entrant B is labeled as another version", () => {
        expect(() =>
            playGame(
                {
                    ...baseOptions(),
                    versionB: "v0.1",
                    researchEntrantAStrategyProfile: TOURNAMENT_RESEARCH_A19_H64_FINALIST_V6,
                },
                0,
            ),
        ).toThrow("requires entrant B version v0.8");
    });

    test("reports the exact historical v5 qualification hashes", () => {
        const record = playGame(
            {
                ...baseOptions(),
                researchEntrantAStrategyProfile:
                    TOURNAMENT_RESEARCH_A19_H64_F184_LEFT_HUMAN_RANKED_FALLBACK_SCORE_SAFE_COMPACT_VALIDATED,
            },
            0,
        );
        expect(record.entrantAResearchProfile).toMatchObject({
            placementImplementationSha256: "b75fef5f755154f6e645126206cedb37cee849741ebb453c8e250db2999e2be0",
            searchImplementationSha256: "00b1fe13e651ce82b309754993c5dcae4038ad7558092a5edd0fb47a63e85e16",
        });
    });
});
