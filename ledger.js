/**
 * ledger.js — per-request call ledger (core state).
 *
 * One Ledger per inbound request. Tracks real call counts per binding name
 * and blocks calls once maxCalls is reached, per the onExceed policy:
 *   - 'throw' (default): rejected promise carrying BillingGuardError, so
 *     existing try/catch or .catch(() => {}) fallbacks keep working;
 *   - 'empty': neutral result (see d1.js / kv.js), reads as "no data".
 *
 * Invariant: blocking surfaces as a rejection or a return value, never a
 * synchronous throw — chained calls attach .catch() only after the call.
 */

export class BillingGuardError extends Error {
  constructor({ binding, kind, used, limit }) {
    super(
      `[cf-billing-guard] per-request call limit exceeded on "${binding}" (${kind}): used=${used} limit=${limit}`
    );
    this.name = 'BillingGuardError';
    this.binding = binding;
    this.kind = kind;
    this.used = used;
    this.limit = limit;
  }
}

/** Counter + policy for a single binding. */
class Slot {
  constructor(name, kind, policy) {
    this.name = name;
    this.kind = kind; // 'd1' | 'kv'
    this.maxCalls = policy.maxCalls;
    this.onExceed = policy.onExceed; // 'throw' | 'empty'
    this.used = 0;
    this.blocked = 0; // blocked calls (observability)
    this.exceededNotified = false;
  }

  get exceeded() {
    return this.maxCalls !== Infinity && this.used >= this.maxCalls;
  }

  /**
   * Reserve budget for n calls. Returns 'allow' or 'block'.
   * n > 1 is allowed (D1 batch counts per statement) — a batch is never
   * partially executed, so used+n > maxCalls blocks the whole thing.
   */
  reserve(n) {
    if (this.maxCalls === Infinity || this.used + n <= this.maxCalls) return 'allow';
    this.blocked += n;
    return 'block';
  }

  commit(n) {
    this.used += n;
  }
}

export class Ledger {
  /**
   * @param {object} options the original withBillingGuard options (see index.js)
   */
  constructor(options) {
    this.options = options;
    this.slots = new Map(); // binding name -> Slot
  }

  /** Resolve the policy for a binding: bindings[name] > [kind] > defaults */
  policyFor(name, kind) {
    const o = this.options || {};
    const defaults = { maxCalls: 100, onExceed: 'throw', ...(o.defaults || {}) };
    const byKind = kind === 'd1' ? o.d1 : kind === 'kv' ? o.kv : undefined;
    const byName = o.bindings && o.bindings[name];
    return { ...defaults, ...(byKind || {}), ...(byName || {}) };
  }

  slotFor(name, kind) {
    let s = this.slots.get(name);
    if (!s) {
      s = new Slot(name, kind, this.policyFor(name, kind));
      this.slots.set(name, s);
    }
    return s;
  }

  /**
   * Pre-execution check. Returns 'allow' | 'block' (the caller decides
   * between throwing and a neutral result). Fires options.onExceeded on the
   * first blocked call per binding per request.
   */
  beforeCall(binding, kind, method, n = 1) {
    const slot = this.slotFor(binding, kind);
    const decision = slot.reserve(n);
    if (decision === 'block') {
      const info = {
        binding,
        kind,
        method,
        used: slot.used,
        limit: slot.maxCalls,
        blocked: slot.blocked,
      };
      if (!slot.exceededNotified) {
        slot.exceededNotified = true;
        if (typeof this.options.onExceeded === 'function') {
          try {
            this.options.onExceeded(info);
          } catch (e) {}
        }
      }
      if (slot.onExceed === 'empty') return 'empty';
      return 'throw';
    }
    return 'allow';
  }

  /** Record a completed real call + fire the count callback (metrics). */
  afterCall(binding, kind, method, detail = {}, n = 1) {
    const slot = this.slotFor(binding, kind);
    slot.commit(n);
    if (typeof this.options.count === 'function') {
      try {
        this.options.count({ binding, kind, method, used: slot.used, limit: slot.maxCalls, ...detail });
      } catch (e) {}
    }
  }

  /** Build the limit-exceeded error with current counters. */
  exceededError(binding, kind, method) {
    const slot = this.slotFor(binding, kind);
    return new BillingGuardError({
      binding,
      kind,
      used: slot.used,
      limit: slot.maxCalls,
      method,
    });
  }

  /** Drop all counters (used by withBillingGuardDO to give each inbound DO call a fresh budget). */
  reset() {
    this.slots = new Map();
  }

  /** Usage summary at end of request (onRequestEnd callback / tests). */
  summary() {
    return {
      bindings: [...this.slots.values()].map((s) => ({
        binding: s.name,
        kind: s.kind,
        used: s.used,
        limit: s.maxCalls,
        blocked: s.blocked,
        onExceed: s.onExceed,
      })),
    };
  }
}
