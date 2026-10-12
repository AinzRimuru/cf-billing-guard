/**
 * adapter.js — declarative adapter factory.
 *
 * defineAdapter builds a full adapter from a spec: detect by shape, count the
 * listed methods (1 call each), neutralize on 'empty'. For counting surfaces
 * beyond plain per-call counting (batches, nested stubs), write a plain
 * { kind, detect(v), wrap(target, ledger, name) } object instead.
 */

import { WRAPPED } from './d1.js';

/**
 * @param {object} spec
 * @param {string} [spec.kind] adapter kind (defaults to the key used in options.adapters)
 * @param {(v: object) => boolean} spec.detect shape detection
 * @param {string[]} spec.methods the counting surface
 * @param {(method: string, args: any[]) => any} [spec.neutral] result returned when over limit in 'empty' mode
 * @param {(args: any[]) => object} [spec.detail] extra info for the count callback
 */
export function defineAdapter({ kind, detect, methods, neutral, detail }) {
  if (typeof detect !== 'function') {
    throw new TypeError('[cf-billing-guard] defineAdapter: detect(v) is required');
  }
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError('[cf-billing-guard] defineAdapter: methods[] is required');
  }
  const neutralOf = typeof neutral === 'function' ? neutral : () => undefined;
  const detailOf = typeof detail === 'function' ? detail : () => ({});
  const adapter = {
    kind: kind || 'custom',
    detect,
    wrap(target, ledger, binding) {
      const k = adapter.kind; // resolved at wrap time — relabeling via the registry key works
      return new Proxy(target, {
        get(t, prop) {
          if (prop === WRAPPED) return true;
          if (!methods.includes(prop)) {
            const v = Reflect.get(t, prop);
            return typeof v === 'function' ? v.bind(t) : v;
          }
          return async (...args) => {
            const decision = ledger.beforeCall(binding, k, prop, 1);
            if (decision === 'throw') throw ledger.exceededError(binding, k, prop);
            if (decision === 'empty') return neutralOf(prop, args);
            const res = await t[prop](...args);
            ledger.afterCall(binding, k, prop, detailOf(args), 1);
            return res;
          };
        },
      });
    },
  };
  return adapter;
}
