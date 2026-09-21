// WildPress fork: client for the server-side reminder webhook config
// (GET/PUT /v1/webhook-config on the self-hosted cloud). Same-origin from the web
// build; uses the stored self-hosted cloud URL + token for auth.

import { getCloudConfigLocal } from './sync-service-config';

export type WebhookUiConfig = {
    enabled: boolean;
    url: string;
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
