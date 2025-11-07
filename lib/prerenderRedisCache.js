/**
 * Basic Config Variables
 * redis_url (string) - Redis hostname (defaults to localhost)
 * ttl (int) - TTL on keys set in redis (defaults to 1 day)
 */
const url = require('url');
const redis = require('redis');

const DEFAULT_TTL = 86400; // 1 day in seconds
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_DELAY = 5000; // 5 seconds
const RECONNECT_TIMEOUT = 1000 * 60 * 60; // 1 hour

/**
 * Get Redis URL from environment variables
 * @returns {String} - Redis URL
 */
const getRedisUrl = () => {
    return process.env.REDISTOGO_URL ||
        process.env.REDISCLOUD_URL ||
        process.env.REDISGREEN_URL ||
        process.env.REDIS_URL ||
        'redis://127.0.0.1:6379';
};

/**
 * Validate and parse TTL from environment variable
 * @returns {Number} - Valid TTL value
 */
const getValidatedTTL = () => {
    if (process.env.PAGE_TTL === undefined) {
        return DEFAULT_TTL;
    }

    const ttl = parseInt(process.env.PAGE_TTL, 10);

    if (isNaN(ttl)) {
        console.warn(`Redis Cache: Invalid PAGE_TTL value "${process.env.PAGE_TTL}", using default: ${DEFAULT_TTL}`);
        return DEFAULT_TTL;
    }

    if (ttl < 0) {
        console.warn(`Redis Cache: PAGE_TTL cannot be negative, using default: ${DEFAULT_TTL}`);
        return DEFAULT_TTL;
    }

    return ttl;
};

/**
 * Create Redis client retry strategy
 * @param {Object} options - Retry options from redis client
 * @returns {Number|undefined} - Delay in ms, or undefined to stop retrying
 */
const createRetryStrategy = (options) => {
    if (options.error && options.error.code === 'ECONNREFUSED') {
        console.warn('Redis Cache: Connection refused, will retry...');
    }

    if (options.total_retry_time > RECONNECT_TIMEOUT) {
        console.error('Redis Cache: Retry time exhausted');
        return undefined;
    }

    if (options.attempt > MAX_RECONNECT_ATTEMPTS) {
        console.error('Redis Cache: Max reconnection attempts reached');
        return undefined;
    }

    return Math.min(options.attempt * 100, RECONNECT_DELAY);
};

// Initialize configuration
const REDIS_URL = getRedisUrl();
const TTL = getValidatedTTL();
const connection = url.parse(REDIS_URL);
let redisOnline = false;
let reconnectAttempts = 0;

// Create Redis client with retry strategy
const client = redis.createClient({
    host: connection.hostname,
    port: connection.port,
    retry_strategy: createRetryStrategy
});

const STATUS_CODES_TO_CACHE = {
    200: true,
    203: true,
    204: true,
    206: true,
    300: true,
    301: true,
    404: true,
    405: true,
    410: true,
    414: true,
    501: true
};

// Parse out password from the connection string
if (connection.auth) {
    client.auth(connection.auth.split(':')[1], (error) => {
        if (error) {
            console.error(`Redis Cache Authentication Error: ${error}`);
        }
    });
}

// Make redis connection
// Select Redis database, parsed from the URL
connection.path = (connection.pathname || '/').slice(1);
connection.database = connection.path.length ? connection.path : '0';
client.select(connection.database, (error) => {
    if (error) {
        console.error(`Redis Cache Database Selection Error: ${error}`);
    }
});

// Catch all error handler. If redis breaks for any reason it will be reported here.
client.on('error', (error) => {
    console.warn(`Redis Cache Error: ${error}`);
});

client.on('ready', () => {
    redisOnline = true;
    reconnectAttempts = 0;
    console.log('Redis Cache Connected');
});

client.on('reconnecting', () => {
    reconnectAttempts++;
    console.log(`Redis Cache: Reconnecting (attempt ${reconnectAttempts})...`);
});

client.on('end', () => {
    redisOnline = false;
    console.warn('Redis Cache Connection Closed. Will now bypass redis until it\'s back.');
});

/**
 * Helper function to send JSON response
 * @param {Object} res - Response object
 * @param {Number} statusCode - HTTP status code
 * @param {Object} data - Response data
 */
const sendJsonResponse = (res, statusCode, data) => {
    res.send(statusCode, JSON.stringify(data));
};

/**
 * Helper function to log Redis cache errors
 * @param {String} operation - The operation that failed
 * @param {Error} error - The error object
 */
const logRedisError = (operation, error) => {
    console.warn(`Redis Cache Error on ${operation}: ${error}`);
};

/**
 * Validate if header value is safe to set
 * @param {String} headerValue - The header value to validate
 * @returns {Boolean} - True if header is valid
 */
const isValidHeader = (headerValue) => {
    return !/[^\t\x20-\x7e\x80-\xff]/.test(headerValue);
};

/**
 * Scan Redis keys matching a pattern using SCAN (non-blocking)
 * @param {String} pattern - The pattern to match
 * @param {Function} callback - Callback with (error, keys)
 */
const scanKeys = (pattern, callback) => {
    let allKeys = [];
    let cursor = '0';

    const scan = () => {
        client.scan(cursor, 'MATCH', pattern, 'COUNT', 100, (error, reply) => {
            if (error) {
                return callback(error);
            }

            cursor = reply[0];
            const keys = reply[1];

            if (keys.length > 0) {
                allKeys = allKeys.concat(keys);
            }

            // Continue scanning if cursor is not 0
            if (cursor === '0') {
                callback(null, allKeys);
            } else {
                scan();
            }
        });
    };

    scan();
};

/**
 * Handle cache deletion for a pattern (with wildcard)
 * Uses SCAN instead of KEYS to avoid blocking Redis
 * @param {String} pattern - The URL pattern to delete
 * @param {Object} res - Response object
 */
const handlePatternDeletion = (pattern, res) => {
    scanKeys(pattern, (error, keys) => {
        if (error) {
            logRedisError('pattern lookup', error);
            return sendJsonResponse(res, 500, {
                error: 'Failed to lookup cache keys',
                message: error.message
            });
        }

        if (!keys || keys.length === 0) {
            return sendJsonResponse(res, 200, {
                message: 'No cache entries found matching pattern',
                pattern,
                deleted: 0
            });
        }

        // Delete all matching keys
        client.del(keys, (delError, deletedCount) => {
            if (delError) {
                logRedisError('deletion', delError);
                return sendJsonResponse(res, 500, {
                    error: 'Failed to delete cache entries',
                    message: delError.message
                });
            }

            sendJsonResponse(res, 200, {
                message: 'Cache cleared successfully',
                pattern,
                deleted: deletedCount
            });
        });
    });
};

/**
 * Handle cache deletion for a single URL
 * @param {String} url - The URL to delete
 * @param {Object} res - Response object
 */
const handleSingleDeletion = (url, res) => {
    client.del(url, (error, result) => {
        if (error) {
            logRedisError('deletion', error);
            return sendJsonResponse(res, 500, {
                error: 'Failed to delete cache entry',
                message: error.message
            });
        }

        if (result === 0) {
            return sendJsonResponse(res, 404, {
                message: 'Cache entry not found',
                url
            });
        }

        sendJsonResponse(res, 200, {
            message: 'Cache cleared successfully',
            url,
            deleted: result
        });
    });
};

/**
 * Handle DELETE request for cache invalidation
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const handleCacheDelete = (req, res) => {
    if (!req.prerender || !req.prerender.url) {
        return sendJsonResponse(res, 400, {
            error: 'Bad request',
            message: 'Missing prerender URL'
        });
    }

    const urlToDelete = req.prerender.url;

    // Check if this is a pattern-based deletion (e.g., contains wildcard)
    if (urlToDelete.includes('*')) {
        handlePatternDeletion(urlToDelete, res);
    } else {
        handleSingleDeletion(urlToDelete, res);
    }
};

/**
 * Handle GET request to retrieve from cache
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
const handleCacheGet = (req, res, next) => {
    if (!req.prerender || !req.prerender.url) {
        return next();
    }

    client.get(req.prerender.url, (error, result) => {
        if (error || !result) {
            return next();
        }

        try {
            const response = JSON.parse(result);
            const { headers } = response;

            for (const key in headers) {
                if (headers.hasOwnProperty(key) && isValidHeader(headers[key])) {
                    res.setHeader(key, headers[key]);
                }
            }
            res.send(response.statusCode, response.content);
        } catch (parseError) {
            console.error(`Redis Cache Error: Failed to parse cached response for ${req.prerender.url}`);
            next();
        }
    });
};

module.exports = {
    requestReceived: (req, res, next) => {
        // Handle cache invalidation for DELETE requests
        if (req.method === 'DELETE' && redisOnline) {
            return handleCacheDelete(req, res);
        }

        // Handle GET requests - retrieve from cache
        if (req.method === 'GET' && redisOnline) {
            return handleCacheGet(req, res, next);
        }

        next();
    },

    pageLoaded: (req, res, next) => {
        if (!redisOnline || !req.prerender || !STATUS_CODES_TO_CACHE[req.prerender.statusCode]) {
            return next();
        }

        const key = req.prerender.url;
        const response = {
            statusCode: req.prerender.statusCode,
            content: req.prerender.content.toString(),
            headers: req.prerender.headers
        };

        client.set(key, JSON.stringify(response), (error, reply) => {
            // If library set to cache set an expiry on the key.
            if (!error && reply && TTL) {
                client.expire(key, TTL, (error, didSetExpiry) => {
                    if (!error && !didSetExpiry) {
                        console.warn(`Could not set expiry for "${key}"`);
                    }
                });
            }
        });

        next();
    }
};
