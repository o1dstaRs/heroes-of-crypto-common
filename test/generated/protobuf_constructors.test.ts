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

import { PBTypes as ConfirmCodePB } from "../../src/generated/protobuf/v1/confirm_code";
import { PBTypes as GamePublicPB } from "../../src/generated/protobuf/v1/game_public";
import { PBTypes as LobbyPB } from "../../src/generated/protobuf/v1/lobby";
import { PBTypes as NewPlayerPB } from "../../src/generated/protobuf/v1/new_player";
import { PBTypes as PickPhasePB } from "../../src/generated/protobuf/v1/pick_phase_requests";
import { PBTypes as PortalPB } from "../../src/generated/protobuf/v1/player_portal";
import { PBTypes as RequestCodePB } from "../../src/generated/protobuf/v1/request_code";
import { PBTypes as ResetPasswordPB } from "../../src/generated/protobuf/v1/reset_password";
import { PBTypes as ResponseEnqueuePB } from "../../src/generated/protobuf/v1/response_enqueue";
import { PBTypes as TypesPB } from "../../src/generated/protobuf/v1/types";

// Constructing each message via `new X({...})` (rather than fromObject) exercises the constructor's
// per-field assignment branches that fromObject skips — the last uncovered lines in the generated code.
function roundTrip<T extends { serializeBinary(): Uint8Array; toObject(): unknown }>(
    msg: T,
    deserialize: (bytes: Uint8Array) => T,
): void {
    expect(deserialize(msg.serializeBinary()).toObject()).toEqual(msg.toObject());
}

describe("generated message constructors (new X({...}))", () => {
    it("constructs account/queue messages directly", () => {
        roundTrip(new RequestCodePB.RequestCode({ email: "a@b.c" }), RequestCodePB.RequestCode.deserializeBinary);
        roundTrip(
            new ConfirmCodePB.ConfirmCode({ email: "a@b.c", code: "999" }),
            ConfirmCodePB.ConfirmCode.deserializeBinary,
        );
        roundTrip(
            new NewPlayerPB.NewPlayer({ username: "u", email: "a@b.c", password: "p" }),
            NewPlayerPB.NewPlayer.deserializeBinary,
        );
        roundTrip(
            new ResetPasswordPB.ResetPassword({ email: "a@b.c", password: "p", token: new Uint8Array([1, 2]) }),
            ResetPasswordPB.ResetPassword.deserializeBinary,
        );
        roundTrip(
            new ResponseEnqueuePB.ResponseEnqueue({ match_making_queue_added_time: 7 }),
            ResponseEnqueuePB.ResponseEnqueue.deserializeBinary,
        );
    });

    it("constructs game_public + pick-phase request messages directly", () => {
        roundTrip(
            new GamePublicPB.GamePublic({
                id: "g",
                confirmed: true,
                init_time: 5,
                abandoned: true,
                team: TypesPB.TeamVals.LOWER,
            }),
            GamePublicPB.GamePublic.deserializeBinary,
        );
        roundTrip(new PickPhasePB.PickPairRequest({ pair_index: 1 }), PickPhasePB.PickPairRequest.deserializeBinary);
        roundTrip(
            new PickPhasePB.PickBanRequest({ creature: TypesPB.CreatureVals.BERSERKER }),
            PickPhasePB.PickBanRequest.deserializeBinary,
        );
        roundTrip(
            new PickPhasePB.ArtifactRequest({ artifact: 3, level: 2 }),
            PickPhasePB.ArtifactRequest.deserializeBinary,
        );
        roundTrip(new PickPhasePB.RevealRequest({ creature_index: 4 }), PickPhasePB.RevealRequest.deserializeBinary);
    });

    it("constructs lobby messages directly", () => {
        const player = { player_id: "p", username: "n", avatar: "a", rating: 1, league: "L", ready: true };
        roundTrip(new LobbyPB.LobbyPlayer(player), LobbyPB.LobbyPlayer.deserializeBinary);
        roundTrip(
            new LobbyPB.Lobby({
                id: "l",
                name: "n",
                is_private: true,
                status: LobbyPB.LobbyStatus.LOBBY_FULL,
                host: new LobbyPB.LobbyPlayer(player),
                guest: new LobbyPB.LobbyPlayer({ ...player, player_id: "p2" }),
                created_time: 1,
                start_at_ms: 2,
                game_id: "g",
            }),
            LobbyPB.Lobby.deserializeBinary,
        );
        roundTrip(
            new LobbyPB.LobbyList({ lobbies: [new LobbyPB.Lobby({ id: "l", name: "n", is_private: false })] }),
            LobbyPB.LobbyList.deserializeBinary,
        );
        roundTrip(
            new LobbyPB.CreateLobbyRequest({ name: "n", is_private: true, pin: "1234" }),
            LobbyPB.CreateLobbyRequest.deserializeBinary,
        );
        roundTrip(new LobbyPB.JoinLobbyRequest({ pin: "1" }), LobbyPB.JoinLobbyRequest.deserializeBinary);
        roundTrip(new LobbyPB.ReadyRequest({ ready: true }), LobbyPB.ReadyRequest.deserializeBinary);
    });

    it("constructs player_portal messages directly", () => {
        const playerSetup = new PortalPB.PortalMatchSetup({
            artifact_tier_1: 3,
            artifact_tier_2: 11,
            perk: 2,
            augment_placement: 1,
            augment_armor: 3,
            augment_might: 2,
            augment_sniper: 1,
            augment_movement: 0,
            synergies: ["Life:1:2", "Might:2:1"],
            complete: true,
        });
        const opponentSetup = new PortalPB.PortalMatchSetup({
            artifact_tier_1: 12,
            artifact_tier_2: 5,
            perk: 3,
            augment_placement: 0,
            augment_armor: 2,
            augment_might: 3,
            augment_sniper: 0,
            augment_movement: 1,
            synergies: ["Chaos:2:1"],
            complete: true,
        });
        const match = {
            game_id: "g",
            won: false,
            abandoned: true,
            finished_time: 1,
            opponent_username: "o",
            team: TypesPB.TeamVals.UPPER,
            creature_ids: [1, 2],
            opponent_creature_ids: [3],
            duration_ms: 150000,
            total_laps: 9,
            player_damage: 2100,
            opponent_damage: 1900,
            replay_available: true,
            player_top_units: [new PortalPB.PortalUnitPerformance({ creature_id: 1, damage_dealt: 1400 })],
            opponent_top_units: [new PortalPB.PortalUnitPerformance({ creature_id: 3, damage_dealt: 1200 })],
            draw: false,
            player_abandoned: true,
            player_setup: playerSetup,
            opponent_setup: opponentSetup,
        };
        roundTrip(
            new PortalPB.PortalUnitPerformance({ creature_id: 1, damage_dealt: 1400 }),
            PortalPB.PortalUnitPerformance.deserializeBinary,
        );
        roundTrip(playerSetup, PortalPB.PortalMatchSetup.deserializeBinary);
        roundTrip(new PortalPB.PortalMatch(match), PortalPB.PortalMatch.deserializeBinary);
        roundTrip(
            new PortalPB.PortalComboStat({ creature_ids: [1, 2], games: 3, wins: 2 }),
            PortalPB.PortalComboStat.deserializeBinary,
        );
        roundTrip(
            new PortalPB.PortalCreatureStat({ creature_id: 1, games: 3, wins: 2 }),
            PortalPB.PortalCreatureStat.deserializeBinary,
        );
        roundTrip(
            new PortalPB.PortalFactionStat({ faction: TypesPB.FactionVals.NATURE, games: 3, wins: 2 }),
            PortalPB.PortalFactionStat.deserializeBinary,
        );
        roundTrip(
            new PortalPB.ResponsePlayerPortal({
                username: "u",
                wins: 1,
                losses: 1,
                total_games_played: 2,
                current_streak: 1,
                best_win_streak: 1,
                last_login: 9,
                recent_matches: [new PortalPB.PortalMatch(match)],
                combos: [new PortalPB.PortalComboStat({ creature_ids: [1], games: 1, wins: 1 })],
                creature_stats: [new PortalPB.PortalCreatureStat({ creature_id: 1, games: 1, wins: 1 })],
                faction_stats: [new PortalPB.PortalFactionStat({ faction: 1, games: 1, wins: 1 })],
            }),
            PortalPB.ResponsePlayerPortal.deserializeBinary,
        );
    });
});
