import { describe, expect, test } from "bun:test";

import { Doctrine } from "../../src/doctrines/doctrine_properties";
import {
    selectV09DoctrineDraftChoice,
    V09_DEFAULT_DRAFT_BASE_POLICY_SPEC,
    V09_DEFAULT_DRAFT_MODEL_ID,
    V09_DEFAULT_DRAFT_MODEL_SHA256,
    type IDoctrineDraftContext,
} from "../../src/ai/setup/doctrine_draft_policy";
import {
    lockedDoctrineDraftModel,
    LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID,
} from "../../src/simulation/v0_9/doctrine_draft_checkpoint";
import { fingerprintV09 } from "../../src/simulation/v0_9/protocol";
import fixture from "./fixtures/doctrine_draft_v3_replay.json";

describe("v0.9 default doctrine draft", () => {
    test("locks the exact confirmed model and its original candidate menu", () => {
        expect(V09_DEFAULT_DRAFT_MODEL_ID).toBe(LOCKED_DOCTRINE_DRAFT_CHECKPOINT_ID);
        expect(fingerprintV09(lockedDoctrineDraftModel())).toBe(V09_DEFAULT_DRAFT_MODEL_SHA256);
        expect(V09_DEFAULT_DRAFT_BASE_POLICY_SPEC).toBe(fixture.draft);
    });

    test("replays a genuine learned choice with durable caller-owned override state", () => {
        const previous = fixture.collisionExample.previous;
        const input = {
            context: previous.context as IDoctrineDraftContext,
            preferred: { id: previous.preferred, creatureIds: [previous.preferred] },
            alternative: { id: previous.chosen, creatureIds: [previous.chosen] },
            level: 2,
            overrideUsed: false,
        };
        const decision = selectV09DoctrineDraftChoice(Doctrine.THREE_REVEALS, input);
        expect(decision.choice).toBe(previous.chosen);
        expect(decision.consumeOverride).toBe(true);
        expect(selectV09DoctrineDraftChoice(Doctrine.THREE_REVEALS, input)).toEqual(decision);
        expect(selectV09DoctrineDraftChoice(Doctrine.THREE_REVEALS, { ...input, overrideUsed: true })).toEqual({
            choice: previous.preferred,
            consumeOverride: false,
        });
        for (const doctrine of [Doctrine.SEE_NONE, Doctrine.NO_DOCTRINE]) {
            expect(selectV09DoctrineDraftChoice(doctrine, input)).toEqual({
                choice: previous.preferred,
                consumeOverride: false,
            });
        }
        expect(selectV09DoctrineDraftChoice(Doctrine.THREE_REVEALS, { ...input, level: 4 })).toEqual({
            choice: previous.preferred,
            consumeOverride: false,
        });
    });
});
