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
const cleanupSources: Array<() => void> = [];

describe("CustomEventSource", () => {
    afterEach(() => {
        for (const close of cleanupSources.splice(0)) close();
        globalThis.fetch = originalFetch;
    });

    it("receives a ready match after the queue stream ends without a network error", async () => {
        let fetchCount = 0;
        const reconnectStates: number[] = [];
        const errors: string[] = [];
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return streamResponse(fetchCount === 1 ? [`{"ps":"","po":1}\n\n`] : [`{"ps":"match-1","r":28,"c":0}\n\n`]);
        }) as unknown as typeof fetch;
        const source = new CustomEventSource<{ ps: string; r?: number }>("https://example.test/matchmaking", {
            reconnectDelay: 1,
        });
        cleanupSources.push(() => source.close());
        const pendingMatch = Promise.withResolvers<{ ps: string; r?: number }>();
        source.onmessage = (event) => {
            if (event.ps) {
                source.close();
                pendingMatch.resolve(event);
            }
        };
        source.onreconnect = () => reconnectStates.push(source.readyState);
        source.onerror = (error) => errors.push(error.message);
        expect(await pendingMatch.promise).toEqual({ ps: "match-1", r: 28, c: 0 });
        expect(fetchCount).toBe(2);
        expect(reconnectStates).toEqual([0]);
        expect(errors).toEqual([]);
    }, 1000);

    it("does not deliver queued frames after the ready-match handler closes the stream", async () => {
        globalThis.fetch = (async () =>
            streamResponse([`{"ps":"match-1","c":1}\n\n{"ps":"","po":1}\n\n`])) as unknown as typeof fetch;
        const source = new CustomEventSource<{ ps: string }>("https://example.test/handoff");
        cleanupSources.push(() => source.close());
        const delivered: string[] = [];
        const received = Promise.withResolvers<void>();
        source.onmessage = (event) => {
            delivered.push(event.ps);
            source.close();
            received.resolve();
        };
        await received.promise;
        expect(delivered).toEqual(["match-1"]);
        expect(source.readyState).toBe(2);
    });

    it("ignores a response that arrives after the queue stream was intentionally closed", async () => {
        const response = Promise.withResolvers<Response>();
        globalThis.fetch = (() => response.promise) as unknown as typeof fetch;
        const source = new CustomEventSource<unknown>("https://example.test/retired");
        cleanupSources.push(() => source.close());
        let opened = 0;
        source.onopen = () => {
            opened += 1;
        };
        source.close();
        response.resolve(streamResponse([`{"ps":"old-match"}\n\n`]));
        await Bun.sleep(5);
        expect(opened).toBe(0);
        expect(source.readyState).toBe(2);
    });

    it("does not reconnect when an intentional close finishes a pending read", async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let fetchCount = 0;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response(
                new ReadableStream<Uint8Array>({
                    start(value) {
                        controller = value;
                    },
                }),
            );
        }) as unknown as typeof fetch;
        const source = new CustomEventSource<unknown>("https://example.test/cancel", { reconnectDelay: 1 });
        cleanupSources.push(() => source.close());
        const opened = Promise.withResolvers<void>();
        source.onopen = () => opened.resolve();
        await opened.promise;
        source.close();
        controller.close();
        await Bun.sleep(5);
        expect(fetchCount).toBe(1);
        expect(source.readyState).toBe(2);
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
        let resolveMessages!: () => void;
        const messagesReceived = new Promise<void>((resolve) => {
            resolveMessages = resolve;
        });

        source.onopen = () => {
            opened += 1;
        };
        source.onmessage = (event) => {
            messages.push(event);
            if (messages.length === 3) resolveMessages();
        };
        source.addEventListener("topic", listener);

        await messagesReceived;

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
        let resolveReconnected!: () => void;
        const reconnected = new Promise<void>((resolve) => {
            resolveReconnected = resolve;
        });

        source.onreconnect = () => {
            reconnects += 1;
        };
        source.onopen = resolveReconnected;
        source.onerror = (error) => {
            errors.push(error.message);
        };

        await reconnected;

        expect(fetchCount).toBe(2);
        expect(reconnects).toBe(1);
        expect(errors).toEqual([]);

        source.close();
    });

    /**
     * The pick screen treats onopen as "your draft stream is live", which is only safe while a refused
     * stream stays silent: a 429 means the draft is open somewhere else, and the read-only view exists to
     * say so. A stream that never opens must never announce that it did.
     */
    it("never announces an open stream while the server keeps refusing it", async () => {
        let fetchCount = 0;
        let opens = 0;
        const errors: string[] = [];

        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response(null, { status: 429, statusText: "Too Many Requests" });
        }) as unknown as typeof fetch;

        const source = new CustomEventSource<CustomEvent>("https://example.test/refused", {
            reconnectDelay: 1,
            maxReconnectAttempts: 1,
        });
        let resolveExhausted!: () => void;
        const exhausted = new Promise<void>((resolve) => {
            resolveExhausted = resolve;
        });

        source.onopen = () => {
            opens += 1;
        };
        source.onerror = (error) => {
            errors.push(error.message);
            if (error.message === "Max reconnection attempts reached") resolveExhausted();
        };

        await exhausted;

        expect(opens).toBe(0);
        expect(fetchCount).toBeGreaterThan(1);
        expect(source.readyState).toBe(2);
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
        let resolveExhausted!: () => void;
        const exhausted = new Promise<void>((resolve) => {
            resolveExhausted = resolve;
        });

        source.onerror = (error) => {
            errors.push(error.message);
            if (error.message === "Max reconnection attempts reached") resolveExhausted();
        };

        await exhausted;

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
