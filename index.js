/**
 * index.js — cf-billing-guard package entry.
 *
 * Wraps a Worker entry so every inbound request gets a per-request Ledger and
 * Proxy-wrapped D1/KV bindings. Business code keeps calling env.DB / env.KV
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
 *   bindings: { [name]: same shape }  per-binding override (highest priority)
 *   count(info)        after every real call (metrics)
 *   onExceeded(info)   first blocked call per binding per request (alerting)
 *   onRequestEnd(summary)  usage summary when the request ends (logging)
 */

import { Ledger } from './ledger.js';
import { wrapD1, WRAPPED } from './d1.js';
import { wrapKV } from './kv.js';

export { BillingGuardError } from './ledger.js';
export { wrapD1 } from './d1.js';
export { wrapKV } from './kv.js';

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

/** Wrap env with a per-request Ledger (call once per request; wrappers are discarded with it). */
export function instrumentEnv(env, ledger) {
  if (!env || typeof env !== 'object') return env;
  const cache = new Map(); // binding name -> wrapped binding, for this request
  return new Proxy(env, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      const v = Reflect.get(target, prop);
      if (!v || typeof v !== 'object' || v[WRAPPED]) return v;
      if (!looksLikeD1(v) && !looksLikeKV(v)) return v;
      // bindings whitelist (when configured): anything not listed stays unwrapped
      const allow = ledger.options.bindings;
      if (allow && !Object.prototype.hasOwnProperty.call(allow, prop)) return v;
      if (cache.has(prop)) return cache.get(prop);
      const wrapped = looksLikeD1(v) ? wrapD1(v, ledger, prop) : wrapKV(v, ledger, prop);
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
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
        if (typeof options.onRequestEnd === 'function') {
          try {
            options.onRequestEnd(ledger.summary());
          } catch (e) {}
        }
      }
    },
  };
  // Pass through other handlers (scheduled, ...), injecting the wrapped env
  for (const name of ['scheduled', 'queue', 'test', 'email', 'tail']) {
    const h = worker[name];
    if (typeof h === 'function') {
      wrapped[name] = (first, env, ...rest) => h(first, instrumentEnv(env, new Ledger(options)), ...rest);
    }
  }
  return wrapped;
}
