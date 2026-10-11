/**
 * cf-billing-guard CLI tests (node --test).
 * Simulates a host project (wrangler config + Worker entry) in a temp dir and
 * runs cli.js enable / disable to verify: wrapper generation, surgical config
 * patching, idempotency, dry-run, toml support and limit flag passthrough.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'cli.js');

function runCli(args, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Create a mock host project: wrangler config + src/worker.js */
function fixtureHost({ config = 'wrangler.jsonc' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfbg-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'worker.js'), 'export default { async fetch() { return new Response("ok"); } };\n');
  if (config.endsWith('.toml')) {
    fs.writeFileSync(
      path.join(dir, config),
      `# demo worker\nname = "demo"\nmain = "src/worker.js"\ncompatibility_date = "2025-07-01"\n`
    );
  } else if (config.endsWith('.jsonc') || config.endsWith('.json')) {
    fs.writeFileSync(
      path.join(dir, config),
      `{\n  // top-level comment must be preserved\n  "name": "demo",\n  "main": "src/worker.js",\n  "compatibility_date": "2025-07-01"\n}\n`
    );
  }
  return dir;
}

const WRAPPER = path.join('src', 'billing-guard.main.js');

function readMain(dir, config = 'wrangler.jsonc') {
  const text = fs.readFileSync(path.join(dir, config), 'utf8');
  if (config.endsWith('.toml')) {
    const m = text.match(/^main\s*=\s*"(\S+)"\s*(?:#.*)?$/m);
    return m && m[1];
  }
  // jsonc: strip comments, then parse (fixtures contain no // inside strings)
  const noComment = text.replace(/\/\/[^\n]*/g, '');
  return JSON.parse(noComment).main;
}

// ---------- enable ----------

test('CLI enable: generates wrapper entry + surgically patches main (jsonc, comments preserved)', () => {
  const dir = fixtureHost();
  const r = runCli(['enable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('[cf-billing-guard]'), r.out);

  const wrapper = path.join(dir, WRAPPER);
  assert.ok(fs.existsSync(wrapper));
  const content = fs.readFileSync(wrapper, 'utf8');
  assert.match(content, /\/\/ cf-billing-guard:entry=src\/worker\.js/);
  assert.match(content, /import worker from '\.\/worker\.js';/);
  assert.match(content, /withBillingGuard/);
  assert.match(content, /d1: \{ maxCalls: 100 \}/);
  assert.match(content, /kv: \{ maxCalls: 100 \}/);

  assert.equal(readMain(dir), 'src/billing-guard.main.js');
  const cfgText = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  assert.ok(cfgText.includes('// top-level comment must be preserved'), 'original comment preserved');
  assert.ok(cfgText.includes('"name": "demo"'), 'other config untouched');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable: --import overrides the package name; --d1/--kv/--on-exceed reach the wrapper', () => {
  const dir = fixtureHost();
  const r = runCli(['enable', '--import', 'cf-billing-guard', '--d1', '50', '--kv', '20', '--on-exceed', 'empty'], dir);
  assert.equal(r.code, 0, r.out);
  const content = fs.readFileSync(path.join(dir, WRAPPER), 'utf8');
  assert.match(content, /from 'cf-billing-guard';/);
  assert.match(content, /d1: \{ maxCalls: 50 \}/);
  assert.match(content, /kv: \{ maxCalls: 20 \}/);
  assert.match(content, /onExceed: 'empty'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable is idempotent: re-running changes nothing', () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const cfgBefore = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  const wrapperBefore = fs.readFileSync(path.join(dir, WRAPPER), 'utf8');
  const r = runCli(['enable'], dir);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('already enabled'), r.out);
  assert.equal(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'), cfgBefore);
  assert.equal(fs.readFileSync(path.join(dir, WRAPPER), 'utf8'), wrapperBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable --dry-run: writes nothing', () => {
  const dir = fixtureHost();
  const cfgBefore = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  const r = runCli(['enable', '--dry-run'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('dry-run'), r.out);
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)));
  assert.equal(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'), cfgBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable: the generated wrapper imports cleanly and fetch is guarded', async () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const mod = await import(pathToFileURL(path.join(dir, WRAPPER)).href);
  assert.equal(typeof mod.default.fetch, 'function');
  const res = await mod.default.fetch(
    { method: 'GET', url: 'https://x.test/' },
    { OTHER: 'x' } // env without D1/KV bindings must work too
  );
  assert.equal(res instanceof Response || typeof res.then !== 'function', true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable/disable: wrangler.toml support', () => {
  const dir = fixtureHost({ config: 'wrangler.toml' });
  const r = runCli(['enable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readMain(dir, 'wrangler.toml'), 'src/billing-guard.main.js');
  const toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
  assert.ok(toml.includes('# demo worker'), 'toml comment preserved');

  const r2 = runCli(['disable'], dir);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(readMain(dir, 'wrangler.toml'), 'src/worker.js');
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- disable ----------

test('CLI disable: main restored, wrapper deleted, config stays valid', () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const r = runCli(['disable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readMain(dir), 'src/worker.js');
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)), 'wrapper deleted');
  const cfgText = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  assert.ok(cfgText.includes('// top-level comment must be preserved'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI disable: exits safely when nothing is wired', () => {
  const dir = fixtureHost();
  const r = runCli(['disable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('nothing to revert'), r.out);
  fs.rmSync(dir, { recursive: true, force: true });
});
