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

import { afterEach, describe, expect, it } from "bun:test";

import CustomEventSource from "../../src/messaging/custom_event_source";

const originalFetch = globalThis.fetch;

describe("CustomEventSource", () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it("connects with headers, dispatches messages, listeners, and closes", async () => {
        const fetchCalls: RequestInit[] = [];
        const listenerEvents: unknown[] = [];
        const messages: unknown[] = [];
        let opened = 0;

        globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push(init ?? {});
            return streamResponse([
                `{"ps":"topic","value":1}\n\n`,
                `not-json\n\n`,
                `{"ps":"other","value":2}\n\n`,
                `{"ps":"topic","value":3}\n\n`,
            ]);
        }) as unknown as typeof fetch;

        const source = new CustomEventSource<CustomEvent>("https://example.test/events", {
            token: "Bearer token",
        });
        const listener = (event: Event) => listenerEvents.push(event);

        source.onopen = () => {
            opened += 1;
        };
        source.onmessage = (event) => messages.push(event);
        source.addEventListener("topic", listener);

        await wait(20);

        source.removeEventListener("topic", listener);
        source.close();

        expect(fetchCalls[0].headers).toEqual({
            Accept: "text/event-stream",
            Authorization: "Bearer token",
        });
        expect(opened).toBe(1);
        expect(messages).toEqual([
            { ps: "topic", value: 1 },
            { ps: "other", value: 2 },
            { ps: "topic", value: 3 },
        ]);
        expect(listenerEvents).toEqual([
            { ps: "topic", value: 1 },
            { ps: "topic", value: 3 },
        ]);
        expect(source.readyState).toBe(2);
    });

    it("reconnects after 429 responses and stops after max reconnect attempts", async () => {
        let fetchCount = 0;
        let reconnects = 0;
        const errors: string[] = [];

        globalThis.fetch = (async () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                return new Response(null, { status: 429, statusText: "Too Many Requests" });
            }
            return streamResponse([`{"ps":"ready"}\n\n`]);
        }) as unknown as typeof fetch;

        const source = new CustomEventSource<CustomEvent>("https://example.test/reconnect", {
            reconnectDelay: 1,
            maxReconnectAttempts: 1,
        });

        source.onreconnect = () => {
            reconnects += 1;
        };
        source.onerror = (error) => {
            errors.push(error.message);
        };

        await wait(30);

        expect(fetchCount).toBe(2);
        expect(reconnects).toBe(1);
        expect(errors).toEqual([]);

        source.close();
    });

    it("reports connection failures and closes after exhausting reconnects", async () => {
        const errors: string[] = [];

        globalThis.fetch = (async () => {
            throw new Error("network down");
        }) as unknown as typeof fetch;

        const source = new CustomEventSource<CustomEvent>("https://example.test/error", {
            reconnectDelay: 1,
            maxReconnectAttempts: 1,
        });

        source.onerror = (error) => {
            errors.push(error.message);
        };

        await wait(30);

        expect(errors).toContain("No internet connection");
        expect(errors).toContain("Max reconnection attempts reached");
        expect(source.readyState).toBe(2);
    });
});

function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();

    return new Response(
        new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        }),
        { status: 200, statusText: "OK" },
    );
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
