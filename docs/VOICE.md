# 语音方案（三条链路，别混在一起）

这套东西里"她说话"其实有三个来源，走的是完全不同的服务。改之前先确认自己在改哪一条。

| 链路 | 触发 | 用什么 | 需要额外装东西吗 |
|---|---|---|---|
| **① QQ 语音条** | `qq_send_voice_tts` | **Edge TTS**（微软云，在线） | 不需要，上游自带 |
| **② 桌宠说话** | `pet_say` / `pet_speak` | 本地 **GPT-SoVITS**（自训练音色） | 需要：GPT-SoVITS + 本仓库的适配插件 |
| **③ 唱歌** | `qq_sing` | 本地 **GPT-SoVITS**（音色转换） | 同上 |

下面重点说 ②③，因为那是本仓库补的部分。

---

## 为什么需要一个适配插件

桌宠插件（`dsh-coopanion-pet`）的 `pet_speak` 把 TTS 路由**写死**成：

```
POST /plugins/xiaomi-mimo-tts/synthesize   { "text": "..." }  →  200 + 音频字节
```

它只对接 `dsh-xiaomi-tts`（小米云）。而你可能已经有本地 GPT-SoVITS（自训练音色，效果更好、不花钱、不联网）。

本仓库的 `plugins/gsv-tts-bridge` 就是干这个的：**注册同一条路径**，把请求转给本地 GPT-SoVITS（默认 `127.0.0.1:9880/tts`）。于是桌宠不用换声音也能说人话——用的是你自己的音色。

```
桌宠窗口 ──POST /plugins/xiaomi-mimo-tts/synthesize──▶ gsv-tts-bridge ──POST /tts──▶ GPT-SoVITS(9880)
```

---

## 安装步骤

### 第 1 步：装 GPT-SoVITS（独立项目，不在本仓库里）

1. 从 [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 拿一份，按它的文档装好 Python 环境。
2. 准备训练/推理素材（一段你自己的参考音频，5~15 秒干净人声最好；做完整训练更佳）。
3. 确认 API 能起来（等价于下面这条，路径按你的安装位置改）：

```bat
cd /d "D:\gpt-sovits\repo"
set "FTLANG_CACHE=D:\gpt-sovits\repo\GPT_SoVITS\pretrained_models\fast_langdetect"
set "PYTHONIOENCODING=utf-8"
set "NO_PROXY=127.0.0.1,localhost"
set "no_proxy=127.0.0.1,localhost"
"D:\gpt-sovits\venv\Scripts\python.exe" api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

模板脚本见 `scripts/start-gsv-api.example.cmd`（把路径改成你的）。

**三个容易踩的坑**（都是实测过的）：

1. **`NO_PROXY` 必须设**：系统代理会把 `127.0.0.1` 的请求也转走，导致本地调用超时。
2. **第一次合成要 40~60 秒**（模型加载）。这就是 `scripts/warmup-voice.mjs` 存在的原因：开机先合成一句短的把模型压进显存，之后每句约 2 秒。
3. **文本里只要出现英文字母，就可能 400**：GPT-SoVITS 用 NLTK 的 `cmudict` 处理英文，没下载会直接报
   `Resource 'cmudict' not found`。修法（一次性）：

```python
import nltk, ssl
try:
    ssl._create_default_https_context = ssl._create_unverified_context
except Exception:
    pass
nltk.download('cmudict')
```

### 第 2 步：装本仓库的适配插件

把 `plugins/gsv-tts-bridge/` 放进 DSH 的插件目录（或 `npm link` 进当前 profile），然后在
`profiles/<你的 profile>/cordis.patch.yml` 里加一段：

```yaml
- insert:
  - id: gsv-tts-bridge
    name: gsv-tts-bridge
    config:
      apiUrl: http://127.0.0.1:9880
      route: /plugins/xiaomi-mimo-tts/synthesize
      # ↓ 改成你自己的参考音频：必须和 GPT-SoVITS 里加载的模型匹配
      refAudio: D:/qqbridge/voice-dataset/train/audio/ref.wav
      # ↓ 参考音频里那一句话的原文，逐字对应，错一个字音色会跑偏
      promptText: 这里写参考音频里那句话
      textLang: zh
      promptLang: zh
      topK: 15
      topP: 1
      temperature: 1
      speed: 1
      splitMethod: cut5
      repetitionPenalty: 1.35
      timeoutMs: 60000
```

重启 DSH 后生效（宿主插件在启动时注册）。

> **注意**：不要在插件里写顶层 `export const inject = ['webServer']`。实测那样插件会一直 pending
> （日志 `missing: ['webServer']`），`apply` 永不执行、路由没注册（POST 得到 405）。要在 `apply`
> 内部用 `ctx.inject(['webServer'], cb)` 惰性获取。

### 第 3 步：预热（可选但强烈建议）

```bat
node scripts\warmup-voice.mjs
```

把它放进你的开机链（在 GPT-SoVITS API 起来之后）。脚本会读环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GSV_API` | `http://127.0.0.1:9880` | GPT-SoVITS API 地址 |
| `GSV_REF` | `D:/qqbridge/voice-dataset/train/audio/ref.wav` | 参考音频 |

---

## 唱歌（`qq_sing`）

唱歌走的是同一个 GPT-SoVITS，但用法不同：给定一首歌的伴奏 + 原唱，做音色转换后输出整首。

- 需要本地的唱歌脚本（不在本仓库；它负责取 B 站音频、分轨、转换、合成）。
- 桥接侧只负责"点歌 → 调脚本 → 把成品当语音条发出去"。
- 相关工具：`qq_sing`（点歌）、`qq_sing_status`（查进度）。

如果你没有这套脚本，唱歌功能不可用，但**QQ 语音条（Edge TTS）和桌宠说话（适配插件）不受影响**。

---

## 排查对照表

| 现象 | 大概率原因 | 怎么确认 |
|---|---|---|
| 桌宠说话没声音，但 QQ 语音条正常 | 适配插件没注册 / GPT-SoVITS 没起 | `curl -X POST http://127.0.0.1:3080/plugins/xiaomi-mimo-tts/synthesize -d '{"text":"测试"}'` |
| 返回 501 / `no-tts-plugin` | 路由没注册（插件没加载） | 看 DSH 日志有没有 `gsv-tts-bridge` |
| 返回 405 | 插件 pending（`inject` 写法错） | 日志里搜 `missing: ['webServer']` |
| 第一句失败、之后正常 | 模型没预热 | 跑 `warmup-voice.mjs` |
| 含英文的句子 400 | NLTK `cmudict` 缺失 | 见上面第 1 步第 3 条 |
| 声音不对（像别人） | `promptText` 和参考音频不匹配 | 逐字核对；参考音频要干净单人 |
| 合成很慢（每句 2 秒以上） | 显存不够 / 没预热 / 走了代理 | 设 `NO_PROXY`，检查显存 |

---

## 一句话总结

- **上游给的能力**：QQ 发语音条（Edge TTS），开箱即用。
- **本仓库补的能力**：把桌宠的 TTS 路由接到**你自己的** GPT-SoVITS，让她用自己的嗓子说话。
- **不在本仓库里的**：GPT-SoVITS 本体、唱歌脚本、你的参考音频。这些按上面步骤自己装。
