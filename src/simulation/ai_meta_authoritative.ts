import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createAIStrategy } from "../ai/index";
import type { ISetupAugmentChoice } from "../ai/setup/setup_ship";
import {
    premiumAugmentPlanId,
    premiumSetupAugmentsForPlan,
    enumeratePremiumAugmentPlans,
} from "../ai/setup/premium_augment_plans";
import { getUpgradePoints } from "../doctrines/doctrine_properties";
import type { FightProperties } from "../fights/fight_properties";
import { FightStateManager } from "../fights/fight_state_manager";
import type { Grid } from "../grid/grid";
import { PBTypes } from "../generated/protobuf/v1/types";
import {
    createPickSimState,
    getCurrentPickPhase,
    getKnownOpponentCreatures,
    getPickScoutingContext,
    getPickTeamView,
    getVisibleCreatureChoices,
    isPickSimComplete,
    LIVE_PICK_PHASES,
    transitionServerPersistedPickSim,
    type IPickSimState,
    type PickAction,
} from "../picks/pick_sim";
import type { UnitsHolder } from "../units/units_holder";
import type { TeamType } from "../units/unit_properties";
import { getDeterministicRandomSource, setDeterministicRandomSource } from "../utils/lib";
import { hashSimulationParts, makeRng, type IArmyUnitSpec } from "./army";
import {
    materializeRankedRoster,
    aiMetaSynergyLevel,
    prepareMetaPair,
    type IAiMetaPairRecord,
    type IAiMetaRunOptions,
} from "./ai_meta_cohorts_core";
import {
    aiMetaChoiceEvidence,
    aiMetaDraftArtifacts,
    cloneAiMetaDraftObservation,
    type IAiMetaDraftEvidence,
} from "./ai_meta_evidence";
import { aiMetaServerRoot } from "./ai_meta_authoritative_source";
import { assertAuthoritativeMetaCommon } from "./ai_meta_authoritative_resolution";
import { premiumStudyDoctrine, PREMIUM_META_CURRENT_STUDY } from "./ai_meta_study";
import type { IAiMetaRuntimeAdapter } from "./ai_meta_runtime_adapter";
import type { IMatchConfig } from "./battle_engine";

type Budget = { v3: boolean; contextual: boolean; delivery: boolean };
type Decision = {
    choice: number | undefined;
    consumeOverride: boolean;
    consumeContextualOverride?: boolean;
    consumeDeliveryOverride?: boolean;
};
type PickDocument = Record<string, unknown>;
type Player = { aiControlled: boolean; persistentAi: boolean; aiVersion: string; setupReady: boolean; team: TeamType };
interface NativeSession {
    fightProperties: FightProperties;
    unitsHolder: UnitsHolder;
    grid: Grid;
    placementStage: number;
    getPlayerByTeam(team: TeamType): Player;
    commitBotSetupForTeam(player: Player): void;
    setupSynergiesForTeam(team: TeamType): { faction: number; synergy: number }[];
    rebuildPlacementZones(): void;
    refreshSynergies(): void;
    tryAdvanceSetupIfReady(): void;
    rePlaceTeam(team: TeamType, setup: boolean): unknown;
    isUnitPlaced(unit: ReturnType<UnitsHolder["getAllAllies"]>[number]): boolean;
}
interface NativeManager {
    sessions: Map<string, NativeSession>;
    createGame(options: Record<string, unknown>): { gameId: string };
    getSnapshot(
        gameId: string,
        playerId: string,
    ): { hideOpponentRosterDuringSetup: boolean; units: { team: number; placed: boolean; cells: unknown[] }[] };
    stop(): void;
}
interface Server {
    PlaySessionManager: new (options: Record<string, unknown>) => NativeManager;
    placementOptions: Record<string, unknown>;
    bundle(pick: PickDocument, team: TeamType, offers: readonly (readonly number[])[]): Decision;
    creature(pick: PickDocument, team: TeamType, level: number, available: readonly number[]): Decision;
    tier2(pick: PickDocument, team: TeamType, offers: readonly number[], own: readonly number[]): number;
}
const teams = [PBTypes.TeamVals.LEFT, PBTypes.TeamVals.RIGHT] as const;
const nameForTeam = (team: number) => (team === PBTypes.TeamVals.LEFT ? "a" : "b");
const budget = (): Budget => ({ v3: false, contextual: false, delivery: false });
function documentFor(
    state: IPickSimState,
    gameId: string,
    map: number,
    flags: Record<"a" | "b", Budget>,
): PickDocument {
    const doc: PickDocument = {
        id: gameId,
        gameId,
        gridType: map,
        abandoned: false,
        currentPhaseSeq: state.phaseSequence,
        currentPhaseFinishTime: 0,
        creaturesBanned: [...state.creaturesBanned],
        pickPhaseOrder: LIVE_PICK_PHASES.map((p) => p.phase),
        pickPhaseActors: LIVE_PICK_PHASES.map((p) => [...p.actors]),
        pickPhaseLevels: LIVE_PICK_PHASES.map((p) => p.creatureLevel),
    };
    for (const [own, enemy, suffix, side] of [
        [state.left, state.right, "Lower", "a"],
        [state.right, state.left, "Upper", "b"],
    ] as const) {
        Object.assign(doc, {
            [`creaturesPicked${suffix}`]: [...own.creatures],
            [`creaturesAmountToPickByLevel${suffix}`]: [...own.remainingByLevel],
            [`slotsSeen${suffix}`]: [...enemy.revealedOpponentSlots],
            [`doctrine${suffix}`]: own.doctrine,
            [`initialBundles${suffix}`]: structuredClone(own.bundles),
            [`tier2ArtifactOffers${suffix}`]: [...own.tier2Offers],
            [`artifactsMadeMap${suffix}`]: [
                ...(own.tier1Artifact ? [[1, own.tier1Artifact]] : []),
                ...(own.tier2Artifact ? [[2, own.tier2Artifact]] : []),
            ],
            [`augmentsMadeMap${suffix}`]: [],
            [`aiDoctrineDraftOverrideUsed${suffix}`]: flags[side].v3,
            [`aiContextualDraftOverrideUsed${suffix}`]: flags[side].contextual,
            [`aiDeliveryDraftOverrideUsed${suffix}`]: flags[side].delivery,
        });
    }
    return doc;
}

function draft(
    server: Server,
    seed: number,
    map: number,
    variants: IAiMetaDraftEvidence["decisions"][number]["observation"]["synergyVariants"],
    gameId: string,
) {
    const rng = makeRng(seed),
        randomInt = (max: number) => Math.floor(rng() * max);
    let state = createPickSimState(randomInt),
        transitions = 0;
    const flags = { a: budget(), b: budget() },
        decisions: IAiMetaDraftEvidence["decisions"] = [];
    while (!isPickSimComplete(state)) {
        if (++transitions > 60) throw new Error("Authoritative draft retry guard exceeded");
        const phase = getCurrentPickPhase(state),
            simultaneous = [0, 8].includes(state.phaseSequence),
            phaseStart = state;
        for (const team of phase.actors) {
            const observed = simultaneous ? phaseStart : state,
                own = team === teams[0] ? observed.left : observed.right;
            const view = getPickTeamView(observed, team),
                doc = documentFor(observed, gameId, map, flags);
            let action: PickAction, ids: number[], selected: number, chosen: Decision | undefined;
            if (phase.phase === PBTypes.PickPhaseVals.DOCTRINE) {
                ids = [1, 2, 3];
                selected = premiumStudyDoctrine(seed, nameForTeam(team));
                action = { type: "select_doctrine", team, doctrine: selected };
            } else if (phase.phase === PBTypes.PickPhaseVals.INITIAL_PICK) {
                ids = view.bundles.map((_, i) => i);
                chosen = server.bundle(doc, team, view.bundles);
                selected = chosen.choice!;
                action = { type: "select_bundle", team, bundleIndex: selected };
            } else if (phase.phase === PBTypes.PickPhaseVals.ARTIFACT_2) {
                ids = [...view.tier2Offers];
                selected = server.tier2(doc, team, ids, own.creatures);
                action = { type: "select_tier2", team, artifactId: selected };
            } else {
                assert.equal(phase.phase, PBTypes.PickPhaseVals.PICK);
                ids = getVisibleCreatureChoices(observed, team);
                chosen = server.creature(doc, team, phase.creatureLevel, ids);
                selected = chosen.choice!;
                action = { type: "pick_creature", team, creatureId: selected };
            }
            assert(ids.includes(selected), "Native draft returned a nonvisible choice");
            const doctrine = action.type === "select_doctrine";
            const choice = aiMetaChoiceEvidence(
                ids.map((id) => ({ key: String(id), score: Number(id === selected) })),
                String(selected),
                String(selected),
                doctrine ? "explore" : "exploit",
                doctrine ? 1 : 0,
            );
            const observation = cloneAiMetaDraftObservation({
                ...view,
                availableCreatureIds: getVisibleCreatureChoices(observed, team),
                revealedOpponentSlots: [...own.revealedOpponentSlots],
                revealedMap: getPickScoutingContext(observed, team, map).map ?? null,
                synergyVariants: variants,
            });
            const result = transitionServerPersistedPickSim(state, action, randomInt);
            assert.notEqual(result.status, "rejected");
            if (result.status === "rejected") throw new Error(result.reason);
            decisions.push({
                index: decisions.length,
                observation,
                action,
                status: result.status,
                behaviorProbability: choice.behaviorProbability,
                choice,
                scoreMeaning: "baseline-policy-preference",
            });
            if (chosen) {
                const flag = flags[nameForTeam(team)];
                flag.v3 ||= chosen.consumeOverride;
                flag.contextual ||= Boolean(chosen.consumeContextualOverride);
                flag.delivery ||= Boolean(chosen.consumeDeliveryOverride);
            }
            state = result.state;
        }
    }
    const rankedDraft: IAiMetaDraftEvidence = {
        seed,
        policy: "authoritative-current-ranked-default-v1",
        unusedObservationFeatures: [],
        authoritativeState: flags,
        doctrines: { a: state.left.doctrine, b: state.right.doctrine },
        knownOpponentCreatureIds: {
            a: getKnownOpponentCreatures(state, teams[0]),
            b: getKnownOpponentCreatures(state, teams[1]),
        },
        optionalBans: "skipped",
        decisions,
        transcript: state.transcript,
        draftedArtifacts: aiMetaDraftArtifacts(state),
        outcomeContinuation: "retained-draft-artifacts-public-setup-v2",
    };
    return {
        rosters: [materializeRankedRoster(state.left.creatures), materializeRankedRoster(state.right.creatures)] as [
            IArmyUnitSpec[],
            IArmyUnitSpec[],
        ],
        rankedDraft,
    };
}

type Prepared = Omit<IAiMetaPairRecord, "games">;
type Unit = ReturnType<UnitsHolder["getAllAllies"]>[number];
const anchors = (units: Unit[]) =>
    units.map((u) => ({ x: Math.max(...u.getCells().map((c) => c.x)), y: Math.max(...u.getCells().map((c) => c.y)) }));
const bodies = (units: Unit[]) =>
    units.map((u) => [u.getName(), u.getAmountAlive(), u.getFootprintWidth(), u.getFootprintHeight()]);
const kits = (units: Unit[]) =>
    units.map((u) => ({
        name: u.getName(),
        amount: u.getAmountAlive(),
        power: u.getStackPower(),
        spells: u.getSpells().map((s) => [s.getName(), s.getAmount()]),
    }));
const terrain = (cells: readonly { x: number; y: number }[]) =>
    cells.map((c) => ({ ...c })).sort((a, b) => a.x - b.x || a.y - b.y);
const augmentsFor = (fp: FightProperties, team: TeamType): ISetupAugmentChoice[] =>
    [
        { kind: "Placement" as const, value: fp.getAugmentPlacementLevel(team) },
        { kind: "Armor" as const, value: fp.getAugmentArmor(team) },
        { kind: "Might" as const, value: fp.getAugmentMight(team) },
        { kind: "Sniper" as const, value: fp.getAugmentSniper(team) },
        { kind: "Movement" as const, value: fp.getAugmentMovement(team) },
        { kind: "Empower" as const, value: fp.getAugmentEmpower(team) },
    ].filter((x) => x.value > 0);

function nativeOpening(server: Server, prepared: Prepared, aIsGreen: boolean) {
    FightStateManager.getInstance();
    const priorRandom = getDeterministicRandomSource(),
        own = aIsGreen ? [prepared.armyA, prepared.armyB] : [prepared.armyB, prepared.armyA];
    const flags = prepared.evidence!.rankedDraft?.authoritativeState;
    setDeterministicRandomSource(makeRng(hashSimulationParts(prepared.setupSeed, "native-setup", aIsGreen)));
    const manager = new server.PlaySessionManager({
        nowMillis: () => 1000,
        aiTakeoverMs: 999999,
        persistJournal: false,
        startTimers: false,
    });
    try {
        const amounts = new Map(
            own.flatMap((army) => army.roster.map((u, i) => [army.creatureIds[i], u.amount] as const)),
        );
        const { gameId } = manager.createGame({
            gameId: `sim-${prepared.combatSeed}`,
            leftPlayerId: "L",
            rightPlayerId: "R",
            lowerCreatureIds: own[0].creatureIds,
            upperCreatureIds: own[1].creatureIds,
            unitAmountForCreature: (id: number) => amounts.get(id),
            gridType: prepared.map,
            ...server.placementOptions,
            leftArtifactTier1: own[0].artifactT1.id,
            leftArtifactTier2: own[0].artifactT2.id,
            rightArtifactTier1: own[1].artifactT1.id,
            rightArtifactTier2: own[1].artifactT2.id,
            lowerDoctrine: own[0].doctrine,
            upperDoctrine: own[1].doctrine,
            leftDeliveryDraftOverrideUsed: flags?.[aIsGreen ? "a" : "b"].delivery ?? false,
            rightDeliveryDraftOverrideUsed: flags?.[aIsGreen ? "b" : "a"].delivery ?? false,
        });
        const session = manager.sessions.get(gameId)!;
        assert.deepEqual(session.fightProperties.getSynergyVariants(), prepared.evidence!.synergyVariants);
        for (const team of teams) {
            const viewer = manager.getSnapshot(gameId, team === teams[0] ? "L" : "R");
            assert.equal(viewer.hideOpponentRosterDuringSetup, false);
            assert(viewer.units.filter((u) => u.team !== team).every((u) => !u.placed && !u.cells.length));
            const player = session.getPlayerByTeam(team);
            player.aiControlled = true;
            player.persistentAi = true;
            player.aiVersion = "v0.8";
            session.commitBotSetupForTeam(player);
            assert(player.setupReady);
        }
        session.rebuildPlacementZones();
        session.refreshSynergies();
        session.tryAdvanceSetupIfReady();
        assert.equal(session.placementStage, 1);
        const data = teams.map((team, i) => {
            session.rePlaceTeam(team, true);
            const units = session.unitsHolder.getAllAllies(team),
                army = own[i];
            assert(units.every((u) => session.isUnitPlaced(u)));
            const roster = units.map((u) => ({
                ...army.roster.find((s) => s.creatureName === u.getName())!,
                amount: u.getAmountAlive(),
                initialSpellEntries: [...u.getAllProperties().spells],
            }));
            for (const original of army.roster)
                assert.equal(
                    roster.filter((u) => u.creatureName === original.creatureName).reduce((n, u) => n + u.amount, 0),
                    original.amount,
                    "Native split conservation",
                );
            const augments = augmentsFor(session.fightProperties, team);
            const plan = { placement: 0, armor: 0, might: 0, sniper: 0, movement: 0, empower: 0 };
            for (const a of augments) plan[a.kind.toLowerCase() as keyof typeof plan] = a.value;
            const planId = premiumAugmentPlanId(plan);
            const selected = {
                plan,
                planId,
                augments: premiumSetupAugmentsForPlan(plan),
                mode: "exploit" as const,
                propensity: 1,
                contextualScore: 0,
                evidence: aiMetaChoiceEvidence(
                    enumeratePremiumAugmentPlans(getUpgradePoints(army.doctrine)).map((p) => ({
                        key: premiumAugmentPlanId(p),
                        score: Number(premiumAugmentPlanId(p) === planId),
                    })),
                    planId,
                    planId,
                    "exploit",
                    0,
                ),
            };
            // The native planner sees physical terrain, so purchases may differ after a seat swap.
            // Keep the first-seat descriptor for compatibility; each fight records its actual purchases.
            if (aIsGreen) army.augment = selected;
            const synergies = session.setupSynergiesForTeam(team);
            const active = synergies.filter((choice) => aiMetaSynergyLevel(army.creatureIds, choice.faction) > 0);
            if (!aIsGreen) assert.deepEqual(army.synergies, active, "Native synergy identity changed across seats");
            army.synergies = active;
            return {
                team,
                roster,
                augments,
                synergies,
                bodies: bodies(units),
                positions: anchors(units),
                kits: kits(units),
                barrels: session.grid
                    .getArtifactBarrels(team)
                    .map((b) => ({ team: b.team, index: b.index, cell: { ...b.cell } }))
                    .sort((a, b) => a.index - b.index),
            };
        });
        return {
            teams: data,
            terrain: terrain(session.grid.getScatteredMountainsStanding()),
            nativeMethod: "commitBotSetupForTeam/rePlaceTeam",
            deliveryDraftConsumed: flags ?? { a: budget(), b: budget() },
        };
    } finally {
        manager.stop();
        setDeterministicRandomSource(priorRandom);
    }
}

export async function loadAuthoritativeMetaAdapter(): Promise<IAiMetaRuntimeAdapter> {
    await assertAuthoritativeMetaCommon();
    const load = (path: string) => import(pathToFileURL(resolve(aiMetaServerRoot(), path)).href);
    const [session, decider, placement] = await Promise.all([
        load("src/api/game/v1/play_session.ts"),
        load("src/api/game/v1/pick_decider.ts"),
        load("src/api/game/v1/ranked_placement_options.ts"),
    ]);
    session.playSessionManager.stop();
    const server: Server = {
        PlaySessionManager: session.PlaySessionManager,
        placementOptions: placement.RANKED_PLACEMENT_OPTIONS,
        bundle: decider.decideRankedBundleForTeam,
        creature: decider.decideRankedDraftCreatureForTeam,
        tier2: decider.pickRankedTier2ArtifactForTeam,
    };
    const openings = new WeakMap<Prepared, [ReturnType<typeof nativeOpening>, ReturnType<typeof nativeOpening>]>();
    return {
        preparePair(options: IAiMetaRunOptions, pair: number) {
            assert.equal(options.studyProfile, PREMIUM_META_CURRENT_STUDY);
            const combatSeed = hashSimulationParts("ai-meta-combat", options.baseSeed, options.cohort, pair);
            const prepared = prepareMetaPair(options, pair, undefined, (seed, map, variants) =>
                draft(server, seed, map, variants, `sim-${combatSeed}`),
            );
            const a = nativeOpening(server, prepared, true),
                b = nativeOpening(server, prepared, false);
            prepared.evidence!.authoritativeSetup = { schema: "native-ranked-openings-v1", openings: [a, b] };
            openings.set(prepared, [a, b]);
            return prepared;
        },
        configureFight(prepared, aIsGreen, config) {
            const opening = openings.get(prepared)![aIsGreen ? 0 : 1];
            const strategy = (index: number) => {
                const data = opening.teams[index],
                    base = createAIStrategy("v0.8")!;
                return {
                    version: base.version,
                    decideTurn: base.decideTurn.bind(base),
                    placeArmy(units: Parameters<typeof base.placeArmy>[0]) {
                        assert.deepEqual(
                            units.map((u) => [
                                u.getName(),
                                u.getAmountAlive(),
                                u.getFootprintWidth(),
                                u.getFootprintHeight(),
                            ]),
                            data.bodies,
                        );
                        return new Map(units.map((u, i) => [u.getId(), data.positions[i]]));
                    },
                };
            };
            return {
                ...config,
                roster: opening.teams[0].roster,
                redRoster: opening.teams[1].roster,
                greenAugments: opening.teams[0].augments,
                redAugments: opening.teams[1].augments,
                greenSynergies: opening.teams[0].synergies,
                redSynergies: opening.teams[1].synergies,
                greenTacticalSplitStacks: [],
                redTacticalSplitStacks: [],
                greenStrategyOverride: strategy(0),
                redStrategyOverride: strategy(1),
                beforeFightStart(context) {
                    for (const data of opening.teams) {
                        const units = context.unitsHolder.getAllAllies(data.team);
                        assert.deepEqual(
                            anchors(units),
                            data.positions,
                            "Native positions were repaired by combat setup",
                        );
                        assert.deepEqual(kits(units), data.kits, "Native spellbook/stack power mismatch");
                        for (const b of context.grid.getArtifactBarrels(data.team))
                            assert(context.grid.unplaceArtifactBarrel(data.team, b.index));
                        for (const b of data.barrels)
                            assert(context.grid.placeArtifactBarrel(data.team, b.index, b.cell));
                    }
                    assert.deepEqual(terrain(context.grid.getScatteredMountainsStanding()), opening.terrain);
                    setDeterministicRandomSource(makeRng(prepared.combatSeed));
                },
            } as IMatchConfig;
        },
    };
}
