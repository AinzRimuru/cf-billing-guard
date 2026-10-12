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

## 计数口径

一次调用 = 一次真实执行。

| 绑定 | 调用 | 计数 |
|---|---|---|
| D1 | `prepare().bind()` 未执行 | 0 |
| D1 | `first() / all() / run() / raw() / values()` | 1 |
| D1 | `batch([s1..sN])` | N（整批放行或整批拦截） |
| D1 | `exec(sql)` | 1 |
| D1 | `withSession(fn)` | 经包装 session 正常计数 |
| KV | `get / getWithMetadata / put / delete / list` | 1 |

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
| `count` | `(info) => void` | — | 每次真实调用后触发：`{binding, kind, method, used, limit, sql?/key?}` |
| `onExceeded` | `(info) => void` | — | 某绑定首次被拦截时触发（每请求每绑定一次） |
| `onRequestEnd` | `(summary) => void` | — | 请求结束触发：`{bindings:[{binding,kind,used,limit,blocked,onExceed}]}` |

`maxCalls: Infinity` 可关闭限制、仅保留计数。

### 其余导出

- `instrumentEnv(env, ledger)`——用于自建入口或测试。
- `withBillingGuardDO(DOClass, options?)`——包装 Durable Object 类。runtime 实例化导出的 DO 类时给的是**原始 env**，Worker 级包装看不到；此包装器会接管构造函数的 env（构造时捕获的 `this.db = env.DB` 也会被计数），且每次入站 `fetch()` / `alarm()` 独立配额。
- `wrapD1(db, ledger, name)` / `wrapKV(ns, ledger, name)`——直接包装单个绑定。
- `Ledger`、`BillingGuardError`——`error.binding / kind / used / limit` 可供上层识别。

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

## 开发

```bash
npm test   # 22 个用例：计数口径、两种拦截模式、回调、请求隔离、业务降级、CLI
```

发布由 GitHub Actions 在创建 GitHub Release 时自动完成（`.github/workflows/publish.yml`），采用 [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)（OIDC）——无需在 Secrets 里存长期 npm token，provenance 溯源凭证自动生成。CI 在 Node 18/20/22/24 矩阵上运行测试。

## 许可证

[MIT](LICENSE)
