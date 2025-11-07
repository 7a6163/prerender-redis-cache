prerender-redis-cache-ng
========================

[![Tests](https://github.com/7a6163/prerender-redis-cache/actions/workflows/test.yml/badge.svg)](https://github.com/7a6163/prerender-redis-cache/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/7a6163/prerender-redis-cache/branch/master/graph/badge.svg)](https://codecov.io/gh/7a6163/prerender-redis-cache)
[![npm version](https://badge.fury.io/js/prerender-redis-cache-ng.svg)](https://www.npmjs.com/package/prerender-redis-cache-ng)
[![Node.js Version](https://img.shields.io/node/v/prerender-redis-cache-ng.svg)](https://www.npmjs.com/package/prerender-redis-cache-ng)

**Next Generation** Prerender plugin for Redis caching with modern ES6+, comprehensive tests, and production-ready features.

> ⚠️ **Note:** This is a modernized fork of [prerender-redis-cache](https://github.com/jonathanbennett/prerender-redis-cache) with significant improvements and new features.

## ✨ What's New (NG)

- 🚀 **ES6+ Refactored**: Modern JavaScript with arrow functions, const/let, template literals
- 🗑️ **Cache Invalidation**: DELETE requests for single URL and pattern-based deletion
- 🔄 **Auto-Reconnection**: Automatic Redis reconnection with exponential backoff
- ⚡ **SCAN Command**: Non-blocking pattern matching (production-safe, no KEYS)
- 🛡️ **Enhanced Error Handling**: Graceful degradation, validation, defensive programming
- ✅ **Comprehensive Tests**: 33+ tests with 77.94% coverage
- 🔧 **CI/CD Ready**: GitHub Actions + Codecov integration
- 📚 **Better Documentation**: Testing guide, API examples, development docs
- 🐛 **Bug Fixes**: Fixed TTL=0 handling, header validation, JSON parsing errors

Prerender plugin for Redis caching, to be used with the prerender node application from https://github.com/prerender/prerender.

How it works
------------

This plugin stores pages returned through prerender in a redis instance. Currently, it caches the pages for 1 day then expires them. This can be overridden by specifying the env variable "process.env.PAGE_TTL" in seconds. To never expire you should set the `PAGE_TTL` variable to 0.

## 📦 Installation

Install via npm:

```bash
npm install prerender-redis-cache-ng --save
```

## 🚀 Quick Start

In your prerender server.js:

```javascript
const prerender = require('prerender');
const server = prerender();

// Use the Redis cache plugin
server.use(require('prerender-redis-cache-ng'));

server.start();
```

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

Changelog
---------

See [CHANGELOG.md](CHANGELOG.md) for version history and detailed changes.

## Recent Updates

### v1.0.1 (2025-11-07)
- 🐛 **Critical Bug Fix**: Fixed `ClientClosedError` on startup by moving Redis auth/select to ready event handler

### v1.0.0 (2025-01-07)
- ✅ **Cache Invalidation**: DELETE requests for single URL and pattern-based deletion
- ✅ **ES6 Refactoring**: Modern JavaScript with arrow functions, const/let, template literals
- ✅ **Comprehensive Tests**: 33+ tests with 77.94% coverage
- ✅ **CI/CD**: GitHub Actions + Codecov integration
- ✅ **SCAN Command**: Non-blocking pattern matching (production-safe)
- ✅ **Enhanced Error Handling**: Automatic reconnection, validation, graceful degradation
- ✅ **Better Documentation**: Testing guide, development docs, API examples

Todo
----

* Slightly finer-grain error catching to make sure this plugin doesn't crash prerender for any reason.
