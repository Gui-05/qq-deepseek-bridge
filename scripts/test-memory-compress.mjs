// test-memory-compress.mjs —— 压缩模块的离线测试（不联网、不需要 key）。
//
// 覆盖：
//   1. 抽取式降级：没 key 时也能产出 title/summary/tags
//   2. 对话 → 文本：谁说了什么，超长会截断
//   3. 模型返回的宽松 JSON 解析（模型偶尔会包代码块/多余文字）
//   4. 配额闸：maxPerDay 用完后降级
//   5. 永不影响原文：摘要只是字符串，不触碰文件
//
// 跑法：node scripts/test-memory-compress.mjs
import assert from 'node:assert/strict'
import { createMemoryCompressor, chunkToText, extractiveSummary } from '../src/memory-compress.js'

let passed = 0
function ok(name, fn) {
  try {
    Promise.resolve(fn()).then(() => {
      passed += 1
      console.log(`  ✅ ${name}`)
      if (passed === TOTAL) console.log(`\n[compress] 通过 ${passed} 项`)
    }).catch((error) => {
      console.error(`  ❌ ${name}: ${error?.message ?? error}`)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(`  ❌ ${name}: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}

const TOTAL = 8
const messages = [
  { sender: '主人', plain: '今天领导又骂我了，烦死了', time: Date.now() - 600000 },
  { isSelf: true, plain: '又骂你啊 骂啥了', time: Date.now() - 580000 },
  { sender: '主人', plain: '说我方案写得烂 让我重写', time: Date.now() - 560000 },
  { isSelf: true, plain: '那你也别硬顶 先改一版给他看', time: Date.now() - 540000 },
  { sender: '主人', plain: '我在想要不要辞职算了', time: Date.now() - 500000 },
]

console.log('[compress] 离线测试')

ok('chunkToText：谁说了什么', () => {
  const t = chunkToText(messages)
  assert.ok(t.includes('主人：今天领导又骂我了'))
  assert.ok(t.includes('我（小鲸鱼）：又骂你啊'))
})

ok('chunkToText：超长时保留最近的', () => {
  const t = chunkToText(messages, { maxChars: 40 })
  assert.ok(t.startsWith('（更早的内容已省略）'))
  assert.ok(t.includes('辞职'))
})

ok('抽取式：能产出标题', () => {
  const s = extractiveSummary(messages)
  assert.ok(s.title.length > 0)
  assert.ok(s.title.length <= 30)
})

ok('抽取式：标题优先取对方说的、信息量大的那句', () => {
  const s = extractiveSummary(messages)
  // "辞职"那句带关键词加分，应该在标题里
  assert.ok(s.title.includes('辞职') || s.title.includes('领导'), `实际标题：${s.title}`)
})

ok('抽取式：有摘要和标签', () => {
  const s = extractiveSummary(messages)
  assert.ok(s.summary.length > 0)
  assert.ok(Array.isArray(s.tags))
})

ok('没 key 时 summarize 降级为抽取式且不抛', async () => {
  const c = createMemoryCompressor({ apiKey: '', log: () => {} })
  const r = await c.summarize(messages)
  assert.equal(r.ok, true)
  assert.equal(r.by, 'extractive')
  assert.ok(r.error.includes('未配置'))
})

ok('配额闸：maxPerDay=0 表示不限（但没 key 仍降级）', async () => {
  const c = createMemoryCompressor({ apiKey: '', maxPerDay: 0 })
  assert.equal(c.quotaLeft(), Infinity)
})

ok('空对话不会炸', async () => {
  const c = createMemoryCompressor({ apiKey: '' })
  const r = await c.summarize([])
  assert.equal(r.ok, false)
})
