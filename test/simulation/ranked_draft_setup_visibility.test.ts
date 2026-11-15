import { expect, test } from "bun:test";
import { creatureIdForName } from "../../src/ai/setup/creature_score";
import { withRankedDraftPrivateSetupVisibility } from "../../src/simulation/ranked_draft_setup_visibility";

const id = (name: string) => creatureIdForName(name)!;
const fixture = () => ({
    roster: [{ creatureName: "Magic Dragon" }, { creatureName: "Peasant" }],
    redRoster: [{ creatureName: "Beholder" }, { creatureName: "Medusa" }],
    greenRevealedCreatures: [id("Beholder")],
    redRevealedCreatures: [id("Magic Dragon")],
    greenDoctrine: 1,
    redDoctrine: 2,
});

test("private setup receives exactly the legally revealed identities, including collision reveals", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = withRankedDraftPrivateSetupVisibility(input);
    expect(result.greenPublicOpponentCreatures).toEqual([id("Beholder")]);
    expect(result.redPublicOpponentCreatures).toEqual([id("Magic Dragon")]);
    expect(result.greenPublicOpponentCreatures).not.toContain(id("Medusa"));
    expect(input).toEqual(before);
    result.greenPublicOpponentCreatures.push(id("Medusa"));
    expect(input.greenRevealedCreatures).toEqual([id("Beholder")]);
});

test("an explicit empty reveal list stays empty even when the full opponent roster exists", () => {
    const result = withRankedDraftPrivateSetupVisibility({
        ...fixture(),
        greenRevealedCreatures: [],
        redRevealedCreatures: [],
    });
    expect(result.greenPublicOpponentCreatures).toEqual([]);
    expect(result.redPublicOpponentCreatures).toEqual([]);
});

test("reversing physical seats preserves the owner of each private visibility projection", () => {
    const input = fixture();
    const result = withRankedDraftPrivateSetupVisibility({
        ...input,
        roster: input.redRoster,
        redRoster: input.roster,
        greenRevealedCreatures: input.redRevealedCreatures,
        redRevealedCreatures: input.greenRevealedCreatures,
    });
    expect(result.greenPublicOpponentCreatures).toEqual([id("Magic Dragon")]);
    expect(result.redPublicOpponentCreatures).toEqual([id("Beholder")]);
});

test("missing or wrong-seat projections fail instead of silently hiding information", () => {
    expect(() =>
        withRankedDraftPrivateSetupVisibility({ ...fixture(), greenRevealedCreatures: undefined } as never),
    ).toThrow("Missing final draft visibility projection");
    expect(() =>
        withRankedDraftPrivateSetupVisibility({ ...fixture(), greenRevealedCreatures: [id("Magic Dragon")] }),
    ).toThrow("Draft reveal does not belong to the opponent roster");
});
