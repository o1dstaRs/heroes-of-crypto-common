/*
 * -----------------------------------------------------------------------------
 * This file is part of the common code of the Heroes of Crypto.
 *
 * Heroes of Crypto and Heroes of Crypto AI are registered trademarks.
 * -----------------------------------------------------------------------------
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

export type V07AlignedV2QuarantineReason = "abandoned" | "corrupt";

export function quarantineV07AlignedV2Path(
    source: string,
    quarantineDirectory: string,
    reason: V07AlignedV2QuarantineReason,
): string {
    const sourceNameSha256 = createHash("sha256").update(basename(source)).digest("hex").slice(0, 16);
    let target: string;
    do {
        target = join(
            quarantineDirectory,
            `.v07-aligned-v2-quarantine-${reason}-${sourceNameSha256}-${Date.now()}-${process.pid}-${randomUUID()}`,
        );
    } while (existsSync(target));
    if (Buffer.byteLength(basename(target)) > 255) throw new Error("aligned v2 quarantine basename exceeds NAME_MAX");
    renameSync(source, target);
    return target;
}
