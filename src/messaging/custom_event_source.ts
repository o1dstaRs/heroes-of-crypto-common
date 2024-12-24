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

type EventSourceOptions = {
    token?: string;
    reconnectDelay?: number;
    maxReconnectAttempts?: number;
    debug?: boolean;
};

class CustomEventSource<T> {
    private url: string;

    private token: string | null;

    private listeners: Record<string, EventListener[]> = {};

    private isClosed: boolean = false;

    private reconnectAttempts: number = 0;

    private debug: boolean;

    private controller: AbortController | null = null;

    private reconnectDelay: number;

    private maxReconnectAttempts: number;

    public readyState: number = 0;

    public onopen: ((event?: T) => void) | null = null;

    public onmessage: ((event: T) => void) | null = null;

    public onerror: ((error: Error) => void) | null = null;

    public onreconnect: (() => void) | null = null;

    public constructor(url: string, options: EventSourceOptions = {}) {
        this.url = url;
        this.token = options.token || null;
        this.reconnectDelay = options.reconnectDelay || 2000;
        this.maxReconnectAttempts = options.maxReconnectAttempts || 3;
        this.debug = options.debug || false;

        this.debugLog("Initializing CustomEventSource with URL:", url);
        this.connect();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private debugLog(...args: any[]) {
        if (this.debug) {
            console.log("[CustomEventSource]", ...args);
        }
    }

    private async connect(): Promise<boolean> {
        if (this.isClosed) {
            this.debugLog("Connection attempt aborted - EventSource is closed");
            return false;
        }

        this.readyState = 0;

        // Cancel any existing connection
        if (this.controller) {
            this.controller.abort();
        }

        // Create new controller for this connection
        this.controller = new AbortController();

        try {
            this.debugLog("Attempting connection to:", this.url);

            const headers: Record<string, string> = {
                Accept: "text/event-stream",
            };

            if (this.token) {
                headers.Authorization = this.token;
            }

            this.debugLog("Request headers:", headers);

            const response = await fetch(this.url, {
                headers,
                method: "GET",
                mode: "cors",
                cache: "no-cache",
                signal: this.controller.signal,
            }).catch((error) => {
                if ((error as Error).name === "AbortError") {
                    this.debugLog("Connection aborted");
                    throw new Error("Connection aborted");
                }

                // Check for network errors
                if (!navigator.onLine) {
                    throw new Error("No internet connection");
                }

                throw error;
            });

            if (response.status === 429) {
                this.debugLog("429 received - Session exists");
                this.handleReconnection();
                return false;
            }

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status} ${response.statusText}`);
            }

            this.debugLog("Connection established");
            this.readyState = 1;
            this.reconnectAttempts = 0;

            if (this.onopen) {
                this.onopen();
            }

            const reader = response.body?.getReader();
            if (!reader) {
                throw new Error("Failed to read response body.");
            }

            let buffer = "";

            const processChunk = async () => {
                if (this.isClosed) {
                    this.debugLog("Stopping chunk processing - EventSource is closed");
                    reader.cancel();
                    return;
                }

                try {
                    const { done, value } = await reader.read();

                    if (done) {
                        this.debugLog("Stream complete");
                        // this.debugLog("Stream complete, closing connection");
                        // this.close();
                        // this.handleReconnection();
                        return;
                    }

                    buffer += new TextDecoder().decode(value, { stream: true });
                    const parts = buffer.split("\n\n");
                    buffer = parts.pop() || "";

                    parts.forEach((part) => {
                        if (!part.trim()) {
                            this.debugLog("Received empty line - Skipping...");
                            return;
                        }

                        try {
                            const event = JSON.parse(part);
                            this.debugLog("Received event:", event);

                            if (event) {
                                if (this.onmessage) {
                                    this.onmessage(event);
                                }

                                if (this.listeners[event.ps]) {
                                    this.listeners[event.ps].forEach((callback) => callback(event));
                                }
                            }
                        } catch (parseError) {
                            this.debugLog("Failed to parse event:", part, parseError);
                        }
                    });

                    if (!this.isClosed) {
                        setTimeout(processChunk, 0);
                    }
                } catch (error) {
                    if ((error as Error).name === "AbortError") {
                        this.debugLog("Chunk processing aborted");
                        return;
                    }

                    this.debugLog("Error processing chunk:", error);
                    this.handleReconnection(error as Error);
                }
            };

            processChunk();
            return true;
        } catch (err) {
            this.debugLog("Connection failed:", err);

            if (this.onerror) {
                this.onerror(err as Error);
            }

            this.handleReconnection(err as Error);
            return false;
        }
    }

    private handleReconnection(err?: Error) {
        if (this.isClosed) {
            this.debugLog("Reconnection aborted - EventSource is closed");
            return;
        }

        if (err && this.onerror) {
            this.onerror(err);
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            const errMsg = "Max reconnection attempts reached";
            this.debugLog(errMsg);
            if (this.onerror) {
                this.onerror(new Error(errMsg));
            }
            this.close();
            return;
        }

        this.reconnectAttempts += 1;

        if (this.onreconnect) {
            this.onreconnect();
        }

        const delay = this.reconnectDelay * this.reconnectAttempts;
        this.debugLog(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

        setTimeout(() => {
            if (!this.isClosed) {
                this.debugLog(`Attempting reconnection ${this.reconnectAttempts}`);
                this.connect();
            }
        }, delay);
    }

    public addEventListener(event: string, callback: EventListener) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    public removeEventListener(event: string, callback: EventListener) {
        if (this.listeners[event]) {
            this.listeners[event] = this.listeners[event].filter((cb) => cb !== callback);
        }
    }

    public close() {
        this.debugLog("Closing EventSource");
        this.isClosed = true;
        this.readyState = 2;

        if (this.controller) {
            this.controller.abort();
            this.controller = null;
        }

        this.reconnectAttempts = this.maxReconnectAttempts;
    }
}

export default CustomEventSource;
