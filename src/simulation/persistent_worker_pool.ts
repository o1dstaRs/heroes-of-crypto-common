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

import { Worker, type WorkerOptions, type MessagePort, parentPort } from "node:worker_threads";

export interface IPersistentWorkerTask<TRequest> {
    readonly type: "task";
    readonly taskId: number;
    readonly payload: TRequest;
}

export interface IPersistentWorkerStop {
    readonly type: "stop";
}

export type PersistentWorkerRequest<TRequest> = IPersistentWorkerTask<TRequest> | IPersistentWorkerStop;

export type PersistentWorkerResponse<TResult> =
    | { readonly type: "ready" }
    | { readonly type: "result"; readonly taskId: number; readonly result: TResult }
    | { readonly type: "error"; readonly taskId: number; readonly error: string };

export interface IPersistentWorkerBatchProgress {
    readonly completed: number;
    readonly total: number;
}

export interface IPersistentWorkerPoolOptions {
    /** Maximum number of live workers. Values are normalized to a positive integer. */
    readonly concurrency: number;
    /** Maximum dispatched-waiting tasks. Batches backpressure at this bound; defaults to concurrency. */
    readonly maxQueuedTasks?: number;
    readonly workerUrl: URL;
    readonly workerOptions?: WorkerOptions;
}

interface IQueuedTask<TRequest, TResult> {
    readonly id: number;
    readonly payload: TRequest;
    readonly resolve: (result: TResult) => void;
    readonly reject: (error: Error) => void;
}

interface IWorkerSlot<TRequest, TResult> {
    readonly worker: Worker;
    ready: boolean;
    stopping: boolean;
    intentionalStop: boolean;
    task: IQueuedTask<TRequest, TResult> | null;
    failure: Error | null;
}

type PoolState = "open" | "closing" | "closed";

const errorValue = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

const positiveConcurrency = (value: number): number => {
    if (!Number.isFinite(value)) return 1;
    return Math.max(1, Math.floor(value));
};

/**
 * A bounded FIFO worker pool whose threads stay alive across many batches. Workers use the small protocol
 * exported above, so callers send plain structured-cloneable request objects instead of spawning one Bun
 * process (and a fresh worker set) per candidate evaluation.
 */
export class PersistentWorkerPool<TRequest, TResult> {
    public readonly concurrency: number;
    public readonly maxQueuedTasks: number;
    private readonly workerUrl: URL;
    private readonly workerOptions: WorkerOptions | undefined;
    private readonly queue: IQueuedTask<TRequest, TResult>[] = [];
    private readonly capacityWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
    private readonly slots = new Set<IWorkerSlot<TRequest, TResult>>();
    private state: PoolState = "open";
    private nextTaskId = 1;
    private reservedQueueSlots = 0;
    private closePromise: Promise<void> | null = null;
    private resolveClose: (() => void) | null = null;
    public constructor(options: IPersistentWorkerPoolOptions) {
        this.concurrency = positiveConcurrency(options.concurrency);
        this.maxQueuedTasks = positiveConcurrency(options.maxQueuedTasks ?? this.concurrency);
        this.workerUrl = options.workerUrl;
        this.workerOptions = options.workerOptions;
        for (let index = 0; index < this.concurrency; index += 1) this.spawnWorker();
    }
    /** Number of currently live worker threads (primarily useful for telemetry and lifecycle tests). */
    public get workerCount(): number {
        return this.slots.size;
    }
    /** Queue one task. The promise settles when exactly one worker response carrying its task id arrives. */
    public run(payload: TRequest): Promise<TResult> {
        if (this.state !== "open") return Promise.reject(new Error("PersistentWorkerPool is closing"));
        if (this.queue.length + this.reservedQueueSlots >= this.maxQueuedTasks) {
            return Promise.reject(new Error(`PersistentWorkerPool queue is full (${this.maxQueuedTasks})`));
        }
        return this.enqueue(payload);
    }
    /** Queue a batch while preserving request order and applying backpressure at maxQueuedTasks. */
    public async runBatch(
        payloads: readonly TRequest[],
        onProgress?: (progress: IPersistentWorkerBatchProgress) => void,
    ): Promise<TResult[]> {
        const results = new Array<TResult>(payloads.length);
        let next = 0;
        let completed = 0;
        let failure: Error | null = null;
        const lane = async (): Promise<void> => {
            while (!failure) {
                const index = next;
                if (index >= payloads.length) return;
                next += 1;
                try {
                    results[index] = await this.runWithBackpressure(payloads[index]);
                    completed += 1;
                    onProgress?.({ completed, total: payloads.length });
                } catch (error) {
                    failure = errorValue(error);
                    throw failure;
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, payloads.length) }, () => lane()));
        return results;
    }
    /** Continue after task errors and return settlements in request order. */
    public async runBatchSettled(
        payloads: readonly TRequest[],
        onProgress?: (progress: IPersistentWorkerBatchProgress) => void,
    ): Promise<PromiseSettledResult<TResult>[]> {
        const results = new Array<PromiseSettledResult<TResult>>(payloads.length);
        let next = 0;
        let completed = 0;
        const lane = async (): Promise<void> => {
            while (true) {
                const index = next;
                if (index >= payloads.length) return;
                next += 1;
                try {
                    results[index] = { status: "fulfilled", value: await this.runWithBackpressure(payloads[index]) };
                } catch (reason) {
                    results[index] = { status: "rejected", reason };
                }
                completed += 1;
                onProgress?.({ completed, total: payloads.length });
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.concurrency, payloads.length) }, () => lane()));
        return results;
    }
    private enqueue(payload: TRequest, reserved = false): Promise<TResult> {
        if (reserved) this.reservedQueueSlots -= 1;
        return new Promise<TResult>((resolve, reject) => {
            this.queue.push({ id: this.nextTaskId, payload, resolve, reject });
            this.nextTaskId += 1;
            this.dispatch();
        });
    }
    /**
     * Stop accepting work, drain queued/active tasks, then ask every worker to exit. Multiple calls share
     * the same promise. Use terminate() when a caller explicitly wants to abandon pending work.
     */
    public close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        if (this.state === "closed") return Promise.resolve();
        this.state = "closing";
        this.rejectCapacityWaiters(new Error("PersistentWorkerPool is closing"));
        this.closePromise = new Promise<void>((resolve) => {
            this.resolveClose = resolve;
        });
        this.dispatch();
        this.finishCloseIfPossible();
        return this.closePromise;
    }
    /** Immediately reject unfinished work and terminate all live workers. */
    public async terminate(reason: unknown = new Error("PersistentWorkerPool terminated")): Promise<void> {
        if (this.state === "closed") return;
        this.state = "closed";
        const error = errorValue(reason);
        this.rejectCapacityWaiters(error);
        for (const task of this.queue.splice(0)) task.reject(error);
        const terminations: Promise<number>[] = [];
        for (const slot of this.slots) {
            if (slot.task) {
                slot.task.reject(error);
                slot.task = null;
            }
            slot.stopping = true;
            terminations.push(slot.worker.terminate());
        }
        await Promise.allSettled(terminations);
        this.slots.clear();
        this.resolveClose?.();
        this.resolveClose = null;
    }
    private spawnWorker(): void {
        if (this.state === "closed") return;
        const worker = new Worker(this.workerUrl, this.workerOptions);
        const slot: IWorkerSlot<TRequest, TResult> = {
            worker,
            ready: false,
            stopping: false,
            intentionalStop: false,
            task: null,
            failure: null,
        };
        this.slots.add(slot);
        worker.on("message", (message: PersistentWorkerResponse<TResult>) => this.receive(slot, message));
        worker.on("error", (error) => {
            slot.failure = errorValue(error);
        });
        worker.on("exit", (code) => this.workerExited(slot, code));
    }
    private receive(slot: IWorkerSlot<TRequest, TResult>, message: PersistentWorkerResponse<TResult>): void {
        if (!this.slots.has(slot) || slot.stopping || this.state === "closed") return;
        if (message.type === "ready") {
            if (slot.ready) {
                this.failSlot(slot, new Error("Persistent worker sent ready more than once"));
                return;
            }
            slot.ready = true;
            this.dispatch();
            return;
        }
        const task = slot.task;
        if (!task || message.taskId !== task.id) {
            this.failSlot(
                slot,
                new Error(`Persistent worker returned unexpected task ${message.taskId}; active=${task?.id ?? "none"}`),
            );
            return;
        }
        slot.task = null;
        if (message.type === "result") task.resolve(message.result);
        else task.reject(new Error(message.error));
        this.dispatch();
        this.finishCloseIfPossible();
    }
    private dispatch(): void {
        if (this.state === "closed") return;
        for (const slot of this.slots) {
            if (!slot.ready || slot.stopping || slot.task) continue;
            const task = this.queue.shift();
            if (task) {
                this.releaseQueueCapacity();
                slot.task = task;
                try {
                    slot.worker.postMessage({ type: "task", taskId: task.id, payload: task.payload });
                } catch (error) {
                    this.failSlot(slot, errorValue(error));
                }
            } else if (this.state === "closing") {
                slot.stopping = true;
                slot.intentionalStop = true;
                slot.worker.postMessage({ type: "stop" } satisfies IPersistentWorkerStop);
                // The stop message is the graceful half; this is the half that actually ends the
                // thread. A worker answers stop with port.close(), which under Node lets the loop
                // drain and the thread exit — under Bun it closes the port and leaves the thread
                // alive, so "exit" never fires, workerExited() never drops the slot, and
                // finishCloseIfPossible() blocks on slots.size forever. The slot is idle by
                // construction in this branch (no task, empty queue), so nothing is lost.
                void slot.worker.terminate();
            }
        }
    }
    private failSlot(slot: IWorkerSlot<TRequest, TResult>, error: Error): void {
        slot.failure = error;
        slot.stopping = true;
        if (slot.task) {
            slot.task.reject(error);
            slot.task = null;
        }
        void slot.worker.terminate();
    }
    private workerExited(slot: IWorkerSlot<TRequest, TResult>, code: number): void {
        if (!this.slots.delete(slot)) return;
        const expected = slot.intentionalStop && !slot.task;
        const error = slot.failure ?? new Error(`Persistent worker exited unexpectedly with code ${code}`);
        if (slot.task) {
            slot.task.reject(
                slot.failure ?? new Error(`Persistent worker exited ${code} while running task ${slot.task.id}`),
            );
            slot.task = null;
        }
        if (!expected && this.state !== "closed") {
            if (!slot.ready) {
                this.failPool(error);
                return;
            }
            if (this.state === "open" || this.queue.length > 0) {
                this.spawnWorker();
            } else if (code !== 0) {
                for (const task of this.queue.splice(0)) task.reject(error);
            }
        }
        this.dispatch();
        this.finishCloseIfPossible();
    }
    private finishCloseIfPossible(): void {
        if (this.state !== "closing" || this.queue.length > 0) return;
        if ([...this.slots].some((slot) => slot.task || !slot.stopping)) return;
        if (this.slots.size > 0) return;
        this.state = "closed";
        this.resolveClose?.();
        this.resolveClose = null;
    }
    private async runWithBackpressure(payload: TRequest): Promise<TResult> {
        await this.acquireQueueCapacity();
        if (this.state !== "open") {
            this.reservedQueueSlots -= 1;
            throw new Error("PersistentWorkerPool is closing");
        }
        return this.enqueue(payload, true);
    }
    private acquireQueueCapacity(): Promise<void> {
        if (this.state !== "open") return Promise.reject(new Error("PersistentWorkerPool is closing"));
        if (this.queue.length + this.reservedQueueSlots < this.maxQueuedTasks) {
            this.reservedQueueSlots += 1;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            this.capacityWaiters.push({ resolve, reject });
        });
    }
    private releaseQueueCapacity(): void {
        const waiter = this.capacityWaiters.shift();
        if (!waiter) return;
        this.reservedQueueSlots += 1;
        waiter.resolve();
    }
    private rejectCapacityWaiters(error: Error): void {
        for (const waiter of this.capacityWaiters.splice(0)) waiter.reject(error);
    }
    private failPool(error: Error): void {
        if (this.state === "closed") return;
        this.state = "closed";
        this.rejectCapacityWaiters(error);
        for (const task of this.queue.splice(0)) task.reject(error);
        for (const slot of this.slots) {
            if (slot.task) {
                slot.task.reject(error);
                slot.task = null;
            }
            slot.stopping = true;
            slot.intentionalStop = true;
            void slot.worker.terminate();
        }
        this.slots.clear();
        this.resolveClose?.();
        this.resolveClose = null;
    }
}

const serializeWorkerError = (error: unknown): string =>
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);

/** Install the worker half of the protocol used by PersistentWorkerPool. */
export function startPersistentWorker<TRequest, TResult>(
    handler: (payload: TRequest) => TResult | Promise<TResult>,
    port: MessagePort | null = parentPort,
): void {
    if (!port) throw new Error("startPersistentWorker must run in a worker thread");
    let busy = false;
    port.on("message", async (message: PersistentWorkerRequest<TRequest>) => {
        if (message.type === "stop") {
            if (busy) throw new Error("Persistent worker received stop while busy");
            port.close();
            return;
        }
        if (busy) {
            port.postMessage({
                type: "error",
                taskId: message.taskId,
                error: "Persistent worker received overlapping tasks",
            } satisfies PersistentWorkerResponse<TResult>);
            return;
        }
        busy = true;
        try {
            const result = await handler(message.payload);
            port.postMessage({
                type: "result",
                taskId: message.taskId,
                result,
            } satisfies PersistentWorkerResponse<TResult>);
        } catch (error) {
            port.postMessage({
                type: "error",
                taskId: message.taskId,
                error: serializeWorkerError(error),
            } satisfies PersistentWorkerResponse<TResult>);
        } finally {
            busy = false;
        }
    });
    port.postMessage({ type: "ready" } satisfies PersistentWorkerResponse<TResult>);
}
