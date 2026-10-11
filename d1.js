/**
 * d1.js — D1 绑定包装器（Proxy，零侵入核心）。
 *
 * 计数口径（一次"调用"= 一次真实执行）：
 *   statement 终结方法 first/all/run/raw/values ......... 1 次
 *   db.batch([s1, s2, s3]) .............................. N 次（按语句数）
 *   db.exec(sql) ........................................ 1 次
 *   db.withSession(fn) 内部的调用 ....................... 经包装的 session 正常计数
 *   仅 prepare()/bind() 未执行 .......................... 不计数
 *
 * 拦截时（onExceed）：
 *   'throw' → 终结方法返回 rejected Promise（BillingGuardError）
 *   'empty' → 返回与真实 API 同构的"空结果"：
 *     all() → {results:[], success:true, meta:0行}    first() → null
 *     run() → {success:true, meta:0行}                raw()/values() → []
 *     batch() → 每条语句一个空结果
 * 这样业务侧 try/catch、`.catch(()=>{})`、空结果判断等既有逻辑无需任何改动。
 */

export const WRAPPED = Symbol.for('cf-billing-guard.wrapped');
export const REAL = Symbol.for('cf-billing-guard.real');
export const SQL = Symbol.for('cf-billing-guard.sql');

const TERMINALS = new Set(['first', 'all', 'run', 'raw', 'values']);

function zeroMeta() {
  return { changes: 0, last_row_id: 0, duration_ms: 0, rows_read: 0, rows_written: 0 };
}

/** 各方法的"空结果"（与 D1 真实返回同构） */
export function neutralD1(method, count = 1) {
  switch (method) {
    case 'first':
      return null;
    case 'all':
      return { results: [], success: true, meta: zeroMeta() };
    case 'run':
    case 'exec':
      return { success: true, meta: zeroMeta() };
    case 'raw':
    case 'values':
      return [];
    case 'batch':
      return Array.from({ length: count }, () => ({ success: true, meta: zeroMeta() }));
    default:
      return undefined;
  }
}

function shortSql(sql) {
  const s = String(sql).replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/** 包装单个 D1PreparedStatement（保持链式 bind 可用） */
function wrapStatement(stmt, sql, ctx) {
  return new Proxy(stmt, {
    get(target, prop) {
      if (prop === WRAPPED) return true;
      if (prop === REAL) return target;
      if (prop === SQL) return sql;
      if (prop === 'bind') {
        return (...args) => wrapStatement(target.bind(...args), sql, ctx);
      }
      if (TERMINALS.has(prop)) {
        return () => execTerminal(target, prop, sql, ctx);
      }
      const v = Reflect.get(target, prop);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function execTerminal(real, method, sql, ctx) {
  const decision = ctx.ledger.beforeCall(ctx.binding, 'd1', method, 1);
  if (decision === 'throw') {
    throw ctx.ledger.exceededError(ctx.binding, 'd1', method);
  }
  if (decision === 'empty') {
    return neutralD1(method);
  }
  const res = await real[method]();
  ctx.ledger.afterCall(ctx.binding, 'd1', method, { sql: shortSql(sql) }, 1);
  return res;
}

async function runBatch(dbReal, stmts, ctx) {
  const reals = stmts.map((s) => (s && s[REAL]) || s);
  const n = reals.length;
  const decision = ctx.ledger.beforeCall(ctx.binding, 'd1', 'batch', n);
  if (decision === 'throw') throw ctx.ledger.exceededError(ctx.binding, 'd1', 'batch');
  if (decision === 'empty') return neutralD1('batch', n);
  const res = await dbReal.batch(reals);
  ctx.ledger.afterCall(ctx.binding, 'd1', 'batch', { statements: n }, n);
  return res;
}

async function runExec(dbReal, sql, ctx) {
  const decision = ctx.ledger.beforeCall(ctx.binding, 'd1', 'exec', 1);
  if (decision === 'throw') throw ctx.ledger.exceededError(ctx.binding, 'd1', 'exec');
  if (decision === 'empty') return neutralD1('exec');
  const res = await dbReal.exec(sql);
  ctx.ledger.afterCall(ctx.binding, 'd1', 'exec', { sql: shortSql(sql) }, 1);
  return res;
}

/** D1Database / D1Session 共用：拦截 prepare/batch/exec（session 无 withSession） */
function proxyD1(target, ctx, { withSession = false } = {}) {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === WRAPPED) return true;
      if (prop === REAL) return t;
      if (prop === 'prepare') return (sql) => wrapStatement(t.prepare(sql), sql, ctx);
      if (prop === 'batch') return (stmts) => runBatch(t, stmts, ctx);
      if (prop === 'exec') return (sql) => runExec(t, sql, ctx);
      if (withSession && prop === 'withSession') {
        return (fn) =>
          t.withSession((session) => fn(proxyD1(session, ctx, { withSession: false })));
      }
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * 包装 D1 绑定。
 * @param {D1Database} db 原始绑定
 * @param {Ledger} ledger 本请求账本
 * @param {string} binding 绑定名（env 上的属性名）
 */
export function wrapD1(db, ledger, binding) {
  return proxyD1(db, { ledger, binding }, { withSession: true });
}
