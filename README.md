# cf-billing-guard

English | [简体中文](README_zh.md)

[![CI](https://github.com/AinzRimuru/cf-billing-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/AinzRimuru/cf-billing-guard/actions/workflows/ci.yml)

Per-request call limiter for Cloudflare Workers D1 and KV bindings. Wraps `env` in a Proxy, counts every real D1/KV call within a request, and blocks anything past the limit — so a runaway loop, a recursion bug, or a hostile request can't burn through your Cloudflare bill.

Business code stays untouched: same syntax, same chained calls, same result shapes.

## Install

```bash
npm install -D cf-billing-guard
```

## Quick start

```bash
npx cf-billing-guard enable          # wire it up
npx cf-billing-guard disable         # revert completely
```

The CLI reads `main` from `wrangler.jsonc` / `wrangler.json` / `wrangler.toml`, generates a wrapper entry next to it (`billing-guard.main.js`), and repoints only that one line. Re-running `enable` is a no-op; `disable` restores the original `main` and deletes the wrapper.

Equivalent manual wiring:

```js
// billing-guard.main.js
import worker from './index.js';                 // your Worker, unchanged
import { withBillingGuard } from 'cf-billing-guard';

export default withBillingGuard(worker, {
  d1: { maxCalls: 100 },
  kv: { maxCalls: 100 },
});
```

## How it works

```
request ─▶ withBillingGuard(worker).fetch
             ├─ new per-request Ledger (all counters at 0)
             ├─ instrumentEnv(env) — Proxy around env
             │     env.DB ─▶ wrapD1(db, ledger)
             │     env.KV ─▶ wrapKV(ns, ledger)
             └─ worker.fetch(request, wrapped env, ctx)   // business as usual
```

- The CLI wires an explicit whitelist (`bindings`) derived from your wrangler config's `d1_databases` / `kv_namespaces` entries — only the bindings you declared are wrapped. R2, Durable Objects, Queues and any other binding kind are never touched. Without a whitelist (manual wiring), bindings are detected by shape (`prepare+batch+exec` → D1, `get+put+getWithMetadata` → KV) as a best-effort fallback.
- After adding or removing D1/KV bindings, re-run `npx cf-billing-guard enable --force` to refresh the whitelist.
- Wrappers are created per request, so counters are exact and isolated — no cross-request state, no isolate-level approximation.
- Double wrapping is a no-op (`Symbol.for('cf-billing-guard.wrapped')`).

## Supported services

Built-in adapters — guarded by default. Limits are configured in the generated `billing-guard.main.js`: one line per kind next to `d1`/`kv`.

```js
// billing-guard.main.js (generated — edit to taste)
export default withBillingGuard(worker, {
  defaults: { maxCalls: 100, onExceed: 'throw' },
  d1: { maxCalls: 100 },  // per-request D1 call limit
  kv: { maxCalls: 100 },  // per-request KV call limit
  r2: { maxCalls: 50 },   // ← add kinds as needed
  queue: { maxCalls: 100 },
  bindings: { DB: {}, BUCKET: { maxCalls: 10 } }, // per-binding override (highest priority)
});
```

Kinds without their own line fall back to `defaults`.

| kind | counts | `'empty'` neutral |
|---|---|---|
| `d1` | terminal methods 1; `batch` N; `exec` 1 | same-shaped empty results |
| `kv` | `get / getWithMetadata / put / delete / list` | `null` / empty list |
| `r2` | `get / head / put / delete / list` | `null` / `{objects:[]}` |
| `queue` | `send` 1; `sendBatch` N (all-or-nothing) | dropped (`undefined`) |
| `vectorize` | `query / getByIds / deleteByIds / describe` 1; `insert / upsert` N | empty query result |
| `analytics` | `writeDataPoint` | `undefined` |
| `ai` | `run` | `null` |
| `do` | stub `fetch` / RPC 1 each (via `env.<name>.get(...)`) | `undefined` |

Anything else: `observe: true` for counting-only, or `defineAdapter` for full support. Deliberately not covered: Hyperdrive (no per-call billing), Cache API (free, not env-bound), service bindings (unreliable to detect). The CLI whitelist picks up all services above from your wrangler config.

**Testing status**: only `d1` and `kv` have been verified against the live Cloudflare platform (production use). The adapters for `r2`, `queue`, `vectorize`, `analytics`, `ai` and `do` are implemented from the documented API shapes and covered by mock tests, but have **not** been exercised against live bindings — if a real binding's shape differs from what detection expects, it passes through unguarded (never broken). Mismatch reports and patches are welcome.
## Blocking semantics (`onExceed`)

Blocked calls never throw synchronously — they surface as a rejected promise or a neutral result, so chained `.catch(() => {})` and try/catch fallbacks keep working.

| Mode | D1 | KV | Use when |
|---|---|---|---|
| `'throw'` (default) | rejected promise with `BillingGuardError` | same | business code already degrades on errors |
| `'empty'` | same-shaped empty result: `all()` → `{results:[],success:true}`, `first()` → `null`, `run()` → `{success:true,meta:0 rows}`, `raw()` → `[]`, `batch()` → per-statement empty results | `get` → `null` (cache miss), `list` → `{keys:[],list_complete:true}`, `put/delete` → `undefined` | "not found" is already a normal path (caches) |

`batch` is blocked as a whole — never partially executed — to preserve D1's atomicity semantics.

## API

### `withBillingGuard(worker, options?) → worker`

Wraps a Worker entry. `fetch` is required; `scheduled`, `queue`, `test`, `email` and `tail` handlers are passed through with the same instrumented env.

| Key | Type | Default | Description |
|---|---|---|---|
| `defaults` | `{maxCalls?, onExceed?}` | `{100, 'throw'}` | fallback policy |
| `d1` / `kv` | same shape | — | per binding kind |
| `bindings` | `{[name]: same shape}` | — | per binding name (highest priority); also acts as a whitelist |
| `[kind]` | same shape | — | policy for any adapter kind — built-in (`r2`, `queue`, ...) or custom |
| `adapters` | `{[kind]: adapter}` | built-in `d1`/`kv` | custom adapters; matched before the built-ins |
| `observe` | `true \| string[]` | — | count method calls on bindings that match no adapter (`kind: 'observed'`, never blocked) |
| `count` | `(info) => void` | — | after every real call: `{binding, kind, method, used, limit, sql?/key?}` |
| `onExceeded` | `(info) => void` | — | first blocked call per binding per request |
| `onRequestEnd` | `(summary) => void` | — | request finished: `{bindings:[{binding,kind,used,limit,blocked,onExceed}]}` |

`maxCalls: Infinity` disables a limit while keeping the counters.

### Extending

Adapters decide how a binding kind is detected, counted and neutralized — the services in the table above are built in. For a binding kind that is **not** built in, register an adapter with `defineAdapter`:

```js
import { withBillingGuard, defineAdapter } from 'cf-billing-guard';

// hypothetical search service binding (env.SEARCH)
const search = defineAdapter({
  detect: (v) => typeof v.query === 'function' && typeof v.index === 'function',
  methods: ['query', 'index', 'delete'],
  neutral: (m) => (m === 'query' ? { hits: [] } : undefined),
});

export default withBillingGuard(worker, {
  adapters: { search },   // kind adopts the registry key → policy lives under options.search
  search: { maxCalls: 20 },
});
```

A full adapter is a plain `{ kind, detect(v), wrap(target, ledger, name) }` (what `defineAdapter` builds for you). Custom adapters are matched **before** the built-ins, so they can also override d1/kv. Bindings that match no adapter pass through untouched; opt into method-call counting for them with `observe: true` (or `observe: ['NAME']`) — reported as `kind: 'observed'`, never blocked.


### CLI reference

```
cf-billing-guard enable  [--entry <path>] [--out <path>] [--config <path>]
                         [--import <specifier>] [--d1 <n>] [--kv <n>]
                         [--bindings <name,name>] [--on-exceed throw|empty] [--force] [--dry-run]
cf-billing-guard disable [--config <path>] [--out <path>] [--keep] [--dry-run]
```

## Limitations

- Per-request only — no daily quotas, no QPS. A global limit would need cross-request state (Durable Objects); the Ledger could be swapped for a DO proxy.
- Durable Objects: `constructor(ctx, env)` receives the raw env, outside the worker-level wrapper — wrap each class with `withBillingGuardDO`. The CLI-generated wrapper re-exports your entry's named exports unchanged (so DO bindings keep working), but it cannot detect DO classes automatically. Class-RPC methods other than `fetch`/`alarm`, and callbacks running after a response is returned (e.g. WebSocket message handlers), continue on the previous call's budget.
- Manual wiring without a `bindings` whitelist falls back to shape-based detection (false positives are near-impossible for real Cloudflare bindings; pass `--bindings` or set `bindings` to pin names explicitly).
- `exec()` counts as 1 even with multiple statements (Cloudflare bills it as one API call).
- Methods not covered are passed through uncounted — wrapping never breaks new APIs.

## Disclaimer

- Only `d1` and `kv` are verified against the live Cloudflare platform; every other service adapter is mock-tested only. Behavior on real runtimes may differ.
- This library is a best-effort billing guard, not a guarantee: binding kinds it cannot detect pass through uncounted, and blocking a call prevents further usage but does not refund or cap charges already incurred.
- Not affiliated with, sponsored by, or endorsed by Cloudflare. "Cloudflare", "Workers", "D1", "R2", "Durable Objects" and related marks belong to their respective owners.
- Provided as-is under the MIT license. The authors accept no liability for any overage, outage, data loss or other damage arising from the use of this library.

## License

[MIT](LICENSE)
