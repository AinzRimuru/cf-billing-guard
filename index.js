/**
 * index.js — cf-billing-guard package entry.
 *
 * Wraps a Worker entry so every inbound request gets a per-request Ledger and
 * Proxy-wrapped bindings. Business code keeps calling env.DB / env.KV
 * exactly as before; calls beyond the per-request limit are blocked with a
 * rejected promise or a neutral empty result.
 *
 * Manual wiring:
 *   import worker from './index.js';
 *   import { withBillingGuard } from 'cf-billing-guard';
 *   export default withBillingGuard(worker, { d1: { maxCalls: 100 } });
 *
 * Prefer the CLI: npx cf-billing-guard enable
 *
 * options:
 *   defaults: { maxCalls?: number = 100, onExceed?: 'throw'|'empty' = 'throw' }
 *   d1:       same shape, overrides all D1 bindings
 *   kv:       same shape, overrides all KV bindings
 *   [kind]:   same shape, policy for any custom adapter kind
 *   bindings: { [name]: same shape }  per-binding override (highest priority);
 *             doubles as a whitelist — when set, only the listed names are
 *             wrapped, so other binding kinds (R2, Durable Objects, Queues,
 *             ...) are never touched. The CLI derives this list from the
 *             wrangler config (d1_databases / kv_namespaces).
 *   adapters: { [kind]: adapter }  custom adapters, take precedence over the
 *             built-in d1/kv ones (see defineAdapter).
 *   observe:  true | string[]  count method calls on bindings that match no
 *             adapter (kind 'observed', never blocked).
 *   count(info)        after every real call (metrics)
 *   onExceeded(info)   first blocked call per binding per request (alerting)
 *   onRequestEnd(summary)  usage summary when the request ends (logging)
 */

import { Ledger } from './ledger.js';
import { wrapD1, WRAPPED } from './d1.js';
import { wrapKV } from './kv.js';
import { SERVICE_ADAPTERS } from './services.js';

export { BillingGuardError } from './ledger.js';
export { wrapD1 } from './d1.js';
export { wrapKV } from './kv.js';
export { defineAdapter } from './adapter.js';
export { r2Adapter, queueAdapter, vectorizeAdapter, analyticsAdapter, aiAdapter, doAdapter } from './services.js';

/** Detect D1Database by shape (prepare/batch/exec). */
function looksLikeD1(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.prepare === 'function' &&
    typeof v.batch === 'function' &&
    typeof v.exec === 'function'
  );
}

/** Detect KVNamespace by shape (get/put/getWithMetadata). */
function looksLikeKV(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.get === 'function' &&
    typeof v.put === 'function' &&
    typeof v.getWithMetadata === 'function'
  );
}

/**
 * Built-in adapters, in matching order. D1/KV plus the shipped service
 * adapters (r2, queue, vectorize, analytics, ai, do). Custom adapters
 * registered via options.adapters are matched first and can override any.
 */
const BUILTIN_ADAPTERS = [
  { kind: 'd1', detect: looksLikeD1, wrap: wrapD1 },
  { kind: 'kv', detect: looksLikeKV, wrap: wrapKV },
  ...SERVICE_ADAPTERS,
];

/** Normalize + validate custom adapters; user adapters take precedence over built-ins. */
function buildAdapters(custom) {
  const list = [];
  for (const [key, a] of Object.entries(custom || {})) {
    const adapter = a && typeof a === 'object' ? a : null;
    if (!adapter || typeof adapter.detect !== 'function' || typeof adapter.wrap !== 'function') {
      throw new TypeError(
        `[cf-billing-guard] invalid adapter "${key}": expected { kind?, detect(v), wrap(target, ledger, name) } — see defineAdapter()`
      );
    }
    // default kinds (defineAdapter without kind) adopt the registry key,
    // so options[key] resolves the policy; explicit kinds are left alone
    if (!adapter.kind || adapter.kind === 'custom') adapter.kind = key;
    list.push(adapter);
  }
  return [...list, ...BUILTIN_ADAPTERS];
}


/**
 * Generic observer for bindings that match no adapter: counts every method
 * call (kind 'observed'), never blocks. No service-specific knowledge needed,
 * so it covers any binding type, present or future.
 */
function wrapObserved(target, ledger, name) {
  const cache = new Map();
  return new Proxy(target, {
    get(t, prop) {
      if (prop === WRAPPED) return true;
      if (typeof prop !== 'string') return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function') return v;
      if (cache.has(prop)) return cache.get(prop);
      const fn = async (...args) => {
        const res = await t[prop](...args);
        ledger.afterCall(name, 'observed', prop, {}, 1);
        return res;
      };
      cache.set(prop, fn);
      return fn;
    },
  });
}

/**
 * Wrap env with a per-request Ledger (call once per request; wrappers are
 * discarded with it). Matching order: custom adapters → built-in d1/kv →
 * observe (if enabled) → untouched pass-through.
 */
export function instrumentEnv(env, ledger) {
  if (!env || typeof env !== 'object') return env;
  const cache = new Map(); // binding name -> wrapped binding, for this request
  const adapters = buildAdapters(ledger.options.adapters);
  const observe = ledger.options.observe;
  const observeAll = observe === true;
  const observeNames = Array.isArray(observe) ? new Set(observe) : null;
  return new Proxy(env, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      const v = Reflect.get(target, prop);
      if (!v || typeof v !== 'object' || v[WRAPPED]) return v;
      const adapter = adapters.find((a) => a.detect(v));
      if (adapter) {
        // bindings whitelist (when configured): anything not listed stays unwrapped
        const allow = ledger.options.bindings;
        if (allow && !Object.prototype.hasOwnProperty.call(allow, prop)) return v;
        if (cache.has(prop)) return cache.get(prop);
        const wrapped = adapter.wrap(v, ledger, prop);
        cache.set(prop, wrapped);
        return wrapped;
      }
      if (observeAll || (observeNames && observeNames.has(prop))) {
        if (cache.has(prop)) return cache.get(prop);
        const wrapped = wrapObserved(v, ledger, prop);
        cache.set(prop, wrapped);
        return wrapped;
      }
      return v;
    },
  });
}

/** Fire options.onRequestEnd if configured; never throws. */
function reportRequestEnd(options, ledger) {
  if (typeof options.onRequestEnd === 'function') {
    try {
      options.onRequestEnd(ledger.summary());
    } catch (e) {}
  }
}

/** Wrap a Worker entry. */
export function withBillingGuard(worker, options = {}) {
  const wrapped = {
    async fetch(request, env, ctx) {
      const ledger = new Ledger(options);
      const env2 = instrumentEnv(env, ledger);
      try {
        return await worker.fetch(request, env2, ctx);
      } finally {
        reportRequestEnd(options, ledger);
      }
    },
  };
  // Pass through other handlers (scheduled, ...), injecting the wrapped env
  for (const name of ['scheduled', 'queue', 'test', 'email', 'tail']) {
    const h = worker[name];
    if (typeof h === 'function') {
      wrapped[name] = (first, env, ...rest) => {
        const ledger = new Ledger(options);
        try {
          return h(first, instrumentEnv(env, ledger), ...rest);
        } finally {
          reportRequestEnd(options, ledger);
        }
      };
    }
  }
  return wrapped;
}

/**
 * Wrap a Durable Object class so its constructor receives an instrumented env.
 *
 * The runtime instantiates exported DO classes with the raw env — the worker-level
 * wrapper never sees it — so D1/KV calls inside a DO escape counting unless the
 * class is wrapped here. One shared ledger per DO instance; every inbound
 * fetch()/alarm() starts from a fresh budget (ledger reset). Bindings captured
 * in the constructor (this.db = env.DB) are instrumented as well.
 *
 * Not covered: class-RPC methods other than fetch/alarm, and callbacks that run
 * after a fetch() response is returned (e.g. WebSocket message handlers) —
 * those continue on the previous call's budget.
 */
export function withBillingGuardDO(DOClass, options = {}) {
  const ledger = new Ledger(options);
  const guarded = class extends DOClass {
    constructor(ctx, env) {
      super(ctx, instrumentEnv(env, ledger));
    }
  };
  for (const name of ['fetch', 'alarm']) {
    const orig = DOClass.prototype[name];
    if (typeof orig !== 'function') continue;
    guarded.prototype[name] = async function (...args) {
      ledger.reset(); // fresh per-call budget
      try {
        return await orig.apply(this, args);
      } finally {
        reportRequestEnd(options, ledger);
      }
    };
  }
  return guarded;
}
