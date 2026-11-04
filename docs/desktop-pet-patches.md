# 桌宠插件本地补丁台账（dsh-coopanion-pet）

> **为什么有这份文档**：桌宠的修复全部写在 profile 的 `node_modules` 里，不在本仓库。
> 跑一次 `pnpm install`、或插件升级（1.9.2 / 2.0…），**全部会被覆盖**，而且不会有任何报错 ——
> 表现就是「桌宠又点不动了、又没声音了、说话又重复了」。
>
> 升级前后各跑一次：`node scripts/reapply-pet-patches.mjs --check`

- 插件：`dsh-coopanion-pet@1.9.1`
- 安装位置：`<DSH_HOME>\profiles\web\node_modules\dsh-coopanion-pet\`
- 补丁日期：2026-11-04
- 版本结论：以下问题在 1.9.1 上全部实测存在；升级后先 `--check`，未修的再重放。

---

## 0. 一条总背景：独立窗口的"同源"和 DSH 页面不是一回事

独立窗口的页面由**桌面桥**（`desktop/main.cjs` 起的本地 HTTP 服务）提供，源是桥的端口；
而语音合成、静态资源等路由注册在 **DSH 的 webServer（3080）** 上。
上游假设"客户端 fetch 相对路径 = 打到 DSH"，这个假设只在 DSH 页面里成立。
下面 P3–P6 都是这条根因的连锁修复。

---

## P1 `lib/optional.js` — 失败结果缓存 60s → 5s

**症状**：语音时好时坏；一次失败后整整一分钟都不出声。
**原因**：TTS 探测把「没有 TTS 插件」这个结论缓存 60 秒，失败也写进去。TTS 冷启动要 40~60 秒，
第一次必然失败 → 结论被记一分钟 → 每分钟再失败一次继续续期。实测：缓存期内同一条请求
4.8ms 返回 501，等 70 秒后同一请求 200 / 126KB。

**改动**

```js
const CACHE_MS_OK = 60_000;
const CACHE_MS_FAIL = 5_000;
if (known === false && now - checkedAt < CACHE_MS_FAIL) return null;
```

**marker**：`CACHE_MS_FAIL`

---

## P2 `lib/tools.js` — `pet_desktop` 的 status 分支输出校验失败

**症状**：让她查窗口状态永远读不出东西（工具调用被 schema 打回）。
**原因**：`action=status` 额外返回 `running` / `online` 两个布尔，而 `output.schema` 是 oneOf 分支集，
校验报 `value must match exactly one oneOf branch (matched 0)`。

**改动**：只返回 `{ ok, message }`，把状态写进 message。

**marker**：`running=false`

---

## P3 `lib/tools.js` — 两个说话工具的描述（防重复）

**症状**：她一次回话既调 `pet_say` 又调 `pet_speak`，用户听到两遍、第二遍没气泡。
**原因**：`pet_say` 被我们改成**同时朗读**之后，`pet_speak` 变成重复动作，但描述没写这层关系。

**改动**：`say` 描述声明"会同时朗读，别再跟 pet_speak"；`speak` 描述声明"一句话只用其中一个"。

**marker**：`reads it out loud`

---

## P4 `index.js` — 桌面输入框的通路（三处）

### P4a 独立窗口 `/plugins/*` 的转发目标

**症状**：`pet_speak` 报 http-404。
**原因**：客户端的合成请求是相对路径，而 `optional.js` 里宿主再 fetch 时用 `req.headers.host` 拼绝对地址。

**改动**：把 DSH 自己的 web 源告诉桌面桥（`dshBase`），桥据此转发 `/plugins/*`。

**marker**：`dshSelfBase`

### P4b `deliverAnswer` 改走会话服务

**症状**：桌宠输入框里打字，什么都没发生。
**原因**：上游用 `activeAgent.followup`，但 `agent/status` 事件实际只发 `{ status }`
（`dsh-agent-loop` L798），`activeAgent` 永远是 null → 每次都走「没有可用的会话，回答未送达」。

**改动**：`chatRef.send(sessionId, text)`（底层 `sessionController.prompt`）。

**marker**：`chatRef`

### P4c 目标会话 = 她的 QQ 私聊会话

**症状**：桌面输入桥到了**主人自己的 AI 会话**（"最近的会话"通常就是它）。
**原因**：`sessions.json` 才有 `key → sessionId`；`social-v2.json` 没有。读错文件后回落到"最近会话"。

**改动**：依次尝试 `配置的文件 → 同目录 sessions.json → D:/qqbridge/state/sessions.json`；
**并且删掉了"回落到最近会话"的兜底** —— 读不到就不发、只写日志（发错人比发不出去糟）。

**marker**：`resolveDeskChatSession`

---

## P5 `client.js` — 交互与语音（六处）

### P5a 合成请求直连适配器路由

**改动**：`const TTS = '/plugins/xiaomi-mimo-tts/synthesize'`（原来是插件的 `/api/dsh-coopanion-pet/tts`）。
**原因**：插件那条路由内部再 fetch 一次并自带失败缓存，实测经常"引擎是好的但它报 no-tts-plugin"。

**marker**：`/plugins/xiaomi-mimo-tts/synthesize`

### P5b `pet_say` 默认带声音 + 去掉表演标记

**改动**：`say` 命令里调 `speakOnce(stripSayMarkup(text))`。
**原因**：① 主人要"她开口就有声"；② 直接送原文会把 `【happy】`、`<smug>` 念出来。

**marker**：`speakOnce`

### P5c 同一句话不重复朗读

**改动**：8 秒内相同正文只合成一次（`spokenRecently`）。
**原因**：P5b 之后 `pet_say` 与 `pet_speak` 语义重叠，她两个都调就会听到两遍。

**marker**：`dedupe skipped`

### P5d 整段话一屏显示

**改动**：`bubble.say(text, { single: true })`；`assets/bubble.js` 增 `singleBeats()`。
**原因**：上游按标点把一段话拆成一屏一句、快速替换，看起来像"文本被截断"。

**marker**：`assets/bubble.js` 里的 `singleBeats`，以及 `client.js` 里的 `{ single: true }`
（体检脚本分 P5d1 / P5d2 两条）。

### P5e 状态气泡默认关、对话栈默认关

**改动**：`statusBubble` 渲染条件改为必须显式为 `true`；`lines` 帧默认忽略。
**原因**：两者反映的是「连着宠物的那个会话」的活动，宠物是共用的 → 主人在网页端跟 AI 的
对话和工具动作会被贴到她头上（实测看到"让我先确认那三行到底是什么"）。

**marker**：`prefs.linesBubble === true`

### P5f 单击她 = 说话；罐头台词默认关

**改动**：`mouseup` 位移 <8px 且 <600ms 视为单击 → 弹输入框；`touchWake` 默认 `none`，
并把历史存下的 `'poke'` 也当关闭。
**原因**：① 主人要在桌面上直接说话；② 上游默认 `poke`，点她一下会随机冒一句罐头台词
（"这回挺安静的"），看起来像自动回复。

**marker**：`touchWake: 'none'`

---

## P6 `desktop/main.cjs` — 窗口行为（五处）

### P6a 允许无手势自动播放

**改动**：`webPreferences.autoplayPolicy: 'no-user-gesture-required'`。
**原因**：默认策略下 `new Audio().play()` 被拒，而 `voice.js` 把错误 catch 掉了 → 完全静音。

**marker**：`autoplayPolicy`

### P6b 启动时清缓存

**改动**：`win.webContents.session.clearCache()` 后再 `loadURL`。
**原因**：插件的静态资源响应带 `Cache-Control: public, max-age=3600`，
改完 `client.js` 之后窗口一小时都还在跑旧代码（语音修复因此"看起来没生效"过）。

**marker**：`cache cleared`

### P6c 渲染进程报错写进状态日志

**改动**：`console-message` → `status('renderer[...] ...')`。
**原因**：客户端里 fetch/播放失败全被 catch 掉，宿主完全看不见，只能靠猜。

**marker**：`renderer[`

### P6d `/api/dsh-coopanion-pet/*` 转发（含三处排除）

**改动**：通用转发到桥，但**排除** `/desktop`（窗口自己的页面与资源）、`/assets`（client.js 等）、
`/report`（桥的上报端点路径不同）。另外单独转发 `/plugins/*`。

**原因**：不转发 → 语音 404；转发时不排除 → 页面与脚本也 404，窗口打开了却永远 not connected。

**marker**：`!p.startsWith('/api/dsh-coopanion-pet/desktop')`

### P6e 默认可交互 + 环境变量开关

**改动**：`alwaysIgnoreMouse = process.env.DSH_PET_PASSTHROUGH === '1'`（默认 false = 可交互）。
**原因**：中间一版为了绕开"桌面点不动"曾默认永久穿透；真正的 bug 在 P7，修好后恢复可交互。
**开关**：想纯装饰（永远穿透）启动时设 `DSH_PET_PASSTHROUGH=1`。

**marker**：`DSH_PET_PASSTHROUGH`

---

## P7 `desktop/pet.html` — 穿透判定必须看指针位置

**症状**：桌宠一拉起就没法操作桌面（整块屏幕吃点击）。
**原因**：上游只要气泡/按钮条**可见**就把窗口切成"接收点击"：

```js
const overUi = document.querySelector('.cpn-bubble:not([hidden]), .cpn-tools:not([hidden]), ...');
const on = !!(window.__dshPetPointerOn || overUi);
```

她只要说过一句话，气泡就是可见的 → 全屏窗口一直吃点击。

**改动**：改成 `document.elementFromPoint(lastX, lastY)` 命中她自己的 UI 元素才算；
并且**去掉对 `window.__dshCoopanionPet` 存在性的依赖**（独立窗口里那个全局原本没人设，
导致 `setInteractive` 从未被调用，怎么都点不到她），改为 startPreview 完成后补挂。

**marker**：`uiUnderPointer`

---

## 不在本台账里、但属于同一套的东西

| 东西 | 位置 | 会不会被覆盖 |
|---|---|---|
| `gsv-tts-bridge`（小米 TTS 路由 → 本地 SoVITS 的适配器） | `<DSH_HOME>\plugins\gsv-tts-bridge\`（profile 里 `link:`） | 不会 |
| NLTK 资源（cmudict 等） | `%APPDATA%\nltk_data` | 不会 |
| 语音预热脚本 | `<autostart 目录>\warmup-voice.mjs` + `start-all.cmd` 调用 | 不会 |
| 桌宠快捷方式 | 桌面 `小鱼桌宠.lnk` → `start-pet.cmd` | 不会 |

**NLTK 的坑**：下载时若走代理会报 `Security Violation [pathsec.urlopen]`，
需要先 `nltk.pathsec.ALLOW_PROXIED_FETCH = True` 再 `nltk.download(...)`。
缺 `cmudict` 时，**文本里只要出现英文字母**（如 "SoVITS"）合成就会 400。

---

## 升级后怎么恢复

```powershell
# 1) 看哪些补丁丢了（19 条，全部只看 marker，不改文件）
npm run pet:patches
#   或：node scripts/reapply-pet-patches.mjs --check

# 2) 能自动重放的会重放；需要手工的会打印台账编号（宁可不改，也不改错）
npm run pet:patches:apply

# 3) 重启 DSH（宿主侧 6 处：index.js / lib/optional.js / lib/tools.js）
#    客户端与窗口补丁只需重开桌宠窗口：双击桌面「小鱼桌宠」
```

**体检判据**：每条补丁带一个 `marker`（打了补丁才会出现的字符串）。
脚本只在 marker 缺失、且 `find` 在文件里**唯一出现**时才自动重放；
锚点找不到或有歧义一律拒绝改动并提示人工处理。

**什么时候跑**：

- 每次 `pnpm install` / 插件升级之后
- 症状复发时（点不动桌面、没声音、说话重复、查不到窗口状态）先跑一次体检
- 想接进开机自检也可以：`node scripts/reapply-pet-patches.mjs` 有"必须人工"的问题时退出码非零
