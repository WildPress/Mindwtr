// WildPress fork: settings section for the server-side reminder webhook.
// Loads/saves per-namespace config via /v1/webhook-config (stored on the server,
// not in the synced document). Only rendered when self-hosted sync is configured.

import { useEffect, useState } from 'react';

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

export function ServerWebhookSection({ weekdayOptions }: { weekdayOptions: WeekdayOption[] }) {
    const [available] = useState(() => isWebhookConfigAvailable());
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

    const patch = (updates: Partial<WebhookUiConfig>) => setConfig((prev) => ({ ...prev, ...updates }));
    const patchDigest = (updates: Partial<WebhookUiConfig['digest']>) =>
        setConfig((prev) => ({ ...prev, digest: { ...prev.digest, ...updates } }));

    const save = async () => {
        setStatus('saving');
        setError('');
        try {
            setConfig(await saveWebhookConfig(config));
            setStatus('saved');
            window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : String(saveError));
            setStatus('error');
        }
    };

    const busy = status === 'loading' || status === 'saving';

    return (
        <div data-settings-key="serverWebhook" className="space-y-3">
            <div>
                <p className="text-sm font-medium">Server reminders (webhook)</p>
                <p className="text-xs text-muted-foreground mt-1">
                    Fire reminders and digests from the self-hosted server as a webhook, so they arrive
                    even when no device is open. Stored on the server, separate from local notifications.
                </p>
            </div>

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
                    disabled={!config.enabled}
                    placeholder="https://…"
                    onChange={(event) => patch({ url: event.target.value })}
                    className={`${inputClass} w-64`}
                    aria-label="Webhook URL"
                />
            </SettingRow>

            <SettingRow settingsKey="serverWebhookStart" title="Start date reminders">
                <Switch
                    checked={config.kinds.start}
                    onCheckedChange={(start) => patch({ kinds: { ...config.kinds, start } })}
                    aria-label="Start date reminders"
                />
            </SettingRow>
            <SettingRow settingsKey="serverWebhookDue" title="Due date reminders">
                <Switch
                    checked={config.kinds.due}
                    onCheckedChange={(due) => patch({ kinds: { ...config.kinds, due } })}
                    aria-label="Due date reminders"
                />
            </SettingRow>
            <SettingRow settingsKey="serverWebhookReview" title="Review date reminders">
                <Switch
                    checked={config.kinds.review}
                    onCheckedChange={(review) => patch({ kinds: { ...config.kinds, review } })}
                    aria-label="Review date reminders"
                />
            </SettingRow>

            <SettingRow settingsKey="serverWebhookMorning" title="Morning briefing">
                <TimeInput
                    aria-label="Morning briefing time"
                    value={config.digest.morning.time}
                    disabled={!config.digest.morning.enabled}
                    onChange={(time) => patchDigest({ morning: { ...config.digest.morning, time } })}
                    className={inputClass}
                />
                <Switch
                    checked={config.digest.morning.enabled}
                    onCheckedChange={(enabled) => patchDigest({ morning: { ...config.digest.morning, enabled } })}
                    aria-label="Morning briefing"
                />
            </SettingRow>
            <SettingRow settingsKey="serverWebhookEvening" title="Evening review">
                <TimeInput
                    aria-label="Evening review time"
                    value={config.digest.evening.time}
                    disabled={!config.digest.evening.enabled}
                    onChange={(time) => patchDigest({ evening: { ...config.digest.evening, time } })}
                    className={inputClass}
                />
                <Switch
                    checked={config.digest.evening.enabled}
                    onCheckedChange={(enabled) => patchDigest({ evening: { ...config.digest.evening, enabled } })}
                    aria-label="Evening review"
                />
            </SettingRow>
            <SettingRow settingsKey="serverWebhookWeekly" title="Weekly review">
                <select
                    value={config.digest.weekly.day}
                    disabled={!config.digest.weekly.enabled}
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
                    value={config.digest.weekly.time}
                    disabled={!config.digest.weekly.enabled}
                    onChange={(time) => patchDigest({ weekly: { ...config.digest.weekly, time } })}
                    className={inputClass}
                />
                <Switch
                    checked={config.digest.weekly.enabled}
                    onCheckedChange={(enabled) => patchDigest({ weekly: { ...config.digest.weekly, enabled } })}
                    aria-label="Weekly review"
                />
            </SettingRow>

            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={save}
                    disabled={busy}
                    className="px-3 py-1 rounded text-sm border border-border bg-muted hover:bg-muted/80 disabled:opacity-50"
                >
                    {status === 'saving' ? 'Saving…' : 'Save'}
                </button>
                {status === 'saved' && <span className="text-xs text-muted-foreground">Saved</span>}
                {status === 'error' && <span className="text-xs text-red-500">{error}</span>}
            </div>
        </div>
    );
}
