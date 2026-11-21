"use client";

import useSWR from "swr";
import { getScene, listScenes } from "../lib/api";

export const SCENES_KEY = "scenes:list";

export function useScenes() {
    return useSWR(SCENES_KEY, () => listScenes());
}

export function useScene(id: string) {
    return useSWR(["scenes:scene", id], () => getScene(id));
}
