/**
 * memx-inject —— 每轮第一步自动把 memx 的记忆候选推给模型。
 *
 * 机制：监听 agent/pre-step，用用户这句消息去问 memcand（本地向量，零 API），
 * 命中就把候选拼成一条 user 消息插到这一步的消息最前面。
 * 任何异常/超时都原样放行（fail-open），绝不影响正常对话。
 */
import { spawn } from 'node:child_process';

export const name = 'memx-inject';
// 服务名是 agentLoop（dsh-agent-loop: super(ctx,"agentLoop")）；
// 之前写 'agent' → 插件永远 pending（日志 waiting for service: agent）。
export const inject = ['agentLoop'];

// 候选服务 CLI：需实现 `cand_cli <query> <k>` 并输出 {memory:[{id,t,v,snip?}], pinned:[{id,t}]}
// 默认值是本机路径，部署时用 config.cli 覆盖。
const DEFAULT_CLI = '/opt/dsh-mcp/cand_cli.py';

function runCandidates(text, k, timeoutMs, cli) {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    let child;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      try { child?.kill('SIGKILL'); } catch {}
      resolve(v);
    };
    try {
      // 直接执行 cli（不再包一层 python3）：后端可以是任何带 shebang 的可执行文件
      child = spawn(cli, [text, String(k)], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try { finish(JSON.parse(out)); } catch { finish(null); }
    });
  });
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  // 2026-11-09：topK 2→10。旧值让 memcand 已算好的同族条目在最后一层被砍掉
  // （实测 npu 族前 12 条分数连续 0.682→0.539，全是有用的）。真正决定"推几条"
  // 的是 memcand 里的自适应断崖截断，这里只做上限兜底。
  const cli = config.cli || process.env.MEMX_CAND_CLI || DEFAULT_CLI;
  const topK = config.topK ?? 10;
  const timeoutMs = config.timeoutMs ?? 6000;
  const minScore = config.minScore ?? 0.42;
  const strongScore = config.strongScore ?? 0.45;
  const maxChars = config.maxChars ?? 1600;  // 加了块级 snippet 行，正文上限放宽
  const minMargin = config.minMargin ?? 0.005;
  // 每个会话推过哪些条目：推过的不再重复，避免“我知道的事还来提醒我”
  const pushed = new Map();

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const base = await next();
      if (!enabled || !base || base.kind !== 'enter') return base;
      if (payload.step !== 1) return base;
      try {
        // 只用「最近一条/两条真人消息」做查询向量。
        // 旧实现把整段 messages 拼起来取前 800 字 = 会话开场白，后面换话题永远命不中。
        const msgs = payload.messages || [];
        const human = msgs.filter((m) => m.role === 'user' && (!m.source || m.source.kind === 'user'));
        const textOf = (m) => (typeof m.content === 'string' ? m.content
          : (m.content || []).map((c) => c.text || '').join(''));
        const text = (human.length ? human.slice(-2) : msgs.slice(-2))
          .map(textOf).join('\n').trim().slice(0, 800);
        if (text.length < 4) return base;
        const sid = payload.agent?.session?.id ?? 'default';
        const seen = pushed.get(sid) || new Set();
        const res = await runCandidates(text, topK + 2, timeoutMs, cli);
        const mem = (res && res.memory) || [];
        // pinned：记忆里带 `> pin:` 且关键词命中 → 无条件推送，绕过分数/名次/去重
        const pins = ((res && res.pinned) || []).filter((p) => !text.includes(p.id));
        // 候选必须：分数够高、和当前消息里已提到的不重复、以前没推过
        const fresh = mem.filter((m) =>
          (m.v ?? 0) >= minScore && !seen.has(m.id) && !text.includes(m.id));
        // 名次要区分度：top1 与 top2 差距太小时说明语义不聚焦，不打扰；
        // 但 top1 本身够强（>= strongScore）时放行 —— 内核/驱动类问题常是
        // 三五条同分条目挤在一起，旧逻辑在这里静默不推，正好漏掉仓库地图。
        const margin = fresh.length >= 2 ? (fresh[0].v - fresh[1].v) : 1;
        const confident = fresh.length > 0 && fresh[0].v >= strongScore;
        // 只有 1 条命中时没有“名次”可比，要求它本身够强，否则就是弱噪声
        const ok = fresh.length === 1 ? confident : (margin >= minMargin || confident);
        const hits = (fresh.length && ok) ? fresh.slice(0, topK) : [];
        if (!hits.length && !pins.length) return base;
        for (const m of hits) seen.add(m.id);
        pushed.set(sid, seen);
        // 状态标记只用 1 个 ASCII 字符（! 已证伪 / ? 存疑），图例只在真出现时加一次
        const marks = { refuted: '!', uncertain: '?', set: '!' };
        const omarks = { success: '+', failure: '×' };
        const pinLines = pins.map((p) => `- ★[${p.id}] ${String(p.t || '').slice(0, 80)}`);
        const hitLines = hits.map((m) => {
          const st = marks[m.s] ? marks[m.s] : '';
          const oc = omarks[m.o] ? omarks[m.o] : '';
          const tag = (st + oc) ? st + oc + ' ' : '';
          const ev = m.e ? ` e=${m.e}` : '';
          const head = `- ${tag}[${m.id}] ${m.t || ''} (v=${m.v}${ev})`;
          // 块级定位：只给"这段在回答什么"，不再让我去读整条 1900 字。
          // 空 snip 不占行（短条目或首行是残句时宁可省略）。
          return m.snip ? `${head}\n    › ${m.snip}` : head;
        });
        const needLegend = pins.length > 0 || hits.some((m) => m.s === 'refuted' || m.s === 'uncertain' || m.s === 'set' || m.o);
        const legend = needLegend
          ? '（★=本地事实/长期约定；+ 已验证有效；× 失败原因别重走；! 已证伪；? 待复核；e=证据累计）'
          : '';
        // 按条目整行累积，超预算就停 —— 旧的 body.slice(0,maxChars) 会把最后一条
        // 切成半行（实测截在 "- [41-crux-firmware-services] firmware s"）。
        const open = `<memory-candidates>memx 自动推送，非用户输入${legend}\n`;
        const close = '</memory-candidates>';
        let body = open;
        for (const r of [...pinLines, ...hitLines]) {
          if ((body.length + r.length + close.length) > maxChars) break;
          body += r + '\n';
        }
        body += close;
        // 隐藏的关键：source.kind 绝不能是 'user'。
        // 客户端 dsh-client-ui-chat 的 messageDefinition 把 source.kind !== 'user'
        // 的注入消息归成 "context" 节点，而 isVisibleChatNode() 只在 context 节点
        // 含 tool-addition/tool-removal 时才渲染 —— 所以这种消息进 session、
        // 进模型请求，但聊天区一行都不出现（skill-catalog / runtime-context 同理）。
        const msg = {
          id: `memc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: body.slice(0, maxChars) }],
          source: {
            kind: 'memory-candidates',
            form: 'notice',
            summary: `memx: ${hits.length} 条候选${pins.length ? ` + ${pins.length} pinned` : ''}`,
          },
        };
        // 注入位置决定缓存命中率（2026-11-09 大修）：
        // 官方硬盘缓存规则是「从第 0 个 token 开始相同」才算重复，命中 0.02 元/M、
        // 未命中 1 元/M（差 50 倍）。旧代码 `[msg, ...base.messages]` 把每轮都变的
        // 候选塞到最前面 → 第 0 个 token 就变 → 整个前缀缓存全废，等于每轮按 1 元计。
        // 改为插在「最新一条真人消息之前」：系统+工具+历史前缀稳定，只有末尾新增
        // 几百 token 未命中；下一轮的前缀又包含这条，继续命中。
        const arr = base.messages || [];
        let at = arr.length;
        for (let i = arr.length - 1; i >= 0; i--) {
          const m2 = arr[i];
          if (m2 && m2.role === 'user' && (!m2.source || m2.source.kind === 'user')) { at = i; break; }
        }
        return { ...base, messages: [...arr.slice(0, at), msg, ...arr.slice(at)] };
      } catch (e) {
        if (process.env.MEMX_DEBUG) console.error('[memx-inject] err:', e && e.message);
        return base;
      }
    });
    return () => { try { off(); } catch {} };
  }, 'memx-inject lifecycle');
}
