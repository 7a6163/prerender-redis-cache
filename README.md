prerender-redis-cache
=======================

[![Tests](https://github.com/7a6163/prerender-redis-cache/actions/workflows/test.yml/badge.svg)](https://github.com/7a6163/prerender-redis-cache/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/7a6163/prerender-redis-cache/branch/master/graph/badge.svg)](https://codecov.io/gh/7a6163/prerender-redis-cache)
[![npm version](https://badge.fury.io/js/prerender-redis-cache.svg)](https://www.npmjs.com/package/prerender-redis-cache)

Prerender plugin for Redis caching, to be used with the prerender node application from https://github.com/prerender/prerender.

How it works
------------

This plugin stores pages returned through prerender in a redis instance. Currently, it caches the pages for 1 day then expires them. This can be overridden by specifying the env variable "process.env.PAGE_TTL" in seconds. To never expire you should set the `PAGE_TTL` variable to 0.

How to use
----------

In your local prerender project run:

    $ npm install prerender-redis-cache --save

Then in the server.js that initializes the prerender:

    server.use(require('prerender-redis-cache'));

Configuration
-------------

By default it will connect to your Redis instance running on localhost and the default redis port with no authentication, and the default database number (normally 0). You can overwrite this by setting the `REDISTOGO_URL`, `REDISCLOUD_URL`, `REDISGREEN_URL` or `REDIS_URL` (in the format redis://user:password@host:port/databaseNumber). This currently covers all heroku add-ons for Redis to support quick start.

### Automatic Reconnection

The plugin includes automatic reconnection logic with exponential backoff:
- Automatically retries connection on failure (up to 10 attempts)
- Maximum reconnection period: 1 hour
- Gracefully bypasses cache when Redis is unavailable
- All connection events are logged for monitoring

### Environment Variables

- **`PAGE_TTL`**: Cache expiration in seconds (default: 86400 = 1 day)
  - Set to `0` for no expiration
  - Invalid values automatically fall back to the default with a warning

Cache Invalidation
------------------

The plugin supports cache invalidation via DELETE requests. This allows you to manually clear cached pages when content is updated.

### Clear a single URL

Send a DELETE request to the prerender service with the URL to clear:

    curl -X DELETE http://localhost:3000/render?url=http://example.com/page

Response:
```json
{
  "message": "Cache cleared successfully",
  "url": "http://example.com/page",
  "deleted": 1
}
```

### Clear multiple URLs with a pattern

Use wildcards (`*`) to clear multiple URLs at once:

    curl -X DELETE http://localhost:3000/render?url=http://example.com/*

This will clear all cached URLs matching the pattern.

Response:
```json
{
  "message": "Cache cleared successfully",
  "pattern": "http://example.com/*",
  "deleted": 15
}
```

**Note:** Pattern matching uses Redis SCAN command (non-blocking, production-safe) to efficiently find matching cache entries without blocking the Redis server.

Acknowledgements
----------------

Thanks to the following for making branches with changes which were merged with the 0.2.0 release.


Fantastic Prerender team.

@nelsonkopliku

@eddietio

@irnc

Testing
-------

This project includes a comprehensive test suite using Jest.

Run tests:
```bash
npm test
```

Run tests with coverage:
```bash
npm run test:coverage
```

See [TESTING.md](TESTING.md) for detailed testing information.

Todo
----

* Slightly finer-grain error catching to make sure this plugin doesn't crash prerender for any reason.
