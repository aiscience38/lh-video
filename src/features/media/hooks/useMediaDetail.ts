"use client";

import useSWR from "swr";
import type { VideoTask } from "@/types";
import { fetchFilmstrip, fetchMediaTask } from "../lib/api";
import type { Filmstrip } from "../types";

export function useMediaTask(taskId: string) {
    const { data, error, isLoading, mutate } = useSWR<VideoTask, Error>(
        `/api/tasks/${encodeURIComponent(taskId)}`,
        () => fetchMediaTask(taskId),
        { revalidateOnFocus: false, shouldRetryOnError: false },
    );
    return { task: data, error, isLoading, mutate };
}

export function useFilmstrip(taskId: string) {
    const { data, error, isLoading } = useSWR<Filmstrip, Error>(
        `/api/media/${encodeURIComponent(taskId)}/frames`,
        () => fetchFilmstrip(taskId),
        { revalidateOnFocus: false, shouldRetryOnError: false },
    );
    return { filmstrip: data, error, isLoading };
}
