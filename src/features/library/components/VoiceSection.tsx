"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import useSWR from "swr";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { listTtsProviders, listTtsVoices, previewTtsVoice, type TtsProviderStatus, type TtsVoice } from "../lib/api";
import { DEFAULT_CHARACTER_VOICE, VOICE_LANGUAGES, VOICE_PROVIDERS, type CharacterVoice, type VoiceProvider } from "../types";

const SAMPLE_MAX = 400;

function isAvailable(status: TtsProviderStatus): boolean {
    return status.configured && status.reachable;
}

function isVoiceProvider(value: string): value is VoiceProvider {
    return (VOICE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Optional voice profile editor shared by create and edit dialogs.
 * Provider availability comes from GET /api/tts/providers; a provider is only
 * selectable when it is both configured and reachable. When none is usable the
 * section explains the fallback and the caller still saves the character.
 */
export function VoiceSection({ idPrefix, value, onChange, disabled = false }: {
    idPrefix: string;
    value: CharacterVoice;
    onChange: (voice: CharacterVoice) => void;
    disabled?: boolean;
}) {
    const t = useTranslations("library");
    const { data: providers, error: providersError } = useSWR<TtsProviderStatus[]>("tts:providers", listTtsProviders, { revalidateOnFocus: false });
    const [sample, setSample] = useState(() => t("voice.sampleDefault"));
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [previewBusy, setPreviewBusy] = useState(false);
    const [previewError, setPreviewError] = useState(false);
    const audio = useRef<HTMLAudioElement>(null);

    const knownProviders = (providers ?? []).filter(status => isVoiceProvider(status.provider) && status.provider !== "none");
    const unavailableProviders = knownProviders.filter(status => !isAvailable(status));
    const anyAvailable = knownProviders.some(isAvailable);
    const selectedStatus = knownProviders.find(status => status.provider === value.provider);
    const selectedAvailable = Boolean(selectedStatus && isAvailable(selectedStatus));
    const providerUnavailable = value.provider !== "none" && !selectedAvailable;
    const providerKey = (provider: string) => {
        const key = `voice.providers.${provider}`;
        return t.has(key) ? t(key) : provider;
    };
    const reasonLabel = (reason: string | null) => {
        const key = `voice.reasons.${reason ?? "unknown"}`;
        return t.has(key) ? t(key) : t("voice.reasons.unknown");
    };

    const voiceKey = value.provider !== "none" && selectedAvailable ? `tts:voices:${value.provider}` : null;
    const { data: voices, error: voicesError, isLoading: voicesLoading } = useSWR<TtsVoice[]>(voiceKey,
        () => listTtsVoices(value.provider), { revalidateOnFocus: false });
    const voiceList = voices ?? [];

    useEffect(() => {
        if (previewUrl) void audio.current?.play().catch(() => undefined);
    }, [previewUrl]);

    function clearPreview() {
        setPreviewUrl(null);
        setPreviewError(false);
    }

    function chooseProvider(provider: VoiceProvider) {
        onChange(provider === "none"
            ? { ...DEFAULT_CHARACTER_VOICE, settings: {} }
            : { ...value, provider, voiceId: null, previewAssetId: null });
        clearPreview();
    }

    function chooseVoice(voiceId: string) {
        onChange({ ...value, voiceId: voiceId || null, previewAssetId: null });
        clearPreview();
    }

    async function generatePreview() {
        if (!value.voiceId || !sample.trim() || value.provider === "none") return;
        setPreviewBusy(true);
        setPreviewError(false);
        try {
            const preview = await previewTtsVoice({ provider: value.provider, voiceId: value.voiceId, text: sample.trim().slice(0, SAMPLE_MAX) });
            setPreviewUrl(preview.url);
            onChange({ ...value, previewAssetId: preview.assetId });
        } catch {
            setPreviewError(true);
        } finally {
            setPreviewBusy(false);
        }
    }

    return <section aria-labelledby={`${idPrefix}-voice-title`} data-testid="voice-section"
        className="grid gap-3 rounded-xl border border-white/10 bg-white/[.02] p-3">
        <div className="grid gap-1">
            <h3 id={`${idPrefix}-voice-title`} className="text-sm font-semibold">{t("voice.sectionTitle")}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{t("voice.sectionHint")}</p>
        </div>

        {!providers && !providersError && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{t("voice.checking")}
        </p>}

        {providersError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{t("voice.providersError")}</p>}

        {providers && !providersError && <>
            <div className="grid gap-1.5">
                <Label htmlFor={`${idPrefix}-voice-provider`}>{t("voice.providerLabel")}</Label>
                <select id={`${idPrefix}-voice-provider`} value={value.provider} disabled={disabled}
                    onChange={event => chooseProvider(event.target.value as VoiceProvider)}
                    className="h-9 rounded-lg border border-white/10 bg-[#101214] px-2 text-sm text-foreground outline-none focus-visible:border-ring">
                    <option value="none">{t("voice.providerNone")}</option>
                    {knownProviders.map(status => <option key={status.provider} value={status.provider} disabled={!isAvailable(status)}>
                        {isAvailable(status) ? providerKey(status.provider)
                            : t("voice.providerUnavailable", { provider: providerKey(status.provider), reason: reasonLabel(status.reason) })}
                    </option>)}
                </select>
            </div>

            {unavailableProviders.length > 0 && <ul data-testid="voice-unavailable-list" className="grid gap-1 text-xs text-muted-foreground">
                {unavailableProviders.map(status => <li key={status.provider} data-testid={`voice-unavailable-${status.provider}`}>
                    {t("voice.providerUnavailable", { provider: providerKey(status.provider), reason: reasonLabel(status.reason) })}
                </li>)}
            </ul>}

            {!anyAvailable && <div data-testid="voice-fallback" role="note" className="grid gap-1 rounded-lg border border-amber-400/25 bg-amber-400/[.06] p-3">
                <p className="text-xs font-medium text-amber-200">{t("voice.noProvidersTitle")}</p>
                <p className="text-xs leading-relaxed text-muted-foreground">{t("voice.noProviders")}</p>
            </div>}

            {providerUnavailable && <p data-testid="voice-selected-unavailable" role="status" className="text-xs text-muted-foreground">
                {t("voice.selectedUnavailable", {
                    provider: providerKey(value.provider),
                    reason: selectedStatus ? reasonLabel(selectedStatus.reason) : t("voice.reasons.unknown"),
                })}
            </p>}

            {selectedAvailable && <>
                <div className="grid gap-1.5">
                    <Label htmlFor={`${idPrefix}-voice-id`}>{t("voice.voiceLabel")}</Label>
                    {voicesLoading
                        ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 aria-hidden="true" className="size-3.5 animate-spin" />{t("voice.voicesLoading")}</p>
                        : voicesError
                            ? <p role="alert" className="text-xs text-destructive">{t("voice.voicesError")}</p>
                            : <select id={`${idPrefix}-voice-id`} value={value.voiceId ?? ""} disabled={disabled} onChange={event => chooseVoice(event.target.value)}
                                className="h-9 rounded-lg border border-white/10 bg-[#101214] px-2 text-sm text-foreground outline-none focus-visible:border-ring">
                                <option value="">{t("voice.voicePlaceholder")}</option>
                                {voiceList.map(voice => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
                            </select>}
                    {!voicesLoading && !voicesError && voiceList.length === 0 && <p className="text-xs text-muted-foreground">{t("voice.voicesEmpty")}</p>}
                </div>

                <div className="grid gap-1.5">
                    <Label htmlFor={`${idPrefix}-voice-language`}>{t("voice.languageLabel")}</Label>
                    <select id={`${idPrefix}-voice-language`} value={value.language} disabled={disabled}
                        onChange={event => onChange({ ...value, language: event.target.value })}
                        className="h-9 rounded-lg border border-white/10 bg-[#101214] px-2 text-sm text-foreground outline-none focus-visible:border-ring">
                        {VOICE_LANGUAGES.map(language => <option key={language} value={language}>{t(`voice.languages.${language}`)}</option>)}
                    </select>
                </div>

                <div className="grid gap-1.5">
                    <Label htmlFor={`${idPrefix}-voice-sample`}>{t("voice.sampleLabel")}</Label>
                    <Textarea id={`${idPrefix}-voice-sample`} rows={2} maxLength={SAMPLE_MAX} value={sample} disabled={disabled}
                        onChange={event => setSample(event.target.value)} placeholder={t("voice.samplePlaceholder")} />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" size="sm" disabled={disabled || previewBusy || !value.voiceId || !sample.trim()} onClick={() => void generatePreview()}>
                        {previewBusy ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Play aria-hidden="true" />}
                        {t(previewBusy ? "voice.previewing" : "voice.preview")}
                    </Button>
                    {value.previewAssetId && !previewUrl && <span role="status" className="text-xs text-muted-foreground">{t("voice.previewSaved")}</span>}
                </div>

                {previewError && <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{t("voice.previewError")}</p>}
                {previewUrl && <div className="grid gap-1">
                    <audio ref={audio} src={previewUrl} controls aria-label={t("voice.audioLabel")} data-testid="voice-preview-audio" className="w-full" />
                    <p role="status" className="text-xs text-muted-foreground">{t("voice.previewReady")}</p>
                </div>}
            </>}
        </>}
    </section>;
}
