// test-memory-store.mjs —— 记忆库的单元测试（不需要 DSH / QQ）。
//
// 覆盖：
//   1. 写入 + 原文落盘 + 索引只有元数据
//   2. 钉住判定（她说要记 / 被要求记 / 约定）→ 高重要性 + pinned
//   3. 检索（关键词、时间、人物、重要性下限）
//   4. 隐私隔离：owner 私聊的记忆不出现在群聊里；secret 默认不返回
//   5. digest（进 prompt 的那份）不含 secret、钉住的排前面
//
// 跑法：node scripts/test-memory-store.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createMemoryStore, scoreImportance, inferPrivacy, privacyAllows, PRIVACY } from '../src/memory-store.js'

const OWNER = '10000001'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memtest-'))
const store = createMemoryStore({ dir: tmp, ownerQQ: OWNER })

let passed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✅ ${name}`)
  } catch (error) {
    console.error(`  ❌ ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

console.log(`[memory] 临时目录 ${tmp}`)

// ---- 1. 写入与落盘 ----
const w1 = store.write({ key: `private:${OWNER}`, text: '他说这周要被领导骂了好几次，情绪很差。', kind: 'event' })
ok('写入成功', () => assert.equal(w1.ok, true))
ok('原文确实落盘（jsonl 里能读到）', () => {
  const slug = `private_${OWNER}`
  const dayDir = path.join(tmp, slug)
  const files = fs.readdirSync(dayDir)
  assert.equal(files.length, 1)
  const line = fs.readFileSync(path.join(dayDir, files[0]), 'utf8').trim()
  const rec = JSON.parse(line)
  assert.ok(rec.text.includes('领导'))
})
ok('索引里不含 text 字段', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(tmp, 'index.json'), 'utf8'))
  assert.ok(idx.length >= 1)
  assert.equal(idx[0].text, undefined)
  assert.ok(idx[0].title)
})

// ---- 2. 钉住判定 ----
console.log('\n[memory] 钉住（她说的/被要求记的/约定）')
const cases = [
  ['我记着：他下周三要考试。', 'self-noted'],
  ['记住我最喜欢下雨天。', 'requested'],
  ['说好了周末一起看电影。', 'agreement'],
]
for (const [text, reason] of cases) {
  ok(`「${text.slice(0, 12)}…」→ ${reason}`, () => {
    const s = scoreImportance(text, {})
    assert.equal(s.pinned, true, '应该被钉住')
    assert.equal(s.pinnedReason, reason)
    assert.ok(s.importance >= 0.9, `重要性应该 >=0.9，实际 ${s.importance}`)
    // 真的写进去一条，后面 stats 才能数到
    const w = store.write({ key: `private:${OWNER}`, text, kind: 'agreement' })
    assert.equal(w.ok, true)
    assert.equal(w.record.pinned, true)
    assert.ok(w.record.importance >= 0.9)
  })
}
ok('普通闲聊不会被钉住、重要性低', () => {
  const s = scoreImportance('在吗', {})
  assert.equal(s.pinned, false)
  assert.ok(s.importance < 0.3, `应该 <0.3，实际 ${s.importance}`)
})
ok('提到 owner 的事件重要性中等以上', () => {
  const s = scoreImportance('主人今天说他升职了，很开心。', { fromOwner: true })
  assert.ok(s.importance >= 0.6, `实际 ${s.importance}`)
})

// ---- 3. 检索 ----
store.write({ key: `private:${OWNER}`, text: '记住：他讨厌吃香菜。', kind: 'note' })
store.write({ key: `group:20000001`, text: '群里在聊显卡价格，涨得厉害。', kind: 'topic' })
console.log('\n[memory] 检索')
ok('关键词能查到（跨聊天框）', () => {
  const r = store.recall({ q: '香菜', viewerKey: `private:${OWNER}`, crossChat: true })
  assert.equal(r.ok, true)
  assert.ok(r.items.length >= 1)
  assert.ok(r.items[0].text.includes('香菜'))
})
ok('不跨聊天框时只查本会话', () => {
  const r = store.recall({ q: '显卡', viewerKey: `private:${OWNER}`, crossChat: false })
  assert.equal(r.items.length, 0, '本会话没有显卡那条')
  const r2 = store.recall({ q: '显卡', viewerKey: `private:${OWNER}`, crossChat: true })
  assert.ok(r2.items.length >= 1)
})
ok('钉住的排在前面', () => {
  const r = store.recall({ viewerKey: `private:${OWNER}`, crossChat: true, limit: 5 })
  assert.ok(r.items[0].pinned, '第一条应该是钉住的')
})

// ---- 4. 隐私隔离 ----
console.log('\n[memory] 隐私')
ok('owner 私聊的记忆推断为 owner 级', () => {
  assert.equal(inferPrivacy(`private:${OWNER}`, OWNER), PRIVACY.OWNER)
})
ok('群聊记忆推断为 group 级', () => {
  assert.equal(inferPrivacy('group:20000001', OWNER), PRIVACY.GROUP)
})
ok('别人私聊的记忆推断为 friend 级', () => {
  assert.equal(inferPrivacy('private:123456', OWNER), PRIVACY.FRIEND)
})
ok('群聊查不到 owner 私聊的记忆', () => {
  const r = store.recall({ q: '香菜', viewerKey: 'group:20000001', crossChat: true })
  assert.equal(r.items.length, 0, 'owner 级不该出现在群里')
})
ok('别人私聊查不到 owner 私聊的记忆', () => {
  const r = store.recall({ q: '香菜', viewerKey: 'private:123456', crossChat: true })
  assert.equal(r.items.length, 0)
})
ok('别人私聊能看到自己的 friend 级记忆', () => {
  store.write({ key: 'private:123456', text: '他说他在准备考研，压力很大。', kind: 'event' })
  const r = store.recall({ q: '考研', viewerKey: 'private:123456', crossChat: false })
  assert.ok(r.items.length >= 1)
})
ok('secret 默认不返回，显式要求才给', () => {
  store.write({ key: `private:${OWNER}`, text: '他偷偷说别告诉别人他要换工作。', kind: 'event', privacy: PRIVACY.SECRET })
  const r1 = store.recall({ q: '换工作', viewerKey: `private:${OWNER}`, crossChat: true })
  assert.equal(r1.items.length, 0, 'secret 默认不返回')
  const r2 = store.recall({ q: '换工作', viewerKey: `private:${OWNER}`, crossChat: true, includeSecret: true })
  assert.ok(r2.items.length >= 1)
})

// ---- 5. digest ----
console.log('\n[memory] digest（进 prompt 的部分）')
ok('digest 不含 secret', () => {
  const d = store.digest(`private:${OWNER}`, { limit: 20 })
  assert.ok(Array.isArray(d))
  assert.equal(d.filter((x) => x.privacy === PRIVACY.SECRET).length, 0)
})
ok('digest 里钉住的排最前', () => {
  const d = store.digest(`private:${OWNER}`, { limit: 5 })
  assert.ok(d.length > 0)
  assert.equal(d[0].pinned, true, '第一条应为钉住项')
})
ok('digest 每行很小（≤ 300 字符 JSON）', () => {
  const d = store.digest(`private:${OWNER}`, { limit: 10 })
  for (const row of d) assert.ok(JSON.stringify(row).length <= 300)
})

// ---- 6. 统计 ----
ok('stats 能报规模', () => {
  const s = store.stats(`private:${OWNER}`)
  assert.equal(s.ok, true)
  assert.ok(s.total >= 5)
  assert.ok(s.pinned >= 3)
})

// ---- 7. 隐私闸门（提醒 + 她放行）----
console.log('\n[memory] 隐私闸门')
store.write({
  key: `private:${OWNER}`,
  text: '他偷偷说别告诉别人他要换工作',
  kind: 'event',
  privacy: PRIVACY.SECRET,
})
const secretLine = '他偷偷说别告诉别人他要换工作'

ok('owner 私聊里说这件事 → 不拦（他本来就知道）', () => {
  const r = store.gateCheck(`private:${OWNER}`, secretLine)
  assert.equal(r.allowed, true)
})

ok('群里原样复述 → 拦下并给出提醒依据', () => {
  const r = store.gateCheck('group:20000001', `我跟你们说，${secretLine}，别外传`)
  assert.equal(r.allowed, false)
  assert.equal(r.needApprove, true)
  assert.ok(r.hits.length >= 1, '要告诉她命中了哪条')
  assert.ok(r.hits[0].title)
})

ok('群里换个说法、不带原句 → 放行', () => {
  const r = store.gateCheck('group:20000001', '今天群里气氛不错啊')
  assert.equal(r.allowed, true)
})

ok('她放行后，同一段话能发出去（一次性）', () => {
  const text = `我跟你们说，${secretLine}`
  const before = store.gateCheck('group:20000001', text)
  assert.equal(before.allowed, false)
  store.gateApprove('group:20000001', text, '他自己在群里公开说了')
  const after = store.gateCheck('group:20000001', text)
  assert.equal(after.allowed, true)
  assert.equal(after.disclosed, true)
  // 票是一次性的：再发一次要重新申请
  const again = store.gateCheck('group:20000001', text)
  assert.equal(again.allowed, false, '放行票应该只用一次')
})

ok('放行会写审计日志', () => {
  const auditPath = path.join(tmp, 'disclosure-audit.jsonl')
  assert.ok(fs.existsSync(auditPath), '审计文件应该存在')
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(lines.some((l) => l.kind === 'approve'))
  assert.ok(lines.some((l) => l.kind === 'disclose'))
  const disclose = lines.find((l) => l.kind === 'disclose')
  assert.ok(disclose.reason.includes('公开'))
})

ok('别人私聊里转述 owner 的私事 → 也拦', () => {
  const r = store.gateCheck('private:123456', `听说${secretLine}`)
  assert.equal(r.allowed, false)
})

// ---- 清理 ----
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n[memory] 通过 ${passed} 项`)
if (process.exitCode) console.error('[memory] 有失败项')
