import { describe, expect, it } from "bun:test";
import { buildV08A19SearchEnvironment } from "../../src/ai/versions/v0_8_a19_profile";
import {
    A19_BOT_SEAT_SEARCH_DRIVER,
    A19_BOT_SEAT_SEARCH_ENVIRONMENT,
    createA19BotSeatSearchDriverFactory,
} from "../../src/simulation/a19_bot_seat_search";
import { createTally, finalizeTally } from "../../src/simulation/tournament";
import { V08_A19_DEEP_FIT } from "../../src/simulation/v0_8_a19_deep_fit";
import { withScopedAIEnvironment } from "../../src/simulation/v0_8_a13_search";

describe("the production bot seat's search for research runners", () => {
    it("is the server's bot-search environment around the deep-fit driver", () => {
        const profile = withScopedAIEnvironment({ V08_A19_SEARCH_ENV_OVERRIDES: undefined }, () =>
            buildV08A19SearchEnvironment(),
        );
        expect(A19_BOT_SEAT_SEARCH_ENVIRONMENT).toEqual({
            ...profile,
            SEARCH_A19_MATERIAL_ARBITRATION: "ties",
            SEARCH_A19_CERTIFIED_SELECTION_BOUNDS: "1",
            SEARCH_A19_CERTIFIED_TIGHT_BOUNDS: "1",
            SEARCH_A19_ROLLOUT_ALLOCATION: "uniform",
            SEARCH_V08_RANKED_REPLAY_TIEBREAK_EPSILON: "0",
            V08_FLYER_BACKLINE_PRIORITY_LEFT: "0",
            V08_FLYER_BACKLINE_PRIORITY_RIGHT: "0",
            V08_A19_SEARCH_ENV_OVERRIDES: undefined,
        });
        expect(A19_BOT_SEAT_SEARCH_DRIVER).toMatchObject({
            driver: V08_A19_DEEP_FIT.id,
            stockBudget: V08_A19_DEEP_FIT.stockBudget,
            deepBudget: V08_A19_DEEP_FIT.deepBudget,
            rolloutTurnBudget: V08_A19_DEEP_FIT.rolloutTurnBudget,
            work: "offline-deterministic-work",
        });
    });

    it("plays operation-bounded offline work only", () => {
        const factory = createA19BotSeatSearchDriverFactory();
        expect(() => factory({} as never, { offlineDeterministicWork: false })).toThrow("offline deterministic work");
    });

    it("a tournament that names the driver records it; a stock tournament's summary is unchanged", () => {
        const options = { versionA: "v0.8", versionB: "v0.8", games: 0, baseSeed: 1 };
        const tally = createTally(options);
        expect("searchDriver" in finalizeTally(tally, options)).toBe(false);
        expect(finalizeTally(tally, { ...options, searchDriver: "a19-bot-seat-deep-fit-v1" }).searchDriver).toBe(
            A19_BOT_SEAT_SEARCH_DRIVER,
        );
    });
});
