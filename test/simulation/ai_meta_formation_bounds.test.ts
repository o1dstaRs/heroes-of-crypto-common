import { expect, it } from "bun:test";
import { prepareMetaPair, type AiMetaCohort } from "../../src/simulation/ai_meta_cohorts_core";
import { aiMetaMatchConfig } from "../../src/simulation/ai_meta_cohorts_pair";
import { runMatch } from "../../src/simulation/battle_engine";
import { metaFormationProposals } from "../../src/simulation/ai_meta_formation_learning";
import { AI_META_REGISTERED_VERSION_STRATEGY_PROFILE } from "../../src/simulation/ai_meta_strategy_profile";

it("resolves rectangular y=16 anchors with the same legal fallback as ordinary placement", () => {
    const cases: [AiMetaCohort, number][] = [
        ["cross-archetype", 2],
        ["caster-support", 37],
        ["flyer-heavy", 47],
        ["flyer-heavy", 52],
        ["ranged-heavy", 67],
        ["cross-archetype", 83],
        ["uniform-mixed", 118],
        ["ranged-heavy", 232],
    ];
    for (const [cohort, pair] of cases) {
        const prepared = prepareMetaPair(
            {
                cohort,
                games: 576,
                baseSeed: 3161604032,
                collectEvidence: true,
                studyProfile: "premium-ranked-v4",
            },
            pair,
        );
        for (const seat of [0, 1]) {
            const config = {
                ...aiMetaMatchConfig(
                    seat ? prepared.armyB : prepared.armyA,
                    seat ? prepared.armyA : prepared.armyB,
                    prepared.combatSeed,
                    prepared.map,
                    AI_META_REGISTERED_VERSION_STRATEGY_PROFILE,
                    prepared.evidence!.synergyVariants,
                    true,
                ),
                maxLaps: 0,
            };
            const original = runMatch(config);
            let callbacks = 0;
            const captured = runMatch({
                ...config,
                researchFormationSelector(input) {
                    callbacks++;
                    expect(input.units.every((unit) => unit.cell.y >= 0 && unit.cell.y < 16)).toBe(true);
                    const incumbent = metaFormationProposals(input)[0];
                    return new Map(incumbent.positions.map((p) => [p.unitId, p.cell]));
                },
            });
            expect(callbacks).toBe(2);
            expect(captured.placements).toEqual(original.placements);
            expect(captured.totalActions).toBe(original.totalActions);
            expect(captured.outcome).toEqual(original.outcome);
        }
    }
}, 60_000);
