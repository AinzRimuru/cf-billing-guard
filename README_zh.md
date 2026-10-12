# cf-billing-guard

[English](README.md) | 简体中文

[![CI](https://github.com/AinzRimuru/cf-billing-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/AinzRimuru/cf-billing-guard/actions/workflows/ci.yml)

Cloudflare Workers D1 / KV 绑定的**单请求调用上限**工具。用 Proxy 包装 `env`，对每个请求内的真实 D1/KV 调用计数，超出上限即拦截——失控循环、递归 bug 或恶意请求都打不爆你的 Cloudflare 账单。

业务代码零改动：语法、链式调用、返回结构完全不变。

## 安装

```bash
npm install -D cf-billing-guard
```

## 快速开始

```bash
npx cf-billing-guard enable          # 一键接线
npx cf-billing-guard disable         # 完全回滚
```

CLI 从 `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` 读取 `main`，在其同目录生成包装入口 `billing-guard.main.js`，且只改配置中这一行。重复执行 `enable` 无副作用；`disable` 恢复原 `main` 并删除包装文件。

等价的手工接线：

```js
// billing-guard.main.js
import worker from './index.js';                 // 你原有的 Worker，零改动
import { withBillingGuard } from 'cf-billing-guard';

export default withBillingGuard(worker, {
  d1: { maxCalls: 100 },
  kv: { maxCalls: 100 },
});
```

## 工作原理

```
请求 ─▶ withBillingGuard(worker).fetch
         ├─ 新建请求级 Ledger（各绑定计数 = 0）
         ├─ instrumentEnv(env) — 用 Proxy 包装 env
         │     env.DB ─▶ wrapD1(db, ledger)
         │     env.KV ─▶ wrapKV(ns, ledger)
         └─ worker.fetch(request, 包装后的 env, ctx)   // 业务照常
```

- CLI 会从 wrangler 配置的 `d1_databases` / `kv_namespaces` 读出**显式白名单**（`bindings`）写进接线文件——只包装你声明过的绑定；R2、Durable Objects、Queues 等其它任何绑定永不被碰。未配置白名单时（手工接线）才退回按方法签名探测（`prepare+batch+exec` → D1，`get+put+getWithMetadata` → KV）。
- 增删 D1/KV 绑定后，重新执行 `npx cf-billing-guard enable --force` 刷新白名单。
- 包装按请求创建，计数精确且天然隔离——无跨请求状态，无 isolate 级近似。
- 重复包装幂等（`Symbol.for('cf-billing-guard.wrapped')`）。

## 支持的服务

内建适配器——默认生效，策略写在 `options.<kind>`：

| kind | 计数 | `'empty'` 中立结果 |
|---|---|---|
| `d1` | 终结方法 1 次；`batch` N 次；`exec` 1 次 | 同构空结果 |
| `kv` | `get / getWithMetadata / put / delete / list` | `null` / 空列表 |
| `r2` | `get / head / put / delete / list` | `null` / `{objects:[]}` |
| `queue` | `send` 1 条；`sendBatch` N 条（整批原子） | 丢弃（`undefined`） |
| `vectorize` | `query / getByIds / deleteByIds / describe` 1 次；`insert / upsert` 按向量数 | 空查询结果 |
| `analytics` | `writeDataPoint` | `undefined` |
| `ai` | `run` | `null` |
| `do` | stub 的 `fetch` / RPC 各 1 次（经 `env.<name>.get(...)`） | `undefined` |

其余服务：`observe: true` 仅计数，或 `defineAdapter` 升为完整支持。有意不覆盖：Hyperdrive（无按次计费）、Cache API（免费且不走 env）、Service bindings（无法可靠探测）。CLI 白名单会从 wrangler 配置自动提取上表全部服务的绑定名。
## 拦截语义（`onExceed`）

被拦截的调用绝不同步 throw——一律以 rejected Promise 或空结果呈现，链式的 `.catch(() => {})` 和 try/catch 降级路径照常工作。

| 模式 | D1 | KV | 适用 |
|---|---|---|---|
| `'throw'`（默认） | rejected Promise，携带 `BillingGuardError` | 同左 | 业务已有错误降级路径 |
| `'empty'` | 同构空结果：`all()` → `{results:[],success:true}`、`first()` → `null`、`run()` → `{success:true,meta:0行}`、`raw()` → `[]`、`batch()` → 逐语句空结果 | `get` → `null`（缓存未命中）、`list` → `{keys:[],list_complete:true}`、`put/delete` → `undefined` | "查不到"本就是正常路径（缓存类场景） |

`batch` 整批拦截、绝不部分执行，以保持 D1 batch 的原子性语义。

## API

### `withBillingGuard(worker, options?) → worker`

包装 Worker 入口。`fetch` 必有；`scheduled`、`queue`、`test`、`email`、`tail` 处理器透传并注入相同的包装 env。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaults` | `{maxCalls?, onExceed?}` | `{100, 'throw'}` | 兜底策略 |
| `d1` / `kv` | 同上 | — | 按绑定类型 |
| `bindings` | `{[name]: 同上}` | — | 按绑定名覆盖（优先级最高），且充当白名单 |
| `[kind]` | 同上 | — | 任意自定义适配器类型的策略（如 `r2`） |
| `adapters` | `{[kind]: adapter}` | 内建 `d1`/`kv` | 自定义适配器；先于内建匹配 |
| `observe` | `true \| string[]` | — | 对未匹配适配器的绑定按方法计数（`kind: 'observed'`，永不拦截） |
| `count` | `(info) => void` | — | 每次真实调用后触发：`{binding, kind, method, used, limit, sql?/key?}` |
| `onExceeded` | `(info) => void` | — | 某绑定首次被拦截时触发（每请求每绑定一次） |
| `onRequestEnd` | `(summary) => void` | — | 请求结束触发：`{bindings:[{binding,kind,used,limit,blocked,onExceed}]}` |

`maxCalls: Infinity` 可关闭限制、仅保留计数。

### 扩展

适配器（adapter）决定一类绑定如何被探测、计数与拦截——D1/KV 只是两个内建条目。用 `defineAdapter` 注册更多：

```js
import { withBillingGuard, defineAdapter } from 'cf-billing-guard';

const r2 = defineAdapter({
  detect: (v) => typeof v.head === 'function' && typeof v.list === 'function',
  methods: ['get', 'put', 'head', 'delete', 'list'],
  neutral: (m) => (m === 'get' || m === 'head' ? null : m === 'list' ? { objects: [] } : undefined),
});

export default withBillingGuard(worker, {
  adapters: { r2 },   // kind 自动采用注册键名 → 策略写在 options.r2
  r2: { maxCalls: 50 },
});
```

完整适配器是普通的 `{ kind, detect(v), wrap(target, ledger, name) }`（`defineAdapter` 帮你生成的就是它）。自定义适配器**先于**内建匹配，因此也能覆盖 d1/kv。未匹配任何适配器的绑定原样透传；可用 `observe: true`（或 `observe: ['NAME']`）对其按方法计数——以 `kind: 'observed'` 上报，永不拦截。

### CLI 参考

```
cf-billing-guard enable  [--entry <path>] [--out <path>] [--config <path>]
                         [--import <specifier>] [--d1 <n>] [--kv <n>]
                         [--bindings <name,name>] [--on-exceed throw|empty] [--force] [--dry-run]
cf-billing-guard disable [--config <path>] [--out <path>] [--keep] [--dry-run]
```

## 边界

- 只管单请求次数——不做每日额度、不做 QPS。全局额度需要跨请求状态（Durable Objects），可将 Ledger 替换为 DO 代理实现。
- Durable Objects：`constructor(ctx, env)` 拿到的是原始 env，在 Worker 级包装之外——需用 `withBillingGuardDO` 逐类包装。CLI 生成的包装文件会原样转发原入口的命名导出（DO 绑定不受影响），但无法自动识别 DO 类。除 `fetch`/`alarm` 外的 class-RPC 方法、以及响应返回后才执行的回调（如 WebSocket 消息处理）沿用上一个调用的配额。
- 未配置 `bindings` 白名单时退回按方法签名探测（对真实 Cloudflare 绑定几乎不可能误判；用 `--bindings` 或 `bindings` 选项可显式固定名单）。
- `exec()` 含多条语句仍计 1 次（Cloudflare 也按一次 API 调用计费）。
- 未覆盖的方法默认透传不计数——包装不会破坏新 API。

## 许可证

[MIT](LICENSE)
