import { describe, expect, test } from "bun:test";

import { pickRankedAIPerk, RANKED_AI_PERK_CHOICES } from "../../src/ai/setup/perk_variety";
import { Perk } from "../../src/perks/perk_properties";

describe("ranked AI perk variety", () => {
    test("uses every playable perk across matches", () => {
        const selected = new Set(
            Array.from({ length: 300 }, (_, index) =>
                pickRankedAIPerk({ matchId: `match-${index}`, team: 1, aiVersion: "v0.8" }),
            ),
        );

        expect(RANKED_AI_PERK_CHOICES).toEqual([Perk.THREE_REVEALS, Perk.SEE_ALL, Perk.SEE_NONE]);
        expect(selected).toEqual(new Set(RANKED_AI_PERK_CHOICES));
    });

    test("is stable for a match seat and AI version", () => {
        const context = { matchId: "ranked-123", team: 2, aiVersion: "v0.8" } as const;
        expect(pickRankedAIPerk(context)).toBe(pickRankedAIPerk(context));
        expect(RANKED_AI_PERK_CHOICES).toContain(pickRankedAIPerk(context));
    });
});
