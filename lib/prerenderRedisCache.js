/**
 * Basic Config Variables
 * redis_url (string) - Redis hostname (defaults to localhost)
 * ttl (int) - TTL on keys set in redis (defaults to 1 day)
 */
const redis = require('redis');

const DEFAULT_TTL = 86400; // 1 day in seconds
const RECONNECT_DELAY = 5000; // 5 seconds, the cap on reconnect backoff
const SCAN_COUNT = 1000; // keys per SCAN iteration

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
 * Reconnect backoff. Never gives up: while Redis is down every hook falls
 * through to next(), so the only cost of retrying forever is one socket,
 * whereas giving up leaves the process permanently cacheless.
 * Each failed attempt already surfaces through the 'error' event, so this
 * does not log. node-redis passes 0 for the first retry, hence the +1.
 * @param {Number} retries - Retries so far, starting at 0
 * @returns {Number} - Delay in ms before the next attempt
 */
const reconnectStrategy = (retries) => Math.min((retries + 1) * 100, RECONNECT_DELAY);

// Initialize configuration
const REDIS_URL = getRedisUrl();
const TTL = getValidatedTTL();
let redisOnline = false;

// Create Redis client with v5.x API
const client = redis.createClient({
    url: REDIS_URL,
    socket: { reconnectStrategy }
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

// Error handler - must be set before connect()
client.on('error', (error) => {
    console.warn(`Redis Cache Error: ${error.message}`);
    redisOnline = false;
});

// Ready event handler
client.on('ready', () => {
    redisOnline = true;
    console.log('Redis Cache Connected');
});

// Reconnecting event handler
client.on('reconnecting', () => {
    redisOnline = false;
});

// End event handler
client.on('end', () => {
    redisOnline = false;
    console.warn('Redis Cache Connection Closed. Will now bypass redis until it\'s back.');
});

// Connect to Redis - v5.x requires explicit connect()
client.connect().catch((error) => {
    console.error(`Redis Cache: Initial connection failed: ${error.message}`);
    console.warn('Redis Cache: Running without cache until Redis is available');
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
 * Normalize URL for use as Redis key by removing protocol
 * This allows HTTP and HTTPS URLs to share the same cache
 * Callers guarantee a non-empty url.
 * @param {String} url - The URL to normalize
 * @returns {String} - URL without protocol (e.g., "www.example.com/path")
 */
const normalizeUrlForKey = (url) => String(url).replace(/^https?:\/\//, '');

/**
 * Validate if header value is safe to set
 * @param {String} headerValue - The header value to validate
 * @returns {Boolean} - True if header is valid
 */
const isValidHeader = (headerValue) => {
    return !/[^\t\x20-\x7e\x80-\xff]/.test(headerValue);
};

/**
 * Delete every key matching a pattern, one SCAN batch at a time.
 * SCAN (not KEYS) and UNLINK (not DEL) keep the server responsive: neither
 * the match set nor the delete is ever handled in one blocking chunk.
 * @param {String} pattern - The pattern to match
 * @returns {Promise<Number>} - Number of keys deleted
 */
const deleteKeysMatching = async (pattern, progress) => {
    let cursor = '0'; // Redis SCAN cursor must be string in v5.x

    do {
        const result = await client.scan(cursor, {
            MATCH: pattern,
            COUNT: SCAN_COUNT
        });

        cursor = result.cursor.toString(); // Ensure cursor is string

        if (result.keys.length > 0) {
            progress.deleted += await client.unlink(result.keys);
        }
    } while (cursor !== '0');
};

/**
 * Handle cache deletion for a pattern (with wildcard)
 * @param {String} pattern - The URL pattern to delete
 * @param {Object} res - Response object
 */
const handlePatternDeletion = async (pattern, res) => {
    // Deleting per SCAN batch means a mid-way failure leaves earlier batches
    // gone, so the count travels with the request and is reported either way.
    const progress = { deleted: 0 };

    try {
        await deleteKeysMatching(normalizeUrlForKey(pattern), progress);

        if (progress.deleted === 0) {
            return sendJsonResponse(res, 200, {
                message: 'No cache entries found matching pattern',
                pattern,
                deleted: 0
            });
        }

        sendJsonResponse(res, 200, {
            message: 'Cache cleared successfully',
            pattern,
            deleted: progress.deleted
        });
    } catch (error) {
        console.warn(`Redis Cache Error on pattern deletion: ${error}`);
        return sendJsonResponse(res, 500, {
            error: 'Failed to delete cache entries',
            message: error.message,
            deleted: progress.deleted
        });
    }
};

/**
 * Handle cache deletion for a single URL
 * @param {String} url - The URL to delete
 * @param {Object} res - Response object
 */
const handleSingleDeletion = async (url, res) => {
    try {
        const cacheKey = normalizeUrlForKey(url);
        const result = await client.del(cacheKey);

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
    } catch (error) {
        console.warn(`Redis Cache Error on deletion: ${error}`);
        return sendJsonResponse(res, 500, {
            error: 'Failed to delete cache entry',
            message: error.message
        });
    }
};

/**
 * Handle DELETE request for cache invalidation
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 */
const handleCacheDelete = async (req, res) => {
    if (!req.prerender || !req.prerender.url) {
        return sendJsonResponse(res, 400, {
            error: 'Bad request',
            message: 'Missing prerender URL'
        });
    }

    const urlToDelete = req.prerender.url;

    // Check if this is a pattern-based deletion (e.g., contains wildcard)
    if (urlToDelete.includes('*')) {
        return await handlePatternDeletion(urlToDelete, res);
    } else {
        return await handleSingleDeletion(urlToDelete, res);
    }
};

/**
 * Handle GET request to retrieve from cache
 * @param {Object} req - Request object
 * @param {Object} res - Response object
 * @param {Function} next - Next middleware function
 */
const handleCacheGet = async (req, res, next) => {
    if (!req.prerender || !req.prerender.url) {
        return next();
    }

    const cacheKey = normalizeUrlForKey(req.prerender.url);

    try {
        const result = await client.get(cacheKey);

        if (!result) {
            return next();
        }

        const response = JSON.parse(result);
        const { headers } = response;

        for (const key in headers) {
            if (headers.hasOwnProperty(key) && isValidHeader(headers[key])) {
                res.setHeader(key, headers[key]);
            }
        }
        res.send(response.statusCode, response.content);
    } catch (error) {
        if (error instanceof SyntaxError) {
            console.error(`Redis Cache Error: Failed to parse cached response for ${req.prerender.url}`);
        }
        next();
    }
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

    pageLoaded: async (req, res, next) => {
        if (!redisOnline || !req.prerender || !req.prerender.url ||
            !STATUS_CODES_TO_CACHE[req.prerender.statusCode]) {
            return next();
        }

        try {
            const cacheKey = normalizeUrlForKey(req.prerender.url);
            const response = {
                statusCode: req.prerender.statusCode,
                // Bodyless statuses (204, 301, 410...) arrive with no content
                content: (req.prerender.content || '').toString(),
                headers: req.prerender.headers
            };

            // Set the cache entry with optional TTL
            if (TTL > 0) {
                await client.set(cacheKey, JSON.stringify(response), { EX: TTL });
            } else {
                await client.set(cacheKey, JSON.stringify(response));
            }
        } catch (error) {
            console.warn(`Redis Cache Error on set: ${error}`);
        }

        next();
    },

    // For testing only
    _reconnectStrategy: reconnectStrategy,
    _closeConnection: async () => {
        try {
            // quit() waits for a live connection; while the client is stuck in
            // its (endless) reconnect loop that never settles, so tear it down.
            if (client.isReady) {
                await client.quit();
            } else {
                client.destroy();
            }
        } catch {
            // Ignore errors during cleanup
        }
    }
};
