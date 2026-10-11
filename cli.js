#!/usr/bin/env node
/**
 * cf-billing-guard CLI — 自动接线 / 回滚（方案 A：包装入口）。
 *
 * enable：
 *   1. 从 wrangler 配置（wrangler.jsonc / wrangler.json / wrangler.toml，自动探测）
 *      读取当前 main（= 原始 Worker 入口）；
 *   2. 在同目录生成包装入口 billing-guard.main.js（含回滚标记 cf-billing-guard:entry=...）；
 *   3. 外科手术式修改 wrangler 配置的 main 一行 —— 只动这一行，注释/顺序/其余配置原样保留。
 * disable：
 *   1. 从包装文件的标记读回原始入口；
 *   2. main 改回原值，删除生成的包装文件。
 *
 * 两次执行 enable 幂等（已启用则跳过）；所有改动均可 --dry-run 预览。
 *
 * 用法：
 *   npx cf-billing-guard enable  [--entry <path>] [--out <path>] [--config <path>]
 *                                [--import <specifier>] [--d1 <n>] [--kv <n>]
 *                                [--on-exceed throw|empty] [--force] [--dry-run]
 *   npx cf-billing-guard disable [--config <path>] [--keep] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // 包根（或仓库检出位置）
const MARKER_RE = /^\s*\/\/\s*cf-billing-guard:entry=(\S+)\s*$/m;
const PKG_NAME = 'cf-billing-guard';

// ---------- 参数 ----------

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'enable';
  const args = { cmd, _: [] };
  const flagsWithValue = new Set(['--entry', '--out', '--config', '--import', '--d1', '--kv', '--on-exceed']);
  for (let i = cmd === argv[0] ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (flagsWithValue.has(a)) {
      args[a.slice(2)] = argv[++i];
    } else if (a === '--force' || a === '--dry-run' || a === '--keep') {
      args[a.slice(2)] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

const fail = (msg) => {
  console.error('[cf-billing-guard] 错误：' + msg);
  process.exit(1);
};
const log = (msg) => console.log('[cf-billing-guard] ' + msg);

// ---------- 运行环境探测 ----------

/**
 * 是否作为已安装的 npm 包运行（决定生成的包装文件 import 包名还是相对路径）。
 * 两条线索任一命中即视为已安装：
 *   - 本文件所在路径（import.meta.url，符号链接已被 Node 解析为真实路径）
 *   - 进程入口路径（process.argv[1]，经 node_modules/.bin 壳脚本调用时保留 node_modules 段）
 */
function isInstalled() {
  const segments = (p) => path.resolve(p).split(path.sep);
  if (HERE.split(path.sep).includes('node_modules')) return true;
  if (process.argv[1] && segments(process.argv[1]).includes('node_modules')) return true;
  return false;
}

// ---------- wrangler 配置（读取 + 外科手术式修改） ----------

const CONFIG_CANDIDATES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function findConfig(explicit, cwd) {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!fs.existsSync(p)) fail(`wrangler 配置不存在：${p}`);
    return p;
  }
  for (const name of CONFIG_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  fail(`未找到 wrangler 配置（${CONFIG_CANDIDATES.join(' / ')}），请用 --config 指定`);
}

/** 去掉 JSONC 注释（保留字符串字面量内的 // 与 /*） */
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 读取配置：返回 { path, text, isToml, main } */
function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const isToml = /\.toml$/i.test(configPath);
  let main;
  if (isToml) {
    const m = text.match(/^\s*main\s*=\s*(['"])(.*?)\1/m);
    main = m ? m[2] : undefined;
  } else {
    try {
      main = JSON.parse(stripJsonComments(text)).main;
    } catch (e) {
      fail(`wrangler 配置不是合法 JSON(C)：${configPath}（${e.message}）`);
    }
  }
  return { path: configPath, text, isToml, main };
}

/** 把 main 一行替换为新值（只动这一行；jsonc/toml 追加回滚注释，纯 json 不加）。返回新文本。 */
function patchMainInText(text, newMain, { isToml, configName, revertHint }) {
  const wantComment = !/\.json$/i.test(configName); // jsonc / toml 可带注释
  const comment = wantComment ? (isToml ? ' # ' : ' // ') + revertHint : '';
  if (isToml) {
    const reToml = /^(\s*)main\s*=\s*(['"]).*?\2\s*(#.*)?$/m;
    if (reToml.test(text)) {
      return text.replace(reToml, (_m, indent) => `${indent}main = "${newMain}"${comment}`);
    }
    return `main = "${newMain}"${comment}\n` + text;
  }
  const reJson = /^(\s*)"main"\s*:\s*"(?:[^"\\]|\\.)*"\s*(,)?\s*(\/\/.*)?$/m;
  if (reJson.test(text)) {
    return text.replace(reJson, (_m, indent, comma) => `${indent}"main": "${newMain}"${comma || ''}${comment}`);
  }
  // 无 main 键：插到对象开头
  const idx = text.indexOf('{');
  if (idx < 0) fail('wrangler 配置结构异常（找不到 "{"），请手工修改 main');
  return text.slice(0, idx + 1) + `\n  "main": "${newMain}",${comment}` + text.slice(idx + 1);
}

// ---------- 包装入口生成 / 识别 ----------

function relSpec(fromFile, toFile) {
  const from = path.dirname(path.resolve(fromFile));
  const to = path.resolve(toFile);
  const r = path.relative(from, to);
  if (!r || path.isAbsolute(r)) return pathToFileURL(to).href; // 跨盘符（Windows）无法相对化 → file:// URL
  const s = r.replace(/\\/g, '/');
  return s.startsWith('.') ? s : './' + s;
}

/** withBillingGuard 的导入来源：显式指定 > 已安装包名 > 本地同仓模块 */
function defaultImportSource(outFile, explicit) {
  if (explicit) return explicit;
  if (isInstalled()) return PKG_NAME;
  const local = path.join(HERE, 'index.js');
  if (fs.existsSync(local)) return relSpec(outFile, local);
  return PKG_NAME;
}

/** CLI 调用命令展示：已安装为包 → npx cf-billing-guard；本地仓库 → node <相对路径>/cli.js */
function cliCommand(cwd) {
  if (isInstalled()) return `npx ${PKG_NAME}`;
  const rel = path.relative(cwd, path.join(HERE, 'cli.js')).replace(/\\/g, '/');
  return `node ${rel}`;
}

function wrapperContent({ entryMark, entrySpec, importSrc, d1, kv, onExceed, revertCmd }) {
  return `/**
 * cf-billing-guard 接线入口（自动生成，请勿提交业务逻辑；调整限额直接改下方 options）。
 * 生成：${revertCmd.replace(' disable ', ' enable ')}    回滚：${revertCmd}
 */
// cf-billing-guard:entry=${entryMark}
import worker from '${entrySpec}';
import { withBillingGuard } from '${importSrc}';

export default withBillingGuard(worker, {
  defaults: { maxCalls: ${d1}, onExceed: '${onExceed}' },
  d1: { maxCalls: ${d1} }, // 单请求 D1 调用上限
  kv: { maxCalls: ${kv} }, // 单请求 KV 调用上限
});
`;
}

function markerEntry(file) {
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(MARKER_RE);
  return m ? m[1] : null;
}

// ---------- 文件写入（--dry-run 时只打印） ----------

function makeWriter(dryRun) {
  return {
    write(file, content) {
      if (dryRun) return log(`[dry-run] 将写入 ${file}（${content.length} 字节）`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      log(`已写入 ${file}`);
    },
    remove(file) {
      if (dryRun) return log(`[dry-run] 将删除 ${file}`);
      fs.unlinkSync(file);
      log(`已删除 ${file}`);
    },
  };
}

// ---------- enable / disable ----------

function enable(args, cwd) {
  const dryRun = !!args['dry-run'];
  const io = makeWriter(dryRun);
  const configPath = findConfig(args.config, cwd);
  const cfg = readConfig(configPath);
  log(`wrangler 配置：${configPath}${cfg.main ? `（当前 main = ${cfg.main}）` : '（无 main）'}`);

  // 原始入口：--entry 优先；当前 main 若已是本工具生成的包装文件则自动解包
  let entry = args.entry || cfg.main;
  if (!entry) fail('配置中无 main，请用 --entry 指定原始 Worker 入口');
  const entryAbs = path.resolve(cwd, entry);
  const wrappedEntry = markerEntry(entryAbs);
  if (wrappedEntry) {
    entry = wrappedEntry; // 已是包装文件 → 解出原始入口（幂等/换名场景）
    log(`检测到 main 已是 cf-billing-guard 包装文件，原始入口 = ${entry}`);
  }
  const outAbs = path.resolve(cwd, args.out || path.join(path.dirname(entry), 'billing-guard.main.js'));
  log(`原始入口：${entry} → 包装入口：${path.relative(cwd, outAbs) || outAbs}`);

  // 已启用且文件在 → 幂等跳过
  if (cfg.main && path.resolve(cwd, cfg.main) === outAbs && markerEntry(outAbs)) {
    log('已处于启用状态，无需改动（如需重新生成请先 disable 或加 --force）');
    return;
  }
  // 覆盖保护：已存在的非本工具文件
  if (fs.existsSync(outAbs) && !markerEntry(outAbs) && !args.force) {
    fail(`${outAbs} 已存在且不是 cf-billing-guard 生成的文件；确认覆盖请加 --force`);
  }

  const outRel = path.relative(cwd, outAbs).replace(/\\/g, '/');
  const importSrc = defaultImportSource(outAbs, args.import);
  const d1 = Number(args.d1) > 0 ? Number(args.d1) : 100;
  const kv = Number(args.kv) > 0 ? Number(args.kv) : 100;
  const onExceed = args['on-exceed'] === 'empty' ? 'empty' : 'throw';
  const cliCmd = cliCommand(cwd);
  const revertCmd = `${cliCmd} disable --out ${outRel}`;

  io.write(
    outAbs,
    wrapperContent({
      entryMark: entry, // 配置相对路径（cwd 相对），disable 回填 main 用
      entrySpec: relSpec(outAbs, entryAbs), // import 说明符（包装文件相对）
      importSrc,
      d1,
      kv,
      onExceed,
      revertCmd,
    })
  );
  const patched = patchMainInText(cfg.text, outRel.replace(/\\/g, '/'), {
    isToml: cfg.isToml,
    configName: path.basename(configPath),
    revertHint: `cf-billing-guard 接线入口（原 ${entry}）；回滚：${revertCmd}`,
  });
  // 自检：改完仍是合法 JSON(C)（TOML 仅尽力而为）
  if (!cfg.isToml) {
    try {
      JSON.parse(stripJsonComments(patched));
    } catch (e) {
      fail(`修改后配置校验失败，已放弃写入（${e.message}）`);
    }
  }
  io.write(configPath, patched);
  log(`wrangler main 已指向 ${outRel}${dryRun ? '（dry-run 未写入）' : ''}`);
  log('完成。业务入口文件零改动；回滚：' + revertCmd);
}

function disable(args, cwd) {
  const dryRun = !!args['dry-run'];
  const io = makeWriter(dryRun);
  const configPath = findConfig(args.config, cwd);
  const cfg = readConfig(configPath);

  // 从当前 main（或 --out 指向的包装文件）读回原始入口
  let wrapperAbs = cfg.main ? path.resolve(cwd, cfg.main) : null;
  if ((!wrapperAbs || !markerEntry(wrapperAbs)) && args.out) wrapperAbs = path.resolve(cwd, args.out);
  const entry = wrapperAbs && markerEntry(wrapperAbs);
  if (!entry) {
    log('未发现 cf-billing-guard 接线（main 不是生成的包装文件），无需回滚');
    return;
  }
  const patched = patchMainInText(cfg.text, entry, {
    isToml: cfg.isToml,
    configName: path.basename(configPath),
    revertHint: `cf-billing-guard 已回滚`,
  });
  if (!cfg.isToml) {
    try {
      JSON.parse(stripJsonComments(patched));
    } catch (e) {
      fail(`修改后配置校验失败，已放弃写入（${e.message}）`);
    }
  }
  io.write(configPath, patched);
  log(`wrangler main 已恢复为 ${entry}`);
  if (args.keep) {
    log(`保留包装文件 ${path.relative(cwd, wrapperAbs)}（--keep）`);
  } else {
    io.remove(wrapperAbs);
  }
  log('回滚完成，业务零残留。');
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
if (args.cmd === 'enable') enable(args, cwd);
else if (args.cmd === 'disable') disable(args, cwd);
else fail(`未知命令：${args.cmd}（支持 enable / disable）`);
