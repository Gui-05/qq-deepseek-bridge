// gsv-tts-bridge —— 把小米 TTS 的路由转发给本地 GPT-SoVITS。
//
// 为什么需要它：dsh-coopanion-pet 的 `pet_speak` 把 TTS 路由写死成
//   POST /plugins/xiaomi-mimo-tts/synthesize  { "text": "..." }  → 200 + 音频字节
// 只认 dsh-xiaomi-tts（小米云）。我们已经有本地的 GPT-SoVITS（9880，混合音色），
// 所以这里注册同一条路径做适配，桌宠就能用自己的嗓子说话，不用换成小米的声音。
//
// 安全：只监听宿主本来的 webServer 路由，不额外开端口；只接受 POST，
// 文本长度上限 500 字（pet_speak 的描述也是这个量级）。
import { Buffer } from 'node:buffer'

export const name = 'gsv-tts-bridge'

// 注意：**不能**声明顶层 `export const inject = ['webServer']`。
// 实测那样会让插件一直 pending（DSH 日志：missing: ['webServer']），apply 永不执行，
// 路由因此没注册（POST 得到 405、GET 得到 404）。必须像 dsh-coopanion-pet 那样，
// 在 apply 内部用 ctx.inject(['webServer'], cb) 惰性获取。

const MAX_TEXT = 500

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

async function readJson(req, limitBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function apply(ctx, config = {}) {
  const apiUrl = String(config.apiUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
  const route = String(config.route || '/plugins/xiaomi-mimo-tts/synthesize')
  const refAudio = String(config.refAudio || '')
  const promptText = String(config.promptText || '')
  const timeoutMs = Math.max(5000, Number(config.timeoutMs) || 60000)

  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx.get('webServer')
    if (!webServer?.register) {
      ctx.logger?.warn?.('gsv-tts-bridge: webServer.register 不可用，跳过注册')
      return
    }

    const dispose = webServer.register({
      kind: 'exact',
      path: route,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        let text = ''
        try {
          const body = await readJson(req)
          text = String(body.text ?? '').trim()
        } catch (error) {
          json(res, 400, { ok: false, error: `bad request: ${error?.message ?? error}` })
          return
        }
        if (!text) {
          json(res, 400, { ok: false, error: 'text 不能为空' })
          return
        }
        if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT)

        const payload = {
          text,
          text_lang: String(config.textLang || 'zh'),
          ref_audio_path: refAudio,
          prompt_text: promptText,
          prompt_lang: String(config.promptLang || 'zh'),
          top_k: Number(config.topK) || 15,
          top_p: Number(config.topP) || 1,
          temperature: Number(config.temperature) || 1,
          text_split_method: String(config.splitMethod || 'cut5'),
          batch_size: 1,
          speed_factor: Number(config.speed) || 1,
          media_type: 'wav',
          streaming_mode: false,
          seed: 42,
          parallel_infer: true,
          repetition_penalty: Number(config.repetitionPenalty) || 1.35,
        }

        try {
          const upstream = await fetch(`${apiUrl}/tts`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!upstream.ok) {
            const detail = await upstream.text().catch(() => '')
            ctx.logger?.warn?.(`gsv-tts-bridge: GPT-SoVITS ${upstream.status} ${detail.slice(0, 200)}`)
            json(res, 502, { ok: false, error: `GPT-SoVITS HTTP ${upstream.status}` })
            return
          }
          const audio = Buffer.from(await upstream.arrayBuffer())
          if (!audio.length) {
            json(res, 502, { ok: false, error: 'GPT-SoVITS 返回空音频' })
            return
          }
          res.writeHead(200, {
            'content-type': upstream.headers.get('content-type') || 'audio/wav',
            'content-length': audio.length,
            'cache-control': 'no-store',
          })
          res.end(audio)
          ctx.logger?.info?.(`gsv-tts-bridge: 合成 ${text.slice(0, 20)}… (${audio.length} bytes)`)
        } catch (error) {
          ctx.logger?.warn?.(`gsv-tts-bridge: 合成失败 ${error?.message ?? error}`)
          json(res, 502, { ok: false, error: String(error?.message ?? error) })
        }
      },
    })

    ctx.effect(() => dispose, 'gsv-tts-bridge: 路由')
  })
}
