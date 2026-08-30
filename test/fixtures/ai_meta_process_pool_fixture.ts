import { type AiMetaProcessRequest } from "../../src/simulation/ai_meta_cohorts_process_protocol";

if (!process.send) throw new Error("ai_meta_process_pool_fixture requires Bun IPC");

process.on("message", (message: AiMetaProcessRequest) => {
    if (message.type === "stop") {
        process.disconnect?.();
        return;
    }
    process.send?.({
        type: "result",
        taskId: message.taskId,
        record: { pair: message.task.pair, processId: process.pid },
    });
});

process.send({ type: "ready" });
