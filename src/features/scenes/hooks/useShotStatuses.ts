"use client";

import useSWR from "swr";
import type { ShotStatus } from "../types";

const FAILED = new Set(["ERROR", "FAILED", "CANCELLED", "CANCELED"]);
const RUNNING = new Set(["IN_PROGRESS", "RUNNING"]);
const DONE = new Set(["COMPLETED", "DONE"]);

/** Reads task statuses from the two existing history endpoints, keyed by task id. */
async function loadTaskStatuses(): Promise<Record<string, string>> {
    const lists = await Promise.all(["/api/tasks", "/api/image-tasks"].map(async url => {
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) return [];
            const body: unknown = await response.json();
            return Array.isArray(body) ? body : [];
        } catch {
            return [];
        }
    }));
    const statuses: Record<string, string> = {};
    for (const list of lists) {
        for (const task of list) {
            if (!task || typeof task !== "object") continue;
            const record = task as Record<string, unknown>;
            if (typeof record.task_id !== "string") continue;
            const status = record.status ?? record.freepik_status;
            if (typeof status === "string" && status) statuses[record.task_id] = status.toUpperCase();
        }
    }
    return statuses;
}

/**
 * `taskIds` is the only task reference a shot stores. Without a record the
 * shot is queued; the chip becomes running/done/failed once a task reports it.
 */
export function deriveShotStatus(taskIds: readonly string[], statuses: Record<string, string> | undefined): ShotStatus {
    if (taskIds.length === 0) return "idle";
    if (!statuses) return "queued";
    const known = taskIds.map(id => statuses[id]).filter((status): status is string => Boolean(status));
    if (known.some(status => FAILED.has(status))) return "failed";
    if (known.some(status => RUNNING.has(status))) return "running";
    if (known.length === taskIds.length && known.every(status => DONE.has(status))) return "done";
    return "queued";
}

export function useTaskStatuses(taskIds: string[]): Record<string, string> | undefined {
    const { data } = useSWR(taskIds.length > 0 ? "scenes:task-statuses" : null, loadTaskStatuses, {
        revalidateOnFocus: false,
        shouldRetryOnError: false,
    });
    return data;
}
