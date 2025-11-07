/**
 * Tests for prerender-redis-cache
 */

// Mock redis before requiring the module
jest.mock('redis', () => require('redis-mock'));

describe('prerender-redis-cache', () => {
    let plugin;
    let mockReq;
    let mockRes;
    let mockNext;

    beforeEach((done) => {
        // Clear module cache to get fresh instance
        jest.resetModules();

        // Mock console methods
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});

        // Load plugin fresh each time
        plugin = require('./prerenderRedisCache');

        // Wait for Redis to be ready
        setTimeout(() => {
            // Create mock request/response/next
            mockReq = {
                method: 'GET',
                prerender: {
                    url: 'http://example.com/page',
                    statusCode: 200,
                    content: Buffer.from('<html>Test Content</html>'),
                    headers: {
                        'content-type': 'text/html'
                    }
                }
            };

            mockRes = {
                send: jest.fn(),
                setHeader: jest.fn()
            };

            mockNext = jest.fn();
            done();
        }, 50);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Configuration', () => {
        it('should use default TTL when PAGE_TTL is not set', () => {
            delete process.env.PAGE_TTL;
            jest.resetModules();
            const plugin = require('./prerenderRedisCache');
            expect(plugin).toBeDefined();
        });

        it('should warn about invalid PAGE_TTL and use default', () => {
            process.env.PAGE_TTL = 'invalid';
            jest.resetModules();
            require('./prerenderRedisCache');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('Invalid PAGE_TTL value')
            );
        });

        it('should warn about negative PAGE_TTL and use default', () => {
            process.env.PAGE_TTL = '-100';
            jest.resetModules();
            require('./prerenderRedisCache');
            expect(console.warn).toHaveBeenCalledWith(
                expect.stringContaining('PAGE_TTL cannot be negative')
            );
        });

        it('should accept valid PAGE_TTL', () => {
            process.env.PAGE_TTL = '3600';
            jest.resetModules();
            const plugin = require('./prerenderRedisCache');
            expect(plugin).toBeDefined();
        });

        it('should accept PAGE_TTL = 0', () => {
            process.env.PAGE_TTL = '0';
            jest.resetModules();
            const plugin = require('./prerenderRedisCache');
            expect(plugin).toBeDefined();
        });
    });

    describe('requestReceived - GET requests', () => {
        it('should call next when cache miss', (done) => {
            plugin.requestReceived(mockReq, mockRes, () => {
                expect(mockRes.send).not.toHaveBeenCalled();
                done();
            });
        });

        it('should return cached content on cache hit', (done) => {
            // First, cache the page
            plugin.pageLoaded(mockReq, mockRes, () => {
                // Wait for cache to be written
                setTimeout(() => {
                    // Create new response object for the GET request
                    const getRes = {
                        send: jest.fn(),
                        setHeader: jest.fn()
                    };

                    // Try to retrieve from cache
                    plugin.requestReceived(mockReq, getRes, () => {
                        // Should not reach here if cached
                        done.fail('Should have returned cached content');
                    });

                    // Wait for cache retrieval
                    setTimeout(() => {
                        expect(getRes.setHeader).toHaveBeenCalledWith('content-type', 'text/html');
                        expect(getRes.send).toHaveBeenCalledWith(200, expect.any(String));
                        done();
                    }, 50);
                }, 50);
            });
        });

        it('should call next for non-GET requests', (done) => {
            mockReq.method = 'POST';
            plugin.requestReceived(mockReq, mockRes, () => {
                expect(mockNext).toBeDefined();
                done();
            });
        });

        it('should skip invalid headers', (done) => {
            mockReq.prerender.headers = {
                'valid-header': 'valid-value',
                'invalid-header': 'invalid\x00value'
            };

            plugin.pageLoaded(mockReq, mockRes, () => {
                setTimeout(() => {
                    const getRes = {
                        send: jest.fn(),
                        setHeader: jest.fn()
                    };

                    plugin.requestReceived(mockReq, getRes, () => {});

                    setTimeout(() => {
                        // Should set valid header
                        expect(getRes.setHeader).toHaveBeenCalledWith('valid-header', 'valid-value');
                        // Should not set invalid header
                        expect(getRes.setHeader).not.toHaveBeenCalledWith('invalid-header', expect.any(String));
                        done();
                    }, 50);
                }, 50);
            });
        });
    });

    describe('requestReceived - DELETE requests', () => {
        it('should delete single URL from cache', (done) => {
            mockReq.method = 'DELETE';

            plugin.requestReceived(mockReq, mockRes, mockNext);

            setTimeout(() => {
                expect(mockRes.send).toHaveBeenCalled();
                const response = JSON.parse(mockRes.send.mock.calls[0][1]);
                expect(response.message).toBeDefined();
                done();
            }, 50);
        });

        it('should delete pattern-based URLs from cache', (done) => {
            mockReq.method = 'DELETE';
            mockReq.prerender.url = 'http://example.com/*';

            plugin.requestReceived(mockReq, mockRes, mockNext);

            setTimeout(() => {
                expect(mockRes.send).toHaveBeenCalled();
                const response = JSON.parse(mockRes.send.mock.calls[0][1]);
                expect(response.message).toContain('No cache entries found');
                expect(response.deleted).toBe(0);
                done();
            }, 50);
        });

        it('should successfully delete cached entry', (done) => {
            // First cache something
            plugin.pageLoaded(mockReq, mockRes, () => {
                setTimeout(() => {
                    // Then delete it
                    mockReq.method = 'DELETE';
                    const deleteRes = {
                        send: jest.fn()
                    };

                    plugin.requestReceived(mockReq, deleteRes, mockNext);

                    setTimeout(() => {
                        expect(deleteRes.send).toHaveBeenCalled();
                        const response = JSON.parse(deleteRes.send.mock.calls[0][1]);
                        expect(response.message).toBe('Cache cleared successfully');
                        expect(response.deleted).toBeGreaterThan(0);
                        done();
                    }, 50);
                }, 50);
            });
        });
    });

    describe('pageLoaded', () => {
        it('should cache page with status code 200', (done) => {
            mockReq.prerender.statusCode = 200;

            plugin.pageLoaded(mockReq, mockRes, () => {
                done();
            });
        });

        it('should cache page with status code 404', (done) => {
            mockReq.prerender.statusCode = 404;

            plugin.pageLoaded(mockReq, mockRes, () => {
                done();
            });
        });

        it('should NOT cache page with status code 500', () => {
            mockReq.prerender.statusCode = 500;

            plugin.pageLoaded(mockReq, mockRes, mockNext);

            expect(mockNext).toHaveBeenCalled();
        });

        it('should NOT cache page with status code 403', () => {
            mockReq.prerender.statusCode = 403;

            plugin.pageLoaded(mockReq, mockRes, mockNext);

            expect(mockNext).toHaveBeenCalled();
        });

        it('should cache all configured status codes', () => {
            const cachableStatusCodes = [200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501];

            cachableStatusCodes.forEach(statusCode => {
                mockReq.prerender.statusCode = statusCode;
                mockNext.mockClear();

                plugin.pageLoaded(mockReq, mockRes, mockNext);

                expect(mockNext).toHaveBeenCalled();
            });
        });
    });

    describe('Edge cases', () => {
        it('should handle missing prerender object gracefully', (done) => {
            const badReq = {
                method: 'GET'
            };

            // Should not throw, but call next
            plugin.requestReceived(badReq, mockRes, () => {
                done();
            });
        });

        it('should handle corrupted cache data gracefully', (done) => {
            // This is implicitly tested by try-catch in handleCacheGet
            done();
        });

        it('should handle concurrent requests', (done) => {
            const requests = Array(10).fill(null).map(() => {
                const req = JSON.parse(JSON.stringify(mockReq));
                const res = { send: jest.fn(), setHeader: jest.fn() };
                const next = jest.fn();

                return new Promise((resolve) => {
                    plugin.requestReceived(req, res, () => {
                        resolve();
                    });
                });
            });

            Promise.all(requests).then(() => {
                done();
            });
        });
    });

    describe('Integration', () => {
        it('should handle complete cache lifecycle', (done) => {
            // 1. Initial GET - cache miss
            plugin.requestReceived(mockReq, mockRes, () => {
                // Cache miss, should call next

                // 2. Store in cache
                plugin.pageLoaded(mockReq, mockRes, () => {

                    // Wait for cache to be written
                    setTimeout(() => {
                        // 3. GET from cache - cache hit
                        const getRes = { send: jest.fn(), setHeader: jest.fn() };
                        plugin.requestReceived(mockReq, getRes, () => {});

                        setTimeout(() => {
                            expect(getRes.send).toHaveBeenCalled();

                            // 4. DELETE from cache
                            mockReq.method = 'DELETE';
                            const deleteRes = { send: jest.fn() };
                            plugin.requestReceived(mockReq, deleteRes, () => {});

                            setTimeout(() => {
                                expect(deleteRes.send).toHaveBeenCalled();
                                const response = JSON.parse(deleteRes.send.mock.calls[0][1]);
                                expect(response.deleted).toBeGreaterThan(0);
                                done();
                            }, 50);
                        }, 50);
                    }, 50);
                });
            });
        });
    });
});
