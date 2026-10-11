/**
 * cf-billing-guard core tests (node --test).
 * Mocked D1/KV bindings verify: counting rules, per-request limits, both
 * block modes (throw/empty), and that existing business fallbacks
 * (try/catch, .catch(() => {})) keep working unchanged.
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
      db.batchReceived = stmts; // record what actually reached the driver (unwrap check)
      return stmts.map(() => ({ success: true, meta: { rows_read: 1, rows_written: 1 } }));
    },
    async exec(sql) {
      calls.push(['exec', sql]);
      return { success: true, meta: { rows_read: 0, rows_written: 0 } };
    },
    async withSession(fn) {
      return fn(db); // reuse the same mock
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

// ---------- D1 counting ----------

test('D1: terminal methods count 1 each; prepare/bind without execute is free', async () => {
  const db = mockD1();
  const used = [];
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        env.DB.prepare('SELECT 1').bind(1, 2); // prepare+bind only → 0
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

test('D1: batch counts per statement and passes real statements through (unwrap)', async () => {
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
  assert.equal(db.batchReceived[0].__sql, 'UPDATE x SET a=1'); // driver got the real statement
  assert.equal(db.batchReceived[0].prepare, undefined);         // not the wrapping Proxy
});

test('D1: exec and calls inside withSession are counted', async () => {
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

// ---------- per-request limit: throw mode ----------

test('D1: over-limit returns a rejected promise (BillingGuardError), never throws synchronously', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const errs = [];
        // Common business pattern: .catch(() => {}) — would crash if the
        // wrapper threw synchronously before .catch is attached
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
  assert.equal(db.calls.length, 2); // the 3rd never reached the driver
});

test('BillingGuardError carries binding/kind/used/limit', () => {
  const e = new BillingGuardError({ binding: 'DB', kind: 'd1', used: 3, limit: 2 });
  assert.equal(e.name, 'BillingGuardError');
  assert.equal(e.binding, 'DB');
  assert.equal(e.kind, 'd1');
  assert.equal(e.used, 3);
  assert.equal(e.limit, 2);
  assert.ok(e.message.includes('cf-billing-guard'));
});

test('D1: batch is blocked as a whole (no partial execution)', async () => {
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
  assert.equal(db.calls.length, 1); // the whole batch was skipped
});

// ---------- per-request limit: empty mode ----------

test('D1: onExceed=empty returns same-shaped neutral results', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const a = await env.DB.prepare('SELECT 1').all();   // real (1/1)
        const b = await env.DB.prepare('SELECT 2').all();   // neutral
        const c = await env.DB.prepare('SELECT 3').first(); // neutral
        const d = await env.DB.prepare('UPDATE 4').run();   // neutral
        const e = await env.DB.prepare('SELECT 5').raw();   // neutral
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

test('KV: get/put/delete/list counting; throw blocks; empty returns neutral results', async () => {
  const kv = mockKV();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const v1 = await env.KV.get('k1'); // real
        const v2 = await env.KV.get('k2'); // neutral (limit=1, empty)
        let err = null;
        try {
          await env.KV.put('k3', 'x');
        } catch (e) {
          err = e.name; // empty does not throw → undefined
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

test('KV: throw mode rejects with BillingGuardError', async () => {
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

// ---------- policy resolution / callbacks ----------

test('bindings override has highest priority; non-binding env props pass through', async () => {
  const db = mockD1();
  const kv = mockKV();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        assert.equal(env.OTHER, 'x'); // plain env props stay visible
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

test('count / onExceeded / onRequestEnd callbacks fire', async () => {
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

test('whitelist: only listed names are wrapped — unlisted KV-shaped bindings pass through untouched', async () => {
  const cache = mockKV();
  const otherKv = mockKV(); // e.g. an R2 bucket or any other binding that happens to look KV-ish
  const counted = [];
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        const a = await env.CACHE.get('a');                          // real (1/1)
        let blocked = false;
        try { await env.CACHE.get('b'); } catch (e) { blocked = true; } // over limit
        const x1 = await env.OTHER_KV.get('x');                     // not whitelisted
        const x2 = await env.OTHER_KV.get('y');                     // still untouched
        return new Response(JSON.stringify({ a, blocked, x1, x2 }));
      } },
    { kv: { maxCalls: 1 }, bindings: { CACHE: {} }, count: (i) => counted.push(i.binding) }
  );
  const res = await worker.fetch(req(), { CACHE: cache, OTHER_KV: otherKv });
  const body = JSON.parse(await res.text());
  assert.equal(body.a, 'v:a');
  assert.equal(body.blocked, true);      // CACHE hit its limit
  assert.equal(body.x1, 'v:x');          // OTHER_KV unaffected
  assert.equal(body.x2, 'v:y');
  assert.equal(otherKv.calls.length, 2); // both calls reached the driver
  assert.deepEqual(counted, ['CACHE']);  // only CACHE was counted
});

// ---------- request isolation / idempotency ----------

test('counters are isolated per request', async () => {
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
  // Each request: first call passes, second is blocked → both saw a block
  assert.equal(seen.length, 2);
  assert.equal(db.calls.length, 2); // one allowed call per request
});

test('double wrapping is idempotent: nested instrumentEnv does not double-count', async () => {
  const db = mockD1();
  const ledger = new Ledger({ d1: { maxCalls: 10 } });
  const env1 = instrumentEnv({ DB: db }, ledger);
  const env2 = instrumentEnv(env1, new Ledger({ d1: { maxCalls: 10 } }));
  await env2.DB.prepare('SELECT 1').all();
  await env2.DB.prepare('SELECT 2').all();
  assert.equal(ledger.summary().bindings[0].used, 2); // only the inner layer counts
});

// ---------- business degradation integration ----------

test('integration: existing degradation paths keep working when the limit hits', async () => {
  const db = mockD1();
  const worker = withBillingGuard(
    { fetch: async (r, env) => {
        // Typical business pattern: query an accounts table, fall back to a
        // single account when the query fails
        const getAvailableAccounts = async () => {
          if (env && env.DB) {
            try {
              const { results } = await env.DB.prepare('SELECT username FROM accounts').all();
              if (results && results.length) return results;
            } catch (e) {
              // D1 query failed → fall back
            }
          }
          return env.DH_USERNAME ? [{ username: env.DH_USERNAME }] : [];
        };
        const markUsed = (username) =>
          env.DB.prepare('UPDATE accounts SET last_used=?1 WHERE username=?2')
            .bind(Date.now(), username)
            .run()
            .catch(() => {});

        // limit=2: the first two D1 calls pass, the third (second
        // getAvailableAccounts) is blocked
        const acc1 = await getAvailableAccounts(); // call 1
        await markUsed('u');                       // call 2
        const acc2 = await getAvailableAccounts(); // call 3 → blocked
        await markUsed('u');                       // blocked, does not throw
        return new Response(JSON.stringify({ acc1: acc1.length, acc2: acc2.length }));
      } },
    { d1: { maxCalls: 2 } }
  );

  const res = await worker.fetch(req(), { DB: db, DH_USERNAME: 'fallback-user' });
  const body = JSON.parse(await res.text());
  assert.equal(body.acc1, 2); // normal D1 path
  assert.equal(body.acc2, 1); // blocked → single-account fallback, business unaware
});
