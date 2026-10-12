/**
 * services.js — built-in adapters for Cloudflare binding kinds beyond D1/KV.
 *
 * Counting follows billing dimensions: one "call" = one billable operation,
 * batches count per item (all-or-nothing, like D1 batch). Neutral results for
 * 'empty' mode mirror each real API's "nothing found / nothing done" shape.
 *
 * Not covered (by design): Hyperdrive (no per-call billing — connection
 * pooling), Cache API (free, and accessed via the `caches` global, not env),
 * and service bindings (detection is unreliable; their requests are billed as
 * the target worker's own requests). Use observe: true / defineAdapter for
 * those.
 */

import { WRAPPED } from './d1.js';
import { defineAdapter } from './adapter.js';

// ---------- R2 ----------

export const r2Adapter = defineAdapter({
  kind: 'r2',
  detect: (v) => typeof v.get === 'function' && typeof v.head === 'function' && typeof v.list === 'function',
  methods: ['get', 'put', 'head', 'delete', 'list'],
  neutral: (m) => (m === 'get' || m === 'head' ? null : m === 'list' ? { objects: [], truncated: false } : undefined),
});

// ---------- Queues (producer) ----------

/** send = 1 message; sendBatch = N messages, all-or-nothing. */
export const queueAdapter = {
  kind: 'queue',
  detect: (v) => typeof v.send === 'function' && typeof v.sendBatch === 'function',
  wrap(target, ledger, binding) {
    return new Proxy(target, {
      get(t, prop) {
        if (prop === WRAPPED) return true;
        if (prop === 'send' || prop === 'sendBatch') {
          return async (input) => {
            const batch = prop === 'sendBatch';
            const n = batch && Array.isArray(input) ? input.length : 1;
            const decision = ledger.beforeCall(binding, 'queue', prop, n);
            if (decision === 'throw') throw ledger.exceededError(binding, 'queue', prop);
            if (decision === 'empty') return undefined; // messages dropped, treated as success
            const res = await t[prop](input);
            ledger.afterCall(binding, 'queue', prop, batch ? { messages: n } : {}, n);
            return res;
          };
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  },
};

// ---------- Vectorize ----------

/** query/getByIds/deleteByIds/describe = 1; insert/upsert = N vectors (all-or-nothing). */
export const vectorizeAdapter = {
  kind: 'vectorize',
  detect: (v) => typeof v.query === 'function' && typeof v.upsert === 'function',
  wrap(target, ledger, binding) {
    const singles = new Set(['query', 'getByIds', 'deleteByIds', 'describe']);
    return new Proxy(target, {
      get(t, prop) {
        if (prop === WRAPPED) return true;
        if (singles.has(prop) || prop === 'insert' || prop === 'upsert') {
          return async (...args) => {
            const n = (prop === 'insert' || prop === 'upsert') && Array.isArray(args[0]) ? args[0].length : 1;
            const decision = ledger.beforeCall(binding, 'vectorize', prop, n);
            if (decision === 'throw') throw ledger.exceededError(binding, 'vectorize', prop);
            if (decision === 'empty') {
              return prop === 'query' ? { matches: [], count: 0 } : prop === 'getByIds' ? [] : undefined;
            }
            const res = await t[prop](...args);
            ledger.afterCall(binding, 'vectorize', prop, n > 1 ? { vectors: n } : {}, n);
            return res;
          };
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  },
};

// ---------- Analytics Engine ----------

export const analyticsAdapter = defineAdapter({
  kind: 'analytics',
  detect: (v) => typeof v.writeDataPoint === 'function',
  methods: ['writeDataPoint'],
});

// ---------- Workers AI ----------

export const aiAdapter = defineAdapter({
  kind: 'ai',
  detect: (v) => typeof v.run === 'function' && typeof v.toImage === 'function',
  methods: ['run'],
  neutral: () => null,
});

// ---------- Durable Objects (namespace → stub requests) ----------

/** Count billable stub calls: fetch() and class-RPC methods, 1 each. */

function wrapStub(stub, ledger, binding) {
  const cache = new Map();
  return new Proxy(stub, {
    get(t, prop) {
      if (prop === WRAPPED) return true;
      if (typeof prop !== 'string') return Reflect.get(t, prop);
      const v = Reflect.get(t, prop);
      if (typeof v !== 'function') return v;
      if (cache.has(prop)) return cache.get(prop);
      const fn = async (...args) => {
        const decision = ledger.beforeCall(binding, 'do', prop, 1);
        if (decision === 'throw') throw ledger.exceededError(binding, 'do', prop);
        if (decision === 'empty') return undefined;
        const res = await t[prop](...args);
        ledger.afterCall(binding, 'do', prop, {}, 1);
        return res;
      };
      cache.set(prop, fn);
      return fn;
    },
  });
}

export const doAdapter = {
  kind: 'do',
  detect: (v) =>
    typeof v.newUniqueId === 'function' &&
    typeof v.idFromName === 'function' &&
    typeof v.get === 'function',
  wrap(ns, ledger, binding) {
    return new Proxy(ns, {
      get(t, prop) {
        if (prop === WRAPPED) return true;
        if (prop === 'get' || prop === 'getByName' || prop === 'getById') {
          return (...args) => wrapStub(t[prop](...args), ledger, binding);
        }
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  },
};

/** Registration order = matching order after user adapters and d1/kv. */
export const SERVICE_ADAPTERS = [r2Adapter, queueAdapter, vectorizeAdapter, analyticsAdapter, aiAdapter, doAdapter];
