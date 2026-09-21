// WildPress fork: client for the server-side reminder webhook config
// (GET/PUT /v1/webhook-config on the self-hosted cloud). Same-origin from the web
// build; uses the stored self-hosted cloud URL + token for auth.

import { getCloudConfigLocal } from './sync-service-config';

export type WebhookUiConfig = {
    enabled: boolean;
    url: string;
    /** When true, kinds/digest mirror the on-device notification settings. */
    mirror: boolean;
    kinds: { start: boolean; due: boolean; review: boolean };
    digest: {
        morning: { enabled: boolean; time: string };
        evening: { enabled: boolean; time: string };
        weekly: { enabled: boolean; day: number; time: string };
    };
};

export const DEFAULT_WEBHOOK_UI_CONFIG: WebhookUiConfig = {
    enabled: false,
    url: '',
    mirror: true,
    kinds: { start: true, due: true, review: true },
    digest: {
        morning: { enabled: false, time: '09:00' },
        evening: { enabled: false, time: '20:00' },
        weekly: { enabled: false, day: 1, time: '18:00' },
    },
};

// The cloud URL is stored as the full sync endpoint (…/v1/data); the webhook
// endpoint is /v1/webhook-config on the same origin.
const cloudCreds = (): { endpoint: string; token: string } | null => {
    const { url, token } = getCloudConfigLocal();
    if (!url || !token) return null;
    try {
        return { endpoint: `${new URL(url).origin}/v1/webhook-config`, token };
    } catch {
        return null;
    }
};

/** True only when self-hosted sync is configured (so the section can render). */
export const isWebhookConfigAvailable = (): boolean => cloudCreds() !== null;

export const fetchWebhookConfig = async (): Promise<WebhookUiConfig> => {
    const creds = cloudCreds();
    if (!creds) throw new Error('Self-hosted sync is not configured.');
    const res = await fetch(creds.endpoint, { headers: { authorization: `Bearer ${creds.token}` } });
    if (!res.ok) throw new Error(`Failed to load webhook config (${res.status}).`);
    return res.json() as Promise<WebhookUiConfig>;
};

export const saveWebhookConfig = async (config: WebhookUiConfig): Promise<WebhookUiConfig> => {
    const creds = cloudCreds();
    if (!creds) throw new Error('Self-hosted sync is not configured.');
    const res = await fetch(creds.endpoint, {
        method: 'PUT',
        headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(config),
    });
    if (!res.ok) {
        let message = `Failed to save webhook config (${res.status}).`;
        try {
            const body = (await res.json()) as { error?: unknown };
            if (typeof body?.error === 'string') message = body.error;
        } catch {
            // Non-JSON error body; keep the status message.
        }
        throw new Error(message);
    }
    return res.json() as Promise<WebhookUiConfig>;
};

export type WebhookTestResult = { ok: boolean; status?: number; error?: string };

/** Notification kinds a test can impersonate, with their labels for the dropdown. */
export const WEBHOOK_TEST_KINDS: ReadonlyArray<{ value: string; label: string }> = [
    { value: 'task-reminder', label: 'Task reminder (due/start)' },
    { value: 'task-review', label: 'Review reminder' },
    { value: 'project-review', label: 'Project review' },
    { value: 'digest-morning', label: 'Morning briefing' },
    { value: 'digest-evening', label: 'Evening review' },
    { value: 'weekly-review', label: 'Weekly review' },
];

/** Ask the server to POST a one-off test payload (of the given kind) to the stored URL. */
export const testWebhookConfig = async (kind: string): Promise<WebhookTestResult> => {
    const creds = cloudCreds();
    if (!creds) throw new Error('Self-hosted sync is not configured.');
    const res = await fetch(creds.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${creds.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
    });
    const body = (await res.json().catch(() => ({}))) as WebhookTestResult;
    if (!res.ok && body.error === undefined) return { ok: false, error: `Test failed (${res.status}).` };
    return body;
};
