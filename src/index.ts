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
export * from "./grid/scattered_mountains";
export * as GridConstants from "./grid/grid_constants";
export * as GridMath from "./grid/grid_math";
export * as Augment from "./augments/augment_properties";
export * as Artifact from "./artifacts/artifact_properties";
export * as Doctrine from "./doctrines/doctrine_properties";
export * as Perk from "./perks/perk_properties";
export * from "./abilities/ability";
export * from "./scene/animations";
export * as AbilityHelper from "./abilities/ability_helper";
export * from "./abilities/ability_factory";
export * from "./abilities/ability_properties";
export * from "./abilities/ability_helper";
export * from "./abilities/blind_fury_ability";
export * from "./abilities/stun_aura_ability";
export * from "./abilities/magic_reflection_ability";
export * as AllAbilities from "./abilities";
export * as HoCConfig from "./configuration/config_provider";
export * from "./effects/aura_effect";
export * as EffectHelper from "./effects/effect_helper";
export * from "./spells/applied_spell";
export * from "./effects/effect_properties";
export * from "./effects/effect_factory";
export * from "./effects/effect";
export * as SpellHelper from "./spells/spell_helper";
export * as SmokeHelper from "./spells/smoke_clouds";
export * as FireWallHelper from "./spells/fire_walls";
export * as VineHelper from "./spells/vines";
export * as RayTraversal from "./grid/ray_traversal";
export * from "./spells/spell";
export * as PickHelper from "./picks/pick_helper";
export * as PickSim from "./picks/pick_sim";
export * from "./picks/pick_sim";
export * from "./engine/actions";
export * from "./engine/action_engine";
export * from "./engine/events";
export * from "./engine/hourglass";
export * from "./engine/runtime";
export * from "./engine/turn_engine";
export * from "./handlers/move_handler";
export * from "./handlers/attack_handler";
export * from "./spells/spell_properties";
export * from "./spells/spell_damage";
export * from "./spells/spell_cast_projection";
export * from "./spells/magic_mirror_damage";
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
export * from "./damage/damage_projection";
export * from "./damage/ability_damage_projection";
export * from "./scene/scene_log_interface";
export * from "./scene/scene_stats";
export * from "./scene/statistic_holder_interface";
export * from "./fights/fight_properties";
export * from "./fights/fight_state_manager";
export * from "./factions/faction_type";
export * as HoCLib from "./utils/lib";
export * as HoCMath from "./utils/math";
export * as AI from "./ai/ai";
export * from "./ai/tactical_split_placement";
export {
    getAIStrategy,
    createAIStrategy,
    getRankedAIProfile,
    aiVersionForUnit,
    isMindlessAiUnit,
    MINDLESS_AI_ABILITY,
    MINDLESS_AI_VERSION,
    pickRankedAIDoctrine,
    RANKED_AI_DOCTRINE_CHOICES,
    enumerateCandidates,
    getEnemiesCellsWithinMovementRange,
    AI_VERSIONS,
    RANKED_AI_PROFILES,
    RANKED_SETUP_POLICY_V0,
    LATEST_AI_VERSION,
    DEFAULT_AI_VERSION,
    buildV08A13SearchEnvironment,
    V08_A13_CANDIDATE_ID,
    V08_A13_GENOME,
    V08_A13_GENOME_SHA256,
    V08_A13_OPPONENT_VERSION,
    V08_A13_POLICY,
    V08_A13_PRODUCTION_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A13_PRODUCTION_VERSION,
    V08_A13_PROFILE,
    V08_A13_PROFILE_SCHEMA,
    V08_A13_SEARCH,
    V08_A13_SOURCE_BEHAVIOR_ENVIRONMENT_SHA256,
    V08_A13_SOURCE_BINDING_SHA256,
    V08_A13_SOURCE_COMMIT,
    V08_A13_SOURCE_TREE,
    V08_A13_SOURCE_VERSION,
    V08_A13_VALUE_LEAF,
    buildV08A19SearchEnvironment,
    createV08A19Strategy,
    V08_A19_CANDIDATE_ID,
    V08_A19_PRODUCTION_VERSION,
    V08_A19_PROFILE,
    V08_A19_PROFILE_SCHEMA,
    V08_A19_PRODUCTION_ROUTING_SOURCE_LEDGER,
    V09_MODEL_ARTIFACT,
    V09_MODEL_ID,
    V09_MODEL_PROMOTED,
    V09_MODEL_SHA256,
    V09_MODEL_STATUS,
    V09_EMPTY_FAILURES_SHA256,
    V09_QUALIFICATION_RECEIPT_SCHEMA,
    serializeV09ModelHashPayload,
    serializeV09QualificationReceiptPayload,
    validateV09ModelArtifact,
} from "./ai";
export type {
    IAIPolicyEvent,
    IAIStrategy,
    IRankedAIDoctrineChoiceContext,
    IRankedAIProfile,
    IRankedAISetupPolicy,
    IDecisionContext,
    IPlacementContext,
    CandidateKind,
    ICandidateFeatures,
    ICandidateSet,
    IEnumeratedCandidate,
    IEnumerateOptions,
    IShotCandidateFeatures,
    IV09DecisionTelemetryDetails,
    IV09ModelArtifact,
    IV09QualificationReceipt,
} from "./ai";
// Setup AI (draft/placement policy) — doctrine, bundle, creatures, artifacts, synergies, augments.
export { SETUP_POLICY_V0, SETUP_POLICY_V0_DRAFT_ROLLBACK, SetupPolicyV0 } from "./ai/setup/setup_v0";
export type { ISetupPolicyV0Options } from "./ai/setup/setup_v0";
export { createPlacementSetupDecisionContext, createTier2ArtifactDecisionContext } from "./ai/setup/setup_strategy";
export type {
    IPlacementSetupDecisionContext,
    ISetupDecisionContext,
    ISetupPolicy,
    ITier2ArtifactDecisionContext,
} from "./ai/setup/setup_strategy";
export { creatureIdForName, creatureInfo, scoreCreature } from "./ai/setup/creature_score";
export {
    applyDraftCoherenceOverlay,
    DRAFT_COHERENCE_WEIGHT,
    draftBundleCoherenceAffinity,
    draftCreatureCoherenceAffinity,
    pickCoherentDraftBundle,
    pickCoherentDraftCreature,
} from "./ai/setup/draft_coherence";
export type { DraftBundle, IDraftCoherenceContext } from "./ai/setup/draft_coherence";
export {
    compileNonFightSetupPolicy,
    compileReplayTacticsSetupPolicy,
    COHORT_SAFE_PUBLIC_ROSTER_PLACEMENT,
    placementOpponentVisibility,
    resolveSetupPolicy,
    SETUP_COHORTS,
    setupCohort,
    V07_COHORT_SAFE_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_COHORT_SAFE_PUBLIC_ROSTER_SETUP_SPEC,
    V07_NONFIGHT_BEHAVIOR_SHA256,
    V07_NONFIGHT_SETUP_ARTIFACT,
    V07_NONFIGHT_SETUP_SPEC,
    V07_PUBLIC_ROSTER_BEHAVIOR_SHA256,
    V07_PUBLIC_ROSTER_SETUP_ARTIFACT,
    V07_PUBLIC_ROSTER_SETUP_SPEC,
} from "./ai/setup/setup_ship";
export {
    canonicalReplayTacticsSetupBehavior,
    parseReplayTacticsSetupArtifact,
    RANKED_REPLAY_TACTICS_BASE_SPEC,
    RANKED_REPLAY_TACTICS_BEHAVIOR_SHA256,
    RANKED_REPLAY_TACTICS_BUDGET,
    RANKED_REPLAY_TACTICS_SETUP_ARTIFACT,
    RANKED_REPLAY_TACTICS_SETUP_SPEC,
    REPLAY_TACTICS_ARMY_IDENTITIES,
    replayTacticsArmyIdentity,
    replayTacticsAugmentPlan,
} from "./ai/setup/setup_replay_tactics";
export type {
    IResolvedSetupPolicy,
    ISetupAugmentChoice,
    ISetupPolicyBehavior,
    ISetupSynergyChoice,
    PlacementPolicyVariant,
    SetupCohort,
    V07SetupPolicyBehaviorSha256,
    V07SetupPolicySpec,
} from "./ai/setup/setup_ship";
export type {
    IReplayTacticsAugmentPlan,
    IReplayTacticsClassifier,
    IReplayTacticsSetupArtifact,
    IReplayTacticsSetupBehavior,
    ReplayTacticsArmyIdentity,
} from "./ai/setup/setup_replay_tactics";
export * as HoCConstants from "./constants";
export * from "./generated/protobuf/v1";
export { default as CREATURES_JSON } from "./configuration/creatures.json";
export { default as CustomEventSource } from "./messaging/custom_event_source";
