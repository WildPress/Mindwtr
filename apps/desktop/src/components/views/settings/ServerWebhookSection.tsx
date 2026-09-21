// WildPress fork: settings section for the server-side reminder webhook.
// Loads/saves per-namespace config via /v1/webhook-config (stored on the server,
// not in the synced document). Only rendered when self-hosted sync is configured.
//
// "Mirror on-device notifications" copies the local reminder/digest settings into
// the webhook config so they need not be entered twice; the mirrored values are
// persisted on save (the server stores concrete values, not a live mirror).

import { Bell } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useTaskStore, type AppData } from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';
import {
    DEFAULT_WEBHOOK_UI_CONFIG,
    fetchWebhookConfig,
    isWebhookConfigAvailable,
    saveWebhookConfig,
    type WebhookUiConfig,
} from '../../../lib/webhook-config-client';
import { Switch } from '../../ui/Switch';
import { TimeInput } from '../../ui/TimeInput';
import { SettingRow } from './SettingRow';

type WeekdayOption = { value: number; label: string };
type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

const inputClass = 'bg-muted px-2 py-1 rounded text-sm border border-border disabled:opacity-50 disabled:cursor-not-allowed';

/** The kinds/digest the webhook would use if it mirrored the on-device settings. */
function mirroredFromSettings(settings: AppData['settings']): Pick<WebhookUiConfig, 'kinds' | 'digest'> {
    const master = settings?.notificationsEnabled !== false;
    const weeklyDay = Number.isFinite(settings?.weeklyReviewDay) ? (settings?.weeklyReviewDay as number) : 0;
    return {
        kinds: {
            start: master && settings?.startDateNotificationsEnabled !== false,
            due: master && settings?.dueDateNotificationsEnabled !== false,
            review: master && settings?.reviewAtNotificationsEnabled !== false,
        },
        digest: {
            morning: { enabled: settings?.dailyDigestMorningEnabled === true, time: settings?.dailyDigestMorningTime ?? '09:00' },
            evening: { enabled: settings?.dailyDigestEveningEnabled === true, time: settings?.dailyDigestEveningTime ?? '20:00' },
            weekly: { enabled: settings?.weeklyReviewEnabled === true, day: weeklyDay, time: settings?.weeklyReviewTime ?? '18:00' },
        },
    };
}

export function ServerWebhookSection({ weekdayOptions }: { weekdayOptions: WeekdayOption[] }) {
    const [available] = useState(() => isWebhookConfigAvailable());
    const settings = useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const [config, setConfig] = useState<WebhookUiConfig>(DEFAULT_WEBHOOK_UI_CONFIG);
    const [status, setStatus] = useState<Status>('loading');
    const [error, setError] = useState('');

    useEffect(() => {
        if (!available) return;
        let active = true;
        fetchWebhookConfig()
            .then((loaded) => {
                if (active) {
                    setConfig(loaded);
                    setStatus('idle');
                }
            })
            .catch((loadError) => {
                if (!active) return;
                reportError('Failed to load server webhook config', loadError);
                setConfig(DEFAULT_WEBHOOK_UI_CONFIG);
                setStatus('idle');
            });
        return () => {
            active = false;
        };
    }, [available]);

    if (!available) return null;

    const mirror = config.mirror;
    const mirrored = mirroredFromSettings(settings);
    // Values shown in the kind/digest controls: the device settings when mirroring,
    // otherwise the webhook's own stored values.
    const view: WebhookUiConfig = mirror ? { ...config, ...mirrored } : config;
    // Everything under the enable switch is disabled when the webhook is off;
    // kinds/digest are additionally locked while mirroring.
    const off = !config.enabled;
    const locked = off || mirror;

    const patch = (updates: Partial<WebhookUiConfig>) => setConfig((prev) => ({ ...prev, ...updates }));
    const patchDigest = (updates: Partial<WebhookUiConfig['digest']>) =>
        setConfig((prev) => ({ ...prev, digest: { ...prev.digest, ...updates } }));

    const save = async () => {
        setStatus('saving');
        setError('');
        // Persist concrete values: when mirroring, snapshot the device settings.
        const payload: WebhookUiConfig = mirror ? { ...config, ...mirrored } : config;
        try {
            setConfig(await saveWebhookConfig(payload));
            setStatus('saved');
            window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
            setStatus('error');
        }
    };

    return (
        <section className="space-y-3">
            <h2 data-settings-key="serverWebhook" className="text-lg font-semibold flex items-center gap-2">
                <Bell className="w-5 h-5" />
                Server reminders
            </h2>
            <div className="bg-card border border-border rounded-lg p-6 space-y-4">
                <p className="text-sm text-muted-foreground">
                    Fire reminders and digests from the self-hosted server as a webhook, so they arrive
                    even when no device is open. Stored on the server, separate from the on-device
                    notifications above.
                </p>

                <SettingRow settingsKey="serverWebhookEnabled" title="Enable server webhook">
                    <Switch
                        checked={config.enabled}
                        onCheckedChange={(enabled) => patch({ enabled })}
                        aria-label="Enable server webhook"
                    />
                </SettingRow>

                <SettingRow settingsKey="serverWebhookUrl" title="Webhook URL">
                    <input
                        type="url"
                        value={config.url}
                        disabled={off}
                        placeholder="https://…"
                        onChange={(event) => patch({ url: event.target.value })}
                        className={`${inputClass} w-64`}
                        aria-label="Webhook URL"
                    />
                </SettingRow>

                <SettingRow
                    settingsKey="serverWebhookMirror"
                    title="Mirror on-device notifications"
                    description="Use the same reminders and digest times as the on-device notifications above."
                >
                    <Switch
                        checked={mirror}
                        disabled={off}
                        onCheckedChange={(value) => patch({ mirror: value })}
                        aria-label="Mirror on-device notifications"
                    />
                </SettingRow>

                <SettingRow settingsKey="serverWebhookStart" title="Start date reminders">
                    <Switch
                        checked={view.kinds.start}
                        disabled={locked}
                        onCheckedChange={(start) => patch({ kinds: { ...config.kinds, start } })}
                        aria-label="Start date reminders"
                    />
                </SettingRow>
                <SettingRow settingsKey="serverWebhookDue" title="Due date reminders">
                    <Switch
                        checked={view.kinds.due}
                        disabled={locked}
                        onCheckedChange={(due) => patch({ kinds: { ...config.kinds, due } })}
                        aria-label="Due date reminders"
                    />
                </SettingRow>
                <SettingRow settingsKey="serverWebhookReview" title="Review date reminders">
                    <Switch
                        checked={view.kinds.review}
                        disabled={locked}
                        onCheckedChange={(review) => patch({ kinds: { ...config.kinds, review } })}
                        aria-label="Review date reminders"
                    />
                </SettingRow>

                <div className="border-t border-border/50" />

                <div data-settings-key="serverWebhookDigests" className="space-y-3">
                    <div>
                        <p className="text-sm font-medium">Digests</p>
                        <p className="text-xs text-muted-foreground mt-1">Morning, evening and weekly review prompts.</p>
                    </div>

                    <SettingRow settingsKey="serverWebhookMorning" title="Morning briefing">
                        <TimeInput
                            aria-label="Morning briefing time"
                            value={view.digest.morning.time}
                            disabled={locked || !view.digest.morning.enabled}
                            onChange={(time) => patchDigest({ morning: { ...config.digest.morning, time } })}
                            className={inputClass}
                        />
                        <Switch
                            checked={view.digest.morning.enabled}
                            disabled={locked}
                            onCheckedChange={(enabled) => patchDigest({ morning: { ...config.digest.morning, enabled } })}
                            aria-label="Morning briefing"
                        />
                    </SettingRow>
                    <SettingRow settingsKey="serverWebhookEvening" title="Evening review">
                        <TimeInput
                            aria-label="Evening review time"
                            value={view.digest.evening.time}
                            disabled={locked || !view.digest.evening.enabled}
                            onChange={(time) => patchDigest({ evening: { ...config.digest.evening, time } })}
                            className={inputClass}
                        />
                        <Switch
                            checked={view.digest.evening.enabled}
                            disabled={locked}
                            onCheckedChange={(enabled) => patchDigest({ evening: { ...config.digest.evening, enabled } })}
                            aria-label="Evening review"
                        />
                    </SettingRow>
                    <SettingRow settingsKey="serverWebhookWeekly" title="Weekly review">
                        <select
                            value={view.digest.weekly.day}
                            disabled={locked || !view.digest.weekly.enabled}
                            onChange={(event) => patchDigest({ weekly: { ...config.digest.weekly, day: Number(event.target.value) } })}
                            className={inputClass}
                            aria-label="Weekly review day"
                        >
                            {weekdayOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        <TimeInput
                            aria-label="Weekly review time"
                            value={view.digest.weekly.time}
                            disabled={locked || !view.digest.weekly.enabled}
                            onChange={(time) => patchDigest({ weekly: { ...config.digest.weekly, time } })}
                            className={inputClass}
                        />
                        <Switch
                            checked={view.digest.weekly.enabled}
                            disabled={locked}
                            onCheckedChange={(enabled) => patchDigest({ weekly: { ...config.digest.weekly, enabled } })}
                            aria-label="Weekly review"
                        />
                    </SettingRow>
                </div>

                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={save}
                        disabled={status === 'loading' || status === 'saving'}
                        className="px-3 py-1 rounded text-sm border border-border bg-muted hover:bg-muted/80 disabled:opacity-50"
                    >
                        {status === 'saving' ? 'Saving…' : 'Save'}
                    </button>
                    {status === 'saved' && <span className="text-xs text-muted-foreground">Saved</span>}
                    {status === 'error' && <span className="text-xs text-red-500">{error}</span>}
                </div>
            </div>
        </section>
    );
}
