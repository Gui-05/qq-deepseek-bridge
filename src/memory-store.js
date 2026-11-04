// memory-store.js —— 小鱼的长期记忆库（原文落盘 + 索引注入 + 按需检索）
//
// ## 为什么要有它
//
// 桥接原来的记忆只有三个内存数组（activeTopics / pendingThoughts / memberImpressions），
// 上限 200 字/条、过期即丢 —— 她其实**没有长期记忆**：话题一出上下文就没了。
// 这个模块把「上下文里放摘要索引、完整原文放磁盘、需要时用工具查」做成一套：
//
//   memory/
//     index.json                     ← 索引：每条一行元数据（标题、时间、重要性、隐私）
//     private_<主人QQ>/2026-11-04.jsonl   ← 原文，按天分文件追加
//     group_<群号>/2026-11-04.jsonl
//
// ## 三个关键属性
//
// 1. **importance（0~1）**：重要性。既用于压缩排序（先折叠最旧最低的），
//    也用于检索加权与人格扮演（重要的事更容易被想起来）。
// 2. **privacy**：隐私级别。跨聊天框查询时按级别过滤，防止把私密话说给外人。
// 3. **pinned**：钉住。她说要记的 / 被要求记的 / 约定，**永不压缩**、永远进索引。
//
// 设计取舍：
//   - 用 jsonl 按天追加：写入便宜、按时间范围扫快、坏一行不影响别人
//   - 索引与原文分离：索引可以整份读进内存（几千条也只几百 KB），原文只在命中时读
//   - 不引入外部依赖：子串匹配 + 中文粗切，够用且可预测
import fs from 'node:fs'
import path from 'node:path'

/** 隐私级别（越往后越私密）。 */
export const PRIVACY = {
  PUBLIC: 'public',           // 群里公开说的：任何会话都能提
  GROUP: 'group',             // 某个群里的：该群 + owner 私聊
  FRIEND: 'friend',           // 某位好友的私聊：该好友 + owner 私聊
  OWNER: 'owner',             // 与 owner 的私聊：只有 owner 私聊
  SECRET: 'secret',           // 标了"别告诉别人"：只有 owner 主动问时才查
}

const PRIVACY_ORDER = [PRIVACY.PUBLIC, PRIVACY.GROUP, PRIVACY.FRIEND, PRIVACY.OWNER, PRIVACY.SECRET]

/** 记录种类。 */
export const KINDS = ['topic', 'event', 'impression', 'quote', 'agreement', 'note']

/**
 * 钉住判定用的词表（用户 2026-11-04 明确要求这三类优先级更高）：
 *   selfNoted  她说要记下来
 *   requested  被要求记下来
 *   agreement  约定 / 承诺
 */
const SELF_NOTED = [
  '我记着', '我记住了', '我记住', '我记一下', '记一笔', '我得记住', '别忘了这个',
  '这个我记下', '我留个记录',
]
const REQUESTED = [
  '记住', '记一下', '记下', '别忘', '要记得', '帮我记', '你记着', '别忘了',
]
const AGREEMENT = [
  '说好了', '说好', '答应', '约好', '约定', '一言为定', '就这么定',
  '到时候', '明天见', '改天', '下次一起', '我会来', '等你', '等你回来',
]

/** 情绪 / 冲突 / 承诺（提高重要性）。 */
const EMOTION_WORDS = [
  '生气', '难过', '哭', '开心', '累', '烦', '委屈', '害怕', '担心', '喜欢', '讨厌',
  '谢谢', '对不起', '抱歉', '别告诉', '秘密', '崩溃', '失业', '分手', '吵架',
]
/** 纯寒暄 / 无信息量（降低重要性）。 */
const FILLER = [
  '在吗', '早上好', '晚安', '哈哈', '哈哈哈', '好的', '嗯嗯', '收到', '哦哦',
  '早', '安', '好', '嗯', '啊', '草', '乐', '6',
]

/** 把会话 key 变成安全的目录名：private:123456 → private_123456 */
export function keyToSlug(key) {
  return String(key ?? '').replace(/[^a-zA-Z0-9:_-]/g, '').replace(/:/g, '_') || 'unknown'
}

/** 默认隐私级别：按来源会话推断。 */
export function inferPrivacy(key, ownerQQ = '', ownerAliases = []) {
  const k = String(key ?? '')
  const owner = String(ownerQQ ?? '')
  if (k.startsWith('group:')) return PRIVACY.GROUP
  if (k.startsWith('private:')) {
    const qq = k.slice('private:'.length)
    const aliases = [owner, ...(Array.isArray(ownerAliases) ? ownerAliases : [])]
      .map((x) => String(x ?? '').trim()).filter(Boolean)
    if (!aliases.length || aliases.includes(qq)) return PRIVACY.OWNER
    return PRIVACY.FRIEND
  }
  return PRIVACY.PUBLIC
}

/** 隐私是否允许 viewer 看到这条。 */
export function privacyAllows(recordPrivacy, viewerKey, ownerQQ = '') {
  const p = String(recordPrivacy ?? PRIVACY.PUBLIC)
  const owner = String(ownerQQ ?? '')
  const k = String(viewerKey ?? '')
  const isOwnerViewer = owner && k === `private:${owner}`

  // owner 私聊：能看全部（secret 也只在被主动问到时返回，由调用方决定是否过滤）
  if (isOwnerViewer) return true
  if (p === PRIVACY.PUBLIC) return true
  if (p === PRIVACY.GROUP) return k.startsWith('group:')
  if (p === PRIVACY.FRIEND) return k.startsWith('private:')
  // OWNER / SECRET：非 owner 一律看不到
  return false
}

/** 文本里是否命中某个词表。返回命中的词。 */
function hitAny(text, words) {
  const s = String(text ?? '')
  for (const w of words) if (w && s.includes(w)) return w
  return ''
}

/**
 * 算一条记忆的重要性（0~1）。
 *
 * 钉住的三种（她说要记 / 被要求记 / 约定）直接给最高档 ——
 * 这是用户明确要求的优先级：这类事忘了最伤人。
 */
export function scoreImportance(text, opts = {}) {
  const raw = String(text ?? '')
  const { fromOwner = false, kind = '', pinned = false } = opts

  // 钉住的三类：优先级最高
  const selfNoted = hitAny(raw, SELF_NOTED)
  const requested = hitAny(raw, REQUESTED)
  const agreement = hitAny(raw, AGREEMENT)
  if (pinned || selfNoted || requested || agreement) {
    return {
      importance: selfNoted || requested ? 0.96 : 0.92,
      pinned: true,
      pinnedReason: selfNoted ? 'self-noted' : requested ? 'requested' : 'agreement',
      matched: selfNoted || requested || agreement,
    }
  }

  let score = 0.3
  const reasons = []
  if (fromOwner) { score += 0.25; reasons.push('owner') }
  const emo = hitAny(raw, EMOTION_WORDS)
  if (emo) { score += 0.20; reasons.push(`emotion:${emo}`) }
  if (/[0-9０-９]|明天|后天|昨天|上周|下周|月|号|点/.test(raw)) { score += 0.10; reasons.push('time') }
  if (/[你我他她].{0,6}(叫|是|在|住|做)/.test(raw)) { score += 0.05; reasons.push('entity') }
  if (kind === 'agreement') { score += 0.25; reasons.push('kind:agreement') }
  if (kind === 'impression') { score += 0.10; reasons.push('kind:impression') }
  const filler = hitAny(raw, FILLER)
  if (filler && raw.length <= 6) { score -= 0.20; reasons.push(`filler:${filler}`) }
  if (raw.length <= 4) { score -= 0.15; reasons.push('too-short') }

  return {
    importance: Math.max(0, Math.min(1, Number(score.toFixed(2)))),
    pinned: false,
    pinnedReason: '',
    matched: '',
    reasons,
  }
}

/** 从一段文本抽一个短标题（≤40 字）：去掉多余空白，取第一句。 */
export function makeTitle(text, max = 40) {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  const first = one.split(/[。！？!?\n；;]/)[0] || one
  const t = first.length > max ? `${first.slice(0, max)}…` : first
  return t
}

/** 中文粗切：给检索用。返回去重后的词元列表。 */
export function tokenize(text) {
  const s = String(text ?? '').toLowerCase()
  const tokens = new Set()
  // 英文/数字整词
  for (const m of s.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0])
  // 中文二元组（粗切，够检索用）
  const cjk = s.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const chunk of cjk.split(/\s+/)) {
    if (!chunk) continue
    if (chunk.length === 1) tokens.add(chunk)
    for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.add(chunk.slice(i, i + 2))
  }
  return [...tokens]
}

export function createMemoryStore(options = {}) {
  const dir = String(options.dir ?? 'D:/qqbridge/memory')
  const ownerQQ = String(options.ownerQQ ?? '')
  // 主人的多个号（用户 2026-11-04：必须把 owner 标记清楚）。
  // 同一人多号时，只用 ownerQQ 判会把这些号记成 friend 级，
  // 后果是"跨会话查不到关于主人自己的事"——对人格扮演伤害很大。
  const ownerAliases = new Set(
    [ownerQQ, ...(Array.isArray(options.ownerAliases) ? options.ownerAliases : [])]
      .map((x) => String(x ?? '').trim())
      .filter(Boolean),
  )
  const ownerKeys = new Set([...ownerAliases].map((qq) => `private:${qq}`))
  const isOwnerKey = (key) => ownerKeys.has(String(key ?? ''))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const maxIndexEntries = Number(options.maxIndexEntries) || 20000

  const indexPath = path.join(dir, 'index.json')
  /** 内存里的索引（整份读入；几千条也只几百 KB）。 */
  let index = []
  let loaded = false

  function ensureDir(p) {
    try { fs.mkdirSync(p, { recursive: true }) } catch { /* 已存在 */ }
  }

  function loadIndex() {
    if (loaded) return
    loaded = true
    try {
      const raw = fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(raw)
      index = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : []
    } catch {
      index = []
    }
  }

  function saveIndex() {
    ensureDir(dir)
    const tmp = `${indexPath}.tmp`
    try {
      fs.writeFileSync(tmp, JSON.stringify(index), 'utf8')
      fs.renameSync(tmp, indexPath)
    } catch (error) {
      log(`记忆索引写入失败: ${error?.message ?? error}`)
    }
  }

  function dayFile(key, at) {
    const d = new Date(at)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return path.join(dir, keyToSlug(key), `${yyyy}-${mm}-${dd}.jsonl`)
  }

  function nextId(at) {
    const d = new Date(at)
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const seq = index.filter((r) => String(r.id ?? '').startsWith(`m-${stamp}`)).length + 1
    return `m-${stamp}-${String(seq).padStart(4, '0')}`
  }

  /**
   * 写一条记忆。
   *
   * @param {object} input
   *   key       会话 key（来源）
   *   text      原文（完整内容，落盘的就是它）
   *   kind      KINDS 之一
   *   tags      手工标签
   *   privacy   不传则按 key 推断
   *   pinned    强制钉住（她说要记 / 被要求记 / 约定）
   */
  function write(input = {}) {
    loadIndex()
    const key = String(input.key ?? '')
    const text = String(input.text ?? '').trim()
    if (!text) return { ok: false, error: 'text 不能为空' }

    const at = Number(input.at) || Date.now()
    const scored = scoreImportance(text, {
      fromOwner: isOwnerKey(key),
      kind: String(input.kind ?? ''),
      pinned: input.pinned === true,
    })
    const record = {
      id: nextId(at),
      at,
      key,
      kind: KINDS.includes(input.kind) ? input.kind : (scored.pinned ? 'agreement' : 'topic'),
      title: makeTitle(text),
      importance: input.importance !== undefined ? Math.max(0, Math.min(1, Number(input.importance))) : scored.importance,
      // 主人会话：**不允许**被模型传的 privacy 覆盖（实测她传过 "friend"，
      // 结果主人自己的事被记成好友级，跨会话查不到）。只保留 secret 这种更强的意图。
      privacy: (() => {
        if (isOwnerKey(key)) {
          return String(input.privacy) === PRIVACY.SECRET ? PRIVACY.SECRET : PRIVACY.OWNER
        }
        return input.privacy || inferPrivacy(key, ownerQQ, [...ownerAliases])
      })(),
      // noPin：日摘要这类"整天概括"不该因为里面出现"约定"两个字就被钉住，
      // 否则钉住条目会泛滥（实测 16 条日摘要里 13 条被误钉）。
      pinned: input.noPin === true ? (input.pinned === true) : (scored.pinned || input.pinned === true),
      pinnedReason: scored.pinnedReason || (input.pinned ? 'forced' : ''),
      tags: [...new Set([...(Array.isArray(input.tags) ? input.tags : []), ...(scored.matched ? [scored.pinnedReason] : [])])].slice(0, 12),
      src: String(input.src ?? 'auto'),
      text,
    }

    // 原文落盘
    const file = dayFile(key, at)
    ensureDir(path.dirname(file))
    try {
      fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
    } catch (error) {
      return { ok: false, error: `原文写入失败: ${error?.message ?? error}` }
    }

    // 索引只留元数据（不含 text）
    const { text: _omit, ...meta } = record
    meta.file = path.relative(dir, file).replace(/\\/g, '/')
    index.push(meta)
    if (index.length > maxIndexEntries) index = index.slice(-maxIndexEntries)
    saveIndex()
    return { ok: true, record: meta }
  }

  /** 读某条记录的原��（按 id 在索引里找到文件，再扫那一行）。 */
  function readOne(id) {
    loadIndex()
    const meta = index.find((r) => r.id === id)
    if (!meta) return null
    try {
      const lines = fs.readFileSync(path.join(dir, meta.file), 'utf8').split('\n')
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const rec = JSON.parse(line)
          if (rec.id === id) return rec
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 文件不在 */ }
    return { ...meta, text: '' }
  }

  /** 把 since 解析成毫秒时间戳。支持 '7d' / '24h' / '2026-11-01' / 数字(ms)。 */
  function parseSince(since) {
    if (since === undefined || since === null || since === '') return 0
    if (typeof since === 'number') return since
    const s = String(since).trim()
    const rel = /^(\d+)\s*([dhm])$/.exec(s)
    if (rel) {
      const n = Number(rel[1])
      const unit = rel[2] === 'd' ? 86400000 : rel[2] === 'h' ? 3600000 : 60000
      return Date.now() - n * unit
    }
    const t = Date.parse(s)
    return Number.isFinite(t) ? t : 0
  }

  /**
   * 检索。
   *
   * @param {object} query
   *   q          关键词（可空 = 按时间/重要性取最近的）
   *   viewerKey  谁在查（隐私过滤用）
   *   crossChat  是否允许跨会话（默认 false）
   *   since      时间下限
   *   kind       种类筛选
   *   person     人物标签筛选
   *   minImportance 重要性下限
   *   limit      最多几条（默认 5）
   *   includeSecret 是否把 secret 也带出来（只有 owner 主动问时用）
   */
  function recall(query = {}) {
    loadIndex()
    const viewerKey = String(query.viewerKey ?? '')
    const crossChat = query.crossChat === true
    const sinceMs = parseSince(query.since)
    const kind = String(query.kind ?? '')
    const person = String(query.person ?? '')
    const minImp = query.minImportance === undefined ? 0 : Number(query.minImportance) || 0
    const limit = Math.max(1, Math.min(20, Number(query.limit) || 5))
    const q = String(query.q ?? '').trim()
    const qTokens = q ? tokenize(q) : []

    const rows = []
    for (const meta of index) {
      if (!crossChat && meta.key !== viewerKey) continue
      if (sinceMs && Number(meta.at) < sinceMs) continue
      if (kind && meta.kind !== kind) continue
      if (person && !(Array.isArray(meta.tags) && meta.tags.includes(person))) continue
      if (Number(meta.importance) < minImp) continue
      if (meta.privacy === PRIVACY.SECRET && !query.includeSecret) continue
      if (!privacyAllows(meta.privacy, viewerKey, ownerQQ)) continue

      // 打分：关键词命中 + 重要性 + 新鲜度（钉住的一律靠前）
      let score = 0
      if (qTokens.length) {
        const hay = `${meta.title ?? ''} ${(meta.tags || []).join(' ')}`
        const hayTokens = new Set(tokenize(hay))
        let hits = 0
        for (const t of qTokens) if (hayTokens.has(t)) hits += 1
        // 原文也参与打分（只读命中的那些文件，代价可接受）
        score += hits * 2
        if (hits === 0) {
          // 标题没命中就去看原文（限制了每次最多扫 200 条索引，先按原文字符串找更快）
          const full = readOne(meta.id)
          const text = String(full?.text ?? '')
          if (q && text.includes(q)) score += 3
          else {
            const textTokens = new Set(tokenize(text))
            let textHits = 0
            for (const t of qTokens) if (textTokens.has(t)) textHits += 1
            score += textHits
          }
        }
        if (score <= 0) continue
      }
      score += Number(meta.importance) * 3
      if (meta.pinned) score += 4
      const ageDays = (Date.now() - Number(meta.at)) / 86400000
      score += Math.max(0, 2 - ageDays / 7)
      rows.push({ meta, score })
    }

    rows.sort((a, b) => b.score - a.score)
    const picked = rows.slice(0, limit).map(({ meta }) => {
      const full = readOne(meta.id)
      return {
        id: meta.id,
        at: meta.at,
        kind: meta.kind,
        title: meta.title,
        importance: meta.importance,
        pinned: !!meta.pinned,
        privacy: meta.privacy,
        from: meta.key,
        tags: meta.tags || [],
        text: String(full?.text ?? '').slice(0, 600),
      }
    })
    return { ok: true, count: picked.length, scanned: index.length, items: picked }
  }

  /** 记忆库规模统计。 */
  function stats(viewerKey) {
    loadIndex()
    const visible = index.filter((r) => privacyAllows(r.privacy, viewerKey, ownerQQ))
    const pinned = visible.filter((r) => r.pinned).length
    const byKey = {}
    for (const r of visible) byKey[r.key] = (byKey[r.key] || 0) + 1
    const ats = visible.map((r) => Number(r.at)).filter(Boolean)
    return {
      ok: true,
      total: index.length,
      visible: visible.length,
      pinned,
      oldest: ats.length ? Math.min(...ats) : 0,
      newest: ats.length ? Math.max(...ats) : 0,
      byKey,
    }
  }

  /** 取"永远进索引"的那批：钉住的 + 最近的 + 重要的。给 prompt 注入用。 */
  function digest(viewerKey, options2 = {}) {
    loadIndex()
    const limit = Math.max(1, Math.min(40, Number(options2.limit) || 12))
    const rows = index
      .filter((r) => privacyAllows(r.privacy, viewerKey, ownerQQ))
      .filter((r) => r.privacy !== PRIVACY.SECRET)
      .map((r) => ({
        r,
        score: (r.pinned ? 10 : 0) + Number(r.importance) * 5
          + Math.max(0, 3 - (Date.now() - Number(r.at)) / 86400000 / 10),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ r }) => ({
        id: r.id,
        at: r.at,
        title: r.title,
        importance: r.importance,
        pinned: !!r.pinned,
        from: r.key,
      }))
    return rows
  }

  // ───────────────────────── 隐私闸门（提醒 + 她放行）─────────────────────────
  //
  // 设计（用户 2026-11-04 定）：
  //   **"能不能看"不设限，"能不能说"是软约束 + 机械提醒。**
  //   闸门不阻止她思考，只在她要把**别人私下说的事**转述给第三方时提醒一句，
  //   并把放行权交回给她：她判断可以说 → 调 gateApprove 拿一次性放行票 → 再发一次即可。
  //   每次放行写一条审计（谁、什么时候、什么理由、涉及哪几条记忆）。
  //
  // 为什么是"12 字连续片段"而不是关键词：
  //   关键词（"换工作""吵架"）误报太多；12 字连续片段基本只有复述原话才会命中。

  const SHINGLE = 12
  const PASS_TTL_MS = 180000 // 放行票有效期 3 分钟
  const passes = new Map()   // `${key}|${hash}` -> { expiresAt, reason }

  /** 文本 → 12 字连续片段集合（去空白）。短于 12 字的整句当一片段（≥6 字才收）。 */
  function shingles(text) {
    const s = String(text ?? '').replace(/\s+/g, '')
    const out = new Set()
    if (s.length < SHINGLE) {
      if (s.length >= 6) out.add(s)
      return out
    }
    for (let i = 0; i + SHINGLE <= s.length; i += 1) out.add(s.slice(i, i + SHINGLE))
    return out
  }

  /** 轻量文本指纹（不是安全用途，只做"同一段话"的键）。 */
  function hashText(text) {
    const s = String(text ?? '')
    let h = 2166136261
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return `${s.length}:${(h >>> 0).toString(36)}`
  }

  /** 受保护池：来自**别的会话**的 owner / secret 级记忆（30 秒缓存）。 */
  let protectedCache = null
  function buildProtected(viewerKey) {
    loadIndex()
    const now = Date.now()
    if (protectedCache && protectedCache.viewerKey === viewerKey && now - protectedCache.builtAt < 30000) {
      return protectedCache
    }
    const list = []
    for (const meta of index) {
      if (meta.key === viewerKey) continue
      if (meta.privacy !== PRIVACY.OWNER && meta.privacy !== PRIVACY.SECRET) continue
      const full = readOne(meta.id)
      const text = String(full?.text ?? '')
      if (!text) continue
      list.push({
        id: meta.id,
        from: meta.key,
        privacy: meta.privacy,
        title: meta.title,
        shingles: shingles(text),
      })
    }
    protectedCache = { viewerKey, list, builtAt: now }
    return protectedCache
  }

  /**
   * 出站前的隐私检查。
   *
   * @returns {{allowed:boolean, hits:Array, needApprove:boolean, disclosed?:boolean}}
   *   allowed=false → 调用方应**拦下并提醒她**（不是永久拒绝：她可以放行后重发）。
   */
  function gateCheck(viewerKey, text) {
    const k = String(viewerKey ?? '')
    const owner = String(ownerQQ ?? '')
    // owner 私聊不检查：这些事他本来就知道
    if (owner && k === `private:${owner}`) return { allowed: true, hits: [], needApprove: false }

    const pool = buildProtected(k)
    if (!pool.list.length) return { allowed: true, hits: [], needApprove: false }
    const mine = shingles(text)
    if (!mine.size) return { allowed: true, hits: [], needApprove: false }

    const hits = []
    for (const rec of pool.list) {
      for (const sh of mine) {
        if (rec.shingles.has(sh)) {
          hits.push({ id: rec.id, from: rec.from, privacy: rec.privacy, title: rec.title, snippet: sh })
          break
        }
      }
      if (hits.length >= 3) break
    }
    if (!hits.length) return { allowed: true, hits: [], needApprove: false }

    const ticket = `${k}|${hashText(text)}`
    const pass = passes.get(ticket)
    if (pass && pass.expiresAt > Date.now()) {
      passes.delete(ticket) // 一次性
      appendAudit({ kind: 'disclose', key: k, reason: pass.reason, hits: hits.map((h) => h.id), at: Date.now() })
      return { allowed: true, hits, needApprove: false, disclosed: true }
    }
    return { allowed: false, hits, needApprove: true }
  }

  /** 她说"这句可以说" → 发一张一次性放行票（绑到这段文字）。 */
  function gateApprove(viewerKey, text, reason = '') {
    const k = String(viewerKey ?? '')
    const ticket = `${k}|${hashText(text)}`
    passes.set(ticket, { expiresAt: Date.now() + PASS_TTL_MS, reason: String(reason || '').slice(0, 200) })
    appendAudit({ kind: 'approve', key: k, reason: String(reason || '').slice(0, 200), at: Date.now() })
    return { ok: true, expiresInMs: PASS_TTL_MS }
  }

  /** 审计日志：谁在什么时候、以什么理由放行了哪几条隐私。 */
  function appendAudit(entry) {
    try {
      ensureDir(dir)
      fs.appendFileSync(path.join(dir, 'disclosure-audit.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
    } catch { /* 审计失败不影响主流程 */ }
  }

  return { dir, write, recall, readOne, stats, digest, gateCheck, gateApprove, loadIndex, indexPath }
}
