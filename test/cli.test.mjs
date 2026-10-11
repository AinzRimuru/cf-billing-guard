/**
 * cf-billing-guard CLI 测试（node --test）。
 * 在临时目录里模拟宿主项目（wrangler 配置 + Worker 入口），
 * 跑 cli.js enable / disable 验证：包装文件生成、配置外科手术式修改、
 * 幂等、dry-run、toml 支持、限额参数透传。
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

/** 建一个模拟宿主项目：wrangler.jsonc + src/worker.js */
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
      `{\n  // 顶部注释必须保留\n  "name": "demo",\n  "main": "src/worker.js",\n  "compatibility_date": "2025-07-01"\n}\n`
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
  // jsonc：去注释后解析（fixture 内容不含字符串内 //，直接全局剥离）
  const noComment = text.replace(/\/\/[^\n]*/g, '');
  return JSON.parse(noComment).main;
}

// ---------- enable ----------

test('CLI enable: 生成包装入口 + 外科手术式改 main（jsonc，注释保留）', () => {
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
  assert.ok(cfgText.includes('// 顶部注释必须保留'), '原有注释被保留');
  assert.ok(cfgText.includes('"name": "demo"'), '其余配置不动');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable: --import 指定包名；--d1/--kv/--on-exceed 透传到生成文件', () => {
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

test('CLI enable 幂等：重复执行不改动', () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const cfgBefore = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  const wrapperBefore = fs.readFileSync(path.join(dir, WRAPPER), 'utf8');
  const r = runCli(['enable'], dir);
  assert.equal(r.code, 0);
  assert.ok(r.out.includes('已处于启用状态'), r.out);
  assert.equal(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'), cfgBefore);
  assert.equal(fs.readFileSync(path.join(dir, WRAPPER), 'utf8'), wrapperBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable --dry-run: 不写任何文件', () => {
  const dir = fixtureHost();
  const cfgBefore = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  const r = runCli(['enable', '--dry-run'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('dry-run'), r.out);
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)));
  assert.equal(fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8'), cfgBefore);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable: 生成的包装入口可被 import，fetch 已接入 guard', async () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const mod = await import(pathToFileURL(path.join(dir, WRAPPER)).href);
  assert.equal(typeof mod.default.fetch, 'function');
  const res = await mod.default.fetch(
    { method: 'GET', url: 'https://x.test/' },
    { OTHER: 'x' } // 无 D1/KV 绑定的 env 也应正常工作
  );
  assert.equal(res instanceof Response || typeof res.then !== 'function', true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI enable/disable: wrangler.toml 支持', () => {
  const dir = fixtureHost({ config: 'wrangler.toml' });
  const r = runCli(['enable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readMain(dir, 'wrangler.toml'), 'src/billing-guard.main.js');
  const toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
  assert.ok(toml.includes('# demo worker'), 'toml 原注释保留');

  const r2 = runCli(['disable'], dir);
  assert.equal(r2.code, 0, r2.out);
  assert.equal(readMain(dir, 'wrangler.toml'), 'src/worker.js');
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- disable ----------

test('CLI disable: main 恢复原值、包装文件删除、配置校验通过', () => {
  const dir = fixtureHost();
  assert.equal(runCli(['enable'], dir).code, 0);
  const r = runCli(['disable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readMain(dir), 'src/worker.js');
  assert.ok(!fs.existsSync(path.join(dir, WRAPPER)), '包装文件已删除');
  const cfgText = fs.readFileSync(path.join(dir, 'wrangler.jsonc'), 'utf8');
  assert.ok(cfgText.includes('// 顶部注释必须保留'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI disable: 未接线时安全退出', () => {
  const dir = fixtureHost();
  const r = runCli(['disable'], dir);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.includes('无需回滚'), r.out);
  fs.rmSync(dir, { recursive: true, force: true });
});
