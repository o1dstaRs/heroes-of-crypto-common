/**
 * Finish a standalone simulation CLI after every task has returned and all result files have been written.
 * Bun can spend tens of seconds destroying idle simulation worker realms. Exiting the owning process avoids
 * that cost; this must never be used by an imported library, between batches, or while writers are pending.
 * Drain both output pipes before exiting so a piped completion receipt is not truncated.
 */
export async function exitCompletedWorkerCli(): Promise<never> {
    await Promise.all(
        [process.stdout, process.stderr].map(
            (stream) =>
                new Promise<void>((resolve, reject) => {
                    stream.once("error", reject);
                    stream.end(resolve);
                }),
        ),
    );
    process.exit(0);
}
