// recover-from-sessions.mjs —— 从 DSH 会话存档里恢复 QQ 对话，回填进归档。
//
// 背景（2026-11-04）：桥接的 recentMessages 只保留最近 100 条，更早的对话从未落盘，
// 所以"记忆压缩"永远压不到它们。而 DSH 侧其实保留了**完整会话转录**
// （state/agents 工作区下的 session.v4.jsonl.zstd，多帧 zstd 拼接）。
//
// 这个脚本做三件事：
//   1. 解压每个会话（逐帧，Node 的 zstdDecompressSync 只解第一帧，必须自己切帧）
//   2. 抽出「进来的消息」和「她发出去的消息」
//        - 进来的：user/message 里的【本次消息快照】JSON（有 sender/text/userId）
//        - 发出的：tool/call 里 qq_send_*/qq_reply 的 arguments（含 key 和 messages）
//   3. 去重后写进 state/archive/<会话>/<年月>.jsonl（时间升序追加）
//
// 用法：
//   node scripts/recover-from-sessions.mjs            # 只统计，不写
//   node scripts/recover-from-sessions.mjs --write    # 回填归档
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const ARCHIVE_DIR = path.join(REPO_ROOT, 'state', 'archive')
const SESSION_ROOT = 'D:/dsh/sessions/--C-Users-~6842~5BC5~745E-Desktop-~6842~8001~5E08-fish~0020in~0020QicQ-qq-bridge-state-agents--'
const WRITE = process.argv.includes('--write')

const isMagic = (b, i) => b[i] === 0x28 && b[i + 1] === 0xb5 && b[i + 2] === 0x2f && b[i + 3] === 0xfd

/** 逐帧解压（DSH 的 .zstd 是多帧拼接）。 */
function decompressAll(file) {
  const buf = fs.readFileSync(file)
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i += 1) if (isMagic(buf, i)) offs.push(i)
  let text = ''
  for (let i = 0; i < offs.length; i += 1) {
    const end = i + 1 < offs.length ? offs[i + 1] : buf.length
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[i], end)).toString('utf8') } catch { /* 跳过坏帧 */ }
  }
  return text
}

/** 从 tool/call 里认出"发消息"的调用，返回 {key, texts, at}。 */
function extractSend(call) {
  const name = String(call?.name ?? '')
  if (!/qq_(send_message|send_burst|send_group_message|send_private_message|reply)/.test(name)) return null
  let args
  try { args = JSON.parse(String(call.arguments ?? '{}')) } catch { return null }
  const key = String(args.key ?? '').trim()
    || (args.groupId ? `group:${args.groupId}` : (args.userId ? `private:${args.userId}` : ''))
  if (!key) return null
  let texts = []
  if (Array.isArray(args.messages)) texts = args.messages.map(String)
  else if (typeof args.messages === 'string') {
    const t = args.messages.trim()
    if (t.startsWith('[')) { try { const p = JSON.parse(t); if (Array.isArray(p)) texts = p.map(String) } catch { texts = [t] } }
    else texts = [t]
  } else if (typeof args.message === 'string') texts = [args.message]
  texts = texts.map((s) => s.trim()).filter(Boolean)
  return texts.length ? { key, texts } : null
}

/** 从 user/message 里抽【本次消息快照】的入站消息。 */
function extractIncoming(text) {
  const i = text.indexOf('【本次消息快照】')
  if (i < 0) return []
  const start = text.indexOf('{', i)
  if (start < 0) return []
  // 快照是单行 JSON，取到行尾
  const end = text.indexOf('\n', start)
  const raw = text.slice(start, end < 0 ? undefined : end).trim()
  try {
    const snap = JSON.parse(raw)
    return (snap.messages ?? []).map((m) => ({
      time: Number(m.time) || 0,
      sender: String(m.sender ?? ''),
      userId: m.userId ?? null,
      text: String(m.text ?? ''),
      isOwner: !!m.isOwner,
    }))
  } catch { return [] }
}

const sessions = []
for (const dir of fs.readdirSync(SESSION_ROOT)) {
  const f = path.join(SESSION_ROOT, dir, 'session.v4.jsonl.zstd')
  if (!fs.existsSync(f)) continue
  sessions.push({ id: dir, file: f, mtime: fs.statSync(f).mtimeMs })
}
sessions.sort((a, b) => a.mtime - b.mtime)

const recovered = []   // {at, key, isSelf, sender, text, src}
for (const s of sessions) {
  const text = decompressAll(s.file)
  const lines = text.split('\n').filter(Boolean)
  let preset = ''
  const rows = []
  for (const line of lines) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type === 'session') preset = String(o.agentPreset ?? '')
    if (o.type === 'user/message') {
      const t = (o.data?.content ?? []).map((c) => c.text ?? '').join('\n')
      const at = Number(o.time) || 0
      for (const m of extractIncoming(t)) {
        rows.push({ at: m.time || at, isSelf: false, sender: m.sender, text: m.text, keyHint: m.userId ? `private:${m.userId}` : '' })
      }
    }
    if (o.type === 'tool/call') {
      const hit = extractSend(o.data)
      if (hit) {
        const at = Number(o.time) || 0
        for (const tx of hit.texts) rows.push({ at, isSelf: true, sender: '', text: tx, keyHint: hit.key })
      }
    }
  }
  // 决定这一场属于哪个会话：preset 含 group → 群聊；否则用 keyHint 里出现最多的
  const isGroupSession = preset.includes('group')
  const counts = new Map()
  for (const r of rows) {
    if (!r.keyHint) continue
    counts.set(r.keyHint, (counts.get(r.keyHint) || 0) + 1)
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  const key = isGroupSession
    ? (dominant.startsWith('group:') ? dominant : process.env.QQ_GROUP_KEY || 'group:<群号>')
    : (dominant.startsWith('private:') ? dominant : process.env.QQ_OWNER_KEY || 'private:<主人QQ>')
  for (const r of rows) {
    if (!r.text) continue
    recovered.push({ at: r.at, key, isSelf: r.isSelf, sender: r.sender, text: r.text })
  }
  console.log(`  ${s.id.slice(0, 12)}… preset=${preset} → ${key}  抽到 ${rows.length} 条`)
}

recovered.sort((a, b) => a.at - b.at)
console.log(`\n[恢复] 共 ${recovered.length} 条（去重前）`)

// 去重：同 key + 同文本 + 时间差 < 3 分钟 视为同一条
const seen = new Set()
const unique = []
for (const r of recovered) {
  const bucket = Math.round(r.at / 180000)
  const sig = `${r.key}|${r.isSelf ? 'self' : r.sender}|${r.text.slice(0, 40)}|${bucket}`
  if (seen.has(sig)) continue
  seen.add(sig)
  unique.push(r)
}
console.log(`[恢复] 去重后 ${unique.length} 条`)

const byKey = new Map()
for (const r of unique) {
  if (!byKey.has(r.key)) byKey.set(r.key, [])
  byKey.get(r.key).push(r)
}
for (const [k, list] of byKey) {
  const a = new Date(list[0].at).toLocaleString('zh-CN', { hour12: false })
  const b = new Date(list[list.length - 1].at).toLocaleString('zh-CN', { hour12: false })
  console.log(`  ${k}: ${list.length} 条  ${a} → ${b}`)
}

if (!WRITE) {
  console.log('\n（只统计，未写入。加 --write 回填归档）')
  process.exit(0)
}

// 写归档（按年月分文件，覆盖式重写：先分组再去重写回，避免重复追加）
for (const [k, list] of byKey) {
  const slug = k.replace(/[^a-zA-Z0-9:_-]/g, '').replace(/:/g, '_')
  const dir = path.join(ARCHIVE_DIR, slug)
  fs.mkdirSync(dir, { recursive: true })
  const byMonth = new Map()
  for (const r of list) {
    const d = new Date(r.at)
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (!byMonth.has(ym)) byMonth.set(ym, [])
    byMonth.get(ym).push(r)
  }
  for (const [ym, rows] of byMonth) {
    const file = path.join(dir, `${ym}.jsonl`)
    // 保留已有内容里不在本次恢复范围内的行（避免覆盖新归档）
    const existing = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      : []
    const have = new Set(existing.map((r) => `${r.time}|${r.isSelf ? 's' : r.sender}|${String(r.plain ?? '').slice(0, 40)}`))
    const out = [...existing]
    for (const r of rows) {
      const sig = `${r.at}|${r.isSelf ? 's' : r.sender}|${r.text.slice(0, 40)}`
      if (have.has(sig)) continue
      have.add(sig)
      out.push({ time: r.at, isSelf: r.isSelf, sender: r.sender, userId: null, plain: r.text, kind: '', messageId: null, seq: null, backfilled: true })
    }
    out.sort((a, b) => Number(a.time) - Number(b.time))
    fs.writeFileSync(file, out.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    console.log(`  写入 ${slug}/${ym}.jsonl → ${out.length} 条`)
  }
}
console.log('\n[恢复] 归档回填完成')
