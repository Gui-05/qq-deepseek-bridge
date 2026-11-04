#!/usr/bin/env node
// reapply-pet-patches.mjs — 桌宠本地补丁的体检 / 重放工具。
//
// 背景：桌宠（dsh-coopanion-pet）的修复全部写在 profile 的 node_modules 里，
// `pnpm install` 或插件升级会把它们覆盖掉，而且没有任何报错 ——
// 表现只是"桌宠又点不动了/又没声音了/说话又重复了"。台账见 docs/desktop-pet-patches.md。
//
// 用法：
//   node scripts/reapply-pet-patches.mjs            # 等于 --check
//   node scripts/reapply-pet-patches.mjs --check    # 只体检：每处补丁还在不在
//   node scripts/reapply-pet-patches.mjs --apply    # 体检 + 重放能安全自动重放的
//   node scripts/reapply-pet-patches.mjs --json     # 机器可读
//
// 设计原则：
//   1. **判据是 marker**（改动里必然出现的字符串），不是"文件是否被改过"；
//   2. 能自动重放的补丁必须带 find/replace，且 find 必须在文件里**唯一**出现；
//   3. 找不到锚点 / 锚点不唯一 → 拒绝改动，打印 doc 段落让人类处理（宁可不改也不改错）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

/** profile 里插件的位置（可用 PET_DIR 覆盖）。 */
const PET_DIR = process.env.PET_DIR
  || 'D:/dsh/profiles/web/node_modules/dsh-coopanion-pet'

/**
 * 补丁表。
 *
 * 字段：
 *   id      台账编号（对应 docs/desktop-pet-patches.md）
 *   file    相对 PET_DIR 的路径
 *   title   一句话说明
 *   marker  打了补丁才会出现的字符串
 *   find/replace  可选：能自动重放时的精确锚点对
 *   host    是否需要重启 DSH 才生效（宿主侧代码）
 */
const PATCHES = [
  {
    id: 'P1',
    file: 'lib/optional.js',
    title: 'TTS 失败缓存 60s → 5s',
    marker: 'CACHE_MS_FAIL',
    find: 'const CACHE_MS = 60_000;',
    replace: 'const CACHE_MS_OK = 60_000;\n  const CACHE_MS_FAIL = 5_000;',
    host: true,
  },
  {
    id: 'P2',
    file: 'lib/tools.js',
    title: 'pet_desktop status 输出只带 {ok,message}',
    marker: 'running=false',
    // 结构较大，交给人工；见台账 P2
    host: true,
  },
  {
    id: 'P3',
    file: 'lib/tools.js',
    title: '两个说话工具的描述（防重复）',
    marker: 'reads it out loud',
    host: true,
  },
  {
    id: 'P4a',
    file: 'index.js',
    title: '独立窗口 /plugins 转发目标（dshBase）',
    marker: 'dshSelfBase',
    host: true,
  },
  {
    id: 'P4b',
    file: 'index.js',
    title: 'deliverAnswer 改走会话服务（chatRef）',
    marker: 'chatRef',
    host: true,
  },
  {
    id: 'P4c',
    file: 'index.js',
    title: '目标会话读 sessions.json，且不回落到最近会话',
    marker: 'resolveDeskChatSession',
    host: true,
  },
  {
    id: 'P5a',
    file: 'client.js',
    title: '合成请求直连 /plugins 适配器路由',
    marker: "const TTS = '/plugins/xiaomi-mimo-tts/synthesize';",
    host: false,
  },
  {
    id: 'P5b',
    file: 'client.js',
    title: 'pet_say 默认带声音 + 去掉表演标记',
    marker: 'speakOnce',
    host: false,
  },
  {
    id: 'P5c',
    file: 'client.js',
    title: '同一句话不重复朗读',
    marker: 'dedupe skipped',
    host: false,
  },
  {
    id: 'P5d1',
    file: 'assets/bubble.js',
    title: '整段话一屏显示（singleBeats 切句器）',
    marker: 'singleBeats',
    host: false,
  },
  {
    id: 'P5d2',
    file: 'client.js',
    title: 'pet_say 调用处传 single: true',
    marker: '{ single: true }',
    host: false,
  },
  {
    id: 'P5e',
    file: 'client.js',
    title: '状态气泡 / 对话栈默认关',
    marker: 'prefs.linesBubble === true',
    host: false,
  },
  {
    id: 'P5f',
    file: 'client.js',
    title: '单击她 = 说话；罐头台词默认关',
    marker: "touchWake: 'none'",
    host: false,
  },
  {
    id: 'P6a',
    file: 'desktop/main.cjs',
    title: '允许无手势自动播放',
    marker: 'autoplayPolicy',
    host: false,
  },
  {
    id: 'P6b',
    file: 'desktop/main.cjs',
    title: '启动时清缓存',
    marker: 'cache cleared',
    host: false,
  },
  {
    id: 'P6c',
    file: 'desktop/main.cjs',
    title: '渲染进程报错写进状态日志',
    marker: 'renderer[',
    host: false,
  },
  {
    id: 'P6d',
    file: 'desktop/main.cjs',
    title: '/api/dsh-coopanion-pet/* 转发（含 /desktop、/assets、/report 排除）',
    marker: "!p.startsWith('/api/dsh-coopanion-pet/desktop')",
    host: false,
  },
  {
    id: 'P6e',
    file: 'desktop/main.cjs',
    title: '默认可交互（DSH_PET_PASSTHROUGH=1 可强制穿透）',
    marker: 'DSH_PET_PASSTHROUGH',
    host: false,
  },
  {
    id: 'P7',
    file: 'desktop/pet.html',
    title: '穿透判定必须看指针位置',
    marker: 'uiUnderPointer',
    host: false,
  },
]

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function checkOne(patch) {
  const file = path.join(PET_DIR, patch.file)
  const text = readFileSafe(file)
  if (text === null) {
    return { ...patch, state: 'missing-file', file }
  }
  if (text.includes(patch.marker)) {
    return { ...patch, state: 'applied', file }
  }
  // 没打上：看看能不能自动补
  if (patch.find && patch.replace) {
    const hits = countOccurrences(text, patch.find)
    if (hits === 1) return { ...patch, state: 'reappliable', file }
    return { ...patch, state: hits === 0 ? 'anchor-missing' : 'anchor-ambiguous', file }
  }
  return { ...patch, state: 'manual', file }
}

function applyOne(result) {
  if (result.state !== 'reappliable') return result
  const text = fs.readFileSync(result.file, 'utf8')
  const next = text.replace(result.find, result.replace)
  if (next === text) return { ...result, state: 'apply-noop' }
  fs.writeFileSync(result.file, next, 'utf8')
  const after = fs.readFileSync(result.file, 'utf8')
  return { ...result, state: after.includes(result.marker) ? 'reapplied' : 'apply-unverified' }
}

const ICON = {
  applied: '✅',
  reapplied: '🔧',
  reappliable: '🟡',
  manual: '🟡',
  'anchor-missing': '❌',
  'anchor-ambiguous': '❌',
  'missing-file': '❌',
  'apply-noop': '❌',
  'apply-unverified': '❌',
}

function main() {
  const args = new Set(process.argv.slice(2))
  const asJson = args.has('--json')
  const doApply = args.has('--apply')

  if (!fs.existsSync(PET_DIR)) {
    console.error(`[pet-patches] 找不到插件目录：${PET_DIR}`)
    console.error('[pet-patches] 用 PET_DIR 环境变量指定实际路径')
    process.exit(2)
  }

  let results = PATCHES.map(checkOne)
  if (doApply) results = results.map(applyOne)

  if (asJson) {
    console.log(JSON.stringify({ petDir: PET_DIR, patches: results.map(({ find, replace, ...rest }) => rest) }, null, 2))
  } else {
    console.log(`[pet-patches] 插件目录：${PET_DIR}`)
    for (const r of results) {
      console.log(`  ${ICON[r.state] ?? '?'} ${r.id.padEnd(4)} ${r.state.padEnd(15)} ${r.title}`)
      if (['anchor-missing', 'anchor-ambiguous', 'missing-file', 'apply-unverified'].includes(r.state)) {
        console.log(`        ↳ ${r.file}（需人工处理，见 docs/desktop-pet-patches.md ${r.id}）`)
      }
    }
    const bad = results.filter((r) => r.state.startsWith('anchor') || r.state.startsWith('apply-') || r.state === 'missing-file')
    const manual = results.filter((r) => r.state === 'manual')
    const ok = results.filter((r) => r.state === 'applied' || r.state === 'reapplied')
    console.log('')
    console.log(`[pet-patches] 正常 ${ok.length} / 需重放 ${manual.length} / 需人工 ${bad.length}`)
    const hosts = results.filter((r) => r.host).length
    if (manual.length || bad.length || doApply) {
      console.log(`[pet-patches] 提示：宿主侧补丁（${hosts} 处）改完要重启 DSH；client.js / desktop/* 只需重开桌宠窗口`)
    }
  }

  // 退出码：有"必须人工"的问题才非零，方便接进启动自检
  const blocking = results.some((r) => r.state.startsWith('anchor') || r.state === 'missing-file' || r.state.startsWith('apply-'))
  process.exit(blocking ? 1 : 0)
}

main()
