// rebuild-memory.mjs —— 把某会话的完整原文压进记忆库（手动补压用）。
//
// 场景：压缩流程出过问题、或者想对历史消息重新压一遍时用。
// 它做四件事：
//   1. 从 state/social-v2.json 读该会话的全部 recentMessages（原文）
//   2. 按「12 条 / 1200 字」切块（与桥接内一致）
//   3. 逐块调模型压成摘要，写进 memory/（重要性与钉住由 memory-store 自己算）
//   4. 生成接力卡，供重建会话时注入
//
// 用法：
//   node scripts/rebuild-memory.mjs --key private:<主人QQ>
//   node scripts/rebuild-memory.mjs --key private:<主人QQ> --dry
//
// 注意：会**追加**写入记忆库（不是清空重写）。要重新开始就先手动清 index.json。
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createMemoryCompressor } from '../src/memory-compress.js'
import { createMemoryStore } from '../src/memory-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const STATE_FILE = path.join(REPO_ROOT, 'state', 'social-v2.json')
const CARRY_FILE = path.join(REPO_ROOT, 'state', 'session-carryover.json')
const CONFIG_FILE = path.join(REPO_ROOT, 'config.json')

function argOf(flag, fallback) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const hasFlag = (f) => process.argv.includes(f)

const key = argOf('--key', process.env.QQ_OWNER_KEY || 'private:<主人QQ>')
const dry = hasFlag('--dry')
const maxPerChunk = Number(argOf('--chunk', '12'))
const maxChars = Number(argOf('--chars', '1200'))

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const cc = cfg.memoryCompress ?? {}
if (!cc.apiKey) {
  console.error('❌ config.json 的 memoryCompress.apiKey 为空，无法调用模型')
  process.exit(1)
}

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
const conv = state?.conversations?.[key]
if (!conv) {
  console.error(`找不到会话 ${key}`)
  process.exit(1)
}
const messages = Array.isArray(conv.recentMessages) ? conv.recentMessages : []
console.log(`[重建] ${key}：原文 ${messages.length} 条`)

// ── 切块（与桥接内 chunkByTopic 同规则，另加条数/字数上限）──
function chunk(list) {
  const out = []
  let cur = []
  let curChars = 0
  let prevAt = 0
  let prevSender = ''
  for (const m of list) {
    const at = Number(m?.time) || 0
    const sender = String(m?.sender ?? '')
    const gap = prevAt && at - prevAt > 10 * 60 * 1000
    const changed = prevSender && sender && sender !== prevSender && !m?.isSelf
    const len = String(m?.plain ?? m?.text ?? '').length
    if (cur.length && (gap || (changed && cur.length >= 6) || cur.length >= maxPerChunk || curChars + len > maxChars)) {
      out.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(m)
    curChars += len
    prevAt = at || prevAt
    if (!m?.isSelf && sender) prevSender = sender
  }
  if (cur.length) out.push(cur)
  return out
}

const chunks = chunk(messages)
console.log(`[重建] 切成 ${chunks.length} 块（每块 ≤${maxPerChunk} 条 / ≤${maxChars} 字）`)

const compressor = createMemoryCompressor({
  apiKey: cc.apiKey,
  baseUrl: cc.baseUrl,
  model: cc.model,
  timeoutMs: cc.timeoutMs ?? 45000,
  maxPerDay: 0, // 手工补压不限配额
  log: (line) => console.log(`  · ${line}`),
})

const store = createMemoryStore({
  dir: path.join(REPO_ROOT, 'memory'),
  ownerQQ: cfg.ownerQQ,
  ownerAliases: cfg.ownerQQAliases ?? [],
})

const summaries = []
const written = []
for (const [i, c] of chunks.entries()) {
  const first = String(c[0]?.plain ?? c[0]?.text ?? '').slice(0, 26)
  const last = String(c[c.length - 1]?.plain ?? c[c.length - 1]?.text ?? '').slice(0, 26)
  process.stdout.write(`  [${i + 1}/${chunks.length}] ${c.length} 条（${first}… → …${last}）`)
  const r = await compressor.summarize(c, { fromOwner: key === `private:${cfg.ownerQQ}` })
  if (!r.ok) {
    console.log(' ❌ 跳过（无内容）')
    continue
  }
  console.log(`\n      标题：${r.title}`)
  console.log(`      重要性：${r.importance}${r.pinned ? '（钉住）' : ''}  来源：${r.by}`)
  if (r.by !== 'model') {
    console.log(`      ⚠️ 模型降级：${r.error ?? ''}`)
  }
  summaries.push({ title: r.title, summary: r.summary, by: r.by, at: Date.now() })
  if (!dry) {
    const w = store.write({
      key,
      text: r.summary || r.title,
      kind: r.pinned ? 'agreement' : 'event',
      tags: r.tags,
      importance: r.importance,
      pinned: r.pinned === true,
      src: 'rebuild',
    })
    if (w.ok) written.push(w.record)
    else console.log(`      写入失败：${w.error}`)
  }
}

console.log(`\n[重建] 完成：${written.length} 条已写入${dry ? '（dry：未写入）' : ''}`)

// ── 接力卡 ──
if (!dry && summaries.length) {
  const recentLines = messages.slice(-20).map((m) => {
    const who = m.isSelf ? '你' : (m.sender || '对方')
    return `${who}：${String(m.plain ?? m.text ?? '').slice(0, 60)}`
  }).filter(Boolean)
  const carry = fs.existsSync(CARRY_FILE) ? JSON.parse(fs.readFileSync(CARRY_FILE, 'utf8')) : {}
  carry[key] = {
    at: Date.now(),
    used: false,
    summaries: summaries.map((s) => `${new Date(s.at).toLocaleDateString('zh-CN')}：${s.title}`),
    recentLines,
    stats: { rebuilt: true, chunks: chunks.length, messages: messages.length },
  }
  fs.writeFileSync(CARRY_FILE, JSON.stringify(carry), 'utf8')
  console.log(`[重建] 接力卡已更新：${summaries.length} 条摘要 + ${recentLines.length} 行原话`)
}
