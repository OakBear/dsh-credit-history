import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CREDIT_HISTORY_API_PATH, registerHistoryRpc } from '../../src/rpc-server.js'
import { CreditHistory } from '../../src/credit-history.js'
import { observeSessionProviders } from '../../src/session-provider-observer.js'
import type { HistoryAccountEntry } from '../../src/credit-history-rpc.js'

/**
 * 积分历史**端到端 RPC**（`history.read` / `history.configure`）。
 *
 * 与 `credit-history-wiring.spec.ts` 的分工：那个文件测**装配**（取数适配器
 * 与引擎构造），本文件测**线上通道** —— 从 `connection.fetch` 的 POST 端点
 * 进来，经 `handleMethod` 到引擎，再回到响应信封。这条链路上任何一环出错
 * （分支没接上、`history` 为 undefined、参数名写错）都会表现为
 * **前端「积分历史」标签页永远空白**，而单测全绿 —— 故必须真跑一遍。
 *
 * ⚠️ 独立插件后端点由 `registerHistoryRpc` 注册（路径 `/api/credit-history`），
 * 引擎在 harness 里本地构造 —— 不依赖宿主账号池，桩面最小。
 */

const MINUTE = 60_000

/** 复刻真实 `ctx` 的最小形态（与 `jet-hub-rpc.spec.ts` 的替身同思路）。 */
interface Harness {
  post(method: string, payload: unknown): Promise<{ ok: boolean; value?: any; error?: { code: string; message: string } }>
  readonly home: string
}

function harness(home: string, accounts: HistoryAccountEntry[]): Harness {
  /**
   * home 经 `DSH_JET_HUB_STATE_DIR` 交给装配层（与生产 `resolveDshHome` 同一
   * 优先级链）。不设的话引擎会写到**真实的** `~/.dsh/jet-hub/` —— 既污染
   * 开发机，断言也会因为「文件不在我以为的位置」而失败。
   */
  process.env.DSH_JET_HUB_STATE_DIR = home
  let handler: ((request: Request) => Promise<Response>) | undefined

  const connection = {
    fetch: {
      register: (config: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        if (config.path === CREDIT_HISTORY_API_PATH) handler = config.fetch
      },
    },
  }
  const ctx = {
    get: (key: string) => key === 'connection' ? connection : undefined,
    logger: { warn: () => {}, info: () => {} },
    effect: () => () => {},
  }

  // 本地构造引擎：query 直接回「无账号读数」的空结果（本文件只测通道与
  // 引擎的读改入口，不打上游）；accounts 来自测试参数。
  const history = new CreditHistory({
    home,
    query: async () => ({ ok: true, value: { accounts: [] } }),
    accounts: async () => accounts,
    warn: () => {},
  })

  registerHistoryRpc(connection, history)

  return {
    home,
    async post(method, payload) {
      if (!handler) throw new Error('端点未注册（connection.fetch.register 未被调用）')
      const response = await handler(new Request(`http://localhost${CREDIT_HISTORY_API_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'credit-history', payload: { method, payload } }),
      }))
      const body = await response.json() as { result: { ok: boolean; value?: any; error?: { code: string; message: string } } }
      return body.result
    },
  }
}

/** 一个启用账号（积分历史只在有启用账号时才采样）。 */
function enabledAccount(id = 'acc-1'): HistoryAccountEntry {
  return {
    id, provider: 'buddy', nickname: id, enabled: true, credentialRef: 'REF', createdAt: 1,
  } as HistoryAccountEntry & { provider: string; createdAt: number }
}

describe('端点注册', () => {
  it('history.read 与 history.configure 都在 Jet Hub 的 switch 分支里', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    // 若分支未接上，两者都会落到 `default` 分支回 `unknown method`。
    for (const method of ['history.read', 'history.configure']) {
      const result = await h.post(method, {})
      expect(result.error?.message ?? '', `${method} 落到了 default 分支`).not.toContain('unknown method')
    }
  })
})

describe('history.read：本地读历史，绝不打上游', () => {
  it('空历史返回可渲染的空结构（而不是错误）', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('history.read', { provider: 'buddy', hours: 24 })
    expect(result.ok).toBe(true)
    expect(result.value.accounts).toEqual([])
    expect(result.value.intervalMinutes).toBe(5)
    expect(result.value.retentionDays).toBe(30)
  })

  it('⚠️ provider 为空必须拒绝（避免「全部来源」这种没有定义的查询）', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('history.read', { provider: '   ' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('provider 不能为空')
  })

  it('⚠️ 越界 hours 由引擎夹取，不报错（显示窗口不是写入参数）', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    for (const hours of [0, -5, 99999, 'abc']) {
      const result = await h.post('history.read', { provider: 'buddy', hours })
      expect(result.ok, `hours=${String(hours)} 不该失败`).toBe(true)
    }
  })
})

describe('history.configure：非法值拒绝并透传中文报错', () => {
  it('只接受 5 / 15，其余给中文错误', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('history.configure', { intervalMinutes: 7 })
    expect(result.ok).toBe(false)
    // 引擎的中文校验文案必须**原样**透传到前端，否则用户只看到「保存失败」。
    expect(result.error?.message).toContain('仅支持 5 或 15 分钟采样')
  })

  it('合法值生效并**落盘**（重启后不回退）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e2e-'))
    const h = harness(home, [enabledAccount()])
    const saved = await h.post('history.configure', { intervalMinutes: 15, enabled: false })
    expect(saved.ok).toBe(true)
    expect(saved.value).toEqual({ enabled: false, intervalMinutes: 15 })
    // 落盘位置必须是 jet-hub 目录（单一存储）。
    const file = join(home, 'jet-hub', 'credit-history.json')
    expect(existsSync(file)).toBe(true)
    const state = JSON.parse(readFileSync(file, 'utf8')) as { intervalMinutes: number; enabled: boolean }
    expect(state.intervalMinutes).toBe(15)
    expect(state.enabled).toBe(false)
  })

  it('enabled 必须是布尔值（字符串 "false" 不能被当成 false）', async () => {
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('history.configure', { enabled: 'false' })
    expect(result.ok).toBe(false)
    expect(result.error?.message).toContain('enabled 必须是布尔值')
  })
})

describe('history.read 读回真实历史（读盘 → view → 信封）', () => {
  /**
   * 预置一份**真实形态**的存储：3 个点 —— 正常消耗 → 一段 3 天空缺 → 正常消耗，
   * 且只有第 1 点带 `packages`（正是增量编码写出的形态）。
   *
   * ⚠️ 时间基准必须取 **`Date.now()`**，不能写死常量：`prune()` 会丢弃 30 天
   * 以外的点，写死一个「看起来像 2025 年」的毫秒值会让**全部点被清空**，
   * 现象是「读回 0 个点」—— 极易误判成引擎坏了（本会话为此白查过两次）。
   */
  const seed = (home: string, at = Date.now() - 3 * 24 * 60 * MINUTE) => {
    mkdirSync(join(home, 'jet-hub'), { recursive: true })
    const packages = [{ id: 'p1', name: '资源包', total: 100 }]
    writeFileSync(join(home, 'jet-hub', 'credit-history.json'), JSON.stringify({
      version: 1, enabled: true, intervalMinutes: 5,
      series: {
        'buddy/buddy-9369510a': {
          provider: 'buddy', accountId: 'buddy-9369510a', nickname: 'uuwm',
          points: [
            { at, status: 'ok', total: 1000, expiredTotal: 0, packages },
            { at: at + 5 * MINUTE, status: 'ok', total: 940, expiredTotal: 0 },
            { at: at + 3 * 24 * 60 * MINUTE, status: 'ok', total: 820, expiredTotal: 0 },
          ],
        },
      },
      attempts: { buddy: at + 3 * 24 * 60 * MINUTE }, failures: {},
    }))
    return at
  }

  it('⚠️ 只有第 1 点带 packages，但 3 个点都必须拿到完整 packages', async () => {
    // 这锁的是增量编码的**还原**路径：省略 packages 的点若在 view() 里
    // 退化成 null，面板的「资源包」列会时有时无 —— 用户看到的是
    // 「资源包凭空消失又出现」，而数据其实一直都在。
    const home = mkdtempSync(join(tmpdir(), 'e2e-'))
    const at = seed(home)
    const result = await harness(home, [enabledAccount()]).post('history.read', { provider: 'buddy', hours: 24 * 30 })
    expect(result.ok).toBe(true)
    const points = result.value.accounts[0].points
    expect(points).toHaveLength(3)
    for (const [index, point] of points.entries()) {
      expect(point.packages, `第 ${index + 1} 点的 packages 未被还原`).toHaveLength(1)
      expect(typeof point.at).toBe('number')   // 走势图的 x 轴依赖它
    }
    // 相邻正常采样的消耗被算出，且用的是**真实时间差**（5 分钟）。
    expect(points[1].change).toEqual({ kind: 'usage', minutes: 5, amount: 60 })
    // ⚠️ 3 天空缺必须标成 gap，不能被当成「3 天消耗了 120」——
    // 那会画出一条缓慢下滑的直线，正是用户要求「合并缺口」时要避免的误导。
    expect(points[2].change.kind).toBe('gap')
    expect(points[2].change.kind).not.toBe('usage')
    expect(at).toBeLessThan(Date.now())
  })

  it('⚠️ 显示窗口收窄时旧点被夹掉（1 小时窗口看不到 3 天前的点）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e2e-'))
    seed(home)
    const h = harness(home, [enabledAccount()])
    const wide = await h.post('history.read', { provider: 'buddy', hours: 24 * 30 })
    const narrow = await h.post('history.read', { provider: 'buddy', hours: 1 })
    expect(wide.value.accounts[0].points.length).toBe(3)
    expect(narrow.value.accounts[0].points.length).toBeLessThan(3)
  })

  it('⚠️ 未知来源优雅回空，而不是报错', async () => {
    // 与 `balances()` 的「不支持的积分来源」拒绝**有意不同**：问一个没有数据的
    // 来源，答案就是「没有」。若改成报错，某个来源被移除后，仍开着旧标签页的
    // 用户会看到一片红字，而正确表现是「暂无数据」。
    const h = harness(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('history.read', { provider: 'nope' })
    expect(result.ok).toBe(true)
    expect(result.value.accounts).toEqual([])
  })
})

describe('⚠️ 与独立插件并存时不会互相覆盖数据', () => {
  it('旧位置的文件存在时，端点仍只写 jet-hub 一份，且旧文件保持原样', async () => {
    const home = mkdtempSync(join(tmpdir(), 'e2e-'))
    // 模拟「独立插件还在跑」：旧位置有一份属于它自己的数据。
    mkdirSync(join(home, 'credit-history'), { recursive: true })
    const legacyFile = join(home, 'credit-history', 'history.json')
    const legacyBody = JSON.stringify({ version: 1, enabled: true, intervalMinutes: 15, series: {}, attempts: {}, failures: {} })
    writeFileSync(legacyFile, legacyBody)

    const h = harness(home, [enabledAccount()])
    const result = await h.post('history.configure', { intervalMinutes: 15 })
    expect(result.ok).toBe(true)

    // 旧文件**逐字节未变** —— 回滚独立插件时数据还在。
    expect(readFileSync(legacyFile, 'utf8')).toBe(legacyBody)
    // 新数据落在 jet-hub 目录。
    expect(existsSync(join(home, 'jet-hub', 'credit-history.json'))).toBe(true)
  })
})

/**
 * `session.provider`：积分历史面板「按会话自动切源」的取数端点。
 *
 * 测三件事：① 分支真的接上了（不落 default 的 `unknown method`）；
 * ② 实时观察路径 —— 同一进程里发生过的 `assistant/message` 能被查到；
 * ③ 查不到（未知会话 / 缺 sessionId）返回 `provider: null` 而不是报错，
 *    让前端静默回落到「可用探针」行为。
 */

/** harness 变体：额外捕获 `session/event` 监听器（观察器的实时路径）。 */
function harnessWithEvents(home: string, accounts: HistoryAccountEntry[]): {
  post: Harness['post']
  emit: (session: unknown) => void
} {
  process.env.DSH_JET_HUB_STATE_DIR = home
  let handler: ((request: Request) => Promise<Response>) | undefined

  const eventListeners: Array<(session: never) => void> = []
  const connection = {
    fetch: {
      register: (config: { path: string; fetch: (request: Request) => Promise<Response> }) => {
        if (config.path === CREDIT_HISTORY_API_PATH) handler = config.fetch
      },
    },
  }
  const ctx = {
    get: (key: string) => key === 'connection' ? connection : undefined,
    logger: { warn: () => {}, info: () => {} },
    effect: () => () => {},
    on: (name: string, listener: (session: never) => void) => {
      if (name === 'session/event') eventListeners.push(listener)
      return () => {}
    },
  }

  const history = new CreditHistory({
    home,
    query: async () => ({ ok: true, value: { accounts: [] } }),
    accounts: async () => accounts,
    warn: () => {},
  })

  // 观察器在 registerHistoryRpc 之前挂上（生产 apply() 也是这个顺序），
  // session/event 重放契约与宿主一致：{ id, seq, eventAt(seq) }。
  const observer = observeSessionProviders(ctx)
  registerHistoryRpc(connection, history, observer)

  const post = async (method: string, payload: unknown) => {
    if (!handler) throw new Error('端点未注册（connection.fetch.register 未被调用）')
    const response = await handler(new Request(`http://localhost${CREDIT_HISTORY_API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'credit-history', payload: { method, payload } }),
    }))
    const body = await response.json() as { result: { ok: boolean; value?: any; error?: { code: string; message: string } } }
    return body.result
  }
  return { post, emit: (session) => { for (const listener of eventListeners) listener(session as never) } }
}

describe('session.provider：按会话查最近使用的供应商', () => {
  it('未知会话返回 ok + provider:null（不报错，前端据此回落到可用探针）', async () => {
    const h = harnessWithEvents(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('session.provider', { sessionId: 'no-such-session' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ provider: null })
  })

  it('实时观察：session/event 里的 assistant/message.source.provider 能被查到', async () => {
    const h = harnessWithEvents(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    // 复刻 dsh-session 的重放契约：seq=1 且 eventAt(0) 是带 provider 的消息。
    h.emit({
      id: 'sess-1',
      seq: 1,
      eventAt: (seq: number) => seq === 0
        ? { type: 'assistant/message', time: 1000, data: { message: { source: { kind: 'model', provider: 'buddy' } } } }
        : undefined,
    })
    const result = await h.post('session.provider', { sessionId: 'sess-1' })
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ provider: 'buddy' })
  })

  it('⚠️ 非模型来源（kind 不为 model）不算数：查不到就回落 null', async () => {
    const h = harnessWithEvents(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    h.emit({
      id: 'sess-2',
      seq: 1,
      eventAt: (seq: number) => seq === 0
        ? { type: 'assistant/message', time: 1000, data: { message: { source: { kind: 'tool', callId: 'c1' } } } }
        : undefined,
    })
    const result = await h.post('session.provider', { sessionId: 'sess-2' })
    expect(result.value).toEqual({ provider: null })
  })

  it('⚠️ 缺 sessionId 不报错（前端旧版本可能不带）', async () => {
    const h = harnessWithEvents(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
    const result = await h.post('session.provider', {})
    expect(result.ok).toBe(true)
    expect(result.value).toEqual({ provider: null })
  })

  it('⚠️ 磁盘兜底不命中真实目录外的会话（不越出 DSH_JET_HUB_STATE_DIR/DSH_HOME 语义）', async () => {
    // 用临时 home：观察器的磁盘兜底读 DSH_HOME —— 指到空临时目录，确认查未知
    // 会话仍是干净 null 且有负缓存（第二次查询同样快速返回，不抛错）。
    const home = mkdtempSync(join(tmpdir(), 'e2e-'))
    const oldHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const h = harnessWithEvents(mkdtempSync(join(tmpdir(), 'e2e-')), [enabledAccount()])
      for (let i = 0; i < 2; i += 1) {
        const result = await h.post('session.provider', { sessionId: 'sess-disk-miss' })
        expect(result.ok).toBe(true)
        expect(result.value).toEqual({ provider: null })
      }
    } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
    }
  })
})
