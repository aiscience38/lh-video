import "server-only";

import { appendAsset, hashPrompt, readAsset, LEDGER_CONFLICT_ERROR } from "@/server/ledger/store";
import { saveTtsAudio } from "@/server/media/storage";
import type { TtsProviderId, TtsSynthResult } from "./contract";

/**
 * Materializes a synthesized MP3 as a content-addressed file and records it in
 * the shared asset ledger.
 *
 * ElevenLabs is billed per character, so its row is a quoted hold
 * (`estimated: true`). ComfyUI runs on local hardware and is always 0, which
 * the ledger schema requires for the `comfyui` provider.
 */

/** Published Creator-tier rate, ~$0.18 per 1,000 characters; kept as a quote. */
export const ELEVENLABS_ESTIMATED_USD_PER_CHARACTER = 0.00018;

export interface MaterializedTtsAsset {
    assetId: string;
    url: string;
    mimeType: string;
}

export function estimateElevenLabsCostUsd(text: string): number {
    return Math.round(text.length * ELEVENLABS_ESTIMATED_USD_PER_CHARACTER * 1_000_000) / 1_000_000;
}

export async function materializeTtsAsset(
    provider: TtsProviderId,
    text: string,
    result: TtsSynthResult,
    model?: string,
): Promise<MaterializedTtsAsset> {
    const filename = await saveTtsAudio(Buffer.from(result.bytes));
    const assetId = filename.slice(0, -".mp3".length);
    // Identical bytes deduplicate to the same content address; the ledger has
    // exactly one row per asset, so an existing row is the success path.
    if (!(await readAsset(assetId))) {
        try {
            await appendAsset({
                assetId,
                source: "provider",
                provider,
                model: provider === "elevenlabs" ? model?.trim() || "eleven_multilingual_v2" : "qwen3-tts",
                promptHash: hashPrompt(text),
                costUsd: provider === "elevenlabs" ? estimateElevenLabsCostUsd(text) : 0,
                license: "unknown",
                estimated: provider === "elevenlabs",
            });
        } catch (error) {
            if (!(error instanceof Error) || error.message !== LEDGER_CONFLICT_ERROR) throw error;
        }
    }
    return { assetId, url: `/api/tts/audio/${assetId}`, mimeType: result.mimeType };
}
