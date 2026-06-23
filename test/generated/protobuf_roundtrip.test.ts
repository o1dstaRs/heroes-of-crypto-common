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
import { PBTypes as FightPB } from "../../src/generated/protobuf/v1/fight";
import { PBTypes as GamePublicPB } from "../../src/generated/protobuf/v1/game_public";
import { PBTypes as NewPlayerPB } from "../../src/generated/protobuf/v1/new_player";
import { PBTypes as PickPhasePB } from "../../src/generated/protobuf/v1/pick_phase_requests";
import { PBTypes as RequestCodePB } from "../../src/generated/protobuf/v1/request_code";
import { PBTypes as ResetPasswordPB } from "../../src/generated/protobuf/v1/reset_password";
import { PBTypes as ResponseEnqueuePB } from "../../src/generated/protobuf/v1/response_enqueue";
import { PBTypes as ResponseMePB } from "../../src/generated/protobuf/v1/response_me";
import { PBTypes as TypesPB } from "../../src/generated/protobuf/v1/types";
import { PBTypes as UnitPB } from "../../src/generated/protobuf/v1/unit";

describe("generated protobuf messages", () => {
    it("round-trips account and queue messages", () => {
        const requestCode = RequestCodePB.RequestCode.fromObject({ email: "player@example.com" });
        expect(RequestCodePB.RequestCode.deserializeBinary(requestCode.serializeBinary()).toObject()).toEqual({
            email: "player@example.com",
        });

        const confirmCode = ConfirmCodePB.ConfirmCode.fromObject({ email: "player@example.com", code: "123456" });
        expect(ConfirmCodePB.ConfirmCode.deserializeBinary(confirmCode.serializeBinary()).toObject()).toEqual({
            email: "player@example.com",
            code: "123456",
        });

        const newPlayer = NewPlayerPB.NewPlayer.fromObject({
            username: "player",
            email: "player@example.com",
            password: "secret",
        });
        expect(NewPlayerPB.NewPlayer.deserializeBinary(newPlayer.serializeBinary()).toObject()).toEqual({
            username: "player",
            email: "player@example.com",
            password: "secret",
        });

        const resetPassword = ResetPasswordPB.ResetPassword.fromObject({
            email: "player@example.com",
            password: "new-secret",
            token: new Uint8Array([1, 2, 3]),
        });
        expect(ResetPasswordPB.ResetPassword.deserializeBinary(resetPassword.serializeBinary()).toObject()).toEqual({
            email: "player@example.com",
            password: "new-secret",
            token: new Uint8Array([1, 2, 3]),
        });

        const enqueue = ResponseEnqueuePB.ResponseEnqueue.fromObject({ match_making_queue_added_time: 123 });
        expect(ResponseEnqueuePB.ResponseEnqueue.deserializeBinary(enqueue.serializeBinary()).toObject()).toEqual({
            match_making_queue_added_time: 123,
        });
    });

    it("round-trips public game and profile messages", () => {
        const game = GamePublicPB.GamePublic.fromObject({
            id: "game-id",
            confirmed: true,
            init_time: 100,
            abandoned: true,
            team: TypesPB.TeamVals.UPPER,
        });
        expect(GamePublicPB.GamePublic.deserializeBinary(game.serializeBinary()).toObject()).toEqual({
            id: "game-id",
            confirmed: true,
            init_time: 100,
            abandoned: true,
            team: TypesPB.TeamVals.UPPER,
        });

        const responseMe = ResponseMePB.ResponseMe.fromObject({
            username: "player",
            email: "player@example.com",
            wins: 7,
            losses: 3,
            total_games_played: 10,
            is_active: true,
            match_making_queue_added_time: 100,
            match_making_cooldown_till: 200,
            in_game_id: "game-id",
        });
        expect(ResponseMePB.ResponseMe.deserializeBinary(responseMe.serializeBinary()).toObject()).toEqual({
            username: "player",
            email: "player@example.com",
            wins: 7,
            losses: 3,
            total_games_played: 10,
            is_active: true,
            match_making_queue_added_time: 100,
            match_making_cooldown_till: 200,
            in_game_id: "game-id",
        });
    });

    it("round-trips pick phase request messages", () => {
        const pickPair = PickPhasePB.PickPairRequest.fromObject({ pair_index: 2 });
        const pickBan = PickPhasePB.PickBanRequest.fromObject({ creature: TypesPB.CreatureVals.BERSERKER });
        const artifact = PickPhasePB.ArtifactRequest.fromObject({ artifact: 4, level: 2 });
        const reveal = PickPhasePB.RevealRequest.fromObject({ creature_index: 5 });

        expect(PickPhasePB.PickPairRequest.deserializeBinary(pickPair.serializeBinary()).toObject()).toEqual({
            pair_index: 2,
        });
        expect(PickPhasePB.PickBanRequest.deserializeBinary(pickBan.serializeBinary()).toObject()).toEqual({
            creature: TypesPB.CreatureVals.BERSERKER,
        });
        expect(PickPhasePB.ArtifactRequest.deserializeBinary(artifact.serializeBinary()).toObject()).toEqual({
            artifact: 4,
            level: 2,
        });
        expect(PickPhasePB.RevealRequest.deserializeBinary(reveal.serializeBinary()).toObject()).toEqual({
            creature_index: 5,
        });
    });

    it("round-trips string lists, unit data, and fight state messages", () => {
        const stringList = TypesPB.StringList.fromObject({ values: ["a", "b"] });
        expect(TypesPB.StringList.deserializeBinary(stringList.serializeBinary()).toObject()).toEqual({
            values: ["a", "b"],
        });

        const unit = UnitPB.UnitData.fromObject({
            id: new Uint8Array([9, 8, 7]),
            faction: TypesPB.FactionVals.MIGHT,
            name: "Berserker",
            team: TypesPB.TeamVals.UPPER,
            max_hp: 10,
            hp: 9,
            steps: 3,
            steps_mod: 1,
            morale: 2,
            luck: 1,
            speed: 5,
            armor_mod: 1,
            base_armor: 4,
            attack_type: TypesPB.AttackVals.MELEE,
            attack_type_selected: TypesPB.AttackVals.MELEE,
            attack: 6,
            attack_damage_min: 2,
            attack_damage_max: 4,
            attack_range: 1,
            range_shots: 0,
            range_shots_mod: 0,
            shot_distance: 1,
            magic_resist: 3,
            magic_resist_mod: 1,
            can_cast_spells: true,
            can_fly: true,
            exp: 11,
            size: TypesPB.UnitSizeVals.SMALL,
            level: TypesPB.UnitLevelVals.FIRST,
            spells: ["Heal"],
            abilities: ["Stun"],
            effects: ["Break"],
            amount_alive: 2,
            amount_died: 1,
            luck_mod: 1,
            attack_multiplier: 1.25,
        });
        expect(UnitPB.UnitData.deserializeBinary(unit.serializeBinary()).toObject()).toEqual(unit.toObject());

        const fight = FightPB.Fight.fromObject({
            id: new Uint8Array([1, 2, 3, 4]),
            current_lap: 2,
            grid_type: TypesPB.GridVals.NORMAL,
            first_turn_made: true,
            fight_started: true,
            fight_finished: true,
            previous_turn_team: TypesPB.TeamVals.UPPER,
            highest_speed_this_turn: 6,
            already_made_turn: ["u1"],
            already_made_turn_by_team: { [TypesPB.TeamVals.UPPER]: { values: ["u1"] } },
            already_hourglass: ["u2"],
            already_replied_attack: ["u3"],
            team_units_alive: { [TypesPB.TeamVals.UPPER]: 2 },
            hourglass_queue: ["u4"],
            morale_plus_queue: ["u5"],
            morale_minus_queue: ["u6"],
            current_turn_start: 100,
            current_turn_end: 200,
            current_lap_total_time_per_team: { [TypesPB.TeamVals.UPPER]: 50 },
            up_next: ["u7"],
            steps_morale_multiplier: 1.5,
            has_additional_time_requested_per_team: { [TypesPB.TeamVals.UPPER]: true },
        });
        expect(FightPB.Fight.deserializeBinary(fight.serializeBinary()).toObject()).toEqual(fight.toObject());
    });

    it("constructs generated messages directly with object data", () => {
        const responseMe = new ResponseMePB.ResponseMe({
            username: "direct-player",
            email: "direct@example.com",
            wins: 11,
            losses: 4,
            total_games_played: 15,
            is_active: true,
            match_making_queue_added_time: 321,
            match_making_cooldown_till: 654,
            in_game_id: "direct-game",
        });
        expect(ResponseMePB.ResponseMe.deserializeBinary(responseMe.serializeBinary()).toObject()).toEqual(
            responseMe.toObject(),
        );

        const unit = new UnitPB.UnitData({
            id: new Uint8Array([1, 3, 5]),
            faction: TypesPB.FactionVals.NATURE,
            name: "Direct Unit",
            team: TypesPB.TeamVals.LOWER,
            max_hp: 40,
            hp: 35,
            steps: 6,
            steps_mod: 2,
            morale: 3,
            luck: 2,
            speed: 8,
            armor_mod: 1.5,
            base_armor: 7,
            attack_type: TypesPB.AttackVals.RANGE,
            attack_type_selected: TypesPB.AttackVals.RANGE,
            attack: 12,
            attack_damage_min: 4,
            attack_damage_max: 9,
            attack_range: 2,
            range_shots: 5,
            range_shots_mod: 2,
            shot_distance: 3.5,
            magic_resist: 15,
            magic_resist_mod: 4,
            can_cast_spells: true,
            can_fly: true,
            exp: 200,
            size: TypesPB.UnitSizeVals.LARGE,
            level: TypesPB.UnitLevelVals.THIRD,
            spells: ["Wind Flow", "Heal"],
            abilities: ["Area Throw"],
            effects: ["Regeneration"],
            amount_alive: 6,
            amount_died: 2,
            luck_mod: 1,
            attack_multiplier: 1.5,
        });
        expect(UnitPB.UnitData.deserializeBinary(unit.serializeBinary()).toObject()).toEqual(unit.toObject());
    });
});
