/**
 * 「会话 → 推理供应商」观察器（积分历史标签页按会话自动切源的取数依据）。
 *
 * ## 为什么存在
 *
 * 积分历史面板此前永远落在默认 `qodercn`：它不知道「当前会话用的是哪个
 * 供应商」。而会话日志里每条 `assistant/message` 事件都带
 * `data.message.source.provider`（如 `buddy` / `qodercn`；类型见
 * `@deepseek-ai/dsh-llm` 的 `AssistantProvenance`）—— 这就是权威数据源。
 * 本模块把它聚合成 `sessionId → 最近一次供应商`，供 jet-hub RPC 的
 * `session.provider` 方法查询。
 *
 * ## 两条取数路径
 *
 * 1. **实时**：`ctx.on('session/event')` 按游标重放（与 dsh-turn-usage 同款
 *    模式），扫 `assistant/message` 事件，记录每个 session 最近一次出现的
 *    provider。进程不重启时这条路径零额外 IO。
 * 2. **兜底（进程刚启动 / 内存未命中）**：按需解压
 *    `$DSH_HOME/sessions/<slug>/session-<id>/session.v4.jsonl.zstd`
 *    （`node:zlib` 自带 `zstdDecompressSync`，无新依赖），倒序找最后一条带
 *    provider 的 `assistant/message`。结果记忆，同一会话只解压一次。
 *
 * ## 为什么兜底不做成「启动时全量扫盘」
 *
 * 会话目录可能有成百上千个，启动全扫会把 dsh 启动拖慢几十秒（集群 FS 上更
 * 糟）。「问到才查 + 记忆」把成本摊到实际用到的那一次（单文件解压几十毫秒）。
 *
 * ## 内存与泄漏
 *
 * 缓存以 sessionId 为键、条目只含 `{ provider, ts }`；上限 `MAX_CACHE`，
 * 超限按插入序淘汰最早一条（近似 LRU）。游标用 `WeakMap` 以 session 对象为
 * 键，session 回收后自动消失。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 兜底缓存条目上限：超过后按插入序淘汰最早的一条。 */
const MAX_CACHE = 512

/**
 * 单个会话文件的解压输入上限（字节）。正常会话远小于此；截断只可能丢最早
 * 的历史，而我们要的恰是**最后**一条 —— 不影响正确性，只防异常巨文件拖垮内存。
 */
const MAX_SCAN_BYTES = 64 * 1024 * 1024

/** 会话日志事件的最小结构（只取本模块用到的字段；避免依赖非直接依赖包的类型）。 */
interface SessionEventLike {
  type?: unknown
  time?: unknown
  data?: unknown
}

/** `ctx.on('session/event')` 推过来的 session 对象的最小结构。 */
interface SessionLike {
  id: string
  seq: number
  eventAt(seq: number): SessionEventLike | undefined
}

/** `ctx.on` 的最小结构（cordis 的 EventEmitter 形态；回调注册用不到泛型）。 */
interface ContextLike {
  on(name: 'session/event', listener: (session: SessionLike) => void): unknown
}

/** 缓存条目：provider 为 `undefined` 表示「确定没有」（负缓存，避免反复解压）。 */
interface ProviderEntry {
  provider: string | undefined
  ts: number
}

/** 从 assistant/message 事件里取 provider；非模型来源（sidechat 等）没有 source.provider。 */
function providerFromEvent(event: SessionEventLike | undefined): string | undefined {
  if (event?.type !== 'assistant/message') return undefined
  const data = event.data as { message?: { source?: { kind?: unknown; provider?: unknown } } } | undefined
  const source = data?.message?.source
  // 只有 `kind: 'model'` 的来源带 provider（`@deepseek-ai/dsh-llm` 的
  // ModelMessageSource）；工具结果来源（kind:'tool'）与伪 provider 一并排除。
  if (source?.kind !== 'model') return undefined
  return typeof source.provider === 'string' && source.provider.length > 0
    ? source.provider
    : undefined
}

export class SessionProviderObserver {
  /** sessionId → 观测结果；按插入序淘汰（#remember 里重插实现刷新）。 */
  readonly #cache = new Map<string, ProviderEntry>()
  /** session 对象 → 已重放的 seq 数；WeakMap，随 session 回收。 */
  readonly #cursors = new WeakMap<SessionLike, number>()

  /** 订阅 `session/event`。回调内纯同步、零 IO（重放只遍历内存事件）。 */
  attach(ctx: ContextLike): void {
    // 最小测试桩 / 非标准宿主可能没有 ctx.on：没有就不订阅，查询退化为
    // 纯磁盘兜底路径（providerOf 的 #scanFromDisk 不依赖监听）。
    if (typeof ctx?.on !== 'function') return
    ctx.on('session/event', (session) => {
      let consumed = this.#cursors.get(session) ?? 0
      while (consumed < session.seq) {
        const event = session.eventAt(consumed)
        const provider = providerFromEvent(event)
        if (provider !== undefined) {
          this.#remember(session.id, { provider, ts: typeof event?.time === 'number' ? event.time : Date.now() })
        }
        consumed += 1
      }
      this.#cursors.set(session, consumed)
    })
  }

  /**
   * 查询一个会话最近使用的供应商。
   *
   * @returns provider id（如 `'buddy'`）；内存与磁盘都查不到时 `undefined`
   *   （纯空白会话 / 会话文件已清），由调用方回落到默认行为。
   */
  providerOf(sessionId: string): string | undefined {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
    const cached = this.#cache.get(sessionId)
    if (cached !== undefined) return cached.provider
    return this.#scanFromDisk(sessionId)
  }

  /** 记录一次观测；重插刷新插入序（近似 LRU），超限淘汰最早。 */
  #remember(sessionId: string, entry: ProviderEntry): void {
    this.#cache.delete(sessionId)
    this.#cache.set(sessionId, entry)
    if (this.#cache.size > MAX_CACHE) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
  }

  /** 兜底：解压会话文件找 provider；结果（含「确定没有」）记忆后返回。 */
  #scanFromDisk(sessionId: string): string | undefined {
    if (this.#cache.has(sessionId)) return this.#cache.get(sessionId)?.provider
    let entry: ProviderEntry
    try {
      entry = this.#readProviderFromSessionFile(sessionId)
    } catch {
      // 解压失败 / 损坏文件：按「没有」处理并负缓存 —— 慢盘不该被反复重试。
      entry = { provider: undefined, ts: 0 }
    }
    this.#remember(sessionId, entry)
    return entry.provider
  }

  /** 在 `$DSH_HOME/sessions/<slug>/session-<id>/session.v4.jsonl.zstd` 里找 provider。 */
  #readProviderFromSessionFile(sessionId: string): ProviderEntry {
    const home = process.env.DSH_HOME?.trim() || join(process.env.HOME ?? '', '.dsh')
    const sessionsRoot = join(home, 'sessions')
    if (!existsSync(sessionsRoot)) return { provider: undefined, ts: 0 }
    for (const slug of readdirSync(sessionsRoot)) {
      const file = join(sessionsRoot, slug, `session-${sessionId}`, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const buf = readFileSync(file).subarray(0, MAX_SCAN_BYTES)
      const lines = zstdDecompressSync(buf).toString('utf8').split('\n')
      // 倒序找：最后一条带 provider 的 assistant/message 即「最近用的」。
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i]
        if (!line.includes('"assistant/message"')) continue
        let event: SessionEventLike
        try {
          event = JSON.parse(line) as SessionEventLike
        } catch {
          continue
        }
        const provider = providerFromEvent(event)
        if (provider !== undefined) {
          return { provider, ts: typeof event.time === 'number' ? event.time : 0 }
        }
      }
      // 文件里没有任何带 provider 的消息：确定没有。
      return { provider: undefined, ts: 0 }
    }
    // 所有 cwd 桶里都找不到该会话的文件：确定没有。
    return { provider: undefined, ts: 0 }
  }
}

/** 创建并挂载观察器；返回查询句柄（jet-hub RPC 的 `session.provider` 用）。 */
export function observeSessionProviders(ctx: ContextLike): SessionProviderObserver {
  const observer = new SessionProviderObserver()
  observer.attach(ctx)
  return observer
}
