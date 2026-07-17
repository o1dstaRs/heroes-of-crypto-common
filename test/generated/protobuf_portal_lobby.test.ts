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

import { PBTypes as LobbyPB } from "../../src/generated/protobuf/v1/lobby";
import { PBTypes as PortalPB } from "../../src/generated/protobuf/v1/player_portal";
import { PBTypes as TypesPB } from "../../src/generated/protobuf/v1/types";

/** Serialize → deserialize → toObject equals the original toObject (covers every field accessor). */
function roundTrip<T extends { serializeBinary(): Uint8Array; toObject(): unknown }>(
    msg: T,
    deserialize: (bytes: Uint8Array) => T,
): void {
    expect(deserialize(msg.serializeBinary()).toObject()).toEqual(msg.toObject());
}

const playerTopUnit = { creature_id: 2, damage_dealt: 4200 };
const opponentTopUnit = { creature_id: 5, damage_dealt: 3700 };
const portalMatch = {
    game_id: "game-1",
    won: true,
    abandoned: false,
    finished_time: 1700,
    opponent_username: "rival",
    team: TypesPB.TeamVals.UPPER,
    creature_ids: [1, 2, 3],
    opponent_creature_ids: [4, 5],
    duration_ms: 725000,
    total_laps: 18,
    player_damage: 9200,
    opponent_damage: 8100,
    replay_available: true,
    player_top_units: [playerTopUnit],
    opponent_top_units: [opponentTopUnit],
    draw: false,
    player_abandoned: false,
};
const portalCombo = { creature_ids: [7, 8], games: 12, wins: 9 };
const portalCreature = { creature_id: 5, games: 20, wins: 14 };
const portalFaction = { faction: TypesPB.FactionVals.MIGHT, games: 30, wins: 21 };

const lobbyPlayer = {
    player_id: "p-1",
    username: "host",
    avatar: "avatar.png",
    rating: 1500,
    league: "Gold",
    ready: true,
};

describe("generated player_portal protobuf messages", () => {
    it("round-trips each portal sub-message directly", () => {
        roundTrip(
            PortalPB.PortalUnitPerformance.fromObject(playerTopUnit),
            PortalPB.PortalUnitPerformance.deserializeBinary,
        );
        roundTrip(PortalPB.PortalMatch.fromObject(portalMatch), PortalPB.PortalMatch.deserializeBinary);
        roundTrip(
            PortalPB.PortalMatch.fromObject({ ...portalMatch, game_id: "game-draw", won: false, draw: true }),
            PortalPB.PortalMatch.deserializeBinary,
        );
        roundTrip(PortalPB.PortalComboStat.fromObject(portalCombo), PortalPB.PortalComboStat.deserializeBinary);
        roundTrip(
            PortalPB.PortalCreatureStat.fromObject(portalCreature),
            PortalPB.PortalCreatureStat.deserializeBinary,
        );
        roundTrip(PortalPB.PortalFactionStat.fromObject(portalFaction), PortalPB.PortalFactionStat.deserializeBinary);
    });

    it("round-trips a fully-populated ResponsePlayerPortal", () => {
        const portal = PortalPB.ResponsePlayerPortal.fromObject({
            username: "player",
            wins: 42,
            losses: 18,
            total_games_played: 60,
            current_streak: 4,
            best_win_streak: 11,
            last_login: 1700000,
            recent_matches: [
                portalMatch,
                {
                    ...portalMatch,
                    game_id: "game-2",
                    won: false,
                    abandoned: true,
                    player_abandoned: true,
                },
            ],
            combos: [portalCombo],
            creature_stats: [portalCreature],
            faction_stats: [portalFaction],
        });
        roundTrip(portal, PortalPB.ResponsePlayerPortal.deserializeBinary);
        expect(portal.recent_matches.length).toBe(2);
        expect(portal.creature_stats[0].wins).toBe(14);
    });

    it("constructs ResponsePlayerPortal directly and round-trips", () => {
        const portal = new PortalPB.ResponsePlayerPortal({
            username: "direct",
            wins: 1,
            losses: 0,
            total_games_played: 1,
            current_streak: 1,
            best_win_streak: 1,
            last_login: 5,
            recent_matches: [],
            combos: [],
            creature_stats: [],
            faction_stats: [],
        });
        roundTrip(portal, PortalPB.ResponsePlayerPortal.deserializeBinary);
    });
});

describe("generated lobby protobuf messages", () => {
    it("round-trips LobbyPlayer and the request messages", () => {
        roundTrip(LobbyPB.LobbyPlayer.fromObject(lobbyPlayer), LobbyPB.LobbyPlayer.deserializeBinary);
        roundTrip(
            LobbyPB.CreateLobbyRequest.fromObject({ name: "My Lobby", is_private: true, pin: "1234" }),
            LobbyPB.CreateLobbyRequest.deserializeBinary,
        );
        roundTrip(LobbyPB.JoinLobbyRequest.fromObject({ pin: "4321" }), LobbyPB.JoinLobbyRequest.deserializeBinary);
        roundTrip(LobbyPB.ReadyRequest.fromObject({ ready: true }), LobbyPB.ReadyRequest.deserializeBinary);
    });

    it("round-trips a fully-populated Lobby and LobbyList", () => {
        const lobby = LobbyPB.Lobby.fromObject({
            id: "lobby-1",
            name: "Battle Room",
            is_private: true,
            status: LobbyPB.LobbyStatus.LOBBY_STARTING,
            host: lobbyPlayer,
            guest: { ...lobbyPlayer, player_id: "p-2", username: "guest", ready: false },
            created_time: 1000,
            start_at_ms: 6000,
            game_id: "game-9",
        });
        roundTrip(lobby, LobbyPB.Lobby.deserializeBinary);
        expect(lobby.has_host).toBe(true);
        expect(lobby.has_guest).toBe(true);
        expect(lobby.status).toBe(LobbyPB.LobbyStatus.LOBBY_STARTING);

        const list = LobbyPB.LobbyList.fromObject({
            lobbies: [
                lobby.toObject(),
                {
                    id: "lobby-2",
                    name: "Open Room",
                    is_private: false,
                    status: LobbyPB.LobbyStatus.LOBBY_OPEN,
                    host: lobbyPlayer,
                    created_time: 2000,
                    start_at_ms: 0,
                    game_id: "",
                },
            ],
        });
        roundTrip(list, LobbyPB.LobbyList.deserializeBinary);
        expect(list.lobbies.length).toBe(2);
    });

    it("an OPEN lobby with no guest reports has_guest=false", () => {
        const lobby = LobbyPB.Lobby.fromObject({
            id: "solo",
            name: "Waiting",
            is_private: false,
            status: LobbyPB.LobbyStatus.LOBBY_OPEN,
            host: lobbyPlayer,
            created_time: 1,
            start_at_ms: 0,
            game_id: "",
        });
        expect(lobby.has_guest).toBe(false);
        roundTrip(lobby, LobbyPB.Lobby.deserializeBinary);
    });
});
