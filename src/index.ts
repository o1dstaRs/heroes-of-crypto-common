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

export * from "./grid/grid";
export * as GridConstants from "./grid/grid_constants";
export * as GridMath from "./grid/grid_math";
export * as Augment from "./augments/augment_properties";
export * as Artifact from "./artifacts/artifact_properties";
export * as Perk from "./perks/perk_properties";
export * from "./abilities/ability";
export * from "./scene/animations";
export * as AbilityHelper from "./abilities/ability_helper";
export * from "./abilities/ability_factory";
export * from "./abilities/ability_properties";
export * from "./abilities/ability_helper";
export * as AllAbilities from "./abilities";
export * as HoCConfig from "./configuration/config_provider";
export * from "./effects/aura_effect";
export * as EffectHelper from "./effects/effect_helper";
export * from "./spells/applied_spell";
export * from "./effects/effect_properties";
export * from "./effects/effect_factory";
export * from "./effects/effect";
export * as SpellHelper from "./spells/spell_helper";
export * from "./spells/spell";
export * as PickHelper from "./picks/pick_helper";
export * as PickSim from "./picks/pick_sim";
export * from "./picks/pick_sim";
export * from "./engine/actions";
export * from "./engine/action_engine";
export * from "./engine/events";
export * from "./engine/runtime";
export * from "./engine/turn_engine";
export * from "./handlers/move_handler";
export * from "./handlers/attack_handler";
export * from "./spells/spell_properties";
export * from "./synergies/synergy_properties";
export * from "./grid/path_definitions";
export * from "./grid/path_helper";
export * from "./grid/square_placement";
export * from "./grid/rectangle_placement";
export * from "./grid/placement_properties";
export * from "./grid/grid_settings";
export * from "./grid/grid_type";
export * from "./obstacles/obstacle_type";
export * from "./units/unit_properties";
export * from "./units/units_holder";
export * from "./units/unit";
export * from "./scene/scene_log_interface";
export * from "./scene/scene_stats";
export * from "./scene/statistic_holder_interface";
export * from "./fights/fight_properties";
export * from "./fights/fight_state_manager";
export * from "./factions/faction_type";
export * as HoCLib from "./utils/lib";
export * as HoCMath from "./utils/math";
export * as AI from "./ai/ai";
export {
    getAIStrategy,
    enumerateCandidates,
    getEnemiesCellsWithinMovementRange,
    AI_VERSIONS,
    LATEST_AI_VERSION,
    DEFAULT_AI_VERSION,
} from "./ai";
export type {
    IAIStrategy,
    IDecisionContext,
    IPlacementContext,
    CandidateKind,
    ICandidateFeatures,
    ICandidateSet,
    IEnumeratedCandidate,
    IEnumerateOptions,
    IShotCandidateFeatures,
} from "./ai";
// Setup AI (draft/placement policy) — perk, bundle, creatures, artifacts, synergies, augments.
export { SETUP_POLICY_V0, SetupPolicyV0 } from "./ai/setup/setup_v0";
export type { ISetupPolicy } from "./ai/setup/setup_strategy";
export { scoreCreature, creatureInfo } from "./ai/setup/creature_score";
export * as HoCConstants from "./constants";
export * from "./generated/protobuf/v1";
export { default as CREATURES_JSON } from "./configuration/creatures.json";
export { default as CustomEventSource } from "./messaging/custom_event_source";
