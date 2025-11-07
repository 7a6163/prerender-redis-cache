# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Cache Invalidation**: Support for DELETE requests to invalidate cached entries
  - Single URL deletion: `DELETE http://example.com/page`
  - Pattern-based deletion with wildcards: `DELETE http://example.com/*`
  - JSON response format with deletion status and count
- **Comprehensive Test Suite**: 33+ tests with 77.94% code coverage
  - Configuration validation tests
  - Cache operations tests (GET, DELETE, pageLoaded)
  - Edge case and error handling tests
  - Integration tests for complete cache lifecycle
  - Header validation tests
  - URL pattern tests
- **CI/CD Integration**:
  - GitHub Actions workflow for automated testing
  - Codecov integration for coverage tracking
  - Multi-version Node.js testing (14.x, 16.x, 18.x, 20.x)
  - Status badges in README
- **Documentation**:
  - `TESTING.md` - Comprehensive testing guide
  - `CHANGELOG.md` - Version history and changes
  - `CLAUDE.md` - Development guidelines
  - Enhanced README with badges and examples
  - Codecov configuration file

### Changed
- **ES6 Refactoring**: Complete migration from ES5 to ES6
  - `var` → `const`/`let`
  - Function declarations → Arrow functions
  - String concatenation → Template literals
  - Added destructuring and modern JavaScript features
- **Code Architecture**: Modular structure with focused helper functions
  - Configuration: `getRedisUrl()`, `getValidatedTTL()`, `createRetryStrategy()`
  - Cache operations: `handleCacheGet()`, `handleCacheDelete()`, `handlePatternDeletion()`, `handleSingleDeletion()`
  - Utilities: `sendJsonResponse()`, `logRedisError()`, `isValidHeader()`, `scanKeys()`
- **Redis Operations**: Use SCAN instead of KEYS for pattern matching
  - Non-blocking operation
  - Production-safe for large datasets
  - Iterative scanning with cursor
- **Error Handling**: Enhanced error handling throughout
  - Try-catch for JSON parsing
  - Validation for missing `req.prerender` object
  - Error callbacks for all Redis operations
  - Graceful degradation on failures

### Fixed
- **TTL Configuration**: Fixed parsing of PAGE_TTL environment variable
  - Now correctly handles `PAGE_TTL=0` (never expire)
  - Validates and rejects negative values
  - Warns on invalid non-numeric values
- **Connection Resilience**: Automatic reconnection with exponential backoff
  - Max 10 reconnection attempts
  - Exponential backoff strategy
  - 1-hour maximum retry timeout
  - Connection state tracking with `redisOnline` flag
- **Header Validation**: Proper validation of HTTP headers
  - Filters out headers with invalid characters
  - Prevents potential security issues
  - Uses `isValidHeader()` function for consistent validation
- **Magic Numbers**: Replaced hardcoded values with named constants
  - `DEFAULT_TTL = 86400` (1 day in seconds)
  - `MAX_RECONNECT_ATTEMPTS = 10`
  - `RECONNECT_DELAY = 5000` (5 seconds)
  - `RECONNECT_TIMEOUT = 3600000` (1 hour)
- **Typo**: Fixed "Conncetion" → "Connection" in log message

### Security
- **Input Validation**: Added validation for all request inputs
  - Checks for missing `req.prerender` object
  - Validates URL presence before operations
  - Prevents crashes from malformed requests
- **Header Filtering**: Enhanced header validation to prevent injection
  - Regex validation: `!/[^\t\x20-\x7e\x80-\xff]/`
  - Filters control characters and invalid bytes

### Performance
- **SCAN Command**: Non-blocking pattern matching for cache invalidation
  - Replaces blocking KEYS command
  - Safe for production with large datasets
  - O(N) but spreads load over multiple calls
- **Code Organization**: Improved maintainability through modular design
  - Single responsibility principle
  - Easier to test and debug
  - Reduced function complexity (93 lines → 13 lines for `requestReceived`)

### Developer Experience
- **Testing Infrastructure**:
  - Jest configuration with coverage reporting
  - redis-mock for fast, isolated tests
  - Multiple test categories (unit, integration, edge cases)
  - Test scripts: `npm test`, `npm run test:watch`, `npm run test:coverage`
- **Documentation**:
  - Inline JSDoc comments for all functions
  - Comprehensive README with examples
  - Testing guide with setup instructions
  - CI/CD setup documentation
- **Development Tools**:
  - ESLint-friendly ES6 code
  - Git ignore for coverage and test artifacts
  - Consistent code style throughout

## [0.2.2] - Previous Release

### Features
- Redis caching for prerendered pages
- Configurable TTL via `PAGE_TTL` environment variable
- Support for multiple Redis providers (REDISTOGO, REDISCLOUD, REDISGREEN, REDIS_URL)
- Selective caching based on HTTP status codes (200, 203, 204, 206, 3xx, 404, 405, 410, 414, 501)
- Automatic database selection from Redis URL
- Password authentication support

### Known Issues (Fixed in Unreleased)
- No cache invalidation mechanism
- ES5 codebase (outdated JavaScript)
- No test suite
- Hardcoded configuration values
- No automatic reconnection on Redis failure
- KEYS command could block Redis in production

---

## Upgrade Guide

### From 0.2.2 to Unreleased

**No Breaking Changes** - This is a backwards-compatible update.

#### New Features Available

1. **Cache Invalidation**:
   ```bash
   # Delete single URL
   curl -X DELETE http://localhost:3000/render?url=http://example.com/page

   # Delete all URLs matching pattern
   curl -X DELETE http://localhost:3000/render?url=http://example.com/*
   ```

2. **Better Error Handling**:
   - Automatically recovers from Redis connection failures
   - Validates environment variables on startup
   - Gracefully handles malformed cache data

3. **Production Ready**:
   - Non-blocking SCAN for pattern matching
   - Comprehensive test coverage
   - CI/CD integration

#### Environment Variables

All existing environment variables work as before:
- `REDISTOGO_URL`
- `REDISCLOUD_URL`
- `REDISGREEN_URL`
- `REDIS_URL`
- `PAGE_TTL`

New behavior:
- `PAGE_TTL=0` now correctly means "never expire" (previously broken)
- Invalid `PAGE_TTL` values now log warnings and use defaults

---

## Contributors

Thanks to all contributors who have helped improve this project!

- Original author: Jonathan Bennett
- Refactoring and modernization: Claude Code
- Testing infrastructure: Community contributions

---

## License

MIT License - See LICENSE file for details
