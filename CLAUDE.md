# CLAUDE.md

Prerender.io plugin that caches rendered pages in Redis. Published to npm as
`prerender-redis-cache-ng`. `index.js` is a one-line re-export; all code lives in
`lib/prerenderRedisCache.js`.

## Commands

```bash
npm run lint            # oxlint --deny-warnings (no-undef is on; see .oxlintrc.json)
npm test                # jest --forceExit
npm run test:watch
npm run test:coverage   # fails below 100% on any metric
npm run test:mutation   # stryker; fails below a 100% mutation score
docker run -d -p 6379:6379 valkey/valkey:9-alpine   # integration tests need real Redis
```

Two suites, deliberately different:

- `prerenderRedisCache.test.js` — integration, hits a **live Redis** on
  `127.0.0.1:6379` database 15. `--forceExit` is required; the redis client keeps
  the event loop alive.
- `prerenderRedisCache.internals.test.js` — unit, fakes the `redis` module via
  `jest.doMock` + `jest.resetModules`. Covers what a healthy server can't reach
  (URL resolution, reconnect backoff, lifecycle events, error paths) and reaches
  100% coverage on its own in ~0.2s.

**Stryker mutates against the unit suite only** (`testMatch: **/*.internals.test.js`
in `stryker.config.json`) — the integration suite is too slow and timing-dependent
to run once per mutant. So a new branch needs unit coverage, not just integration
coverage, or the mutation score drops and CI breaks.

That config also re-declares `testPathIgnorePatterns`. package.json ignores
`/.stryker-tmp/` so `npm test` skips leftover sandboxes, but Stryker runs jest
*inside* that directory — without the override it finds no tests at all and
exits with "No tests were executed".

## Architecture

The module is a singleton with **module-level side effects**: it reads env vars,
creates the redis client, and calls `connect()` at import time. Consequences:

- Changing `PAGE_TTL`/`REDIS_URL` in a test requires `jest.resetModules()` +
  re-`require()`, and each re-require opens a *new* connection that must be closed
  via the exported `_closeConnection()` (test-only escape hatch).
- `redisOnline` is a module-level flag driven by client `ready`/`end`/`error`
  events. When false, every hook falls through to `next()` — Redis being down
  degrades to no-cache, never an error.
- `_reconnectStrategy` and `_closeConnection` are exported purely so tests can
  drive the wiring; they are not public API.

Exported prerender hooks:

- `requestReceived` — GET serves from cache; DELETE invalidates (wildcard in the
  URL → SCAN + per-batch UNLINK, otherwise a single DEL).
- `pageLoaded` — writes the response only if its status is in
  `STATUS_CODES_TO_CACHE`.

Invariants worth preserving:

- **Cache keys are protocol-agnostic.** `normalizeUrlForKey()` strips
  `http(s)://` so both schemes share one entry. Anything that builds or matches a
  key must go through it.
- **Use SCAN, never KEYS; UNLINK, never bulk DEL.** KEYS blocks the server, and
  so does one DEL over a huge match set. `deleteKeysMatching` unlinks each SCAN
  batch as it arrives so neither the match set nor the delete is one big chunk.
- `PAGE_TTL=0` means never expire (`SET` without `EX`); invalid or negative values
  warn and fall back to 86400.
- **Writes are zstd; reads sniff the format.** `decode()` checks magic bytes and
  handles all three storage eras: zstd (2.0.0+), gzip (1.2.x) and plain JSON
  (pre-1.2). Never make reads assume a format — that is what lets the cache
  migrate itself and `PAGE_COMPRESS` be flipped either way without stranding it.
  Reads go through `bufferClient` (a `withTypeMapping` Buffer view of the same
  connection) — a plain `client.get` would UTF-8 mangle the compressed bytes.
- Use the **async** `zlib` functions. The prerender server is one Node process
  serving every request; a sync compress of a 250KB page blocks all of them.
  Note the async and sync zstd APIs frame output differently (a 1-byte size
  difference), so never compare output across the two in a test.
- **zstd requires Node >= 22.15.0** — that is why `engines` is pinned there.
  Do not add a runtime fallback to gzip when zstd is missing: in a mixed-Node
  fleet the older workers would silently miss on every entry the newer ones
  wrote. One codec for everyone.
- **`reconnectStrategy` never returns `false`.** Giving up leaves the process
  permanently cacheless; retrying forever costs one socket while every hook
  already bypasses the cache. node-redis passes `0` for the first retry, hence
  the `+1`. It deliberately does not log — the `error` event fires on every
  failed attempt already.
- Because it never gives up, `connect()` never rejects on an unreachable server
  and `quit()` never settles while reconnecting — `_closeConnection()` therefore
  destroys the client unless `isReady`.
- Only `handleCacheGet`'s `client.get` and the writes are wrapped in `try` — key
  building stays outside, so a bad URL fails loudly instead of looking like a
  cache miss.

## Redis client

redis v5.x API: explicit `connect()`, promise-based commands, `SET` options as
`{ EX: ttl }`, and `scan()` returning `{ cursor, keys }` where the cursor must be
coerced to a string before the next iteration.

## CI

`.github/workflows/test.yml` runs Node 20/22/24 against a valkey service
container, plus lint on every version and mutation tests on Node 24 only. Pushing a `v*` tag triggers `publish.yml` (npm publish with provenance
+ GitHub release). Bump `package.json` version and update `CHANGELOG.md` before
tagging.
