import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { AppData, ReminderScheduleRequest, Task } from '@mindwtr/core';
import { writeCloudData } from './server-data-cache';
import {
    buildEmitterSettings,
    buildReminderWebhookPayload,
    classifyReminderKind,
    collectDueReminders,
    resolveReminderWebhookConfig,
    startReminderWebhookPoller,
    __testing,
} from './server-reminder-webhook';
import { __testing as webhookConfigTesting } from './server-webhook-config';

const BASE_ENV = {
    MINDWTR_CLOUD_REMINDER_WEBHOOK_ENABLED: 'true',
    MINDWTR_CLOUD_REMINDER_WEBHOOK_URL: 'https://hook.test/mindwtr',
} as const;

// Digests fire on the server's local clock, so isolating per-task reminders (which
// fire on absolute task timestamps) keeps these assertions timezone-independent.
const NO_DIGESTS = {
    MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_ENABLED: 'false',
    MINDWTR_CLOUD_REMINDER_DIGEST_EVENING_ENABLED: 'false',
    MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_ENABLED: 'false',
} as const;

const KEY = 'a'.repeat(64); // a valid namespace key ([a-f0-9]{64})

const makeTask = (overrides: Pick<Task, 'id' | 'title'> & Partial<Task>): Task => ({
    status: 'next',
    tags: [],
    contexts: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
});

const makeRequest = (overrides: Partial<ReminderScheduleRequest> = {}): ReminderScheduleRequest => ({
    key: 'task:t1',
    title: 'Task',
    message: 'body',
    fireAt: new Date('2026-09-18T19:00:00.000Z'),
    data: { kind: 'task-reminder', taskId: 't1' },
    ...overrides,
});

const writeNamespace = (dataDir: string, key: string, data: Partial<AppData>): void => {
    const full: AppData = {
        tasks: [],
        projects: [],
        sections: [],
        areas: [],
        people: [],
        settings: {},
        ...data,
    };
    writeCloudData(join(dataDir, `${key}.json`), full);
};

describe('resolveReminderWebhookConfig', () => {
    test('is disabled by default with an empty environment', () => {
        const config = resolveReminderWebhookConfig({});
        expect(config.enabled).toBe(false);
    });

    test('throws when enabled without a URL', () => {
        expect(() => resolveReminderWebhookConfig({ MINDWTR_CLOUD_REMINDER_WEBHOOK_ENABLED: 'true' }))
            .toThrow(/URL is required/i);
    });

    test('parses defaults when enabled', () => {
        const config = resolveReminderWebhookConfig(BASE_ENV);
        expect(config.enabled).toBe(true);
        expect(config.url).toBe('https://hook.test/mindwtr');
        expect(config.authToken).toBeNull();
        expect(config.pollIntervalMs).toBe(60_000);
        expect(config.maxLookbackMs).toBe(600_000);
        expect(config.requestTimeoutMs).toBe(10_000);
        expect(config.kinds).toEqual({ start: true, due: true, review: true });
        expect(config.digest.morning).toEqual({ enabled: true, time: '09:00' });
        expect(config.digest.evening).toEqual({ enabled: true, time: '20:00' });
        expect(config.digest.weekly).toEqual({ enabled: true, day: 1, time: '18:00' });
    });

    test('honours overrides', () => {
        const config = resolveReminderWebhookConfig({
            ...BASE_ENV,
            MINDWTR_CLOUD_REMINDER_WEBHOOK_TOKEN: 'secret-token',
            MINDWTR_CLOUD_REMINDER_REVIEW_ENABLED: 'false',
            MINDWTR_CLOUD_REMINDER_DIGEST_EVENING_ENABLED: 'off',
            MINDWTR_CLOUD_REMINDER_POLL_INTERVAL_MS: '30000',
            MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_DAY: '0',
            MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_TIME: '7:30',
        });
        expect(config.authToken).toBe('secret-token');
        expect(config.kinds.review).toBe(false);
        expect(config.digest.evening.enabled).toBe(false);
        expect(config.pollIntervalMs).toBe(30_000);
        expect(config.digest.weekly.day).toBe(0);
        expect(config.digest.morning.time).toBe('7:30');
    });

    const malformed: Array<[string, string]> = [
        ['MINDWTR_CLOUD_REMINDER_START_ENABLED', 'maybe'],
        ['MINDWTR_CLOUD_REMINDER_POLL_INTERVAL_MS', '500'], // below the 1000ms floor
        ['MINDWTR_CLOUD_REMINDER_POLL_INTERVAL_MS', 'soon'],
        ['MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_TIME', '25:00'],
        ['MINDWTR_CLOUD_REMINDER_DIGEST_MORNING_TIME', 'noon'],
        ['MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_DAY', '9'],
    ];
    for (const [key, value] of malformed) {
        test(`throws on a malformed ${key}=${value}`, () => {
            expect(() => resolveReminderWebhookConfig({ ...BASE_ENV, [key]: value })).toThrow();
        });
    }
});

describe('buildEmitterSettings', () => {
    test('maps config onto notification settings, ignoring device settings', () => {
        const config = resolveReminderWebhookConfig({
            ...BASE_ENV,
            MINDWTR_CLOUD_REMINDER_START_ENABLED: 'false',
        });
        const settings = buildEmitterSettings(config);
        expect(settings.notificationsEnabled).toBe(true);
        expect(settings.startDateNotificationsEnabled).toBe(false);
        expect(settings.dueDateNotificationsEnabled).toBe(true);
        expect(settings.dailyDigestMorningEnabled).toBe(true);
        expect(settings.dailyDigestMorningTime).toBe('09:00');
        expect(settings.weeklyReviewDay).toBe(1);
    });
});

describe('collectDueReminders', () => {
    const config = resolveReminderWebhookConfig({ ...BASE_ENV, ...NO_DIGESTS });

    test('returns a task reminder whose fire time is in the (from, to] window', () => {
        const task = makeTask({ id: 't1', title: 'Review Q3', dueDate: '2026-09-18T19:00:00.000Z' });
        const due = collectDueReminders(
            { tasks: [task], projects: [] },
            config,
            { from: new Date('2026-09-18T18:59:00.000Z'), to: new Date('2026-09-18T19:00:30.000Z') },
        );
        expect(due).toHaveLength(1);
        expect(due[0].data.taskId).toBe('t1');
    });

    test('excludes a reminder that fires outside the window', () => {
        const task = makeTask({ id: 't1', title: 'Review Q3', dueDate: '2026-09-18T19:00:00.000Z' });
        const due = collectDueReminders(
            { tasks: [task], projects: [] },
            config,
            { from: new Date('2026-09-18T19:01:00.000Z'), to: new Date('2026-09-18T19:02:00.000Z') },
        );
        expect(due).toHaveLength(0);
    });

    test('respects the per-kind toggles', () => {
        const reviewOff = resolveReminderWebhookConfig({
            ...BASE_ENV,
            ...NO_DIGESTS,
            MINDWTR_CLOUD_REMINDER_REVIEW_ENABLED: 'false',
        });
        const task = makeTask({ id: 't1', title: 'Weekly plan', reviewAt: '2026-09-18T19:00:00.000Z' });
        const window = { from: new Date('2026-09-18T18:59:00.000Z'), to: new Date('2026-09-18T19:01:00.000Z') };
        expect(collectDueReminders({ tasks: [task], projects: [] }, config, window)).toHaveLength(1);
        expect(collectDueReminders({ tasks: [task], projects: [] }, reviewOff, window)).toHaveLength(0);
    });

    test('emits a digest only for the cycle it is due in (local time)', () => {
        const morningOnly = resolveReminderWebhookConfig({
            ...BASE_ENV,
            MINDWTR_CLOUD_REMINDER_DIGEST_EVENING_ENABLED: 'false',
            MINDWTR_CLOUD_REMINDER_WEEKLY_REVIEW_ENABLED: 'false',
        });
        // A local-time window straddling 09:00 catches the morning digest; both ends
        // are local Dates, so this holds in any timezone.
        const inWindow = collectDueReminders(
            { tasks: [], projects: [] },
            morningOnly,
            { from: new Date(2026, 8, 18, 8, 0, 0), to: new Date(2026, 8, 18, 10, 0, 0) },
        );
        expect(inWindow.map(classifyReminderKind)).toContain('digest-morning');

        const outOfWindow = collectDueReminders(
            { tasks: [], projects: [] },
            morningOnly,
            { from: new Date(2026, 8, 18, 10, 0, 0), to: new Date(2026, 8, 18, 11, 0, 0) },
        );
        expect(outOfWindow).toHaveLength(0);
    });
});

describe('classifyReminderKind / buildReminderWebhookPayload', () => {
    test('classifies each reminder shape', () => {
        expect(classifyReminderKind(makeRequest())).toBe('task-reminder');
        expect(classifyReminderKind(makeRequest({ key: 'task:t1:r2' }))).toBe('due-repeat');
        expect(classifyReminderKind(makeRequest({ data: { kind: 'task-review', taskId: 't1' } }))).toBe('task-review');
        expect(classifyReminderKind(makeRequest({
            key: 'project:p1',
            data: { kind: 'project-review', projectId: 'p1' },
        }))).toBe('project-review');
        expect(classifyReminderKind(makeRequest({ key: 'digest:morning', data: { kind: 'daily-digest' } }))).toBe('digest-morning');
        expect(classifyReminderKind(makeRequest({ key: 'digest:evening', data: { kind: 'daily-digest' } }))).toBe('digest-evening');
        expect(classifyReminderKind(makeRequest({ key: 'digest:weekly-review', data: { kind: 'weekly-review' } }))).toBe('weekly-review');
    });

    test('builds a payload with only the relevant id', () => {
        const payload = buildReminderWebhookPayload(makeRequest({ title: 'Review Q3' }), KEY);
        expect(payload.event).toBe('reminder');
        expect(payload.kind).toBe('task-reminder');
        expect(payload.key).toBe('task:t1');
        expect(payload.taskId).toBe('t1');
        expect(payload.title).toBe('Review Q3');
        expect(payload.firedAt).toBe('2026-09-18T19:00:00.000Z');
        expect(payload.namespace).toBe(KEY);
        expect(payload.projectId).toBeUndefined();

        const projectPayload = buildReminderWebhookPayload(makeRequest({
            key: 'project:p1',
            data: { kind: 'project-review', projectId: 'p1' },
        }), KEY);
        expect(projectPayload.projectId).toBe('p1');
        expect(projectPayload.taskId).toBeUndefined();
    });
});

describe('startReminderWebhookPoller', () => {
    let dataDir = '';
    afterEach(() => {
        if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        dataDir = '';
    });

    type Call = { url: string; body: Record<string, string>; auth: string | null };
    const recordingFetch = (calls: Call[], status = 200): typeof fetch => (
        (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(url),
                body: JSON.parse(String(init?.body ?? '{}')) as Record<string, string>,
                auth: new Headers(init?.headers).get('authorization'),
            });
            return new Response(null, { status });
        }) as unknown as typeof fetch
    );

    test('arms from first sight, then delivers a reminder once when it comes due', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-reminder-'));
        writeNamespace(dataDir, KEY, {
            tasks: [makeTask({ id: 't1', title: 'Review Q3', dueDate: '2026-09-18T19:00:00.000Z' })],
        });
        const config = resolveReminderWebhookConfig({
            ...BASE_ENV,
            ...NO_DIGESTS,
            MINDWTR_CLOUD_REMINDER_WEBHOOK_TOKEN: 'secret-token',
        });
        const calls: Call[] = [];
        let nowMs = Date.parse('2026-09-18T18:59:00.000Z');
        const poller = startReminderWebhookPoller({ dataDir, config, fetchImpl: recordingFetch(calls), now: () => nowMs });

        // First cycle arms the checkpoint from "now" — no backfill of the 19:00 reminder.
        await poller.runOnce();
        expect(calls).toHaveLength(0);
        expect(existsSync(join(dataDir, __testing.STATE_FILE_NAME))).toBe(true);

        // The reminder's fire time now falls inside the window.
        nowMs = Date.parse('2026-09-18T19:00:30.000Z');
        await poller.runOnce();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://hook.test/mindwtr');
        expect(calls[0].auth).toBe('Bearer secret-token');
        expect(calls[0].body.kind).toBe('task-reminder');
        expect(calls[0].body.taskId).toBe('t1');
        expect(calls[0].body.namespace).toBe(KEY);

        // A later cycle does not re-deliver the same reminder.
        nowMs = Date.parse('2026-09-18T19:05:00.000Z');
        await poller.runOnce();
        expect(calls).toHaveLength(1);

        poller.stop();
    });

    test('is at-most-once: a failed delivery is not retried', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-reminder-'));
        writeNamespace(dataDir, KEY, {
            tasks: [makeTask({ id: 't1', title: 'Review Q3', dueDate: '2026-09-18T19:00:00.000Z' })],
        });
        const config = resolveReminderWebhookConfig({ ...BASE_ENV, ...NO_DIGESTS });
        const calls: Call[] = [];
        let nowMs = Date.parse('2026-09-18T18:59:00.000Z');
        const poller = startReminderWebhookPoller({ dataDir, config, fetchImpl: recordingFetch(calls, 500), now: () => nowMs });

        await poller.runOnce(); // arm
        nowMs = Date.parse('2026-09-18T19:00:30.000Z');
        await poller.runOnce(); // attempt (server returns 500)
        expect(calls).toHaveLength(1);

        nowMs = Date.parse('2026-09-18T19:02:00.000Z');
        await poller.runOnce(); // checkpoint already advanced past 19:00 -> no retry
        expect(calls).toHaveLength(1);

        poller.stop();
    });

    test('clamps look-back so a stale checkpoint does not dump old reminders', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-reminder-'));
        const nowMs = Date.parse('2026-09-18T19:00:00.000Z');
        writeNamespace(dataDir, KEY, {
            tasks: [
                makeTask({ id: 'stale', title: 'Old', dueDate: '2026-09-18T18:30:00.000Z' }), // 30 min ago
                makeTask({ id: 'fresh', title: 'Recent', dueDate: '2026-09-18T18:59:30.000Z' }), // 30s ago
            ],
        });
        // Pretend the server was down for an hour.
        __testing.writeState(dataDir, { [KEY]: nowMs - 60 * 60 * 1000 });

        const config = resolveReminderWebhookConfig({
            ...BASE_ENV,
            ...NO_DIGESTS,
            MINDWTR_CLOUD_REMINDER_MAX_LOOKBACK_MS: '120000', // 2 minutes
        });
        const calls: Call[] = [];
        const poller = startReminderWebhookPoller({ dataDir, config, fetchImpl: recordingFetch(calls), now: () => nowMs });

        await poller.runOnce();
        // Only the reminder inside the 2-minute look-back is delivered; the 30-min-old one is dropped.
        expect(calls.map((call) => call.body.taskId)).toEqual(['fresh']);

        poller.stop();
    });

    test('persists the checkpoint across poller instances', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-reminder-'));
        writeNamespace(dataDir, KEY, { tasks: [] });
        const config = resolveReminderWebhookConfig({ ...BASE_ENV, ...NO_DIGESTS });
        const nowMs = Date.parse('2026-09-18T19:00:00.000Z');

        const first = startReminderWebhookPoller({ dataDir, config, fetchImpl: recordingFetch([]), now: () => nowMs });
        await first.runOnce();
        first.stop();

        const state = JSON.parse(readFileSync(join(dataDir, __testing.STATE_FILE_NAME), 'utf8'));
        expect(state[KEY]).toBe(nowMs);
    });

    test('a namespace sidecar overrides the global config (url + kinds)', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-reminder-'));
        writeNamespace(dataDir, KEY, {
            tasks: [makeTask({ id: 't1', title: 'Due', dueDate: '2026-09-18T19:00:00.000Z' })],
        });
        // Global fallback OFF: nothing would fire without a sidecar.
        const config = resolveReminderWebhookConfig({});
        webhookConfigTesting.writeWebhookConfig(dataDir, KEY, {
            enabled: true,
            url: 'https://sidecar.test/hook',
            kinds: { start: false, due: true, review: false },
            digest: {
                morning: { enabled: false, time: '09:00' },
                evening: { enabled: false, time: '20:00' },
                weekly: { enabled: false, day: 1, time: '18:00' },
            },
        });
        const calls: Call[] = [];
        let nowMs = Date.parse('2026-09-18T18:59:00.000Z');
        const poller = startReminderWebhookPoller({ dataDir, config, fetchImpl: recordingFetch(calls), now: () => nowMs });

        await poller.runOnce(); // arm
        expect(calls).toHaveLength(0);

        nowMs = Date.parse('2026-09-18T19:00:30.000Z');
        await poller.runOnce();
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://sidecar.test/hook');
        expect(calls[0].body.taskId).toBe('t1');

        poller.stop();
    });
});
