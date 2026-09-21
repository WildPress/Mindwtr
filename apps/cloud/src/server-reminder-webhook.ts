// Server-side reminder webhook emitter.
//
// The mobile and desktop clients turn a task's start/due/review dates (and the
// daily/weekly digests) into LOCAL notifications: mobile pre-arms native alarms,
// desktop polls while it is open. Neither fires when the phone is asleep or the
// desktop is closed, so an external automation that wants to *react* to a due
// reminder (e.g. relay it to a chat bot) can only poll the data and guess.
//
// This module lets the always-on cloud server do the firing instead. It reuses
// core's `buildReminderSchedule` (the same derivation the clients use) on a timer,
// finds every reminder whose fire time crossed into the last poll window, and
// POSTs each one to a configured webhook. The result is a real push that never
// depends on a client being awake.
//
// The whole feature is inert unless `MINDWTR_CLOUD_REMINDER_WEBHOOK_ENABLED` is on.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
    buildReminderSchedule,
    type NotificationSettings,
    type ReminderScheduleRequest,
    type Task,
    type Project,
} from '@mindwtr/core';
import { loadAppData } from './server-data-cache';
import { logInfo, logWarn } from './server-config';
import { readWebhookConfig } from './server-webhook-config';

// Namespace data files are `<sha256(token)>.json`; the poll loop scans for them
// exactly like server-request.ts does for the namespace quota count.
const NAMESPACE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;

// A poll can only ever fire a reminder once, when its `fireAt` first falls inside
// the (from, to] window, so a per-namespace "last checked" timestamp is the entire
// state. Stored as one small JSON map next to the namespace data; a best-effort
// operational file, not namespace data, so it uses a plain atomic write rather
// than the storage-authority machinery reserved for the sync documents.
const STATE_FILE_NAME = '.reminder-webhook-state.json';

export type ReminderWebhookDigestConfig = Readonly<{
    morning: { enabled: boolean; time: string };
    evening: { enabled: boolean; time: string };
    weekly: { enabled: boolean; day: number; time: string };
}>;

export type ReminderWebhookConfig = Readonly<{
    enabled: boolean;
    url: string;
    authToken: string | null;
    pollIntervalMs: number;
    /** Cap on how far back a first poll (or one after downtime) will reach, so a
     * restart never dumps a backlog of stale reminders. */
    maxLookbackMs: number;
    requestTimeoutMs: number;
    /** Which per-task date reminders to emit. Digests are configured separately. */
    kinds: { start: boolean; due: boolean; review: boolean };
    digest: ReminderWebhookDigestConfig;
}>;

export type ReminderWebhookEventKind =
    | 'task-reminder'
    | 'due-repeat'
    | 'task-review'
    | 'project-review'
    | 'digest-morning'
    | 'digest-evening'
    | 'weekly-review';

export type ReminderWebhookPayload = {
    event: 'reminder';
    kind: ReminderWebhookEventKind;
    /** The core schedule key, e.g. `task:<id>`, `task:<id>:r2`, `digest:morning`.
     * Included so a downstream consumer can dedupe or disambiguate if it wants to. */
    key: string;
    taskId?: string;
    projectId?: string;
    title: string;
    message: string;
    /** ISO-8601 instant the reminder was due. */
    firedAt: string;
    /** The namespace (token hash) the reminder belongs to. */
    namespace: string;
};

// --- Config resolution -------------------------------------------------------

const REMINDER_ENV = {
    enabled: 'MINDWTR_CLOUD_REMINDER_WEBHOOK_ENABLED',
    url: 'MINDWTR_CLOUD_REMINDER_WEBHOOK_URL',
    token: 'MINDWTR_CLOUD_REMINDER_WEBHOOK_TOKEN',
    pollIntervalMs: 'MINDWTR_CLOUD_REMINDER_POLL_INTERVAL_MS',
    maxLookbackMs: 'MINDWTR_CLOUD_REMINDER_MAX_LOOKBACK_MS',
    requestTimeoutMs: 'MINDWTR_CLOUD_REMINDER_WEBHOOK_TIMEOUT_MS',
    startEnabled: 'MINDWTR_CLOUD_REMINDER_START_ENABLED',
    dueEnabled: 'MINDWTR_CLOUD_REMINDER_DUE_ENABLED',
    reviewEnabled: 'MINDWTR_CLOUD_REMINDER_REVIEW_ENABLED',
    morningEnabled: 'MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_ENABLED',
    morningTime: 'MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_TIME',
    eveningEnabled: 'MINDWTR_CLOUD_REMINDER_DIGEST_EVENING_ENABLED',
    eveningTime: 'MINDWTR_CLOUD_REMINDER_DIGEST_EVENING_TIME',
    weeklyEnabled: 'MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_ENABLED',
    weeklyDay: 'MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_DAY',
    weeklyTime: 'MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_TIME',
} as const;

type Env = Readonly<Record<string, string | undefined>>;

const isTruthy = (value: string): boolean => (
    value === '1' || value === 'true' || value === 'yes' || value === 'on'
);
const isFalsy = (value: string): boolean => (
    value === '0' || value === 'false' || value === 'no' || value === 'off'
);

const resolveBool = (raw: string | undefined, fallback: boolean, label: string): boolean => {
    const value = String(raw ?? '').trim().toLowerCase();
    if (value === '') return fallback;
    if (isTruthy(value)) return true;
    if (isFalsy(value)) return false;
    throw new Error(`Invalid ${label}: expected a boolean (true/false/1/0/yes/no/on/off).`);
};

const resolveMs = (raw: string | undefined, fallback: number, minimum: number, label: string): number => {
    const value = String(raw ?? '').trim();
    if (value === '') return fallback;
    if (!/^\d+$/.test(value)) {
        throw new Error(`Invalid ${label}: expected a non-negative integer of milliseconds.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new Error(`Invalid ${label}: expected an integer greater than or equal to ${minimum}.`);
    }
    return parsed;
};

// Validated against core's `parseTimeOfDay` shape so a malformed override fails at
// startup rather than silently collapsing to the digest default at poll time.
const resolveTime = (raw: string | undefined, fallback: string, label: string): string => {
    const value = String(raw ?? '').trim();
    if (value === '') return fallback;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    const hour = match ? Number(match[1]) : NaN;
    const minute = match ? Number(match[2]) : NaN;
    if (!match || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        throw new Error(`Invalid ${label}: expected a "HH:mm" 24-hour time.`);
    }
    return value;
};

const resolveWeekday = (raw: string | undefined, fallback: number, label: string): number => {
    const value = String(raw ?? '').trim();
    if (value === '') return fallback;
    if (!/^\d+$/.test(value) || Number(value) > 6) {
        throw new Error(`Invalid ${label}: expected an integer from 0 (Sunday) through 6 (Saturday).`);
    }
    return Number(value);
};

/**
 * Resolves the emitter config from the environment. Throws on any malformed value,
 * and (when enabled) on a missing webhook URL, so a misconfigured deployment fails
 * loudly at startup instead of silently never firing.
 */
export const resolveReminderWebhookConfig = (env: Env = process.env): ReminderWebhookConfig => {
    const enabled = resolveBool(env[REMINDER_ENV.enabled], false, REMINDER_ENV.enabled);
    const url = String(env[REMINDER_ENV.url] ?? '').trim();
    if (enabled && url === '') {
        throw new Error(`${REMINDER_ENV.url} is required when ${REMINDER_ENV.enabled} is on.`);
    }
    const token = String(env[REMINDER_ENV.token] ?? '').trim();

    return Object.freeze({
        enabled,
        url,
        authToken: token === '' ? null : token,
        pollIntervalMs: resolveMs(env[REMINDER_ENV.pollIntervalMs], 60_000, 1_000, REMINDER_ENV.pollIntervalMs),
        maxLookbackMs: resolveMs(env[REMINDER_ENV.maxLookbackMs], 600_000, 0, REMINDER_ENV.maxLookbackMs),
        requestTimeoutMs: resolveMs(env[REMINDER_ENV.requestTimeoutMs], 10_000, 1, REMINDER_ENV.requestTimeoutMs),
        kinds: {
            start: resolveBool(env[REMINDER_ENV.startEnabled], true, REMINDER_ENV.startEnabled),
            due: resolveBool(env[REMINDER_ENV.dueEnabled], true, REMINDER_ENV.dueEnabled),
            review: resolveBool(env[REMINDER_ENV.reviewEnabled], true, REMINDER_ENV.reviewEnabled),
        },
        digest: {
            morning: {
                enabled: resolveBool(env[REMINDER_ENV.morningEnabled], true, REMINDER_ENV.morningEnabled),
                time: resolveTime(env[REMINDER_ENV.morningTime], '09:00', REMINDER_ENV.morningTime),
            },
            evening: {
                enabled: resolveBool(env[REMINDER_ENV.eveningEnabled], true, REMINDER_ENV.eveningEnabled),
                time: resolveTime(env[REMINDER_ENV.eveningTime], '20:00', REMINDER_ENV.eveningTime),
            },
            weekly: {
                enabled: resolveBool(env[REMINDER_ENV.weeklyEnabled], true, REMINDER_ENV.weeklyEnabled),
                day: resolveWeekday(env[REMINDER_ENV.weeklyDay], 1, REMINDER_ENV.weeklyDay),
                time: resolveTime(env[REMINDER_ENV.weeklyTime], '18:00', REMINDER_ENV.weeklyTime),
            },
        },
    });
};

// --- Reminder derivation -----------------------------------------------------

// Only the digest title/body keys are read without a fallback inside
// buildReminderSchedule; every other label already falls back to English. This
// server-local map keeps the webhook `message` readable without pulling the app's
// i18n bundles into the server.
export const DEFAULT_REMINDER_TRANSLATIONS: Readonly<Record<string, string>> = Object.freeze({
    'digest.morningTitle': 'Morning briefing',
    'digest.morningBody': "Here's what needs your attention today.",
    'digest.eveningTitle': 'Evening review',
    'digest.eveningBody': 'Wrap up the day and check tomorrow.',
    'digest.weeklyReviewTitle': 'Weekly review',
    'digest.weeklyReviewBody': "It's time for your weekly review.",
    'settings.startDateNotifications': 'Start date reminder',
    'settings.dueDateNotifications': 'Due date reminder',
    'settings.reviewAtNotifications': 'Review date reminder',
    'settings.notifications': 'Task reminder',
    'review.projectsStep': 'Review project',
});

/**
 * Synthesises the notification settings the schedule derivation needs from the
 * server-side config. The device's own notification settings are deliberately
 * ignored: they are device-local and never sync up to the server, so the webhook
 * is driven entirely by server config instead.
 */
export const buildEmitterSettings = (config: ReminderWebhookConfig): NotificationSettings => ({
    notificationsEnabled: true,
    startDateNotificationsEnabled: config.kinds.start,
    dueDateNotificationsEnabled: config.kinds.due,
    reviewAtNotificationsEnabled: config.kinds.review,
    dailyDigestMorningEnabled: config.digest.morning.enabled,
    dailyDigestMorningTime: config.digest.morning.time,
    dailyDigestEveningEnabled: config.digest.evening.enabled,
    dailyDigestEveningTime: config.digest.evening.time,
    weeklyReviewEnabled: config.digest.weekly.enabled,
    weeklyReviewDay: config.digest.weekly.day,
    weeklyReviewTime: config.digest.weekly.time,
});

/**
 * The reminders whose fire time falls in the half-open window `(from, to]`.
 *
 * `buildReminderSchedule` already bounds the one-shot task/project/repeat requests
 * to that window (via `now`/`deliveryWindowTo`); the digest entries it emits carry
 * their *next* occurrence unconditionally, so the same `(from, to]` filter is what
 * keeps a digest to the single cycle it is actually due. Contiguous, non-overlapping
 * windows across polls therefore deliver every reminder exactly once.
 */
export const collectDueReminders = (
    data: { tasks: Task[]; projects: Project[] },
    config: ReminderWebhookConfig,
    window: { from: Date; to: Date },
    translations: Record<string, string> = DEFAULT_REMINDER_TRANSLATIONS,
): ReminderScheduleRequest[] => {
    const { requests } = buildReminderSchedule({
        settings: buildEmitterSettings(config),
        tasks: data.tasks,
        projects: data.projects,
        translations,
        now: window.from,
        deliveryWindowTo: window.to,
    });
    const fromMs = window.from.getTime();
    const toMs = window.to.getTime();
    return requests.filter((request) => {
        const fireAtMs = request.fireAt.getTime();
        return fireAtMs > fromMs && fireAtMs <= toMs;
    });
};

const REPEAT_KEY_PATTERN = /:r\d+$/;

export const classifyReminderKind = (request: ReminderScheduleRequest): ReminderWebhookEventKind => {
    switch (request.data.kind) {
        case 'daily-digest':
            return request.key === 'digest:evening' ? 'digest-evening' : 'digest-morning';
        case 'weekly-review':
            return 'weekly-review';
        case 'project-review':
            return 'project-review';
        case 'task-review':
            return 'task-review';
        default:
            // `task-reminder` covers both the base start/due reminder and its
            // bounded due-time repeats; the `:rN` key suffix is the only thing
            // that tells them apart. (Start vs due are not separable here — core
            // labels both `task-reminder` — so both surface as `task-reminder`.)
            return REPEAT_KEY_PATTERN.test(request.key) ? 'due-repeat' : 'task-reminder';
    }
};

export const buildReminderWebhookPayload = (
    request: ReminderScheduleRequest,
    namespace: string,
): ReminderWebhookPayload => {
    const payload: ReminderWebhookPayload = {
        event: 'reminder',
        kind: classifyReminderKind(request),
        key: request.key,
        title: request.title,
        message: request.message,
        firedAt: request.fireAt.toISOString(),
        namespace,
    };
    // JSON.stringify drops undefined fields, so only the relevant id is sent.
    if (request.data.taskId) payload.taskId = request.data.taskId;
    if (request.data.projectId) payload.projectId = request.data.projectId;
    return payload;
};

// --- State persistence -------------------------------------------------------

type ReminderWebhookState = Record<string, number>;

const readState = (dataDir: string): ReminderWebhookState => {
    const path = join(dataDir, STATE_FILE_NAME);
    if (!existsSync(path)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return {};
        const state: ReminderWebhookState = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (NAMESPACE_FILE_PATTERN.test(`${key}.json`) && typeof value === 'number' && Number.isFinite(value)) {
                state[key] = value;
            }
        }
        return state;
    } catch {
        // A corrupt state file just means the next poll re-arms from `now` (capped
        // by maxLookback); never worth crashing the server over.
        return {};
    }
};

const writeState = (dataDir: string, state: ReminderWebhookState): void => {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const path = join(dataDir, STATE_FILE_NAME);
    const tempPath = `${path}.${process.pid}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state), 'utf8');
    renameSync(tempPath, path);
};

// --- Delivery ----------------------------------------------------------------

const deliverReminder = async (
    fetchImpl: typeof fetch,
    config: ReminderWebhookConfig,
    payload: ReminderWebhookPayload,
): Promise<boolean> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (config.authToken) headers.authorization = `Bearer ${config.authToken}`;
        const response = await fetchImpl(config.url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        return response.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
};

// --- Poller ------------------------------------------------------------------

const listNamespaceKeys = (dataDir: string): string[] => {
    if (!existsSync(dataDir)) return [];
    const keys: string[] = [];
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(NAMESPACE_FILE_PATTERN);
        if (match?.[1]) keys.push(match[1]);
    }
    return keys;
};

export type ReminderWebhookPollerOptions = {
    dataDir: string;
    config: ReminderWebhookConfig;
    /** Injectable for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
    /** Injectable clock for tests; defaults to Date.now. */
    now?: () => number;
};

export type ReminderWebhookPoller = {
    /** Runs one poll cycle. Exposed so tests can drive cycles deterministically. */
    runOnce: () => Promise<void>;
    stop: () => void;
};

/**
 * Starts the poll loop. Each cycle, for every namespace, it derives the reminders
 * that came due since the last cycle (bounded by `maxLookbackMs`) and POSTs each to
 * the webhook. Delivery is at-most-once: the per-namespace checkpoint advances once
 * the namespace has been read and processed, whether or not each POST succeeded, so
 * a webhook outage drops those pings (logged) rather than re-firing the whole window.
 * A namespace whose data file fails to load keeps its old checkpoint and is retried.
 */
export const startReminderWebhookPoller = (options: ReminderWebhookPollerOptions): ReminderWebhookPoller => {
    const { dataDir, config } = options;
    const fetchImpl = options.fetchImpl ?? fetch;
    const now = options.now ?? Date.now;

    // A namespace's stored webhook config (set via the UI / /v1/webhook-config)
    // overrides the enabled/url/kinds/digest of the global env fallback, while the
    // operational params (poll interval, look-back, timeout, auth token) stay global.
    const resolveNamespaceConfig = (key: string): ReminderWebhookConfig => {
        const stored = readWebhookConfig(dataDir, key);
        if (!stored) return config;
        return {
            ...config,
            enabled: stored.enabled,
            url: stored.url,
            kinds: stored.kinds,
            digest: stored.digest,
        };
    };

    const state = readState(dataDir);
    let running = false;

    const runOnce = async (): Promise<void> => {
        // A slow cycle (many reminders, a hanging webhook) must never overlap the
        // next tick and double-fire.
        if (running) return;
        running = true;
        try {
            const toMs = now();
            const to = new Date(toMs);
            const earliestFromMs = toMs - config.maxLookbackMs;
            let stateChanged = false;

            for (const key of listNamespaceKeys(dataDir)) {
                const nsConfig = resolveNamespaceConfig(key);
                const active = nsConfig.enabled && nsConfig.url !== '';

                // First time we see a namespace, arm from `now` so we never backfill
                // its entire history of past-due reminders on first run. We advance
                // the checkpoint even while inactive, so enabling it later never dumps
                // a backlog.
                const lastMs = state[key];
                const fromMs = lastMs === undefined ? toMs : Math.max(lastMs, earliestFromMs);

                if (active && fromMs < toMs) {
                    let data;
                    try {
                        data = loadAppData(join(dataDir, `${key}.json`));
                    } catch {
                        // Leave the checkpoint untouched so a transient read error is
                        // retried next cycle (the lookback cap bounds the catch-up).
                        logWarn('reminder webhook namespace load failed', { namespace: key });
                        continue;
                    }
                    const due = collectDueReminders(data, nsConfig, { from: new Date(fromMs), to });
                    for (const request of due) {
                        const payload = buildReminderWebhookPayload(request, key);
                        const delivered = await deliverReminder(fetchImpl, nsConfig, payload);
                        const context = { namespace: key, reminderKind: payload.kind, reminderKey: payload.key };
                        if (delivered) {
                            logInfo('reminder webhook delivered', context);
                        } else {
                            logWarn('reminder webhook delivery failed', context);
                        }
                    }
                }

                state[key] = toMs;
                stateChanged = true;
            }

            if (stateChanged) {
                try {
                    writeState(dataDir, state);
                } catch {
                    logWarn('reminder webhook state persistence failed');
                }
            }
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => {
        void runOnce();
    }, config.pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
        runOnce,
        stop: () => clearInterval(timer),
    };
};

// Re-exported for tests that build a temp data dir and assert state files.
export const __testing = { STATE_FILE_NAME, readState, writeState, listNamespaceKeys };
