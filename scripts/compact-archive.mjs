// compact-archive.mjs —— 把归档里的历史对话按「天」压成记忆。
//
// 用途：recover-from-sessions.mjs 回填了历史之后，用它把历史补进记忆库。
// 粒度选"一天一条"：逐条压会产生几百次模型调用，日摘要已经够她记住时间线；
// 细节仍然可以从归档里 qq_memory_recall 查到（记忆条目里保留了当天的标题）。
//
// 用法：
//   node scripts/compact-archive.mjs                     # 全部会话、全部日期，dry 预览
//   node scripts/compact-archive.mjs --write             # 真写记忆库
//   node scripts/compact-archive.mjs --key private:<主人QQ> --write
//   node scripts/compact-archive.mjs --since 2026-11-01 --write
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createMemoryCompressor } from '../src/memory-compress.js'
import { createMemoryStore } from '../src/memory-store.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const ARCHIVE_DIR = path.join(REPO_ROOT, 'state', 'archive')
const CONFIG_FILE = path.join(REPO_ROOT, 'config.json')

const WRITE = process.argv.includes('--write')
const argOf = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d }

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
const cc = cfg.memoryCompress ?? {}
if (!cc.apiKey) { console.error('❌ memoryCompress.apiKey 为空'); process.exit(1) }

const onlyKey = argOf('--key', '')
const sinceDay = argOf('--since', '')

const store = createMemoryStore({
  dir: path.join(REPO_ROOT, 'memory'),
  ownerQQ: cfg.ownerQQ,
  ownerAliases: cfg.ownerQQAliases ?? [],
})
const compressor = createMemoryCompressor({
  apiKey: cc.apiKey,
  baseUrl: cc.baseUrl,
  model: cc.model,
  timeoutMs: cc.timeoutMs ?? 45000,
  maxPerDay: 0,
  log: (l) => console.log(`  · ${l}`),
})

const keys = fs.readdirSync(ARCHIVE_DIR).filter((d) => fs.statSync(path.join(ARCHIVE_DIR, d)).isDirectory())
let wrote = 0
for (const slug of keys) {
  const key = slug.replace(/^private_/, 'private:').replace(/^group_/, 'group:')
  if (onlyKey && key !== onlyKey) continue
  const dir = path.join(ARCHIVE_DIR, slug)
  const rows = []
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push(JSON.parse(line)) } catch { /* 坏行 */ }
    }
  }
  rows.sort((a, b) => Number(a.time) - Number(b.time))
  // 按天分组
  const byDay = new Map()
  for (const r of rows) {
    const d = new Date(Number(r.time))
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (sinceDay && day < sinceDay) continue
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(r)
  }
  console.log(`\n[归档压缩] ${key}：${rows.length} 条，${byDay.size} 天`)
  for (const [day, list] of byDay) {
    const textLen = list.reduce((a, r) => a + String(r.plain ?? '').length, 0)
    process.stdout.write(`  ${day}  ${list.length} 条 / ${textLen} 字  `)
    const r = await compressor.summarize(list, { maxChars: 9000, fromOwner: key === `private:${cfg.ownerQQ}` })
    if (!r.ok) { console.log('跳过'); continue }
    console.log(`\n      ${r.title}\n      ${String(r.summary ?? '').slice(0, 160)}\n      imp=${r.importance}${r.pinned ? ' 📌' : ''}  ${r.by}`)
    if (WRITE) {
      // 时间戳用"当天中午"，不要用写入时刻 —— 否则历史记忆全显示成今天，
      // 她按时间回忆时会以为所有事都发生在同一天。
      const dayNoon = new Date(`${day}T12:00:00+08:00`).getTime()
      const w = store.write({
        key,
        at: Number.isFinite(dayNoon) ? dayNoon : Date.now(),
        noPin: true,
        text: r.summary || r.title,
        kind: r.pinned ? 'agreement' : 'event',
        tags: [...(r.tags ?? []), day],
        importance: r.importance,
        // 日摘要不钉住：整天概括里出现"约定"不代表这条本身是约定，
        // 传 pinned 会把 noPin 覆盖掉（踩过）。
        src: 'archive-digest',
      })
      if (w.ok) wrote += 1
      else console.log(`      写入失败：${w.error}`)
    }
  }
}
console.log(`\n[归档压缩] ${WRITE ? `写入 ${wrote} 条` : 'dry 预览，未写入（加 --write 真写）'}`)
