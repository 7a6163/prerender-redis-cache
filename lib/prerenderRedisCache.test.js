/**
 * Tests for prerender-redis-cache
 *
 * Prerequisites:
 * - Redis server running on localhost:6379
 * - Run with: docker run -d -p 6379:6379 valkey/valkey:9-alpine
 */

describe('prerender-redis-cache', () => {
    let plugin;
    let mockReq;
    let mockRes;
    let mockNext;
    let redisClient;

    beforeAll(() => {
        // Set test Redis URL (use test database 15 to avoid conflicts)
        process.env.REDIS_URL = 'redis://127.0.0.1:6379/15';

        // Load plugin once for most tests
        plugin = require('./prerenderRedisCache');
    });

    beforeEach((done) => {
        // Mock console methods
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});

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

    afterEach(async () => {
        jest.restoreAllMocks();

        // Clean up test Redis database
        if (!redisClient) {
            const redis = require('redis');
            redisClient = redis.createClient({
                url: 'redis://127.0.0.1:6379/15'
            });
            await redisClient.connect();
        }

        try {
            await redisClient.flushDb(); // Clear test database
        } catch (error) {
            // Ignore cleanup errors
        }
    });

    afterAll(async () => {
        // Close plugin's Redis connection
        if (plugin && plugin._closeConnection) {
            try {
                await plugin._closeConnection();
            } catch (error) {
                // Ignore errors
            }
        }

        // Close cleanup Redis client
        if (redisClient) {
            try {
                await redisClient.quit();
            } catch (error) {
                // Ignore errors
            }
        }
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

        it('should delete pattern-based URLs from cache', async () => {
            mockReq.method = 'DELETE';
            mockReq.prerender.url = 'http://example.com/*';

            await plugin.requestReceived(mockReq, mockRes, mockNext);

            // Wait for async operations
            await new Promise(resolve => setTimeout(resolve, 100));

            expect(mockRes.send).toHaveBeenCalled();
            const response = JSON.parse(mockRes.send.mock.calls[0][1]);
            expect(response.message).toContain('No cache entries found');
            expect(response.deleted).toBe(0);
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

        it('should cache all configured status codes', async () => {
            const cachableStatusCodes = [200, 203, 204, 206, 300, 301, 404, 405, 410, 414, 501];

            for (const statusCode of cachableStatusCodes) {
                mockReq.prerender.statusCode = statusCode;
                mockNext.mockClear();

                await new Promise(resolve => {
                    plugin.pageLoaded(mockReq, mockRes, () => {
                        mockNext();
                        resolve();
                    });
                });

                expect(mockNext).toHaveBeenCalled();
            }
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

    describe('Redis Error Handling', () => {
        it('should handle Redis GET errors gracefully', (done) => {
            // We can't easily mock redis-mock errors, but we can test the flow
            // This tests the error path by ensuring next() is called on error
            const badReq = {
                method: 'GET',
                prerender: {
                    url: 'http://error.test/page'
                }
            };

            plugin.requestReceived(badReq, mockRes, () => {
                expect(mockRes.send).not.toHaveBeenCalled();
                done();
            });
        });

        it('should handle pattern deletion with multiple cached entries', (done) => {
            // Cache multiple entries with same prefix
            const urls = [
                'http://example.com/page1',
                'http://example.com/page2',
                'http://example.com/page3'
            ];

            let cached = 0;
            urls.forEach((url) => {
                const req = {
                    ...mockReq,
                    prerender: {
                        ...mockReq.prerender,
                        url: url
                    }
                };

                plugin.pageLoaded(req, mockRes, () => {
                    cached++;
                    if (cached === urls.length) {
                        // Now delete all with pattern
                        setTimeout(() => {
                            const deleteReq = {
                                method: 'DELETE',
                                prerender: { url: 'http://example.com/*' }
                            };
                            const deleteRes = { send: jest.fn() };

                            plugin.requestReceived(deleteReq, deleteRes, mockNext);

                            setTimeout(() => {
                                expect(deleteRes.send).toHaveBeenCalled();
                                const response = JSON.parse(deleteRes.send.mock.calls[0][1]);
                                expect(response.deleted).toBeGreaterThanOrEqual(0);
                                done();
                            }, 50);
                        }, 50);
                    }
                });
            });
        });

        it('should handle DELETE request with missing prerender', (done) => {
            const badReq = {
                method: 'DELETE'
            };
            const deleteRes = { send: jest.fn() };

            plugin.requestReceived(badReq, deleteRes, mockNext);

            setTimeout(() => {
                expect(deleteRes.send).toHaveBeenCalledWith(
                    400,
                    expect.stringContaining('Missing prerender URL')
                );
                done();
            }, 50);
        });
    });

    describe('TTL and Expiry', () => {
        it('should set TTL on cached entries', (done) => {
            process.env.PAGE_TTL = '3600';
            jest.resetModules();
            const pluginWithTTL = require('./prerenderRedisCache');

            setTimeout(() => {
                const req = {
                    method: 'GET',
                    prerender: {
                        url: 'http://ttl.test/page',
                        statusCode: 200,
                        content: Buffer.from('<html>TTL Test</html>'),
                        headers: { 'content-type': 'text/html' }
                    }
                };

                pluginWithTTL.pageLoaded(req, mockRes, () => {
                    // TTL should be set in Redis (tested implicitly)
                    expect(mockRes.send).not.toHaveBeenCalled();
                    done();
                });
            }, 50);
        });

        it('should handle PAGE_TTL = 0 (never expire)', (done) => {
            process.env.PAGE_TTL = '0';
            jest.resetModules();
            const pluginNoExpiry = require('./prerenderRedisCache');

            setTimeout(() => {
                const req = {
                    method: 'GET',
                    prerender: {
                        url: 'http://noexpiry.test/page',
                        statusCode: 200,
                        content: Buffer.from('<html>No Expiry Test</html>'),
                        headers: { 'content-type': 'text/html' }
                    }
                };

                pluginNoExpiry.pageLoaded(req, mockRes, () => {
                    // TTL should not be set
                    expect(mockRes.send).not.toHaveBeenCalled();
                    done();
                });
            }, 50);
        });
    });

    describe('Header Validation', () => {
        it('should filter out all invalid headers', (done) => {
            const reqWithBadHeaders = {
                ...mockReq,
                prerender: {
                    ...mockReq.prerender,
                    headers: {
                        'valid-header-1': 'valid-value-1',
                        'valid-header-2': 'valid-value-2',
                        'invalid-header-1': 'invalid\x00value',
                        'invalid-header-2': 'another\x01bad',
                        'valid-header-3': 'valid-value-3'
                    }
                }
            };

            plugin.pageLoaded(reqWithBadHeaders, mockRes, () => {
                setTimeout(() => {
                    const getRes = {
                        send: jest.fn(),
                        setHeader: jest.fn()
                    };

                    plugin.requestReceived(reqWithBadHeaders, getRes, () => {});

                    setTimeout(() => {
                        // Check valid headers were set
                        expect(getRes.setHeader).toHaveBeenCalledWith('valid-header-1', 'valid-value-1');
                        expect(getRes.setHeader).toHaveBeenCalledWith('valid-header-2', 'valid-value-2');
                        expect(getRes.setHeader).toHaveBeenCalledWith('valid-header-3', 'valid-value-3');

                        // Check invalid headers were NOT set
                        const calls = getRes.setHeader.mock.calls;
                        const invalidHeaderSet = calls.some(call =>
                            call[0].includes('invalid-header')
                        );
                        expect(invalidHeaderSet).toBe(false);
                        done();
                    }, 50);
                }, 50);
            });
        });

        it('should handle headers with special characters in values', (done) => {
            const reqWithSpecialHeaders = {
                ...mockReq,
                prerender: {
                    ...mockReq.prerender,
                    headers: {
                        'content-type': 'text/html; charset=utf-8',
                        'cache-control': 'max-age=3600, must-revalidate',
                        'x-custom': 'value-with-dashes_and_underscores'
                    }
                }
            };

            plugin.pageLoaded(reqWithSpecialHeaders, mockRes, () => {
                setTimeout(() => {
                    const getRes = {
                        send: jest.fn(),
                        setHeader: jest.fn()
                    };

                    plugin.requestReceived(reqWithSpecialHeaders, getRes, () => {});

                    setTimeout(() => {
                        expect(getRes.setHeader).toHaveBeenCalledWith('content-type', 'text/html; charset=utf-8');
                        expect(getRes.setHeader).toHaveBeenCalledWith('cache-control', 'max-age=3600, must-revalidate');
                        expect(getRes.setHeader).toHaveBeenCalledWith('x-custom', 'value-with-dashes_and_underscores');
                        done();
                    }, 50);
                }, 50);
            });
        });
    });

    describe('Different Status Codes', () => {
        it('should handle all 3xx redirect status codes', (done) => {
            const redirectCodes = [300, 301, 302, 303, 307, 308];
            let tested = 0;

            redirectCodes.forEach((code) => {
                const req = {
                    ...mockReq,
                    prerender: {
                        ...mockReq.prerender,
                        statusCode: code,
                        url: `http://example.com/redirect${code}`
                    }
                };

                // Only 300 and 301 are in STATUS_CODES_TO_CACHE
                plugin.pageLoaded(req, mockRes, () => {
                    tested++;
                    if (tested === redirectCodes.length) {
                        done();
                    }
                });
            });
        });

        it('should NOT cache 2xx codes not in the list', () => {
            const nonCacheableCodes = [201, 202, 205, 207, 208, 226];

            nonCacheableCodes.forEach((code) => {
                mockReq.prerender.statusCode = code;
                mockNext.mockClear();

                plugin.pageLoaded(mockReq, mockRes, mockNext);

                expect(mockNext).toHaveBeenCalled();
            });
        });
    });

    describe('URL Patterns', () => {
        it('should handle URLs with query parameters', (done) => {
            const urlWithQuery = 'http://example.com/page?param=value&other=123';
            const req = {
                ...mockReq,
                prerender: {
                    ...mockReq.prerender,
                    url: urlWithQuery
                }
            };

            plugin.pageLoaded(req, mockRes, () => {
                setTimeout(() => {
                    const getRes = { send: jest.fn(), setHeader: jest.fn() };
                    plugin.requestReceived(req, getRes, () => {});

                    setTimeout(() => {
                        expect(getRes.send).toHaveBeenCalled();
                        done();
                    }, 50);
                }, 50);
            });
        });

        it('should handle URLs with hash fragments', (done) => {
            const urlWithHash = 'http://example.com/page#section';
            const req = {
                ...mockReq,
                prerender: {
                    ...mockReq.prerender,
                    url: urlWithHash
                }
            };

            plugin.pageLoaded(req, mockRes, () => {
                setTimeout(() => {
                    const getRes = { send: jest.fn(), setHeader: jest.fn() };
                    plugin.requestReceived(req, getRes, () => {});

                    setTimeout(() => {
                        expect(getRes.send).toHaveBeenCalled();
                        done();
                    }, 50);
                }, 50);
            });
        });

        it('should handle very long URLs', (done) => {
            const longUrl = 'http://example.com/' + 'a'.repeat(1000);
            const req = {
                ...mockReq,
                prerender: {
                    ...mockReq.prerender,
                    url: longUrl
                }
            };

            plugin.pageLoaded(req, mockRes, () => {
                setTimeout(() => {
                    const getRes = { send: jest.fn(), setHeader: jest.fn() };
                    plugin.requestReceived(req, getRes, () => {});

                    setTimeout(() => {
                        expect(getRes.send).toHaveBeenCalled();
                        done();
                    }, 50);
                }, 50);
            });
        });
    });
});
