// warmup-voice.mjs — 开机预热 GPT-SoVITS，让第一次"她说话"不用等 40~60 秒。
//
// 背景（2026-11-04 实测）：
//   TTS 服务起来后模型还没加载，第一句合成要 40~60 秒；这条链路（窗口 → 桥 → DSH →
//   gsv-tts-bridge → SoVITS）里有一处 60 秒上限，于是**开机后第一句话常常直接失败**
//   （表现为"没有声音"/501 no-tts-plugin）。这里在开机时先合成一句短的，把模型压进显存，
//   之后每句约 2 秒。
//
// 为什么用 .mjs 而不是写在 .cmd 里：cmd 按系统 OEM 代码页读取文件，
// 中文 prompt_text 会乱码（prompt_text 必须和参考音频逐字对应，错了音色会跑偏）。
// node 读 UTF-8 没有这个问题。
import fs from 'node:fs'

const API = process.env.GSV_API || 'http://127.0.0.1:9880'
// 默认值只是占位：请用环境变量 GSV_REF 指向你自己的参考音频
  const REF = process.env.GSV_REF || 'D:/qqbridge/voice-dataset/train/audio/ref.wav'
// 参考音频里那句话的原文（必须逐字对应）。用 GSV_PROMPT 环境变量传入你自己的。
  const PROMPT = process.env.GSV_PROMPT || '这里填你的参考音频里那句话'
const LOG = process.env.GSV_LOG || ''

function log(line) {
  const msg = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${line}`
  console.log(msg)
  if (!LOG) return
  try { fs.appendFileSync(LOG, msg + '\r\n', 'utf8') } catch { /* 日志失败不影响主流程 */ }
}

async function waitPort(timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/tts`, { method: 'HEAD' }).catch(() => null)
      if (res) return true
    } catch { /* 还没起来 */ }
    // HEAD 不一定被支持，换个法子：能建立 TCP 就算通（fetch 报错就是没通）
    try {
      await fetch(API, { method: 'GET' })
      return true
    } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function main() {
  log('voice warmup: waiting for GPT-SoVITS on 9880')
  if (!(await waitPort(180000))) {
    log('voice warmup: SKIP (port 9880 not reachable in 180s)')
    return
  }
  const body = {
    text: '嗯。',
    text_lang: 'zh',
    ref_audio_path: REF,
    prompt_text: PROMPT,
    prompt_lang: 'zh',
    text_split_method: 'cut5',
    media_type: 'wav',
    streaming_mode: false,
    batch_size: 1,
    parallel_infer: true,
    seed: 42,
  }
  const started = Date.now()
  try {
    const res = await fetch(`${API}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(240000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      log(`voice warmup: FAILED HTTP ${res.status} ${detail.slice(0, 120)}`)
      return
    }
    const buf = Buffer.from(await res.arrayBuffer())
    log(`voice warmup: ok (${Math.round((Date.now() - started) / 1000)}s, ${Math.round(buf.length / 1024)} KB) - next speech should be ~2s`)
  } catch (error) {
    log(`voice warmup: FAILED ${error?.message ?? error}`)
  }
}

main().catch((error) => log(`voice warmup: unexpected ${error?.message ?? error}`))
