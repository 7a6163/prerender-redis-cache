/**
 * Unit tests for the parts that cannot be driven from a healthy Redis:
 * URL resolution, reconnect backoff, connection lifecycle events and the
 * error paths. Uses a fake client so every branch is deterministic.
 *
 * The integration suite in prerenderRedisCache.test.js covers real Redis.
 */

const EventEmitter = require('events');

const URL_ENV_KEYS = ['REDISTOGO_URL', 'REDISCLOUD_URL', 'REDISGREEN_URL', 'REDIS_URL'];

const makeFakeClient = () => {
    const client = new EventEmitter();
    client.connect = jest.fn().mockResolvedValue(undefined);
    client.quit = jest.fn().mockResolvedValue(undefined);
    client.destroy = jest.fn();
    client.isReady = true;
    client.get = jest.fn().mockResolvedValue(null);
    client.set = jest.fn().mockResolvedValue('OK');
    client.del = jest.fn().mockResolvedValue(1);
    client.unlink = jest.fn().mockResolvedValue(1);
    client.scan = jest.fn().mockResolvedValue({ cursor: '0', keys: [] });
    return client;
};

/**
 * Re-require the plugin against a fake redis module.
 * @param {Object} options - { env, client }
 */
const load = ({ env = {}, client = makeFakeClient() } = {}) => {
    URL_ENV_KEYS.forEach((key) => delete process.env[key]);
    delete process.env.PAGE_TTL;
    Object.assign(process.env, env);

    jest.resetModules();
    const createClient = jest.fn(() => client);
    jest.doMock('redis', () => ({ createClient }));

    const plugin = require('./prerenderRedisCache');
    return { plugin, client, createClient };
};

const makeRes = () => ({ send: jest.fn(), setHeader: jest.fn() });

describe('prerenderRedisCache internals', () => {
    const savedEnv = { ...process.env };

    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        jest.restoreAllMocks();
        URL_ENV_KEYS.forEach((key) => delete process.env[key]);
        delete process.env.PAGE_TTL;
        Object.assign(process.env, savedEnv);
    });

    describe('Redis URL resolution', () => {
        it('prefers REDISTOGO_URL over every other variable', () => {
            const env = {
                REDISTOGO_URL: 'redis://togo:6379',
                REDISCLOUD_URL: 'redis://cloud:6379',
                REDISGREEN_URL: 'redis://green:6379',
                REDIS_URL: 'redis://plain:6379'
            };
            expect(load({ env }).createClient.mock.calls[0][0].url).toBe('redis://togo:6379');
        });

        it('falls back to REDISCLOUD_URL', () => {
            const env = {
                REDISCLOUD_URL: 'redis://cloud:6379',
                REDISGREEN_URL: 'redis://green:6379',
                REDIS_URL: 'redis://plain:6379'
            };
            expect(load({ env }).createClient.mock.calls[0][0].url).toBe('redis://cloud:6379');
        });

        it('falls back to REDISGREEN_URL', () => {
            const env = {
                REDISGREEN_URL: 'redis://green:6379',
                REDIS_URL: 'redis://plain:6379'
            };
            expect(load({ env }).createClient.mock.calls[0][0].url).toBe('redis://green:6379');
        });

        it('falls back to REDIS_URL', () => {
            const env = { REDIS_URL: 'redis://plain:6379' };
            expect(load({ env }).createClient.mock.calls[0][0].url).toBe('redis://plain:6379');
        });

        it('falls back to localhost when nothing is set', () => {
            expect(load().createClient.mock.calls[0][0].url).toBe('redis://127.0.0.1:6379');
        });
    });

    describe('reconnectStrategy', () => {
        let reconnectStrategy;

        it('is handed to the client as its socket reconnect strategy', () => {
            const { plugin, createClient } = load();
            expect(createClient.mock.calls[0][0].socket.reconnectStrategy)
                .toBe(plugin._reconnectStrategy);
        });

        beforeEach(() => {
            reconnectStrategy = load().plugin._reconnectStrategy;
        });

        it('never waits zero, since node-redis passes 0 for the first retry', () => {
            expect(reconnectStrategy(0)).toBe(100);
        });

        it('backs off linearly at 100ms per attempt', () => {
            expect(reconnectStrategy(1)).toBe(200);
            expect(reconnectStrategy(6)).toBe(700);
        });

        it('caps the delay at 5 seconds', () => {
            expect(reconnectStrategy(49)).toBe(5000);
            expect(reconnectStrategy(10000)).toBe(5000);
        });

        it('never gives up, so a long outage still recovers', () => {
            // Returning false here would leave the process permanently cacheless.
            for (const attempt of [0, 1, 11, 100, 100000]) {
                expect(typeof reconnectStrategy(attempt)).toBe('number');
            }
        });

        it('stays quiet, because the error event already reports each failure', () => {
            reconnectStrategy(3);
            expect(console.log).not.toHaveBeenCalled();
        });
    });

    describe('Connection lifecycle', () => {
        it('logs and keeps running when the initial connection fails', async () => {
            const client = makeFakeClient();
            client.connect.mockRejectedValue(new Error('ECONNREFUSED'));
            const { plugin } = load({ client });

            await Promise.resolve(); // let the rejection handler run
            await Promise.resolve();

            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('without cache'));

            // Still bypasses cleanly instead of throwing
            const next = jest.fn();
            plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('serves from cache once ready and bypasses again on error', async () => {
            const { plugin, client } = load();
            client.get.mockResolvedValue(JSON.stringify({
                statusCode: 200,
                content: 'cached',
                headers: {}
            }));

            client.emit('ready');
            expect(console.log).toHaveBeenCalledWith('Redis Cache Connected');

            const res = makeRes();
            await plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, res, jest.fn());
            expect(res.send).toHaveBeenCalledWith(200, 'cached');

            client.emit('error', new Error('boom'));
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));

            const next = jest.fn();
            plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('bypasses the cache while reconnecting', () => {
            const { plugin, client } = load();
            client.emit('ready');
            client.emit('reconnecting');

            const next = jest.fn();
            plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('warns and bypasses the cache when the connection ends', () => {
            const { plugin, client } = load();
            client.emit('ready');
            client.emit('end');
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Connection Closed'));

            const next = jest.fn();
            plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/b' } }, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('quits the client on close when it is connected', async () => {
            const { plugin, client } = load();
            await plugin._closeConnection();
            expect(client.quit).toHaveBeenCalled();
            expect(client.destroy).not.toHaveBeenCalled();
        });

        it('destroys instead of quitting while stuck reconnecting', async () => {
            // quit() waits for a live connection, so it would never settle here.
            const { plugin, client } = load();
            client.isReady = false;
            await plugin._closeConnection();
            expect(client.destroy).toHaveBeenCalled();
            expect(client.quit).not.toHaveBeenCalled();
        });

        it('swallows errors while closing the connection', async () => {
            const { plugin, client } = load();
            client.quit.mockRejectedValue(new Error('already closed'));
            await expect(plugin._closeConnection()).resolves.toBeUndefined();
            expect(client.quit).toHaveBeenCalled();
        });
    });

    describe('Error paths', () => {
        let plugin;
        let client;

        beforeEach(() => {
            ({ plugin, client } = load());
            client.emit('ready');
        });

        it('returns 500 when scanning for a pattern fails', async () => {
            client.scan.mockRejectedValue(new Error('scan failed'));
            const res = makeRes();

            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, res, jest.fn());

            expect(res.send).toHaveBeenCalledWith(500, expect.stringContaining('Failed to delete cache entries'));
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('scan failed'));
        });

        it('returns 500 when unlinking matched keys fails', async () => {
            client.scan.mockResolvedValue({ cursor: '0', keys: ['a/b'] });
            client.unlink.mockRejectedValue(new Error('unlink failed'));
            const res = makeRes();

            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, res, jest.fn());

            expect(res.send).toHaveBeenCalledWith(500, expect.stringContaining('Failed to delete cache entries'));
        });

        it('reports how many keys a partly-failed deletion already removed', async () => {
            client.scan
                .mockResolvedValueOnce({ cursor: '9', keys: ['a/1', 'a/2'] })
                .mockResolvedValueOnce({ cursor: '0', keys: ['a/3'] });
            client.unlink
                .mockResolvedValueOnce(2)
                .mockRejectedValueOnce(new Error('unlink failed'));
            const res = makeRes();

            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, res, jest.fn());

            expect(JSON.parse(res.send.mock.calls[0][1])).toEqual({
                error: 'Failed to delete cache entries',
                message: 'unlink failed',
                deleted: 2
            });
        });

        it('returns 500 when a single deletion fails', async () => {
            client.del.mockRejectedValue(new Error('del failed'));
            const res = makeRes();

            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/b' } }, res, jest.fn());

            expect(res.send).toHaveBeenCalledWith(500, expect.stringContaining('Failed to delete cache entry'));
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('del failed'));
        });

        it('warns but still calls next when writing to the cache fails', async () => {
            client.set.mockRejectedValue(new Error('set failed'));
            const next = jest.fn();

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 200, content: Buffer.from('x'), headers: {} }
            }, makeRes(), next);

            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('set failed'));
            expect(next).toHaveBeenCalled();
        });
    });

    describe('Pattern deletion over multiple SCAN batches', () => {
        it('unlinks each batch as it arrives instead of buffering them all', async () => {
            const { plugin, client } = load();
            client.emit('ready');

            client.scan
                .mockResolvedValueOnce({ cursor: '17', keys: ['a/1', 'a/2'] })
                .mockResolvedValueOnce({ cursor: '0', keys: ['a/3'] });
            client.unlink
                .mockResolvedValueOnce(2)
                .mockResolvedValueOnce(1);

            const res = makeRes();
            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, res, jest.fn());

            expect(client.unlink).toHaveBeenCalledTimes(2);
            expect(client.unlink).toHaveBeenNthCalledWith(1, ['a/1', 'a/2']);
            expect(client.unlink).toHaveBeenNthCalledWith(2, ['a/3']);
            expect(client.scan).toHaveBeenCalledWith('17', { MATCH: 'a/*', COUNT: 1000 });
            expect(client.scan).toHaveBeenNthCalledWith(1, '0', { MATCH: 'a/*', COUNT: 1000 });
            expect(JSON.parse(res.send.mock.calls[0][1])).toEqual({
                message: 'Cache cleared successfully',
                pattern: 'http://a/*',
                deleted: 3
            });
        });

        it('reports zero deletions without calling unlink', async () => {
            const { plugin, client } = load();
            client.emit('ready');

            const res = makeRes();
            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, res, jest.fn());

            expect(client.unlink).not.toHaveBeenCalled();
            expect(res.send).toHaveBeenCalledWith(200, expect.stringContaining('No cache entries found'));
        });

        it('coerces a numeric cursor to a string', async () => {
            const { plugin, client } = load();
            client.emit('ready');

            client.scan
                .mockResolvedValueOnce({ cursor: 42, keys: [] })
                .mockResolvedValueOnce({ cursor: 0, keys: [] });

            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/*' } }, makeRes(), jest.fn());

            expect(client.scan).toHaveBeenNthCalledWith(2, '42', { MATCH: 'a/*', COUNT: 1000 });
        });
    });

    describe('Bodyless responses', () => {
        it.each([204, 301, 410])('caches status %i with no content instead of throwing', async (statusCode) => {
            const { plugin, client } = load();
            client.emit('ready');
            const next = jest.fn();

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode, content: undefined, headers: {} }
            }, makeRes(), next);

            expect(next).toHaveBeenCalled();
            expect(console.warn).not.toHaveBeenCalled();
            const stored = JSON.parse(client.set.mock.calls[0][1]);
            expect(stored).toEqual({ statusCode, content: '', headers: {} });
        });
    });

    describe('Cacheable status codes', () => {
        it.each([200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501])(
            'caches status %i', async (statusCode) => {
                const { plugin, client } = load();
                client.emit('ready');

                await plugin.pageLoaded({
                    prerender: { url: 'http://a/b', statusCode, content: 'x', headers: {} }
                }, makeRes(), jest.fn());

                expect(client.set).toHaveBeenCalled();
            });

        it.each([201, 302, 400, 401, 403, 500, 502, 503])(
            'does not cache status %i', async (statusCode) => {
                const { plugin, client } = load();
                client.emit('ready');

                await plugin.pageLoaded({
                    prerender: { url: 'http://a/b', statusCode, content: 'x', headers: {} }
                }, makeRes(), jest.fn());

                expect(client.set).not.toHaveBeenCalled();
            });
    });

    describe('Cache key normalization', () => {
        it.each([
            ['http://a/b', 'a/b'],
            ['https://a/b', 'a/b'],
            ['http://a/b?next=http://c/d', 'a/b?next=http://c/d'],
            ['a/b', 'a/b'],
            ['a/b?next=http://c/d', 'a/b?next=http://c/d'],
            ['ftp://a/b', 'ftp://a/b']
        ])('maps %s to key %s', async (url, key) => {
            const { plugin, client } = load();
            client.emit('ready');

            await plugin.requestReceived({ method: 'GET', prerender: { url } }, makeRes(), jest.fn());

            expect(client.get).toHaveBeenCalledWith(key);
        });
    });

    describe('TTL handling', () => {
        it('sets an expiry when PAGE_TTL is positive', async () => {
            const { plugin, client } = load({ env: { PAGE_TTL: '3600' } });
            client.emit('ready');

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 200, content: 'x', headers: {} }
            }, makeRes(), jest.fn());

            expect(client.set).toHaveBeenCalledWith('a/b', expect.any(String), { EX: 3600 });
        });

        it('stores without an expiry when PAGE_TTL is 0', async () => {
            const { plugin, client } = load({ env: { PAGE_TTL: '0' } });
            client.emit('ready');

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 200, content: 'x', headers: {} }
            }, makeRes(), jest.fn());

            expect(client.set).toHaveBeenCalledWith('a/b', expect.any(String));
        });

        it('defaults to one day when PAGE_TTL is unset', async () => {
            const { plugin, client } = load();
            client.emit('ready');

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 200, content: 'x', headers: {} }
            }, makeRes(), jest.fn());

            expect(client.set).toHaveBeenCalledWith('a/b', expect.any(String), { EX: 86400 });
        });

        it.each([
            ['invalid', 'Invalid PAGE_TTL value'],
            ['-100', 'PAGE_TTL cannot be negative']
        ])('warns and uses the default for PAGE_TTL=%s', async (value, warning) => {
            const { plugin, client } = load({ env: { PAGE_TTL: value } });
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(warning));
            client.emit('ready');

            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 200, content: 'x', headers: {} }
            }, makeRes(), jest.fn());

            expect(client.set).toHaveBeenCalledWith('a/b', expect.any(String), { EX: 86400 });
        });
    });

    describe('Cache reads', () => {
        let plugin;
        let client;

        beforeEach(() => {
            ({ plugin, client } = load());
            client.emit('ready');
        });

        it('drops headers containing control characters', async () => {
            client.get.mockResolvedValue(JSON.stringify({
                statusCode: 200,
                content: 'ok',
                headers: { 'x-good': 'fine', 'x-bad': 'bad\nvalue' }
            }));
            const res = makeRes();

            await plugin.requestReceived({ method: 'GET', prerender: { url: 'https://a/b' } }, res, jest.fn());

            expect(res.setHeader).toHaveBeenCalledWith('x-good', 'fine');
            expect(res.setHeader).not.toHaveBeenCalledWith('x-bad', expect.anything());
        });

        it('shares one cache entry between http and https', async () => {
            await plugin.requestReceived({ method: 'GET', prerender: { url: 'https://a/b' } }, makeRes(), jest.fn());
            await plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), jest.fn());

            expect(client.get).toHaveBeenNthCalledWith(1, 'a/b');
            expect(client.get).toHaveBeenNthCalledWith(2, 'a/b');
        });

        it('treats an empty stored value as a miss rather than parsing it', async () => {
            client.get.mockResolvedValue('');
            const next = jest.fn();

            await plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);

            expect(console.error).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('falls through when the cached entry is corrupt', async () => {
            client.get.mockResolvedValue('{not json');
            const next = jest.fn();

            await plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);

            expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to parse'));
            expect(next).toHaveBeenCalled();
        });

        it('falls through on a non-syntax read error without logging a parse failure', async () => {
            client.get.mockRejectedValue(new Error('read failed'));
            const next = jest.fn();

            await plugin.requestReceived({ method: 'GET', prerender: { url: 'http://a/b' } }, makeRes(), next);

            expect(console.error).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('coerces a non-string url instead of throwing past next()', async () => {
            await plugin.requestReceived({ method: 'GET', prerender: { url: 12345 } }, makeRes(), jest.fn());
            expect(client.get).toHaveBeenCalledWith('12345');
        });

        it.each([
            ['no prerender object', null],
            ['no prerender url', {}]
        ])('falls through on a GET with %s', async (_label, prerender) => {
            const next = jest.fn();
            await plugin.requestReceived({ method: 'GET', prerender }, makeRes(), next);
            expect(client.get).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('returns 400 for a DELETE with no prerender url', async () => {
            const res = makeRes();
            await plugin.requestReceived({ method: 'DELETE', prerender: null }, res, jest.fn());
            expect(res.send).toHaveBeenCalledWith(400, JSON.stringify({
                error: 'Bad request',
                message: 'Missing prerender URL'
            }));
        });

        it('reports the deleted count for a single url', async () => {
            const res = makeRes();
            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'https://a/b' } }, res, jest.fn());
            expect(client.del).toHaveBeenCalledWith('a/b');
            expect(JSON.parse(res.send.mock.calls[0][1])).toEqual({
                message: 'Cache cleared successfully',
                url: 'https://a/b',
                deleted: 1
            });
        });

        it('returns 404 when deleting a url that is not cached', async () => {
            client.del.mockResolvedValue(0);
            const res = makeRes();
            await plugin.requestReceived({ method: 'DELETE', prerender: { url: 'http://a/b' } }, res, jest.fn());
            expect(res.send).toHaveBeenCalledWith(404, expect.stringContaining('Cache entry not found'));
        });

        it('passes other methods straight through', () => {
            const next = jest.fn();
            plugin.requestReceived({ method: 'POST', prerender: { url: 'http://a/b' } }, makeRes(), next);
            expect(next).toHaveBeenCalled();
        });

        it('skips caching a response with no prerender payload', async () => {
            const next = jest.fn();
            await plugin.pageLoaded({}, makeRes(), next);
            expect(client.set).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('skips caching a response with no url', async () => {
            const next = jest.fn();
            await plugin.pageLoaded({
                prerender: { statusCode: 200, content: 'x', headers: {} }
            }, makeRes(), next);
            expect(client.set).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        it('skips caching an uncacheable status code', async () => {
            const next = jest.fn();
            await plugin.pageLoaded({
                prerender: { url: 'http://a/b', statusCode: 500, content: 'x', headers: {} }
            }, makeRes(), next);
            expect(client.set).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });
    });
});
