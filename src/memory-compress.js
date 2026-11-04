// memory-compress.js —— 把一段对话压成"可检索的摘要"，写进长期记忆库。
//
// ## 为什么需要调模型
//
// 抽取式标题（取块内得分最高那句）只能得到"他说想辞职"这种没头没尾的碎片，
// 她浏览记忆索引时判断不出该不该点开；生成式摘要能带上因果和上下文：
//   「主人被领导连续批评后想辞职，她劝他先忍两周再看看」
//
// ## 三条铁律
//
// 1. **直连 API，绝不走她自己的会话** —— 否则摘要任务进了她的上下文，
//    越压越长，还污染对话历史（这与"省上下文"目的直接矛盾）。
// 2. **原文永远保留** —— 摘要只是索引，真相在 memory/*.jsonl 里；
//    摘要失败/失真都不影响检索（检索扫原文）。
// 3. **失败必须降级** —— 没 key、超时、限流、模型抽风，都要退化成抽取式，
//    绝不能因为压缩失败把记忆弄丢。
import fs from 'node:fs'
import path from 'node:path'
import { scoreImportance } from './memory-store.js'

/** 默认模型：压缩是机械活，用便宜快的，不用推理模型。 */
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_BASE = 'https://api.deepseek.com'

/** 压缩用的系统提示：只准依据给定消息，不许推断。 */
/**
 * 压缩用的系统提示。
 *
 * 用户 2026-11-04 的要求：把「压缩原则 / 压缩目的 / agent 身份」都写进第一 prompt，
 * 让归档器知道自己在为谁归档、为什么要压、压的时候绝不能丢什么。
 * 四段：身份 → 目的 → 原则 → 输出格式。
 */
const SYSTEM_PROMPT = [
  '# 你是谁',
  '你是「小鲸鱼」的记忆归档员。小鲸鱼是住在主人电脑桌面上的 DeepSeek 鲸鱼娘：',
  '傲娇、嘴硬、心软、说话短、不爱客服腔。她有一个长期记忆库，用来记住聊过的人、事、约定。',
  '你读到的聊天记录就是她的亲身经历——记录里的"我（小鲸鱼）"是她本人，其他名字是跟她说话的人。',
  '',
  '# 为什么要压缩',
  '她的上下文窗口有限。对话变长时，更早的内容必须折叠成简短索引，否则她会被迫忘掉一切。',
  '压缩产物会进她的记忆索引：她以后只看到你写的这一行标题和一段摘要，来决定"要不要去翻原文"。',
  '所以摘要唯一的任务是：让她日后一眼判断"这段值不值得点开"，点开能靠原文找回细节。',
  '',
  '# 压缩原则（违反即失败）',
  '1. 只依据给定记录。不许编造记录里没出现的人、事、时间、因果；记录里没说的，摘要里也不能有。',
  '2. 必须保留：谁说的（人名）；发生了什么；约定与承诺（谁答应了什么、什么时候）；',
  '   情绪与态度（开心/生气/累/委屈）；她自己的立场与反应（答应了/拒绝了/嘴硬了）。',
  '3. 可以丢：纯寒暄、表情占位（[图片][表情]）、重复语气词、"哈哈哈"这类无信息量往来。',
  '4. 用她的视角写，但第三人称叙述：写"主人说…她回了…"，不要写"我说…你说了…"。',
  '5. 约定必须显式标出：出现答应、约好、说定了、承诺时，摘要要写明"约定了什么、什么时候"。',
  '6. 标题要能独立看懂：不要"聊了会儿天"这种空话，要"主人被连批后想辞职，她劝他先忍两周"这种。',
  '',
  '# 输出格式',
  '严格输出 JSON，不要代码块、不要解释、不要多余文字：',
  '{"title":"不超过30字的标题","summary":"80~150字，说清谁、发生了什么、态度/约定","tags":["人名或主题，最多4个"],"importance":0.0到1.0}',
  '',
  'importance 判据：涉及主人的私事/情绪/约定 → 高（0.7~0.95）；有具体人和事 → 中（0.4~0.7）；',
  '寒暄打趣、没有后续价值 → 低（0.1~0.3）。',
].join(String.fromCharCode(10))

/** 从一段对话里抽出"谁的、说了什么"的纯文本行。 */
export function chunkToText(messages, options = {}) {
  const limit = Number(options.maxChars) || 1200
  const lines = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue
    const who = m.isSelf ? '我（小鲸鱼）' : (m.sender || '对方')
    const text = String(m.plain ?? m.text ?? m.tail ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`${who}：${text}`)
  }
  // 太长就只保留最后一段（最近的更重要），并在开头标明截断
  let text = lines.join('\n')
  if (text.length > limit) {
    text = `（更早的内容已省略）\n${text.slice(-limit)}`
  }
  return text
}

/** 抽取式降级：拿不到模型结果时用。返回和模型一致的形状。 */
export function extractiveSummary(messages) {
  const rows = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && String(m.plain ?? m.text ?? '').trim())
    .map((m) => ({
      text: String(m.plain ?? m.text ?? '').replace(/\s+/g, ' ').trim(),
      isSelf: !!m.isSelf,
      sender: String(m.sender ?? ''),
    }))
  if (!rows.length) return { title: '', summary: '', tags: [], importance: 0.3, by: 'extractive' }

  // 标题：优先取"对方说的、最长的一句"（通常信息量最大）
  const others = rows.filter((r) => !r.isSelf)
  const pool = others.length ? others : rows

  /** 过滤掉不像人话的串：纯十六进制、纯符号、含 [图片] 这类占位。 */
  const looksLikeJunk = (s) => {
    const t = String(s ?? '').trim()
    if (!t) return true
    if (/^[0-9A-Fa-f\s]+$/.test(t)) return true                  // "E6 88 91 …"
    if (/^[\[\]（）().,，。！？!?\s\d]+$/.test(t)) return true     // 纯符号数字
    if (/^\[(图片|表情|语音|视频|文件)\]$/.test(t)) return true
    if (!/[\u4e00-\u9fff]/.test(t)) return true                  // 没中文基本没信息
    return false
  }

  const scored = pool
    .filter((r) => !looksLikeJunk(r.text))
    .map((r) => ({
      r,
      score: r.text.length
        + (/[0-9０-９]|明天|后天|下周|约|答应|记住|别忘|辞职|累|生气|开心/.test(r.text) ? 20 : 0),
    }))
    .sort((a, b) => b.score - a.score)
  const title = (scored[0]?.r.text ?? pool[0]?.text ?? '').slice(0, 30)

  // 摘要：取前几句拼接（不调模型时只能这样），同样过滤垃圾行
  const summary = rows
    .filter((r) => !looksLikeJunk(r.text))
    .slice(-6)
    .map((r) => `${r.isSelf ? '我' : (r.sender || '对方')}说「${r.text.slice(0, 40)}」`)
    .join('；')
    .slice(0, 150)

  // 标签：出现最多的人名/主题词（粗切），并过滤废词
  const counts = new Map()
  const STOP = /^(他说|我说|就是|这个|那个|什么|我们|你们|他们|图片|表情|一个|可以|不是|没有|这么|那么)$/
  for (const r of rows) {
    for (const m of r.text.matchAll(/[\u4e00-\u9fff]{2,3}/g)) {
      if (STOP.test(m[0])) continue
      counts.set(m[0], (counts.get(m[0]) || 0) + 1)
    }
  }
  const tags = [...counts.entries()]
    .filter(([w, n]) => n >= 2 && !STOP.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)

  return { title, summary, tags, importance: 0.5, by: 'extractive' }
}

/**
 * 合并"模型给的重要性"与"我们的启发式重要性"。
 *
 * 用户 2026-11-04 定：**两者取更高的那个**。
 * 理由：模型擅长语义理解（"这件事对他很重要"），启发式擅长抓硬信号（约定词、
 * owner 私聊、情绪词）。任一认为重要就算重要，别让一方的误判把重要记忆压掉。
 *
 * 另外**钉住优先于分数**：只要命中"说好了/答应/记住"，就 pinned，
 * 不管模型给多少分（实测模型会给"约定"只打 0.4）。
 */
export function mergeImportance(modelImportance, heuristic) {
  const model = Number(modelImportance)
  const heur = Number(heuristic?.importance ?? 0)
  const importance = Math.max(Number.isFinite(model) ? model : 0, heur)
  return {
    importance: Math.max(0, Math.min(1, Number(importance.toFixed(2)))),
    pinned: heuristic?.pinned === true,
    pinnedReason: heuristic?.pinnedReason ?? '',
  }
}

/** 从 JSON 文本里尽量抠出对象（模型偶尔会包代码块）。 */
function parseLooseJson(text) {
  const raw = String(text ?? '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(cleaned) } catch { /* 继续尝试 */ }
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)) } catch { /* 放弃 */ }
  }
  return null
}

export function createMemoryCompressor(options = {}) {
  const apiKey = String(options.apiKey ?? '').trim()
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const model = String(options.model ?? DEFAULT_MODEL)
  const timeoutMs = Number(options.timeoutMs) || 45000
  const log = typeof options.log === 'function' ? options.log : () => {}
  const maxPerDay = Number(options.maxPerDay) || 0
  const stateFile = String(options.stateFile ?? '').trim()

  let usedToday = 0
  let usedDay = ''

  function today() {
    return new Date().toISOString().slice(0, 10)
  }

  function loadQuota() {
    if (!stateFile) return
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''))
      usedDay = String(raw?.day ?? '')
      usedToday = usedDay === today() ? Number(raw.used) || 0 : 0
    } catch { /* 没有就用默认 */ }
  }

  function saveQuota() {
    if (!stateFile) return
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true })
      fs.writeFileSync(stateFile, JSON.stringify({ day: usedDay, used: usedToday }), 'utf8')
    } catch { /* 配额记录失败不影响主流程 */ }
  }

  loadQuota()

  function quotaLeft() {
    if (usedDay !== today()) { usedDay = today(); usedToday = 0 }
    if (!maxPerDay) return Infinity
    return Math.max(0, maxPerDay - usedToday)
  }

  async function callModel(text) {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `聊天记录：\n${text}` },
        ],
        temperature: 0.3,
        max_tokens: 1200,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${detail.slice(0, 120)}`)
    }
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content ?? ''
    return { content, usage: data?.usage ?? null }
  }

  /**
   * 压缩一段对话。
   *
   * @returns {{ok:boolean, title:string, summary:string, tags:string[], importance:number, by:string, error?:string}}
   *   `by`: 'model' | 'extractive'
   *   永远不会抛：模型不可用就降级抽取式。
   */
  async function summarize(messages, opts = {}) {
    const text = chunkToText(messages, { maxChars: opts.maxChars })
    if (!text.trim()) {
      return { ok: false, title: '', summary: '', tags: [], importance: 0, by: 'empty', error: '没有可压缩的内容' }
    }

    if (!apiKey) {
      const ex = extractiveSummary(messages)
      return { ok: true, ...ex, error: '未配置 API key（降级为抽取式）' }
    }
    if (quotaLeft() <= 0) {
      const ex = extractiveSummary(messages)
      return { ok: true, ...ex, error: '今日压缩次数已用完（降级为抽取式）' }
    }

    try {
      usedToday += 1
      saveQuota()
      const { content } = await callModel(text)
      const parsed = parseLooseJson(content)
      if (!parsed || !parsed.title) throw new Error('模型返回无法解析为 JSON')
      // 重要性：模型分 vs 我们的启发式，**取更高的那个**（用户要求）；
      // 钉住判定永远优先（约定/她说要记/被要求记）。
      const heuristic = scoreImportance(`${parsed.title ?? ''} ${parsed.summary ?? ''} ${(parsed.tags ?? []).join(' ')}`, {
        fromOwner: opts.fromOwner === true,
      })
      const merged = mergeImportance(parsed.importance, heuristic)
      return {
        ok: true,
        title: String(parsed.title).slice(0, 40),
        summary: String(parsed.summary ?? '').slice(0, 300),
        tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 4) : [],
        importance: merged.importance,
        pinned: merged.pinned,
        pinnedReason: merged.pinnedReason,
        modelImportance: Number.isFinite(Number(parsed.importance)) ? Number(parsed.importance) : null,
        by: 'model',
      }
    } catch (error) {
      log(`压缩摘要失败（降级抽取式）: ${error?.message ?? error}`);
      const ex = extractiveSummary(messages)
      return { ok: true, ...ex, error: String(error?.message ?? error) }
    }
  }

  return {
    summarize,
    extractiveSummary,
    quotaLeft,
    get usingModel() { return Boolean(apiKey) },
  }
}
