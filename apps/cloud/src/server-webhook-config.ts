// WildPress fork: per-namespace reminder-webhook config (see server-reminder-webhook.ts).
//
// Option B from the design discussion: rather than riding the app's settings sync
// (which would mean editing the data-loss-sensitive merge), the webhook config for
// each namespace is stored server-side in a sidecar next to the namespace document,
// and edited through a dedicated endpoint the app's UI calls directly. This keeps
// the sync merge untouched. The reminder emitter reads the same sidecar.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

export const WEBHOOK_CONFIG_ROUTE_PATH = '/v1/webhook-config';

// Sidecar filename per namespace: <key>.webhook-config.json (matches the .ics.json
// / .reminder-webhook-state.json sidecar convention already in dataDir).
const configFileName = (key: string): string => `${key}.webhook-config.json`;

export type StoredWebhookConfig = {
    enabled: boolean;
    url: string;
    // UI convenience flag (kinds/digest mirror the device notification settings).
    // The emitter ignores it and uses the concrete kinds/digest as stored.
    mirror: boolean;
    kinds: { start: boolean; due: boolean; review: boolean };
    digest: {
        morning: { enabled: boolean; time: string };
        evening: { enabled: boolean; time: string };
        weekly: { enabled: boolean; day: number; time: string };
    };
};

export const DEFAULT_WEBHOOK_CONFIG: StoredWebhookConfig = Object.freeze({
    enabled: false,
    url: '',
    mirror: true,
    kinds: { start: true, due: true, review: true },
    digest: {
        morning: { enabled: false, time: '09:00' },
        evening: { enabled: false, time: '20:00' },
        weekly: { enabled: false, day: 1, time: '18:00' },
    },
}) as StoredWebhookConfig;

// --- Validation (untrusted request body) ---

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isTime = (v: unknown): v is string =>
    typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** True only for an http(s) URL — the emitter POSTs to it. */
const isWebhookUrl = (v: unknown): v is string => {
    if (typeof v !== 'string' || v.length > 2048) return false;
    if (v === '') return true; // empty = not yet configured
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
};

/** Coerce an arbitrary parsed body into a valid config, or return an error string. */
export const parseWebhookConfig = (body: unknown): { config: StoredWebhookConfig } | { error: string } => {
    if (!isObj(body)) return { error: 'Body must be a JSON object.' };
    if (!isBool(body.enabled)) return { error: '`enabled` must be a boolean.' };
    if (!isWebhookUrl(body.url)) return { error: '`url` must be an http(s) URL or empty.' };
    if (body.enabled && body.url === '') return { error: '`url` is required when `enabled` is true.' };
    if (body.mirror !== undefined && !isBool(body.mirror)) return { error: '`mirror` must be a boolean.' };

    const kinds = body.kinds;
    if (!isObj(kinds) || !isBool(kinds.start) || !isBool(kinds.due) || !isBool(kinds.review)) {
        return { error: '`kinds` must have boolean start/due/review.' };
    }

    const digest = body.digest;
    if (!isObj(digest)) return { error: '`digest` must be an object.' };
    const morning = digest.morning;
    const evening = digest.evening;
    const weekly = digest.weekly;
    if (!isObj(morning) || !isBool(morning.enabled) || !isTime(morning.time)) {
        return { error: '`digest.morning` must have boolean enabled and HH:mm time.' };
    }
    if (!isObj(evening) || !isBool(evening.enabled) || !isTime(evening.time)) {
        return { error: '`digest.evening` must have boolean enabled and HH:mm time.' };
    }
    if (
        !isObj(weekly) || !isBool(weekly.enabled) || !isTime(weekly.time)
        || typeof weekly.day !== 'number' || !Number.isInteger(weekly.day) || weekly.day < 0 || weekly.day > 6
    ) {
        return { error: '`digest.weekly` must have boolean enabled, integer day 0-6, and HH:mm time.' };
    }

    return {
        config: {
            enabled: body.enabled,
            url: body.url,
            mirror: body.mirror === undefined ? true : body.mirror,
            kinds: { start: kinds.start, due: kinds.due, review: kinds.review },
            digest: {
                morning: { enabled: morning.enabled, time: morning.time },
                evening: { enabled: evening.enabled, time: evening.time },
                weekly: { enabled: weekly.enabled, day: weekly.day, time: weekly.time },
            },
        },
    };
};

// --- Storage ---

/** Reads a namespace's stored webhook config, or null when none/invalid. */
export const readWebhookConfig = (dataDir: string, key: string): StoredWebhookConfig | null => {
    const path = join(dataDir, configFileName(key));
    if (!existsSync(path)) return null;
    try {
        const parsed = parseWebhookConfig(JSON.parse(readFileSync(path, 'utf8')));
        return 'config' in parsed ? parsed.config : null;
    } catch {
        return null;
    }
};

const writeWebhookConfig = (dataDir: string, key: string, config: StoredWebhookConfig): void => {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, configFileName(key));
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(config, null, 2), 'utf8');
    renameSync(tempPath, path);
};

// --- Request handler ---

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });

export type WebhookConfigRequestOptions = {
    dataDir: string;
    key: string;
    maxBodyBytes: number;
    /** Injectable for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
};

// Kinds a test can impersonate (matches the emitter's ReminderWebhookEventKind,
// minus the niche due-repeat). Used to validate the requested test kind.
export const TEST_WEBHOOK_KINDS = [
    'task-reminder',
    'task-review',
    'project-review',
    'digest-morning',
    'digest-evening',
    'weekly-review',
] as const;
const TEST_WEBHOOK_KIND_SET: ReadonlySet<string> = new Set(TEST_WEBHOOK_KINDS);

const buildTestPayload = (key: string, kind: string) => ({
    event: 'reminder' as const,
    kind,
    test: true,
    title: 'Mindwtr webhook test',
    message: `Test delivery (${kind}) from the server reminders settings.`,
    firedAt: new Date().toISOString(),
    namespace: key,
});

/**
 * GET returns the namespace's stored config (defaults when unset).
 * PUT validates and stores the config, returning what was saved.
 * POST sends a one-off test payload to the stored URL and reports the result.
 */
export const handleWebhookConfigRequest = async (
    req: Request,
    options: WebhookConfigRequestOptions,
): Promise<Response> => {
    const { dataDir, key, maxBodyBytes } = options;

    if (req.method === 'GET') {
        return json(readWebhookConfig(dataDir, key) ?? DEFAULT_WEBHOOK_CONFIG);
    }

    if (req.method === 'PUT') {
        const raw = await req.text();
        if (raw.length > maxBodyBytes) return json({ error: 'Body too large.' }, 413);
        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(raw);
        } catch {
            return json({ error: 'Body must be valid JSON.' }, 400);
        }
        const result = parseWebhookConfig(parsedBody);
        if ('error' in result) return json({ error: result.error }, 400);
        writeWebhookConfig(dataDir, key, result.config);
        return json(result.config);
    }

    if (req.method === 'POST') {
        const url = readWebhookConfig(dataDir, key)?.url ?? '';
        if (!url) return json({ ok: false, error: 'No webhook URL configured. Save a URL first.' }, 400);
        // Optional { kind } picks which notification type the test impersonates.
        let kind = 'task-reminder';
        const raw = await req.text();
        if (raw.length > maxBodyBytes) return json({ ok: false, error: 'Body too large.' }, 413);
        if (raw) {
            try {
                const parsed = JSON.parse(raw) as { kind?: unknown };
                if (typeof parsed.kind === 'string' && TEST_WEBHOOK_KIND_SET.has(parsed.kind)) kind = parsed.kind;
            } catch {
                // Ignore a malformed body; fall back to the default kind.
            }
        }
        const fetchImpl = options.fetchImpl ?? fetch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(buildTestPayload(key, kind)),
                signal: controller.signal,
            });
            return json({ ok: res.ok, status: res.status });
        } catch {
            return json({ ok: false, error: 'Could not reach the webhook (network error or timeout).' });
        } finally {
            clearTimeout(timeout);
        }
    }

    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, PUT, POST' } });
};

export const __testing = { configFileName, writeWebhookConfig };
