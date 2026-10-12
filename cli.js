#!/usr/bin/env node
/**
 * cf-billing-guard CLI — automatic wiring / rollback (wrapper entry approach).
 *
 * enable:
 *   1. Read the current `main` from the wrangler config (wrangler.jsonc /
 *      wrangler.json / wrangler.toml, auto-detected);
 *   2. Generate a wrapper entry `billing-guard.main.js` next to it, tagged
 *      with `cf-billing-guard:entry=...` for rollback;
 *   3. Surgically patch only the `main` line in the config — comments,
 *      ordering and everything else are preserved as-is.
 * disable:
 *   1. Read the original entry back from the wrapper's marker;
 *   2. Restore `main` and delete the generated wrapper.
 *
 * `enable` is idempotent; every change can be previewed with --dry-run.
 *
 * Usage:
 *   npx cf-billing-guard enable  [--entry <path>] [--out <path>] [--config <path>]
 *                                [--import <specifier>] [--d1 <n>] [--kv <n>]
 *                                [--bindings <name,name>] [--on-exceed throw|empty]
 *                                [--force] [--dry-run]
 *   npx cf-billing-guard disable [--config <path>] [--out <path>] [--keep] [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // package root (or repo checkout)
const MARKER_RE = /^\s*\/\/\s*cf-billing-guard:entry=(\S+)\s*$/m;
const PKG_NAME = 'cf-billing-guard';

// ---------- args ----------

function parseArgs(argv) {
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'enable';
  const args = { cmd, _: [] };
  const flagsWithValue = new Set(['--entry', '--out', '--config', '--import', '--d1', '--kv', '--on-exceed', '--bindings']);
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
  console.error('[cf-billing-guard] error: ' + msg);
  process.exit(1);
};
const log = (msg) => console.log('[cf-billing-guard] ' + msg);

// ---------- environment detection ----------

/**
 * Whether we are running as an installed npm package (decides whether the
 * generated wrapper imports the package name or a relative path). Either
 * hint wins:
 *   - this file's path (import.meta.url; symlinks are resolved to the real
 *     path by Node)
 *   - the process entry (process.argv[1]; keeps the node_modules segment
 *     when invoked through a node_modules/.bin shim)
 */
function isInstalled() {
  const segments = (p) => path.resolve(p).split(path.sep);
  if (HERE.split(path.sep).includes('node_modules')) return true;
  if (process.argv[1] && segments(process.argv[1]).includes('node_modules')) return true;
  return false;
}

// ---------- wrangler config (read + surgical patch) ----------

const CONFIG_CANDIDATES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

function findConfig(explicit, cwd) {
  if (explicit) {
    const p = path.resolve(cwd, explicit);
    if (!fs.existsSync(p)) fail(`wrangler config not found: ${p}`);
    return p;
  }
  for (const name of CONFIG_CANDIDATES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  fail(`no wrangler config found (${CONFIG_CANDIDATES.join(' / ')}); pass --config`);
}

/** Strip JSONC comments (preserves // and /* inside string literals). */
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

/** Read a config: returns { path, text, isToml, main, bindingNames }. */
function readConfig(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const isToml = /\.toml$/i.test(configPath);
  let main;
  let bindingNames = [];
  if (isToml) {
    const m = text.match(/^\s*main\s*=\s*(['"])(.*?)\1/m);
    main = m ? m[2] : undefined;
    bindingNames = tomlBindingNames(text);
  } else {
    let cfg;
    try {
      cfg = JSON.parse(stripJsonComments(text));
    } catch (e) {
      fail(`wrangler config is not valid JSON(C): ${configPath} (${e.message})`);
    }
    main = cfg.main;
    bindingNames = jsonBindingNames(cfg);
  }
  return { path: configPath, text, isToml, main, bindingNames };
}

/**
 * Binding names for every guarded service declared in a wrangler JSON(C) config.
 * Covered: d1_databases, kv_namespaces, r2_buckets, vectorize,
 * analytics_engine_datasets, workflows, hyperdrive, queues.producers,
 * ai.binding, durable_objects.bindings[].name.
 */
function jsonBindingNames(cfg) {
  const names = [];
  const pushArr = (arr, key = 'binding') => {
    if (!Array.isArray(arr)) return;
    for (const e of arr) if (e && typeof e[key] === 'string') names.push(e[key]);
  };
  pushArr(cfg.d1_databases);
  pushArr(cfg.kv_namespaces);
  pushArr(cfg.r2_buckets);
  pushArr(cfg.vectorize);
  pushArr(cfg.analytics_engine_datasets);
  pushArr(cfg.workflows);
  pushArr(cfg.hyperdrive);
  pushArr(cfg.queues && cfg.queues.producers);
  if (cfg.ai && typeof cfg.ai.binding === 'string') names.push(cfg.ai.binding);
  pushArr(cfg.durable_objects && cfg.durable_objects.bindings, 'name');
  return names;
}

/**
 * Binding names from TOML sections. Minimal line-based scan: section headers
 * ([[array-of-tables]] or [table]) switch context; only the mapped key inside
 * a mapped section counts, so identically named keys elsewhere are ignored.
 */
const TOML_BINDING_SECTIONS = {
  d1_databases: 'binding',
  kv_namespaces: 'binding',
  r2_buckets: 'binding',
  vectorize: 'binding',
  analytics_engine_datasets: 'binding',
  workflows: 'binding',
  hyperdrive: 'binding',
  'queues.producers': 'binding',
  'durable_objects.bindings': 'name',
  ai: 'binding',
};

function tomlBindingNames(text) {
  const names = [];
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, ''); // strip trailing comment
    const sec = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*["']([^"']+)["']/);
    if (!kv || !section) continue;
    const wanted = TOML_BINDING_SECTIONS[section];
    if (wanted && kv[1] === wanted) names.push(kv[2]);
  }
  return names;
}

/** Replace the main line with a new value (that line only; jsonc/toml get a revert comment, plain json does not). Returns the new text. */
function patchMainInText(text, newMain, { isToml, configName, revertHint }) {
  const wantComment = !/\.json$/i.test(configName); // jsonc / toml can carry comments
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
  // No main key: insert at the start of the object
  const idx = text.indexOf('{');
  if (idx < 0) fail('unexpected wrangler config structure ("{" not found); patch main manually');
  return text.slice(0, idx + 1) + `\n  "main": "${newMain}",${comment}` + text.slice(idx + 1);
}

// ---------- wrapper generation / detection ----------

function relSpec(fromFile, toFile) {
  const from = path.dirname(path.resolve(fromFile));
  const to = path.resolve(toFile);
  const r = path.relative(from, to);
  if (!r || path.isAbsolute(r)) return pathToFileURL(to).href; // cross-drive (Windows) — use a file:// URL
  const s = r.replace(/\\/g, '/');
  return s.startsWith('.') ? s : './' + s;
}

/** Import source for withBillingGuard: explicit > installed package name > local module. */
function defaultImportSource(outFile, explicit) {
  if (explicit) return explicit;
  if (isInstalled()) return PKG_NAME;
  const local = path.join(HERE, 'index.js');
  if (fs.existsSync(local)) return relSpec(outFile, local);
  return PKG_NAME;
}

/** Display form of the CLI command: installed → npx cf-billing-guard; repo → node <rel>/cli.js */
function cliCommand(cwd) {
  if (isInstalled()) return `npx ${PKG_NAME}`;
  const rel = path.relative(cwd, path.join(HERE, 'cli.js')).replace(/\\/g, '/');
  return `node ${rel}`;
}

function wrapperContent({ entryMark, entrySpec, importSrc, d1, kv, onExceed, whitelist, revertCmd }) {
  const bindingsLine = whitelist && whitelist.length
    ? `  bindings: { ${whitelist.map((n) => `${n}: {}`).join(', ')} }, // explicit whitelist — anything else is never wrapped\n`
    : '';
  return `/**
 * cf-billing-guard wiring entry (auto-generated — tune limits below).
 * Enable: ${revertCmd.replace(' disable ', ' enable ')}    Revert: ${revertCmd}
 */
// cf-billing-guard:entry=${entryMark}
import worker from '${entrySpec}';
import { withBillingGuard } from '${importSrc}';

export default withBillingGuard(worker, {
  defaults: { maxCalls: ${d1}, onExceed: '${onExceed}' },
  d1: { maxCalls: ${d1} }, // per-request D1 call limit
  kv: { maxCalls: ${kv} }, // per-request KV call limit
${bindingsLine}});

// Re-export named exports from the original entry (Durable Object classes, etc.).
// Note: re-exported DO classes still receive the RAW env from the runtime —
// wrap them with withBillingGuardDO(MyDO, options) if they use D1/KV.
export * from '${entrySpec}';
`;
}

function markerEntry(file) {
  if (!fs.existsSync(file)) return null;
  const m = fs.readFileSync(file, 'utf8').match(MARKER_RE);
  return m ? m[1] : null;
}

// ---------- file writes (no-ops under --dry-run) ----------

function makeWriter(dryRun) {
  return {
    write(file, content) {
      if (dryRun) return log(`[dry-run] would write ${file} (${content.length} bytes)`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, 'utf8');
      log(`wrote ${file}`);
    },
    remove(file) {
      if (dryRun) return log(`[dry-run] would delete ${file}`);
      fs.unlinkSync(file);
      log(`deleted ${file}`);
    },
  };
}

// ---------- enable / disable ----------

function enable(args, cwd) {
  const dryRun = !!args['dry-run'];
  const io = makeWriter(dryRun);
  const configPath = findConfig(args.config, cwd);
  const cfg = readConfig(configPath);
  log(`wrangler config: ${configPath}${cfg.main ? ` (current main = ${cfg.main})` : ' (no main)'}`);

  // Original entry: --entry wins; if current main is our own wrapper, unwrap it
  let entry = args.entry || cfg.main;
  if (!entry) fail('config has no main; pass --entry to specify the original Worker entry');
  const entryAbs = path.resolve(cwd, entry);
  const wrappedEntry = markerEntry(entryAbs);
  if (wrappedEntry) {
    entry = wrappedEntry; // already a wrapper → recover the original entry (idempotency / rename)
    log(`main is already a cf-billing-guard wrapper; original entry = ${entry}`);
  }
  const outAbs = path.resolve(cwd, args.out || path.join(path.dirname(entry), 'billing-guard.main.js'));
  log(`original entry: ${entry} → wrapper: ${path.relative(cwd, outAbs) || outAbs}`);

  // Already enabled and file present → idempotent skip
  if (cfg.main && path.resolve(cwd, cfg.main) === outAbs && markerEntry(outAbs)) {
    log('already enabled, nothing to do (run disable first, or pass --force to regenerate)');
    return;
  }
  // Overwrite protection: pre-existing file not generated by this tool
  if (fs.existsSync(outAbs) && !markerEntry(outAbs) && !args.force) {
    fail(`${outAbs} already exists and was not generated by cf-billing-guard; pass --force to overwrite`);
  }

  const outRel = path.relative(cwd, outAbs).replace(/\\/g, '/');
  const importSrc = defaultImportSource(outAbs, args.import);
  const d1 = Number(args.d1) > 0 ? Number(args.d1) : 100;
  const kv = Number(args.kv) > 0 ? Number(args.kv) : 100;
  const onExceed = args['on-exceed'] === 'empty' ? 'empty' : 'throw';
  // Explicit binding whitelist: --bindings flag > names declared in the wrangler
  // config (all guarded services: d1/kv/r2/queue/vectorize/analytics/ai/do).
  // Only whitelisted bindings are wrapped; anything else is never touched.
  // No whitelist resolvable → fall back to shape detection at runtime.
  let whitelist = null;
  if (args.bindings) {
    whitelist = args.bindings.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    whitelist = cfg.bindingNames;
  }
  if (whitelist.length) {
    log(`binding whitelist (${whitelist.join(', ')}) — anything else is never wrapped`);
  } else {
    log('no guarded bindings found in config; falling back to shape detection (pass --bindings to pin names)');
  }
  const cliCmd = cliCommand(cwd);
  const revertCmd = `${cliCmd} disable --out ${outRel}`;

  io.write(
    outAbs,
    wrapperContent({
      entryMark: entry, // config-relative path; disable restores main from it
      entrySpec: relSpec(outAbs, entryAbs), // import specifier, relative to the wrapper
      importSrc,
      d1,
      kv,
      onExceed,
      whitelist,
      revertCmd,
    })
  );
  const patched = patchMainInText(cfg.text, outRel.replace(/\\/g, '/'), {
    isToml: cfg.isToml,
    configName: path.basename(configPath),
    revertHint: `cf-billing-guard entry (was ${entry}); revert: ${revertCmd}`,
  });
  // Self-check: the patched config must still be valid JSON(C) (TOML is best-effort)
  if (!cfg.isToml) {
    try {
      JSON.parse(stripJsonComments(patched));
    } catch (e) {
      fail(`patched config failed validation; aborting write (${e.message})`);
    }
  }
  io.write(configPath, patched);
  log(`wrangler main now points to ${outRel}${dryRun ? ' (dry-run, not written)' : ''}`);
  log(`done. Business entry untouched; revert with: ${revertCmd}`);
}

function disable(args, cwd) {
  const dryRun = !!args['dry-run'];
  const io = makeWriter(dryRun);
  const configPath = findConfig(args.config, cwd);
  const cfg = readConfig(configPath);

  // Read the original entry back from the current main (or --out)
  let wrapperAbs = cfg.main ? path.resolve(cwd, cfg.main) : null;
  if ((!wrapperAbs || !markerEntry(wrapperAbs)) && args.out) wrapperAbs = path.resolve(cwd, args.out);
  const entry = wrapperAbs && markerEntry(wrapperAbs);
  if (!entry) {
    log('no cf-billing-guard wiring found (main is not a generated wrapper); nothing to revert');
    return;
  }
  const patched = patchMainInText(cfg.text, entry, {
    isToml: cfg.isToml,
    configName: path.basename(configPath),
    revertHint: `cf-billing-guard reverted`,
  });
  if (!cfg.isToml) {
    try {
      JSON.parse(stripJsonComments(patched));
    } catch (e) {
      fail(`patched config failed validation; aborting write (${e.message})`);
    }
  }
  io.write(configPath, patched);
  log(`wrangler main restored to ${entry}`);
  if (args.keep) {
    log(`kept wrapper file ${path.relative(cwd, wrapperAbs)} (--keep)`);
  } else {
    io.remove(wrapperAbs);
  }
  log('revert complete, zero residue.');
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const cwd = process.cwd();
if (args.cmd === 'enable') enable(args, cwd);
else if (args.cmd === 'disable') disable(args, cwd);
else fail(`unknown command: ${args.cmd} (expected enable / disable)`);
