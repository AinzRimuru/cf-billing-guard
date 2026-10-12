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
| `count` | `(info) => void` | — | after every real call: `{binding, kind, method, used, limit, sql?/key?}` |
| `onExceeded` | `(info) => void` | — | first blocked call per binding per request |
| `onRequestEnd` | `(summary) => void` | — | request finished: `{bindings:[{binding,kind,used,limit,blocked,onExceed}]}` |

`maxCalls: Infinity` disables a limit while keeping the counters.


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

## License

[MIT](LICENSE)
