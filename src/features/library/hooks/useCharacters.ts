"use client";

import useSWR from "swr";
import { listLibrary } from "../lib/api";

export const CHARACTERS_KEY = "library:characters";

export function useCharacters() {
    return useSWR(CHARACTERS_KEY, () => listLibrary("character"));
}
