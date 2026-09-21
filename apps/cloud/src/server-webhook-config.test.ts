import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    DEFAULT_WEBHOOK_CONFIG,
    handleWebhookConfigRequest,
    parseWebhookConfig,
    readWebhookConfig,
    WEBHOOK_CONFIG_ROUTE_PATH,
    type StoredWebhookConfig,
} from './server-webhook-config';

const KEY = 'a'.repeat(64);

const validConfig: StoredWebhookConfig = {
    enabled: true,
    url: 'http://xyops:5522/api/app/run_event?id=e1&api_key=k',
    mirror: false,
    kinds: { start: false, due: true, review: false },
    digest: {
        morning: { enabled: true, time: '8:30' },
        evening: { enabled: false, time: '20:00' },
        weekly: { enabled: true, day: 1, time: '18:00' },
    },
};

describe('parseWebhookConfig', () => {
    test('accepts a valid config', () => {
        const result = parseWebhookConfig(validConfig);
        expect('config' in result && result.config.url).toBe(validConfig.url);
    });

    test('accepts an https url', () => {
        expect('config' in parseWebhookConfig({ ...validConfig, url: 'https://x.test/h' })).toBe(true);
    });

    const invalid: Array<[string, unknown]> = [
        ['non-object', 42],
        ['enabled not boolean', { ...validConfig, enabled: 'yes' }],
        ['non-http url', { ...validConfig, url: 'ftp://x.test' }],
        ['enabled with empty url', { ...validConfig, enabled: true, url: '' }],
        ['bad time', { ...validConfig, digest: { ...validConfig.digest, morning: { enabled: true, time: '25:00' } } }],
        ['day out of range', { ...validConfig, digest: { ...validConfig.digest, weekly: { enabled: true, day: 9, time: '18:00' } } }],
        ['missing kinds', { ...validConfig, kinds: { start: true } }],
    ];
    for (const [label, body] of invalid) {
        test(`rejects ${label}`, () => {
            expect('error' in parseWebhookConfig(body)).toBe(true);
        });
    }

    test('allows disabled with empty url', () => {
        expect('config' in parseWebhookConfig({ ...validConfig, enabled: false, url: '' })).toBe(true);
    });
});

describe('handleWebhookConfigRequest', () => {
    let dataDir = '';
    afterEach(() => {
        if (dataDir) rmSync(dataDir, { recursive: true, force: true });
        dataDir = '';
    });

    const req = (method: string, body?: unknown): Request =>
        new Request(`http://x${WEBHOOK_CONFIG_ROUTE_PATH}`, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        });

    test('GET returns defaults when unset', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const res = await handleWebhookConfigRequest(req('GET'), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(DEFAULT_WEBHOOK_CONFIG);
    });

    test('PUT stores, GET reads it back, and the sidecar is on disk', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const put = await handleWebhookConfigRequest(req('PUT', validConfig), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(put.status).toBe(200);
        expect(await put.json()).toEqual(validConfig);

        expect(readWebhookConfig(dataDir, KEY)).toEqual(validConfig);
        expect(existsSync(join(dataDir, `${KEY}.webhook-config.json`))).toBe(true);

        const get = await handleWebhookConfigRequest(req('GET'), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(await get.json()).toEqual(validConfig);
    });

    test('PUT rejects an invalid body with 400', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const res = await handleWebhookConfigRequest(req('PUT', { enabled: 'nope' }), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(res.status).toBe(400);
        expect(readWebhookConfig(dataDir, KEY)).toBeNull();
    });

    test('PUT rejects an over-large body with 413', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const res = await handleWebhookConfigRequest(req('PUT', validConfig), { dataDir, key: KEY, maxBodyBytes: 5 });
        expect(res.status).toBe(413);
    });

    test('rejects an unsupported method with 405', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const res = await handleWebhookConfigRequest(req('DELETE'), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(res.status).toBe(405);
    });

    test('POST returns 400 when no URL is configured', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        const res = await handleWebhookConfigRequest(req('POST'), { dataDir, key: KEY, maxBodyBytes: 100000 });
        expect(res.status).toBe(400);
        expect((await res.json()).ok).toBe(false);
    });

    test('POST sends a test payload to the stored URL', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        await handleWebhookConfigRequest(req('PUT', validConfig), { dataDir, key: KEY, maxBodyBytes: 100000 });
        const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
        const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
            return new Response(null, { status: 200 });
        }) as unknown as typeof fetch;

        const res = await handleWebhookConfigRequest(req('POST'), { dataDir, key: KEY, maxBodyBytes: 100000, fetchImpl: fetchStub });
        expect(await res.json()).toEqual({ ok: true, status: 200 });
        expect(calls[0].url).toBe(validConfig.url);
        expect(calls[0].body.test as boolean).toBe(true);
    });

    test('POST reports failure when the webhook cannot be reached', async () => {
        dataDir = mkdtempSync(join(tmpdir(), 'mindwtr-whc-'));
        await handleWebhookConfigRequest(req('PUT', validConfig), { dataDir, key: KEY, maxBodyBytes: 100000 });
        const fetchStub = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;

        const res = await handleWebhookConfigRequest(req('POST'), { dataDir, key: KEY, maxBodyBytes: 100000, fetchImpl: fetchStub });
        expect((await res.json()).ok).toBe(false);
    });
});
