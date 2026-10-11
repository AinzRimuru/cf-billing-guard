/**
 * kv.js — KV binding wrapper (Proxy, zero-intrusion core).
 *
 * Counting (one "call" = one real execution):
 *   get / getWithMetadata → 1 (reads)
 *   put                   → 1 (writes)
 *   delete                → 1 (deletes)
 *   list                  → 1 (lists)
 *
 * Blocking (onExceed):
 *   'throw' → rejected promise (BillingGuardError)
 *   'empty' → neutral result: get → null (cache miss),
 *             getWithMetadata → {value:null, metadata:null},
 *             put/delete → undefined (treated as success, nothing written),
 *             list → {keys:[], list_complete:true}
 */

import { WRAPPED } from './d1.js';

const KV_METHODS = new Set(['get', 'getWithMetadata', 'put', 'delete', 'list']);

function neutralKV(method) {
  switch (method) {
    case 'get':
      return null;
    case 'getWithMetadata':
      return { value: null, metadata: null, cacheStatus: null };
    case 'list':
      return { keys: [], list_complete: true };
    default:
      return undefined; // put / delete
  }
}

function keyOf(args) {
  const k = args && args[0];
  if (typeof k === 'string') return k.length > 80 ? k.slice(0, 80) + '…' : k;
  if (k && typeof k.name === 'string') return k.name; // list options {prefix:...}: name only
  return undefined;
}

/**
 * Wrap a KV binding.
 * @param {KVNamespace} ns raw binding
 * @param {Ledger} ledger per-request ledger
 * @param {string} binding binding name
 */
export function wrapKV(ns, ledger, binding) {
  return new Proxy(ns, {
    get(t, prop) {
      if (prop === WRAPPED) return true;
      if (!KV_METHODS.has(prop)) {
        const v = Reflect.get(t, prop);
        return typeof v === 'function' ? v.bind(t) : v;
      }
      return async (...args) => {
        const decision = ledger.beforeCall(binding, 'kv', prop, 1);
        if (decision === 'throw') throw ledger.exceededError(binding, 'kv', prop);
        if (decision === 'empty') return neutralKV(prop);
        const res = await t[prop](...args);
        ledger.afterCall(binding, 'kv', prop, { key: keyOf(args) }, 1);
        return res;
      };
    },
  });
}
