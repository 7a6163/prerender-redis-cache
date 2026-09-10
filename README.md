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
- 🔄 **Auto-Reconnection**: Backs off to a 5s cap and retries indefinitely — a
  Redis restart never leaves the process permanently cacheless
- ⚡ **Non-Blocking Invalidation**: SCAN instead of KEYS, and UNLINK per batch
  instead of one bulk DEL, so a large purge never stalls the server
- 🔑 **Protocol-Agnostic Keys**: `http://` and `https://` share one cache entry
- 🛡️ **Enhanced Error Handling**: Graceful degradation, validation, defensive programming
- ✅ **Tested to 100%**: 141 tests at 100% coverage and a 100% mutation score
  (Stryker), combining real-Redis integration tests with fast unit tests
- 🔧 **CI/CD Ready**: GitHub Actions + Codecov, with lint, coverage and mutation
  gates enforced on every push
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

The plugin reconnects on its own and **never gives up**:
- Backs off by 100ms per attempt, capped at 5 seconds, retrying indefinitely
- Gracefully bypasses the cache while Redis is unavailable — requests are
  rendered as normal, never failed
- Connection events and every failed attempt are logged for monitoring

Retrying forever is deliberate: giving up after a fixed number of attempts left
the process permanently cacheless after any Redis restart that outlasted them,
while the only cost of retrying is a single socket.

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

Deletion streams: each SCAN batch is UNLINKed as it arrives, so neither the
match set nor the delete is ever handled in one blocking chunk — a purge of
100,000 keys will not stall the server.

Because deletion is incremental, a failure part-way through reports how many
keys were already removed:

```json
{
  "error": "Failed to delete cache entries",
  "message": "...",
  "deleted": 2000
}
```

**Note:** URLs are cached under protocol-agnostic keys, so deleting
`http://example.com/page` also clears the `https://` entry.

Acknowledgements
----------------

Thanks to the following for making branches with changes which were merged with the 0.2.0 release.


Fantastic Prerender team.

@nelsonkopliku

@eddietio

@irnc

Testing
-------

Two suites run under Jest: **real Redis integration tests** for end-to-end
behavior, and **unit tests** with a faked client for the connection lifecycle and
error paths that a healthy server never reaches.

Both are enforced at **100% coverage** and a **100% mutation score**
([Stryker](https://stryker-mutator.io/)).

### Prerequisites

The integration tests require a running Redis server:

```bash
# Using Docker (recommended)
docker run -d -p 6379:6379 valkey/valkey:9-alpine

# Or use your local Redis instance
```

### Run tests

```bash
npm test                # both suites
npm run test:coverage   # fails below 100% on any metric
npm run test:mutation   # Stryker; fails below a 100% mutation score
```

**Note:** Integration tests use Redis database 15 to avoid conflicts with
production data and clean up after each test. The unit tests need no Redis.

Changelog
---------

See [CHANGELOG.md](CHANGELOG.md) for version history and detailed changes.

## Recent Updates

### v1.1.0 (2026-09-10)
- **Fixed**: reconnection gave up after ~5.5s, leaving the process permanently
  cacheless after any Redis restart longer than that
- **Fixed**: bodyless responses (204/301/410) threw and hung the request
- **Fixed**: `_closeConnection()` hung while the client was reconnecting
- **Performance**: wildcard invalidation now `UNLINK`s each SCAN batch instead of
  buffering every match into one blocking `DEL`
- **Added**: oxlint, 100% coverage gate, and 100% mutation score gate (Stryker)

### v1.0.4 (2025-11-07)
- 🔧 **CI/CD**: Fixed Jest hanging issue with `--forceExit` flag
- 🔧 **CI/CD**: Added Redis service to publish workflow
- 🔧 **Testing**: Added `_closeConnection()` method for proper cleanup
- 📦 **Consistency**: Unified Redis image to `valkey/valkey:9-alpine` across all workflows

### v1.0.3 (2025-11-07)
- ⚡ **Testing Infrastructure**: Migrated from redis-mock to real Redis integration tests
- 🚀 **Performance**: 3x faster test execution (~5s vs ~15s)
- 🐛 **Bug Fix**: Fixed Redis v5.x SCAN API cursor type (must be string, not number)
- 🐛 **Bug Fix**: Fixed async/await handling in DELETE operations
- 🔧 **CI/CD**: Added Redis service to GitHub Actions workflow
- 📦 **Dependencies**: Removed redis-mock dependency

### v1.0.2 (2025-11-07)
- 🐛 **Critical Bug Fix**: Fixed Redis 5.x API compatibility (Promise-based API)

### v1.0.1 (2025-11-07)
- 🐛 **Critical Bug Fix**: Fixed `ClientClosedError` on startup by moving Redis auth/select to ready event handler

### v1.0.0 (2025-01-07)
- ✅ **Cache Invalidation**: DELETE requests for single URL and pattern-based deletion
- ✅ **ES6 Refactoring**: Modern JavaScript with arrow functions, const/let, template literals
- ✅ **Comprehensive Tests**: 33+ tests with 75% coverage
- ✅ **CI/CD**: GitHub Actions + Codecov integration
- ✅ **SCAN Command**: Non-blocking pattern matching (production-safe)
- ✅ **Enhanced Error Handling**: Automatic reconnection, validation, graceful degradation
- ✅ **Better Documentation**: Testing guide, development docs, API examples

Known Limitations
-----------------

* **Cache keys carry no prefix.** A pattern deletion of `*` will clear every key
  in the target Redis database, not just prerender's. Give the plugin its own
  database (`redis://host:6379/1`) if you share the instance.
* **DELETE is silently skipped while Redis is offline.** The request falls
  through and renders the page, so a purge can return 200 without having
  invalidated anything.
* **Cache writes are awaited.** `pageLoaded` waits for the Redis write before
  responding, adding that round-trip to every cache miss.
