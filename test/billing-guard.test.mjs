/**
 * cf-billing-guard 核心测试（node --test）。
 * 用 mock 的 D1/KV 绑定验证：计数口径、单请求上限、throw/empty 两种拦截、
 * 既有业务代码降级路径（try/catch、.catch(()=>{})）无需改动即可工作。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { withBillingGuard, instrumentEnv, BillingGuardError } from '../index.js';
import { Ledger } from '../ledger.js';

// ---------- mocks ----------

function mockD1() {
  const calls = [];
  const mkStmt = (sql) => ({
    __sql: sql,
    bind(...a) {
      return mkStmt(sql);
    },
    async first() {
      calls.push(['first', sql]);
      return { username: 'u1' };
    },
    async all() {
      calls.push(['all', sql]);
      return {
        results: [{ username: 'u1' }, { username: 'u2' }],
        success: true,
        meta: { rows_read: 2, rows_written: 0, duration_ms: 1 },
      };
    },
    async run() {
      calls.push(['run', sql]);
      return { success: true, meta: { rows_read: 3, rows_written: 1, duration_ms: 1 } };
    },
    async raw() {
      calls.push(['raw', sql]);
      return [[1], [2], [3]];
    },
  });
  const db = {
    calls,
    prepare(sql) {
      return mkStmt(sql);
    },
    async batch(stmts) {
      calls.push(['batch', stmts.length]);
      db.batchReceived = stmts; // 记录实际收到的语句对象（用于验证 unwrap）
      return stmts.map(() => ({ success: true, meta: { rows_read: 1, rows_written: 1 } }));
    },
    async exec(sql) {
      calls.push(['exec', sql]);
      return { success: true, meta: { rows_read: 0, rows_written: 0 } };
    },
    async withSession(fn) {
      return fn(db); // 直接复用同一 mock
    },
    batchReceived: null,
  };
  return db;
}

function mockKV() {
  const calls = [];
  return {
    calls,
    async get(k) {
      calls.push(['get', k]);
      return 'v:' + k;
    },
    async getWithMetadata(k) {
      calls.push(['getWithMetadata', k]);
      return { value: 'v:' + k, metadata: { a: 1 } };
    },
    async put(k, v) {
      calls.push(['put', k]);
    },
    async delete(k) {
      calls.push(['delete', k]);
    },
    async list() {
      calls.push(['list']);
      return { keys: [{ name: 'a' }, { name: 'b' }], list_complete: true };
    },
  };
}

const req = () => ({ method: 'GET', url: 'https://x.test/v2/' });

// ---------- D1 计数口径 ----------

test('D1: 终结方法各计 1 次；prepare/bind 不计数；链式调用可用', async () => {
  const db = mockD1();
  let used = [];
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        env.DB.prepare('SELECT 1').bind(1, 2); // 只 prepare+bind 不执行 → 0
        await env.DB.prepare('SELECT a').all();
        await env.DB.prepare('SELECT b').first();
        await env.DB.prepare('UPDATE c').run();
        await env.DB.prepare('SELECT d').raw();
        return new Response('ok');
      } },
    { d1: { maxCalls: 100 }, count: (i) => used.push(i) }
  );
  await worker.fetch(req(), { DB: db });
  assert.equal(db.calls.length, 4);
  assert.equal(used.filter((i) => i.kind === 'd1').length, 4);
});

test('D1: batch 按语句数计数，且把真实语句透传给底层（unwrap）', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const s1 = env.DB.prepare('UPDATE x SET a=1');
        const s2 = env.DB.prepare('UPDATE y SET b=2');
        const res = await env.DB.batch([s1, s2]);
        assert.equal(res.length, 2);
        return new Response('ok');
      } },
    {}
  );
  await worker.fetch(req(), { DB: db });
  assert.deepEqual(db.calls, [['batch', 2]]);
  assert.equal(db.batchReceived[0].__sql, 'UPDATE x SET a=1'); // 收到的是真实语句
  assert.equal(db.batchReceived[0].prepare, undefined); // 不是包装 Proxy
});

test('D1: exec 与 withSession 内调用均计数', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        await env.DB.exec('CREATE TABLE t(x)');
        await env.DB.withSession(async (s) => {
          await s.prepare('SELECT 1').all();
          await s.prepare('SELECT 2').all();
        });
        return new Response('ok');
      } },
    {}
  );
  await worker.fetch(req(), { DB: db });
  assert.equal(db.calls.filter((c) => c[0] === 'all').length, 2);
  assert.ok(db.calls.some((c) => c[0] === 'exec'));
});

// ---------- 单请求上限：throw 模式 ----------

test('D1: 超限后以 Promise rejection 抛 BillingGuardError，绝不同步 throw', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const errs = [];
        // 业务侧既有模式：.catch(()=>{}) —— 若包装器同步 throw 会直接崩
        await env.DB.prepare('SELECT 1').all().catch((e) => errs.push(e.name));
        await env.DB.prepare('SELECT 2').all().catch((e) => errs.push(e.name));
        let caught = null;
        try {
          await env.DB.prepare('SELECT 3').all();
        } catch (e) {
          caught = e;
        }
        return new Response(JSON.stringify({ errs, caught: caught && caught.name }));
      } },
    { d1: { maxCalls: 2 } }
  );
  const res = await worker.fetch(req(), { DB: db });
  const body = JSON.parse(await res.text());
  assert.deepEqual(body.errs, []);
  assert.equal(body.caught, 'BillingGuardError');
  assert.equal(db.calls.length, 2); // 第 3 次没打到底层
});

test('BillingGuardError 携带 binding/kind/used/limit 信息', () => {
  const e = new BillingGuardError({ binding: 'DB', kind: 'd1', used: 3, limit: 2 });
  assert.equal(e.name, 'BillingGuardError');
  assert.equal(e.binding, 'DB');
  assert.equal(e.kind, 'd1');
  assert.equal(e.used, 3);
  assert.equal(e.limit, 2);
  assert.ok(e.message.includes('cf-billing-guard'));
});

test('D1: batch 会把整批拦截（不做半量执行）', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        await env.DB.prepare('SELECT 1').all(); // used=1, limit=2
        let err = null;
        try {
          await env.DB.batch([env.DB.prepare('SELECT 2'), env.DB.prepare('SELECT 3')]);
        } catch (e) {
          err = e;
        }
        return new Response(String(err && err.name));
      } },
    { d1: { maxCalls: 2 } }
  );
  const res = await worker.fetch(req(), { DB: db });
  assert.equal(await res.text(), 'BillingGuardError');
  assert.equal(db.calls.length, 1); // batch 整批未执行
});

// ---------- 单请求上限：empty 模式 ----------

test('D1: onExceed=empty 返回同构空结果', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const a = await env.DB.prepare('SELECT 1').all();      // 真实（1/1）
        const b = await env.DB.prepare('SELECT 2').all();      // 空
        const c = await env.DB.prepare('SELECT 3').first();    // 空
        const d = await env.DB.prepare('UPDATE 4').run();      // 空
        const e = await env.DB.prepare('SELECT 5').raw();      // 空
        return new Response(JSON.stringify({ a: a.results.length, b, c, d: d.success, e }));
      } },
    { d1: { maxCalls: 1, onExceed: 'empty' } }
  );
  const res = await worker.fetch(req(), { DB: db });
  const body = JSON.parse(await res.text());
  assert.equal(body.a, 2);
  assert.deepEqual(body.b, { results: [], success: true, meta: { changes: 0, last_row_id: 0, duration_ms: 0, rows_read: 0, rows_written: 0 } });
  assert.equal(body.c, null);
  assert.equal(body.d, true);
  assert.deepEqual(body.e, []);
  assert.equal(db.calls.length, 1);
});

// ---------- KV ----------

test('KV: get/put/delete/list 计数；超限 throw；empty 返回空语义结果', async () => {
  const kv = mockKV();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const v1 = await env.KV.get('k1'); // 真实
        const v2 = await env.KV.get('k2'); // 空（limit=1, empty）
        let err = null;
        try {
          await env.KV.put('k3', 'x');
        } catch (e) {
          err = e.name; // empty 不抛 → undefined
        }
        const l = await env.KV.list();
        return new Response(JSON.stringify({ v1, v2, err: err || null, l }));
      } },
    { kv: { maxCalls: 1, onExceed: 'empty' } }
  );
  const res = await worker.fetch(req(), { KV: kv });
  const body = JSON.parse(await res.text());
  assert.equal(body.v1, 'v:k1');
  assert.equal(body.v2, null);
  assert.equal(body.err, null);
  assert.deepEqual(body.l, { keys: [], list_complete: true });
  assert.equal(kv.calls.length, 1);
});

test('KV: throw 模式超限抛 BillingGuardError', async () => {
  const kv = mockKV();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        await env.KV.get('a');
        try {
          await env.KV.get('b');
        } catch (e) {
          return new Response(e.name);
        }
        return new Response('no');
      } },
    { kv: { maxCalls: 1, onExceed: 'throw' } }
  );
  const res = await worker.fetch(req(), { KV: kv });
  assert.equal(await res.text(), 'BillingGuardError');
});

// ---------- 策略解析 / 回调 ----------

test('bindings 按名覆盖优先级最高；非绑定 env 属性透传', async () => {
  const db = mockD1();
  const kv = mockKV();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        assert.equal(env.OTHER, 'x'); // 普通 env 属性原样可见
        assert.equal(typeof env.DB.prepare, 'function');
        await env.DB.prepare('SELECT 1').all();
        await env.DB.prepare('SELECT 2').all();
        let err = null;
        try {
          await env.DB.prepare('SELECT 3').all();
        } catch (e) {
          err = e;
        }
        return new Response(err ? 'blocked' : 'ok');
      } },
    { defaults: { maxCalls: 50 }, bindings: { DB: { maxCalls: 2 } } }
  );
  const res = await worker.fetch(req(), { DB: db, KV: kv, OTHER: 'x' });
  assert.equal(await res.text(), 'blocked');
});

test('count / onExceeded / onRequestEnd 回调触发', async () => {
  const db = mockD1();
  const counted = [];
  let exceeded = null;
  let summary = null;
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        await env.DB.prepare('SELECT 1').all();
        await env.DB.prepare('SELECT 2').all().catch(() => {});
        return new Response('ok');
      } },
    {
      d1: { maxCalls: 1 },
      count: (i) => counted.push(`${i.binding}:${i.method}`),
      onExceeded: (i) => (exceeded = i),
      onRequestEnd: (s) => (summary = s),
    }
  );
  await worker.fetch(req(), { DB: db });
  assert.deepEqual(counted, ['DB:all']);
  assert.equal(exceeded.binding, 'DB');
  assert.equal(exceeded.limit, 1);
  assert.equal(summary.bindings[0].used, 1);
  assert.equal(summary.bindings[0].blocked, 1);
});

// ---------- 请求隔离 / 幂等 ----------

test('计数按请求隔离：两个请求各自独立', async () => {
  const db = mockD1();
  const seen = [];
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const a = await env.DB.prepare('SELECT 1').all().catch((e) => 'err');
        const b = await env.DB.prepare('SELECT 2').all().catch((e) => 'err');
        seen.push(a === 'err' || b === 'err');
        return new Response('ok');
      } },
    { d1: { maxCalls: 1 } }
  );
  await worker.fetch(req(), { DB: db });
  await worker.fetch(req(), { DB: db });
  // 每个请求：第 1 次成功、第 2 次被拦 → 都出现过拦截
  assert.equal(seen.length, 2);
  assert.equal(db.calls.length, 2); // 每请求只放行 1 次
});

test('重复包装幂等：instrumentEnv 两层不重复计数', async () => {
  const db = mockD1();
  const ledger = new Ledger({ d1: { maxCalls: 10 } });
  const env1 = instrumentEnv({ DB: db }, ledger);
  const env2 = instrumentEnv(env1, new Ledger({ d1: { maxCalls: 10 } }));
  await env2.DB.prepare('SELECT 1').all();
  await env2.DB.prepare('SELECT 2').all();
  assert.equal(ledger.summary().bindings[0].used, 2); // 只有第一层在计数
});

// ---------- 业务降级集成（D1 失败 → 回退单账号） ----------

test('集成：超限后业务降级路径原样生效（D1 失败 → 回退单账号）', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        // 复刻典型业务模式：查账号表，失败则回退单账号
        const getAvailableAccounts = async () => {
          if (env && env.DB) {
            try {
              const { results } = await env.DB.prepare('SELECT username FROM accounts').all();
              if (results && results.length) return results;
            } catch (e) {
              // D1 查询失败则回退单账号
            }
          }
          return env.DH_USERNAME ? [{ username: env.DH_USERNAME }] : [];
        };
        const markUsed = (username) =>
          env.DB.prepare('UPDATE accounts SET last_used=?1 WHERE username=?2')
            .bind(Date.now(), username)
            .run()
            .catch(() => {});

        // limit=2：前两次 D1 调用放行，第 3 次（第二个 getAvailableAccounts）被拦
        const acc1 = await getAvailableAccounts(); // call 1
        await markUsed('u'); // call 2
        const acc2 = await getAvailableAccounts(); // call 3 → 被拦
        await markUsed('u'); // 被拦，不抛
        return new Response(JSON.stringify({ acc1: acc1.length, acc2: acc2.length }));
      } },
    { d1: { maxCalls: 2 } }
  );

  const res = await worker.fetch(req(), { DB: db, DH_USERNAME: 'fallback-user' });
  const body = JSON.parse(await res.text());
  assert.equal(body.acc1, 2); // 正常走 D1
  assert.equal(body.acc2, 1); // 被拦 → 回退单账号，业务无感
});
