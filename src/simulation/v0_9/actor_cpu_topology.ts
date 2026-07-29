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

import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { spawnSync } from "node:child_process";

import { fingerprintV09 } from "./protocol";

export interface IV09ActorPhysicalCpuRow {
    cpu: number;
    core: number;
    socket: number;
}

export interface IV09ActorCpuTopology {
    allowedLogicalCpuIds: number[];
    physicalCpuRows: IV09ActorPhysicalCpuRow[];
    physicalCpuIds: number[];
    topologySha256: string;
}

export function parseV09LinuxCpuList(value: string): number[] {
    const cpus = new Set<number>();
    for (const rawRange of value.split(",")) {
        const range = rawRange.trim();
        if (!range) continue;
        const match = /^(\d+)(?:-(\d+))?$/.exec(range);
        if (!match) throw new Error(`invalid Linux CPU range ${range}`);
        const first = Number(match[1]);
        const last = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) {
            throw new Error(`invalid Linux CPU range ${range}`);
        }
        for (let cpu = first; cpu <= last; cpu += 1) cpus.add(cpu);
    }
    if (!cpus.size) throw new Error("Linux process affinity is empty");
    return [...cpus].sort((left, right) => left - right);
}

function linuxActorCpuTopology(): IV09ActorCpuTopology {
    const status = readFileSync("/proc/self/status", "utf8");
    const affinity = /^Cpus_allowed_list:\s*(.+)$/m.exec(status);
    if (!affinity) throw new Error("cannot read Cpus_allowed_list from /proc/self/status");
    const allowedLogicalCpuIds = parseV09LinuxCpuList(affinity[1]!);
    const allowed = new Set(allowedLogicalCpuIds);
    const lscpu = spawnSync("lscpu", ["-p=CPU,CORE,SOCKET,ONLINE"], { encoding: "utf8" });
    if (lscpu.status !== 0) throw new Error(`lscpu failed: ${lscpu.stderr.trim()}`);
    const physicalCpuRows: IV09ActorPhysicalCpuRow[] = [];
    const seen = new Set<string>();
    for (const line of lscpu.stdout.split(/\r?\n/)) {
        if (!line || line.startsWith("#")) continue;
        const [cpuRaw, coreRaw, socketRaw, online = "Y"] = line.split(",");
        const cpu = Number(cpuRaw);
        const core = Number(coreRaw);
        const socket = Number(socketRaw);
        if (
            !Number.isSafeInteger(cpu) ||
            !Number.isSafeInteger(core) ||
            !Number.isSafeInteger(socket) ||
            online !== "Y" ||
            !allowed.has(cpu)
        ) {
            continue;
        }
        const key = `${socket}:${core}`;
        if (seen.has(key)) continue;
        seen.add(key);
        physicalCpuRows.push({ cpu, core, socket });
    }
    physicalCpuRows.sort((left, right) => left.socket - right.socket || left.core - right.core || left.cpu - right.cpu);
    if (!physicalCpuRows.length) throw new Error("no affinity-allowed physical CPU lanes were discovered");
    return {
        allowedLogicalCpuIds,
        physicalCpuRows,
        physicalCpuIds: physicalCpuRows.map((row) => row.cpu),
        topologySha256: fingerprintV09({ allowedLogicalCpuIds, rows: physicalCpuRows }),
    };
}

export function discoverV09ActorCpuTopology(): IV09ActorCpuTopology {
    if (process.platform === "linux") return linuxActorCpuTopology();
    const physicalCpuIds = Array.from({ length: availableParallelism() }, (_, cpu) => cpu);
    const physicalCpuRows = physicalCpuIds.map((cpu) => ({ cpu, core: cpu, socket: 0 }));
    return {
        allowedLogicalCpuIds: physicalCpuIds,
        physicalCpuRows,
        physicalCpuIds,
        topologySha256: fingerprintV09({ allowedLogicalCpuIds: physicalCpuIds, rows: physicalCpuRows }),
    };
}
