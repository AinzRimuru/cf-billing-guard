/**
 * kv.js — KV 绑定包装器（Proxy，零侵入核心）。
 *
 * 计数口径（一次"调用"= 一次真实执行）：
 *   get / getWithMetadata → 1 次（reads）
 *   put                   → 1 次（writes）
 *   delete                → 1 次（deletes）
 *   list                  → 1 次（lists）
 *
 * 拦截时（onExceed）：
 *   'throw' → rejected Promise（BillingGuardError）
 *   'empty' → 同构"空结果"：get → null（等价缓存未命中）、
 *             getWithMetadata → {value:null, metadata:null}、
 *             put/delete → undefined（视为成功但未写入）、
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
  if (k && typeof k.name === 'string') return k.name; // list 选项 {prefix:...} 等仅记 name
  return undefined;
}

/**
 * 包装 KV 绑定。
 * @param {KVNamespace} ns 原始绑定
 * @param {Ledger} ledger 本请求账本
 * @param {string} binding 绑定名
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
