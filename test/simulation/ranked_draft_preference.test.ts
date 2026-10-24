import { expect, test } from "bun:test";
import { PBTypes } from "../../src/generated/protobuf/v1/types";
import { resolveRankedDraftPick, rankedDraftStrengthCandidate } from "../../src/simulation/ranked_draft_eval";
const genome = rankedDraftStrengthCandidate("ranked-unit-strength-a19-side-v4-w16-r4");
const team = PBTypes.TeamVals.LEFT;
const hydra = PBTypes.CreatureVals.HYDRA;

test("omitted and explicit undefined draft preferences produce identical drafts", () => {
    for (let seed = 1; seed <= 12; seed++) {
        const base = resolveRankedDraftPick(seed, genome, genome, {}, { liveDraftRules: true });
        const disabled = resolveRankedDraftPick(
            seed,
            genome,
            genome,
            {},
            { liveDraftRules: true, researchPreferredCreatureByTeam: undefined },
        );
        expect(disabled).toEqual(base);
    }
});

test("Hydra preference respects bans and public choices and preserves earlier-level decisions", () => {
    let banned = 0,
        legal = 0;
    for (let seed = 1; seed <= 80; seed++) {
        const base = resolveRankedDraftPick(seed, genome, genome, {}, { liveDraftRules: true });
        const candidate = resolveRankedDraftPick(
            seed,
            genome,
            genome,
            {},
            { liveDraftRules: true, researchPreferredCreatureByTeam: { [team]: hydra } },
        );
        expect(candidate.creaturesBanned).toEqual(base.creaturesBanned);
        expect(candidate.left.creatures.slice(0, -1)).toEqual(base.left.creatures.slice(0, -1));
        expect(candidate.right.creatures.slice(0, -1)).toEqual(base.right.creatures.slice(0, -1));
        if (candidate.creaturesBanned.includes(hydra)) {
            banned++;
            expect(candidate).toEqual(base);
        } else {
            legal++;
            expect([...candidate.left.creatures, ...candidate.right.creatures]).toContain(hydra);
        }
    }
    expect(banned).toBeGreaterThan(0);
    expect(legal).toBeGreaterThan(0);
});

test("unknown identities, wrong teams and legacy draft modes fail closed", () => {
    for (const rules of [
        { liveDraftRules: true, researchPreferredCreatureByTeam: { [team]: 999999 } },
        { liveDraftRules: true, researchPreferredCreatureByTeam: { 99: hydra } },
        { liveDraftRules: false, researchPreferredCreatureByTeam: { [team]: hydra } },
    ])
        expect(() => resolveRankedDraftPick(1, genome, genome, {}, rules)).toThrow();
});

test("the evaluation override reaches only the candidate's real draft seat across both mirrors", async () => {
    const { playRankedDraftGame } = await import("../../src/simulation/ranked_draft_eval");
    const stop = new Error("captured fight config");
    let changed = 0;
    for (let game = 0; game < 24; game++) {
        const capture = (preferred?: number) => {
            let roster: import("../../src/simulation/battle_engine").IMatchConfig | undefined;
            expect(() =>
                playRankedDraftGame(
                    genome,
                    genome,
                    {
                        gamesPerOpponent: 24,
                        baseSeed: 2026102410,
                        liveDraftRules: true,
                        researchCandidatePreferredCreature: preferred,
                    },
                    game,
                    0,
                    {
                        matchRunner: (config) => {
                            roster = config;
                            throw stop;
                        },
                    },
                ),
            ).toThrow("captured fight config");
            return roster!;
        };
        const baseline = capture(),
            preferred = capture(hydra);
        const green = game % 4 === 0 || game % 4 === 3;
        const ours = green ? preferred.roster : preferred.redRoster!;
        const old = green ? baseline.roster : baseline.redRoster!;
        if (ours.some((unit) => unit.creatureName === "Hydra")) {
            changed++;
            expect(ours.slice(0, -1)).toEqual(old.slice(0, -1));
        } else expect(preferred).toEqual(baseline);
    }
    expect(changed).toBeGreaterThan(0);
});
