// WildPress fork: settings section for the server-side reminder webhook.
// Loads/saves per-namespace config via /v1/webhook-config (stored on the server,
// not in the synced document). Only rendered when self-hosted sync is configured.
//
// Auto-saves on every change, like the other settings (no Save button). "Mirror
// on-device notifications" copies the local reminder/digest settings into the
// webhook config so they need not be entered twice, and stays in step with them
// while mirroring is on (the server stores concrete values, not a live mirror).

import { Bell } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useTaskStore, type AppData } from '@mindwtr/core';

import { reportError } from '../../../lib/report-error';
import {
    DEFAULT_WEBHOOK_UI_CONFIG,
    fetchWebhookConfig,
    isWebhookConfigAvailable,
    saveWebhookConfig,
    testWebhookConfig,
    WEBHOOK_TEST_KINDS,
    type WebhookTestResult,
    type WebhookUiConfig,
} from '../../../lib/webhook-config-client';
import { Switch } from '../../ui/Switch';
import { TimeInput } from '../../ui/TimeInput';
import { SettingRow } from './SettingRow';

type WeekdayOption = { value: number; label: string };

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

export function ServerWebhookSection({ weekdayOptions, showSaved }: { weekdayOptions: WeekdayOption[]; showSaved: () => void }) {
    const [available] = useState(() => isWebhookConfigAvailable());
    const settings = useTaskStore((state) => state.settings) ?? ({} as AppData['settings']);
    const [config, setConfig] = useState<WebhookUiConfig>(DEFAULT_WEBHOOK_UI_CONFIG);
    const [ready, setReady] = useState(false);
    const [error, setError] = useState('');
    const [testing, setTesting] = useState(false);
    const [testKind, setTestKind] = useState<string>(WEBHOOK_TEST_KINDS[0].value);
    const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
    // Serialised payload last sent, so an unchanged value (e.g. a re-render or a
    // blur with no edit) never fires a redundant PUT or "Saved" toast.
    const lastPersisted = useRef('');

    const runTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            setTestResult(await testWebhookConfig(testKind));
        } catch (testError) {
            setTestResult({ ok: false, error: testError instanceof Error ? testError.message : String(testError) });
        } finally {
            setTesting(false);
        }
    };

    const buildPayload = (next: WebhookUiConfig): WebhookUiConfig =>
        (next.mirror ? { ...next, ...mirroredFromSettings(settings) } : next);

    const persist = (next: WebhookUiConfig) => {
        const payload = buildPayload(next);
        const key = JSON.stringify(payload);
        if (key === lastPersisted.current) return;
        lastPersisted.current = key;
        saveWebhookConfig(payload)
            .then(() => { setError(''); showSaved(); })
            .catch((saveError) => {
                lastPersisted.current = '';
                setError(saveError instanceof Error ? saveError.message : String(saveError));
            });
    };

    const update = (next: WebhookUiConfig) => {
        setConfig(next);
        persist(next);
    };

    useEffect(() => {
        if (!available) return;
        let active = true;
        fetchWebhookConfig()
            .then((loaded) => {
                if (!active) return;
                setConfig(loaded);
                // Seed the dedupe key with what the server already holds, so simply
                // opening the page never triggers a save.
                lastPersisted.current = JSON.stringify(loaded.mirror ? { ...loaded, ...mirroredFromSettings(settings) } : loaded);
                setReady(true);
            })
            .catch((loadError) => {
                if (!active) return;
                reportError('Failed to load server webhook config', loadError);
                setConfig(DEFAULT_WEBHOOK_UI_CONFIG);
                setReady(true);
            });
        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [available]);

    // Keep the stored snapshot in step with the on-device settings while mirroring.
    const mirrorKey = JSON.stringify(mirroredFromSettings(settings));
    useEffect(() => {
        if (!ready || !config.enabled || !config.mirror) return;
        persist(config);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready, config.enabled, config.mirror, mirrorKey]);

    if (!available) return null;

    const mirror = config.mirror;
    const view: WebhookUiConfig = mirror ? { ...config, ...mirroredFromSettings(settings) } : config;
    const off = !config.enabled;
    const locked = off || mirror;

    const patchKinds = (updates: Partial<WebhookUiConfig['kinds']>) => update({ ...config, kinds: { ...config.kinds, ...updates } });
    const patchDigest = (updates: Partial<WebhookUiConfig['digest']>) => update({ ...config, digest: { ...config.digest, ...updates } });

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
                        onCheckedChange={(enabled) => update({ ...config, enabled })}
                        aria-label="Enable server webhook"
                    />
                </SettingRow>

                <SettingRow settingsKey="serverWebhookUrl" title="Webhook URL">
                    <input
                        type="url"
                        value={config.url}
                        disabled={off}
                        placeholder="https://…"
                        onChange={(event) => setConfig((prev) => ({ ...prev, url: event.target.value }))}
                        onBlur={() => persist(config)}
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
                        onCheckedChange={(value) => update({ ...config, mirror: value })}
                        aria-label="Mirror on-device notifications"
                    />
                </SettingRow>

                <SettingRow settingsKey="serverWebhookStart" title="Start date reminders">
                    <Switch
                        checked={view.kinds.start}
                        disabled={locked}
                        onCheckedChange={(start) => patchKinds({ start })}
                        aria-label="Start date reminders"
                    />
                </SettingRow>
                <SettingRow settingsKey="serverWebhookDue" title="Due date reminders">
                    <Switch
                        checked={view.kinds.due}
                        disabled={locked}
                        onCheckedChange={(due) => patchKinds({ due })}
                        aria-label="Due date reminders"
                    />
                </SettingRow>
                <SettingRow settingsKey="serverWebhookReview" title="Review date reminders">
                    <Switch
                        checked={view.kinds.review}
                        disabled={locked}
                        onCheckedChange={(review) => patchKinds({ review })}
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
                    <select
                        value={testKind}
                        disabled={testing || !config.url}
                        onChange={(event) => setTestKind(event.target.value)}
                        className={inputClass}
                        aria-label="Test notification type"
                    >
                        {WEBHOOK_TEST_KINDS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        onClick={runTest}
                        disabled={testing || !config.url}
                        className="px-3 py-1 rounded text-sm border border-border bg-muted hover:bg-muted/80 disabled:opacity-50"
                    >
                        {testing ? 'Testing…' : 'Send test'}
                    </button>
                    {testResult && (testResult.ok
                        ? <span className="text-xs text-muted-foreground">Sent{testResult.status ? ` (${testResult.status})` : ''}</span>
                        : <span className="text-xs text-red-500">{testResult.error ?? 'Failed'}</span>)}
                    {error && <span className="text-xs text-red-500">{error}</span>}
                </div>
            </div>
        </section>
    );
}
