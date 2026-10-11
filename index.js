/**
 * index.js — cf-billing-guard 包入口。
 *
 * 用法（零侵入接线）：
 *   // main.js（新入口文件，原 Worker 文件零改动）
 *   import worker from './index.js';          // 你原有的 Worker
 *   import { withBillingGuard } from 'cf-billing-guard';
 *   export default withBillingGuard(worker, { d1: { maxCalls: 100 } });
 *
 * 或直接用 CLI 自动接线（推荐）：
 *   npm i -D cf-billing-guard && npx cf-billing-guard enable
 *
 * 原理：withBillingGuard 在每个入站请求开始时创建请求级 Ledger，用 Proxy 包装
 * env 上的 D1/KV 绑定（自动探测，或按 bindings 白名单），业务代码通过
 * env.DB / env.KV_NAMESPACE 照常调用 —— 语法、返回结构完全不变，
 * 仅在超出单请求调用上限时按策略 throw / 返回空结果。
 *
 * options:
 *   defaults: { maxCalls?: number = 100, onExceed?: 'throw'|'empty' = 'throw' }
 *   d1:       同上，覆盖所有 D1 绑定
 *   kv:       同上，覆盖所有 KV 绑定
 *   bindings: { [name]: 同上 }  按绑定名覆盖（优先级最高）
 *   count(info)        每次真实调用后的回调（指标埋点）
 *   onExceeded(info)   某绑定首次超限时的回调（告警）
 *   onRequestEnd(summary)  请求结束后的用量摘要回调（日志）
 */

import { Ledger } from './ledger.js';
import { wrapD1, WRAPPED } from './d1.js';
import { wrapKV } from './kv.js';

export { BillingGuardError } from './ledger.js';
export { wrapD1 } from './d1.js';
export { wrapKV } from './kv.js';

/** 探测：D1Database（prepare/batch/exec） */
function looksLikeD1(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.prepare === 'function' &&
    typeof v.batch === 'function' &&
    typeof v.exec === 'function'
  );
}

/** 探测：KVNamespace（get/put/getWithMetadata） */
function looksLikeKV(v) {
  return (
    v && typeof v === 'object' &&
    typeof v.get === 'function' &&
    typeof v.put === 'function' &&
    typeof v.getWithMetadata === 'function'
  );
}

/** 用请求级 Ledger 包装 env（每请求调用一次；绑定包装随请求丢弃，计数互不影响） */
export function instrumentEnv(env, ledger) {
  if (!env || typeof env !== 'object') return env;
  const cache = new Map(); // 本请求内 name -> 包装后的绑定
  return new Proxy(env, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop);
      const v = Reflect.get(target, prop);
      if (!v || typeof v !== 'object' || v[WRAPPED]) return v;
      if (!looksLikeD1(v) && !looksLikeKV(v)) return v;
      // bindings 白名单（若配置）之外的绑定不包装
      const allow = ledger.options.bindings;
      if (allow && !Object.prototype.hasOwnProperty.call(allow, prop)) return v;
      if (cache.has(prop)) return cache.get(prop);
      const wrapped = looksLikeD1(v) ? wrapD1(v, ledger, prop) : wrapKV(v, ledger, prop);
      cache.set(prop, wrapped);
      return wrapped;
    },
  });
}

/** 包装 Worker 入口 */
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
  // 透传其它处理器（scheduled 等），env 同样注入包装
  for (const name of ['scheduled', 'queue', 'test', 'email', 'tail']) {
    const h = worker[name];
    if (typeof h === 'function') {
      wrapped[name] = (first, env, ...rest) => h(first, instrumentEnv(env, new Ledger(options)), ...rest);
    }
  }
  return wrapped;
}
