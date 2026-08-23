import { parentPort } from "node:worker_threads";

type Request = { type: "pair"; pair: number } | { type: "stop" };

if (!parentPort) {
    throw new Error("ai_meta_worker_pool_fixture must run in a worker thread");
}

parentPort.on("message", (message: Request) => {
    if (message.type === "stop") {
        parentPort!.close();
        return;
    }
    // The pool treats records as opaque payloads. Only pair identity is needed to prove that recycling
    // neither drops nor duplicates dispatched work; the real worker's record is covered in its own test.
    parentPort!.postMessage({ type: "result", record: { pair: message.pair } });
});

parentPort.postMessage({ type: "ready" });
