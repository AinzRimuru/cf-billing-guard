/**
 * d1.js — D1 binding wrapper (Proxy, zero-intrusion core).
 *
 * Counting (one "call" = one real execution):
 *   terminal methods first/all/run/raw/values ..... 1
 *   db.batch([s1..sN]) ............................ N (one per statement)
 *   db.exec(sql) .................................. 1
 *   db.withSession(fn) ............................ counted via wrapped session
 *   prepare()/bind() without executing ............ 0
 *
 * Blocking (onExceed):
 *   'throw' → terminal method returns a rejected promise (BillingGuardError)
 *   'empty' → returns a neutral result shaped like the real API:
 *     all() → {results:[], success:true, meta:zeroed}    first() → null
 *     run() → {success:true, meta:zeroed}                raw()/values() → []
 *     batch() → one neutral result per statement
 * Existing try/catch, .catch(() => {}) and empty-result checks keep working.
 */

export const WRAPPED = Symbol.for('cf-billing-guard.wrapped');
export const REAL = Symbol.for('cf-billing-guard.real');
export const SQL = Symbol.for('cf-billing-guard.sql');

const TERMINALS = new Set(['first', 'all', 'run', 'raw', 'values']);

function zeroMeta() {
  return { changes: 0, last_row_id: 0, duration_ms: 0, rows_read: 0, rows_written: 0 };
}

/** Neutral result per method, shaped like the real D1 API. */
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

/** Wrap a single D1PreparedStatement (keeps chained bind() usable). */
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
  const reals = stmts.map((s) => (s && s[REAL]) || s); // unwrap proxies
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

/** Shared by D1Database / D1Session: intercept prepare/batch/exec (session has no withSession). */
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
 * Wrap a D1 binding.
 * @param {D1Database} db raw binding
 * @param {Ledger} ledger per-request ledger
 * @param {string} binding binding name (property on env)
 */
export function wrapD1(db, ledger, binding) {
  return proxyD1(db, { ledger, binding }, { withSession: true });
}
