# dsh-memx-inject

DeepSeek Harness（DSH）插件：每轮自动把**本地记忆候选**推进模型上下文。设计目标是「便宜、准确、可定位」——不是又一个把所有历史倒进 prompt 的记忆插件。

> **免责声明（先说清楚）**：本插件按 MIT「AS IS」发布，**不保证可用性、正确性、兼容性或安全性**，不保证适用于任何特定场景，也不保证后续维护。它会读取你本机路径、会 spawn 子进程、会把候选文本注入模型上下文——**上线前请自行审计**。作者不对任何直接或间接损失负责。

## 它解决什么

大多数记忆插件的问题是「推得太多"或"推得太糙」：

- 推得太多 → 每轮上下文膨胀，且因为注入位置在前，**把前缀缓存整个顶掉**；
- 推得太糙 → 只给一个标题，模型还得去翻 1900 字的原文才知道该看哪段。

本插件针对这两点做了三件事，都有实测数据支撑（见下文）。

## 三个设计要点

### 1. 注入位置为缓存让路

DeepSeek 的上下文硬盘缓存规则是：**从第 0 个 token 开始相同**才算命中。命中价与未命中价差约 50 倍（`0.02` vs `1` 元/百万 token，见[官方说明](https://api-docs.deepseek.com/zh-cn/news/news0802)）。

所以注入**绝不能放在消息列表最前面**。本插件把候选插在「最新一条真人消息之前」：

```
system → 历史 → [memory-candidates] → 用户本轮输入
         ↑ 前缀稳定，全部命中
```

### 2. 条数按分数形态自适应，不设死值

固定 top-k 要么漏、要么灌垃圾。本插件依赖候选服务返回的分数形态，靠**断崖**决定给几条：同族问题给 8–10 条，单点问题给 1 条，无关问题给 0 条。插件侧只做上限兜底（默认 10）。

### 3. 块级定位，不只给标题

候选可以带 `snip` 字段，形如：

```
- [09-crux-gpu-patches] gpu fault patch wfi5 errata128 (v=0.58)
    › 2026-11-07 决定：非周期类 CCU fault 暂不处理 L135-L139
```

`›` 后面是「该文档里与当前问题最相似的块标题 + 行号」。模型可以直接 `read offset=135 limit=5` 精读，省掉「grep 定位 → 再读」那一轮。

**轮次才是成本单位**——每多一轮就要重发整个上下文。用 50 token 的 snippet 换掉 1–2 轮探索。

## 安装

```bash
# 1. 挂进某个 DSH profile
cd "$DSH_HOME/profiles/web"
mkdir -p node_modules/@local
ln -sfn /path/to/dsh-memx-inject node_modules/@local/memx-inject

# 2. package.json 的 dependencies 加一行
#    "@local/memx-inject": "link:/path/to/dsh-memx-inject"

# 3. cordis.patch.yml 插入
- insert:
    - id: memx-inject
      name: '@local/memx-inject'
      config:
        topK: 10
        minScore: 0.42
        strongScore: 0.45
        minMargin: 0.005
        maxChars: 1600
        timeoutMs: 20000
        cli: /opt/dsh-mcp/cand_cli.py
```

⚠️ **patch 的 config 优先级高于插件默认值**。改 `index.js` 里的默认数不生效，必须改 profile patch。

## 候选服务协议

插件本身不含记忆存储，它 spawn 一个 CLI 拿候选。该 CLI 需满足：

```bash
cli <query-text> <k>   # stdout 输出一行 JSON
```

```json
{
  "memory": [
    {"id": "09-crux-gpu-patches", "t": "gpu fault patch wfi5 errata128",
     "v": 0.58, "s": "ok", "o": "success", "e": "+2/-0",
     "snip": "2026-11-07 决定：非周期类 CCU fault 暂不处理 L135-L139"}
  ],
  "pinned": [
    {"id": "79-zh-reasoning", "t": "硬性约定：reasoning 用简体中文"}
  ]
}
```

字段含义：

| 字段 | 含义 |
|---|---|
| `id` | 记忆条目标识 |
| `t` | 一行标题（限 24 字以内最佳） |
| `v` | 相关度分数（插件用 `minScore`/`strongScore` 过滤） |
| `s` | 状态：`ok` / `refuted`（渲染为 `!`）/ `uncertain`（`?`） |
| `o` | 结果：`success`（`+`）/ `failure`（`×`） |
| `e` | 证据计数，如 `+2/-0` |
| `snip` | 可选，块级定位行（建议带 `Lxx-Lyy` 行号） |
| `pinned` | 命中关键词就无条件推送的条目（绕过分数门槛） |

协议缺失时插件 fail-open：任何异常/超时都原样放行，绝不影响正常对话。

## 隐私提醒

- 注入内容会随对话进入模型请求，**不要**让候选服务返回密钥、令牌、个人信息。
- 插件会 spawn 你配置的命令，只指向你信任的可执行文件。

## 实测数据（本机参考值，不构成承诺）

同一批 16 条评测 query（14 正 + 2 负）：

| 方案 | Precision | Recall | nDCG |
|---|---|---|---|
| 固定 top-2 | 0.838 | 0.626 | 0.693 |
| 自适应条数 | 0.581 | 0.914 | 0.868 |

Recall 从 0.63 提到 0.91 的代价是 Precision 降到 0.58——这是「要全不要精」的取舍，可按需调 `minScore` 反向调节。

## License

MIT，见 [LICENSE](./LICENSE)。
