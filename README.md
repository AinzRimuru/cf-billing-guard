# cf-billing-guard

Cloudflare Workers **单请求 D1/KV 调用上限守卫** —— 对 D1 / KV 绑定在单个请求内的调用次数设上限（如 100 次），
防止失控循环 / 递归 / 恶意请求打爆你的 Cloudflare 账单。

对业务代码**零侵入**：业务文件一行不改，只需在入口处包一层（`npx cf-billing-guard enable` 自动完成）。

```js
import worker from './index.js';                 // 你原有的 Worker，零改动
import { withBillingGuard } from 'cf-billing-guard';

export default withBillingGuard(worker, {
  d1: { maxCalls: 100 },   // 每请求 D1 调用上限
  kv: { maxCalls: 100 },   // 每请求 KV 调用上限
});
```

## 安装

```bash
npm i -D cf-billing-guard
```

## 接入（零改动业务代码）

### 方式一：CLI 自动接线（推荐）

```bash
npx cf-billing-guard enable                 # 一键接线
npx cf-billing-guard enable --d1 50 --kv 20 --on-exceed empty
npx cf-billing-guard enable --dry-run       # 预览改动不落盘
npx cf-billing-guard disable                # 回滚，业务零残留
```

CLI 会自动：

1. 从 `wrangler.jsonc` / `wrangler.json` / `wrangler.toml` 读取当前 `main`（原入口）；
2. 在原入口同目录生成包装入口 `billing-guard.main.js`（含回滚标记，重复执行幂等）；
3. **外科手术式**只改配置里 `main` 那一行（注释/顺序/其余配置原样保留），改完自检仍是合法 JSON(C)；
4. `disable` 从包装文件的 `cf-billing-guard:entry=` 标记读回原入口并恢复、删除生成文件。

### 方式二：手工包装入口（CLI 干的事等价于这个）

见本文开头示例，再把 `wrangler` 配置的 `main` 指向该入口文件。
**回滚 = main 改回原入口**，业务无感知。

## 工作原理

```
请求 ──▶ withBillingGuard(worker).fetch
           ├─ 新建请求级 Ledger（各绑定计数=0）
           ├─ instrumentEnv(env) ── Proxy 包装 env
           │     env.DB  ─▶ wrapD1(db, ledger)   Proxy
           │     env.KV  ─▶ wrapKV(ns, ledger)   Proxy
           └─ worker.fetch(request, 包装后env, ctx)   ← 业务照常 env.DB.prepare(...)
```

- 绑定探测：`prepare+batch+exec` → D1；`get+put+getWithMetadata` → KV。
  也可用 `options.bindings` 显式白名单（配置后仅包装列出的名字）。
- 每请求新建包装（不跨请求复用），计数天然隔离、精确（无 isolate 分布式近似问题）。
- 幂等：重复包装（`Symbol.for('cf-billing-guard.wrapped')` 标记）不会重复计数。

## 计数口径（1 次 = 1 次真实执行）

| 绑定 | 调用 | 计数 |
|---|---|---|
| D1 | `prepare().bind()` 未执行 | 0 |
| D1 | `first() / all() / run() / raw() / values()` | 1 |
| D1 | `batch([s1..sN])` | N（按语句数，整批放行或整批拦截） |
| D1 | `exec(sql)` | 1 |
| D1 | `withSession(fn)` 内的调用 | 经包装 session 正常逐条计数 |
| KV | `get / getWithMetadata / put / delete / list` | 1 |

## 拦截语义（`onExceed`）

关键约束：**绝不同步 throw**。所有拦截都以 Promise rejection 或返回值出现，
否则 `env.DB.prepare(...).bind(...).run().catch(()=>{})` 会在 `.catch` 挂上前崩溃。

| 模式 | D1 行为 | KV 行为 | 适用 |
|---|---|---|---|
| `'throw'`（默认） | 终结方法返回 rejected Promise（`BillingGuardError`） | 同左 | 业务已有 try/catch 或 `.catch()` 降级（D1 失败→回退旧路径） |
| `'empty'` | 返回同构空结果：`all()`→`{results:[],success:true}`、`first()`→`null`、`run()`→`{success:true,meta:0行}`、`raw()`→`[]`、`batch()`→逐条空结果 | `get`→`null`（等价缓存未命中）、`list`→`{keys:[],list_complete:true}`、`put/delete`→`undefined` | 业务把"查不到"当正常路径（缓存类场景最自然） |

batch 整批计数、整批拦截，**不做半量执行**，避免与 D1 batch 的原子性语义冲突。

## API

### `withBillingGuard(worker, options?) → worker`

包装 Worker 入口（`fetch` 必有；`scheduled/queue/test/email/tail` 存在则透传并同样注入包装 env）。

**options**

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `defaults` | `{maxCalls?, onExceed?}` | `{100, 'throw'}` | 兜底策略 |
| `d1` / `kv` | 同上 | — | 按绑定类型覆盖 |
| `bindings` | `{[name]: 同上}` | — | 按绑定名覆盖（优先级最高），且充当白名单 |
| `count` | `(info) => void` | — | 每次真实调用后触发：`{binding, kind, method, used, limit, sql?/key?}` |
| `onExceeded` | `(info) => void` | — | 某绑定**首次**超限时触发（每请求每绑定一次）：`{binding, kind, method, used, limit}` |
| `onRequestEnd` | `(summary) => void` | — | 请求结束触发：`{bindings:[{binding,kind,used,limit,blocked,onExceed}]}` |

`maxCalls: Infinity` 可单独关闭某类限制（仅保留统计）。

### 其余导出

- `instrumentEnv(env, ledger)`：单独使用（如自建入口、测试）。
- `wrapD1(db, ledger, name)` / `wrapKV(ns, ledger, name)`：直接包装绑定对象。
- `Ledger` / `BillingGuardError`：`error.binding / kind / used / limit` 可用于上层识别。

### CLI 参数

```
cf-billing-guard enable  [--entry <path>] [--out <path>] [--config <path>]
                         [--import <specifier>] [--d1 <n>] [--kv <n>]
                         [--on-exceed throw|empty] [--force] [--dry-run]
cf-billing-guard disable [--config <path>] [--out <path>] [--keep] [--dry-run]
```

## 已知边界与扩展方向

- **只管单请求次数**：不做每日全局额度、不做 QPS。若将来需要全局额度，
  需引入跨请求状态（Durable Object），可在此结构上把 Ledger 的实现替换为 DO 代理。
- **探测式识别绑定**：按方法签名判断 D1/KV；极小概率误判时用 `bindings` 白名单显式指定。
- `exec()` 含多条语句时仍记 1 次（Cloudflare 也按一次 API 调用计）。
- 未覆盖的 D1/KV 方法（如新 API）默认**透传不计数**，不会因包装而损坏。

## 开发与发布

```bash
npm test    # 22 个用例：计数口径 / 两种拦截 / 回调 / 请求隔离 / 业务降级集成 / CLI enable·disable
```

发布走 GitHub Actions（`.github/workflows/publish.yml`）：

1. 改 `package.json` 的 `version` → 提交 → push；
2. 在 GitHub 上创建 Release，tag 为 `vX.Y.Z`（与版本一致，workflow 会校验）；
3. Release 发布后自动：测试 → 版本校验 → `npm publish --provenance`。

CI（push / PR）在 Node 18/20/22/24 矩阵上跑全量测试。
## License

MIT
