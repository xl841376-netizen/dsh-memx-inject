# dsh-memx-inject

DeepSeek Harness（DSH）插件：每轮自动把**本地记忆候选**推进模型上下文。设计目标是「便宜、准确、可定位」——不是又一个把所有历史倒进 prompt 的记忆插件。

> **免责声明（先说清楚）**：本插件按 MIT「AS IS」发布，**不保证可用性、正确性、兼容性或安全性**，不保证适用于任何特定场景，也不保证后续维护。它会读取你本机路径、会 spawn 子进程、会把候选文本注入模型上下文——**上线前请自行审计**。作者不对任何直接或间接损失负责。
>
> **已知行为：注入内容在 Web UI 中不可见。** 插件把消息标为 `role: "user"` + `source.kind`（非 `user`），DSH Web 客户端会把这类 user-role 注入统一归类为 `context` 节点，而 `isVisibleChatNode` 只放行含 `tool-addition` / `tool-removal` 的 context 节点。结果是：候选确实进入了模型请求和会话记录，但聊天区**一行都不会显示**（`skill-catalog`、`runtime-context` 等注入同理）。
>
> 这是客户端侧的分类规则，**不是本插件能控制的**，也无法通过插件配置关闭或开启。如果你需要可见性、审计或调试入口，得自己在客户端侧加渲染（例如替换 `conversation.chat.node` 的 `context` 渲染器，或在 `conversation.chat.turnTail` 追加一行回执）；那属于使用方的二次开发，不在本插件的承诺范围内。其他客户端（TUI、桌面端）的渲染行为**未经验证**。

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

### 接入条件（必须 / 禁止）

一个后端要能被这个插件接上，至少要满足以下几条——**不满足不会报错，只会静默不推**（fail-open 的代价）：

**必须**

| 条件 | 说明 |
|---|---|
| 单次调用的 stdout 是**恰好一个** JSON 对象 | 插件对 stdout 做整体 `JSON.parse`，不接受 NDJSON、不接受前后缀文本 |
| 完整退出在超时内 | 默认 `timeoutMs: 20000`；超时即 `kill` 并按“无结果”处理 |
| 正常退出码 | 非零退出视为失败，不会重试 |
| `id` 唯一且稳定 | 插件用它做**同会话去重**（同一 `id` 一轮后被记住不再推）。id 不稳定 → 同一内容反复推 |
| `v` 是数字 | `minScore` / `strongScore` / margin 判定都依赖它；缺 `v` 视为 0，会被过滤掉 |
| 编码 UTF-8 | 中文标题、`snip` 里的行号都一样 |

**禁止**

| 禁止项 | 后果 |
|---|---|
| 往 **stdout** 打日志、进度、警告 | JSON 解析失败 → 静默不推。所有诊断信息请走 **stderr**（插件不读 stderr） |
| 等待 stdin | 子进程的 stdin 是 `ignore`，等待会直接卡到超时 |
| 依赖交互式终端 / TTY | 无 TTY，颜色码、分页、光标控制都无意义 |
| 返回超过请求的 `k` 条 | 不报错，但会被截断，白算 |

### 参数含义

```bash
cli <query-text> <k>
```

- `query-text`：最近 **1–2 条真人消息**拼接（≤800 字），不是整段会话。
- `k`：插件请求的**上限**（= `topK + 2`），后端可以返回更少；返回 0 条是完全合法且常见的。
- 后端**不需要**做“推几条”的决策——那是插件的 `minScore` / `strongScore` / `minMargin` 和候选服务的分数形态共同决定的。后端只要给出**分数**，越能反映真实相关性越好。

### 最小可运行后端

后端只需要是**带 shebang 的可执行文件**（插件直接 `spawn` 它，不再包一层解释器），语言不限：

```bash
#!/usr/bin/env bash
# /tmp/mini-cand.sh —— 只回一条固定候选，用来证明协议通了
printf '{"memory":[{"id":"hello","t":"测试候选","v":0.9,"s":"ok"}],"pinned":[]}\n'
```

```bash
chmod +x /tmp/mini-cand.sh
```

```yaml
# cordis.patch.yml
- insert:
    - id: memx-inject
      name: '@local/memx-inject'
      config:
        cli: /tmp/mini-cand.sh
```

### 接入前先自检协议

不必先重启 DSH，直接按插件的方式调一次后端，验证 stdout 是合法单对象 JSON：

```bash
/path/to/your-cli "测试查询" 3 \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("ok memory=%d pinned=%d" % (len(d.get("memory",[])), len(d.get("pinned",[]))))'
```

打印 `ok memory=N pinned=M` 即协议通过。若报 `JSONDecodeError`，多半是后端往 **stdout** 打了日志（见上文禁止项）。

Web UI 中注入内容不可见（见文首声明），所以不要用“页面上有没有出现”来判断接入成功——用上面的自检，或直接查会话记录里的 `memory-candidates`。

### 扩展点

| 想扩展 | 怎么做 |
|---|---|
| 换记忆后端 | 实现上面的协议，改 `config.cli` |
| 自定义字段 | 后端多返回即可，插件忽略不认识的字段（`snip` 就是这类可选扩展） |
| 自定义召回算法 | 后端内部的事，插件不可见 |
| 换模型 | 无需改动——注入的是纯文本 |

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
