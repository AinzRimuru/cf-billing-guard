/**
 * ledger.js — 单请求调用账本（模块核心状态）。
 *
 * 每个入站请求创建一个 Ledger，按绑定名记录 D1/KV 的真实调用次数，
 * 达到 maxCalls 后按 onExceed 策略拦截：
 *   - 'throw'（默认）：以 Promise rejection 抛 BillingGuardError，
 *     让业务代码既有的 try/catch、.catch(()=>{}) 降级路径原样生效；
 *   - 'empty'：返回"空结果"（见 d1.js/kv.js 的 neutral*），
 *     业务侧表现为"查不到数据"，同样无需改动代码。
 *
 * 约束：所有拦截都以 rejection / 空结果形式出现，绝不同步 throw ——
 * 否则 `env.DB.prepare(...).bind(...).run().catch(...)` 这类链式调用
 * 会在 .catch 挂上前就抛出，破坏业务侧降级。
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

/** 单个绑定的计数 + 策略 */
class Slot {
  constructor(name, kind, policy) {
    this.name = name;
    this.kind = kind; // 'd1' | 'kv'
    this.maxCalls = policy.maxCalls;
    this.onExceed = policy.onExceed; // 'throw' | 'empty'
    this.used = 0;
    this.blocked = 0; // 被拦截的调用数（观测用）
    this.exceededNotified = false;
  }

  get exceeded() {
    return this.maxCalls !== Infinity && this.used >= this.maxCalls;
  }

  /**
   * 预定 n 次调用额度。返回 'allow' 或 'block'。
   * n 允许 >1（D1 batch 按语句数计）——放行后绝不允许半量执行，
   * 因此只要 used+n > maxCalls 就整体拦截。
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
   * @param {object} options withBillingGuard 的原始 options（见 index.js）
   */
  constructor(options) {
    this.options = options;
    this.slots = new Map(); // binding name -> Slot
  }

  /** 解析某绑定的策略：bindings[name] > [kind] > defaults */
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
   * 执行前检查。返回 'allow' | 'block'（block 时调用方决定 throw 还是空结果）。
   * 首次超限时触发 options.onExceeded 回调（告警一次/绑定/请求）。
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

  /** 真实调用完成后记账 + count 回调（指标用） */
  afterCall(binding, kind, method, detail = {}, n = 1) {
    const slot = this.slotFor(binding, kind);
    slot.commit(n);
    if (typeof this.options.count === 'function') {
      try {
        this.options.count({ binding, kind, method, used: slot.used, limit: slot.maxCalls, ...detail });
      } catch (e) {}
    }
  }

  /** 构造超限错误（含当前计数信息） */
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

  /** 请求结束时的用量摘要（onRequestEnd 回调 / 测试用） */
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
