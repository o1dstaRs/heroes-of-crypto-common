import { describe, expect, test } from "bun:test";

import { pickRankedAIDoctrine, RANKED_AI_DOCTRINE_CHOICES } from "../../src/ai/setup/doctrine_variety";
import { Doctrine } from "../../src/doctrines/doctrine_properties";

describe("ranked AI doctrine variety", () => {
    test("uses every playable doctrine across matches", () => {
        const selected = new Set(
            Array.from({ length: 300 }, (_, index) =>
                pickRankedAIDoctrine({ matchId: `match-${index}`, team: 1, aiVersion: "v0.8" }),
            ),
        );

        expect(RANKED_AI_DOCTRINE_CHOICES).toEqual([Doctrine.THREE_REVEALS, Doctrine.SEE_ALL, Doctrine.SEE_NONE]);
        expect(selected).toEqual(new Set(RANKED_AI_DOCTRINE_CHOICES));
    });

    test("is stable for a match seat and AI version", () => {
        const context = { matchId: "ranked-123", team: 2, aiVersion: "v0.8" } as const;
        expect(pickRankedAIDoctrine(context)).toBe(pickRankedAIDoctrine(context));
        expect(RANKED_AI_DOCTRINE_CHOICES).toContain(pickRankedAIDoctrine(context));
    });

    test("allocates approximately a third of match seats to each doctrine", () => {
        for (const version of ["v0.4", "v0.6", "v0.7", "v0.8", "v0.9"]) {
            const counts = new Map<Doctrine, number>();
            for (let match = 0; match < 10_000; match++) {
                for (const team of [1, 2]) {
                    const doctrine = pickRankedAIDoctrine({ matchId: `match-${match}`, team, aiVersion: version });
                    counts.set(doctrine, (counts.get(doctrine) ?? 0) + 1);
                }
            }
            for (const doctrine of RANKED_AI_DOCTRINE_CHOICES) {
                expect(counts.get(doctrine)! / 20_000).toBeGreaterThan(0.31);
                expect(counts.get(doctrine)! / 20_000).toBeLessThan(0.36);
            }
        }
    });
});
