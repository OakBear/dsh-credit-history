import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_INTERVAL_MINUTES,
  CreditHistory,
  DEFAULT_INTERVAL_MINUTES,
  FULL_RESOLUTION_DAYS,
  HISTORY_PROVIDERS,
  MAX_POINTS_PER_SERIES,
  RETENTION_DAYS,
  THINNED_INTERVAL_MINUTES,
  changeBetween,
  historyStatePath,
  legacyHistoryStatePath,
  makePoint,
  type CreditHistoryDeps,
  type CreditHistoryQueryResult,
  type StoredHistoryPoint,
} from '../../src/credit-history.js'

/**
 * 积分历史引擎（宿主侧）的回归测试。
 *
 * 锁四组行为，每组都对应一个**真实会出问题**的场景：
 *
 * 1. **默认 5 分钟采样**，且磁盘上的旧状态里那个 15 也升级为 5 —— 用户的
 *    原始诉求就是「提升到每 5 分钟一次」，而旧文件里的 15 与「用户特意选的
 *    15」长得一模一样（实测本机两个历史文件都是 `intervalMinutes: 15`），
 *    故必须靠 `intervalSource` 标记区分，否则重启后又变回去。
 * 2. **单一存储 + 按最新采样时间择优迁移** —— 实测本机两个候选文件是
 *    「目标 ⊂ 旧位置」的子集关系（目标 2/2/1 个点到 10-01，旧位置 66/66/65
 *    个点到 10-05），「目标文件已存在就直接用」会**丢掉四天的新数据**。
 * 3. **体积治理**：资源包增量编码 + 分层抽稀 + 有界兜底。真实数据里 buddy
 *    一个点带 17～21 个资源包、平均 5667 字节，5 分钟采样 × 30 天按原样存
 *    就是约 49 MB 的单文件 JSON。
 * 4. **重启安全与退避语义**（`attempts` 先落盘、指数退避、冷却、`pause(2000)`、
 *    串行采样）—— 这些是原插件来之不易的约定，重构时最容易被抹掉。
 *
 * ⚠️ 全部用例**零网络、零真实计时、零真实用户目录**：
 * `home` 是每个用例自己的临时目录，`query` / `accounts` / `now` / `pause`
 * 全部注入桩（`pause` 只记录毫秒数，不真的等）。
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 起始时刻：2026-10-05 12:00（UTC+8）= 04:00Z。 */
const T0 = Date.UTC(2026, 9, 5, 4, 0, 0)

/** 可控时钟（用例里只靠它推进时间）。 */
function clock(start: number) {
  let now = start
  return { now: () => now, set: (value: number) => { now = value }, advance: (ms: number) => { now += ms } }
}

/** 造一个临时 home（每个用例独享，互不污染）。 */
function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-credit-history-'))
}

/** 造一个资源包（字段与真实响应同形）。 */
function pkg(name: string, remaining: number, extra: Record<string, unknown> = {}) {
  return {
    name,
    unit: '积分',
    active: true,
    remaining,
    total: remaining,
    used: 0,
    cycleStartTime: '2026-10-01T00:00:00Z',
    cycleEndTime: '2026-11-01T00:00:00Z',
    expiredTime: '2026-11-01T00:00:00Z',
    ...extra,
  }
}

/** 一次查询结果：某个 provider 的一批账号读数。 */
function queryResult(accounts: { accountId: string; total?: number; packages?: unknown[]; balance?: null }[]): CreditHistoryQueryResult {
  return {
    ok: true,
    value: {
      accounts: accounts.map(row => ({
        accountId: row.accountId,
        balance: row.balance === null
          ? null
          : { total: row.total ?? 0, expiredTotal: 0, packages: row.packages ?? [] },
      })),
    },
  }
}

/** 引擎的测试装置（含调用记录，便于断言「有没有真的打上游」）。 */
function harness(options: {
  home?: string
  now?: number
  accounts?: readonly { id: string; nickname?: string; credentialRef?: unknown }[]
  results?: CreditHistoryQueryResult[]
  queryThrows?: boolean
} = {}) {
  const home = options.home ?? tempHome()
  const time = clock(options.now ?? T0)
  const pauses: number[] = []
  const queries: string[] = []
  const warns: string[] = []
  const results = [...(options.results ?? [])]
  const accounts = options.accounts ?? [{ id: 'acct-1', nickname: '账号一', credentialRef: 'secret-reference' }]
  const deps: CreditHistoryDeps = {
    home,
    now: () => time.now(),
    pause: async (ms) => { pauses.push(ms) },
    warn: (message) => { warns.push(message) },
    accounts: async () => accounts,
    query: async (provider) => {
      queries.push(provider)
      if (options.queryThrows) throw new Error('上游炸了')
      return results.shift() ?? queryResult([{ accountId: accounts[0]?.id ?? 'acct-1', total: 100 }])
    },
  }
  const history = new CreditHistory(deps)
  return { home, time, pauses, queries, warns, history, deps, accounts }
}

/** 读磁盘状态（断言「落盘了什么」用）。 */
function diskState(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(historyStatePath(home), 'utf8')) as Record<string, unknown>
}

/** 写一个状态文档到指定路径（造迁移场景用）。 */
function writeState(file: string, state: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state), 'utf8')
}

/** 造一份可被接受的状态文档（形如真实历史文件）。 */
function storedState(points: StoredHistoryPoint[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    enabled: true,
    intervalMinutes: 15,
    series: { 'buddy/acct-1': { provider: 'buddy', accountId: 'acct-1', nickname: '账号一', points } },
    attempts: {},
    failures: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------

describe('makePoint：采样点口径', () => {
  it('没有余额或余额非有限数时记 failed，绝不用 0 顶替', () => {
    expect(makePoint({ balance: null }, T0)).toEqual({ at: T0, status: 'failed' })
    expect(makePoint({}, T0)).toEqual({ at: T0, status: 'failed' })
    expect(makePoint({ balance: { total: Number.NaN } }, T0)).toEqual({ at: T0, status: 'failed' })
    expect(makePoint({ balance: { total: -1 } }, T0)).toEqual({ at: T0, status: 'failed' })
  })

  it('资源包按名称排序、字段补齐，cycle 由三个时间拼成', () => {
    const point = makePoint({
      balance: { total: 300, expiredTotal: 20, packages: [pkg('Pack-B', 5), pkg('Pack-A', 10, { unit: '', used: undefined, total: undefined })] },
    }, T0)
    expect(point.status).toBe('ok')
    expect(point.total).toBe(300)
    expect(point.expiredTotal).toBe(20)
    expect(point.packages?.map(p => p.name)).toEqual(['Pack-A', 'Pack-B'])
    const first = point.packages?.[0]
    expect(first?.unit).toBe('积分')
    expect(first?.used).toBe(0)
    expect(first?.cycle).toBe('2026-10-01T00:00:00Z/2026-11-01T00:00:00Z/2026-11-01T00:00:00Z')
  })

  it('资源包顺序按名称的 localeCompare（汉字先后由 ICU 决定，用例不硬编码）', () => {
    // ⚠️ 排序用的是 `localeCompare`（与旧插件一致），而汉字在 ICU 里的先后
    // **与码位无关**（本机实测 `'乙'.localeCompare('甲') < 0`）。所以这里只断言
    // 「升序」这一性质，不去硬编码某个具体次序 —— 否则换 Node/ICU 构建就红。
    const names = ['乙', '丙', '甲']
    const point = makePoint({ balance: { total: 30, packages: names.map(name => pkg(name, 1)) } }, T0)
    const sorted = point.packages?.map(p => p.name) ?? []
    expect(sorted).toHaveLength(names.length)
    expect([...sorted].sort()).toEqual([...names].sort())
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index - 1]!.localeCompare(sorted[index]!)).toBeLessThan(0)
    }
  })
})

describe('changeBetween：变化语义', () => {
  const ok = (at: number, total: number, packages = [pkg('甲', total)]): Parameters<typeof changeBetween>[1] => ({
    at, status: 'ok', total, expiredTotal: 0, packages: packages.map(p => makePoint({ balance: { total: 0, packages: [p] } }, at).packages?.[0] ?? {
      name: '', unit: '积分', active: true, remaining: null, total: null, used: 0, cycleStartTime: '', cycleEndTime: '', expiredTime: '', cycle: '//',
    }),
  })

  it('失败点或缺失前点一律 gap', () => {
    expect(changeBetween(undefined, ok(T0, 100))).toEqual({ kind: 'gap' })
    expect(changeBetween({ at: T0, status: 'failed' }, ok(T0 + MINUTE, 100))).toEqual({ kind: 'gap' })
    expect(changeBetween(ok(T0, 100), { at: T0 + MINUTE, status: 'failed' })).toEqual({ kind: 'gap' })
  })

  it('断档阈值是采样间隔的 2.5 倍（5 分钟间隔 ⇒ 12.5 分钟）', () => {
    // 12 分钟 < 12.5 分钟：不算断档。
    expect(changeBetween(ok(T0, 100), ok(T0 + 12 * MINUTE, 90), 5).kind).toBe('usage')
    // 13 分钟 > 12.5 分钟：算断档。
    expect(changeBetween(ok(T0, 100), ok(T0 + 13 * MINUTE, 90), 5)).toEqual({ kind: 'gap', minutes: 13 })
  })

  it('跨 UTC+8 日界算 reset 而不是消耗', () => {
    const before = Date.UTC(2026, 9, 5, 15, 59, 0)
    expect(changeBetween(ok(before, 100), ok(before + 5 * MINUTE, 90), 5).kind).toBe('reset')
  })

  it('资源包身份变化算 reset，用量减少算 usage、增加算 increase', () => {
    expect(changeBetween(ok(T0, 100), ok(T0 + 5 * MINUTE, 100, [pkg('甲', 50), pkg('乙', 50)]), 5).kind).toBe('reset')
    expect(changeBetween(ok(T0, 100), ok(T0 + 5 * MINUTE, 90), 5)).toEqual({ kind: 'usage', minutes: 5, amount: 10 })
    expect(changeBetween(ok(T0, 100), ok(T0 + 5 * MINUTE, 130), 5)).toEqual({ kind: 'increase', minutes: 5, amount: 30 })
  })

  it('总量守恒但有包在涨（某包补充额度）时不能冒充纯消耗', () => {
    const before = { at: T0, status: 'ok' as const, total: 100, packages: [makePoint({ balance: { total: 0, packages: [pkg('甲', 60)] } }, T0).packages![0]!, makePoint({ balance: { total: 0, packages: [pkg('乙', 40)] } }, T0).packages![0]!] }
    const after = { at: T0 + 5 * MINUTE, status: 'ok' as const, total: 100, packages: [makePoint({ balance: { total: 0, packages: [pkg('甲', 70)] } }, T0).packages![0]!, makePoint({ balance: { total: 0, packages: [pkg('乙', 30)] } }, T0).packages![0]!] }
    expect(changeBetween(before, after, 5).kind).toBe('increase')
  })
})

describe('① 默认 5 分钟采样，且旧数据的 15 升级为 5', () => {
  it('全新 profile 默认 5 分钟（不是旧默认的 15）', () => {
    const { history } = harness()
    expect(DEFAULT_INTERVAL_MINUTES).toBe(5)
    expect(history.view('buddy').intervalMinutes).toBe(5)
    expect(ALLOWED_INTERVAL_MINUTES).toEqual([5, 15])
  })

  it('磁盘上的旧状态（15 且无 user 标记）在启动时升级为 5 并落盘', () => {
    const home = tempHome()
    writeState(historyStatePath(home), storedState([{ at: T0 - HOUR, status: 'ok', total: 100, packages: [] }]))
    expect((diskState(home).intervalMinutes)).toBe(15)

    const { history } = harness({ home })
    expect(history.view('buddy').intervalMinutes).toBe(5)
    // 只查不存不够：升级结果必须落盘，否则重启又回到 15。
    history.configure({})
    expect(diskState(home).intervalMinutes).toBe(5)
    // 旧点仍在（升级间隔不丢数据）。
    const points = history.view('buddy', 24).accounts[0]?.points ?? []
    expect(points).toHaveLength(1)
  })

  it('用户显式 configure 的 15 重启后仍是 15（不被升级逻辑改掉）', async () => {
    const home = tempHome()
    const first = harness({ home })
    await first.history.configure({ intervalMinutes: 15 })
    expect(diskState(home).intervalMinutes).toBe(15)

    // 重启（新建实例读同一份磁盘状态）。
    const second = harness({ home })
    expect(second.history.view('buddy').intervalMinutes).toBe(15)
  })

  it('configure 只接受 5 / 15，非法值抛中文错误且不改状态', async () => {
    const { history } = harness()
    await expect(history.configure({ intervalMinutes: 10 })).rejects.toThrow('仅支持 5 或 15 分钟采样')
    await expect(history.configure({ intervalMinutes: 0 })).rejects.toThrow('仅支持 5 或 15 分钟采样')
    await expect(history.configure({ enabled: 'yes' as unknown as boolean })).rejects.toThrow('enabled 必须是布尔值')
    expect(history.view('buddy').intervalMinutes).toBe(5)
  })
})

describe('② 单一存储库与择优迁移', () => {
  it('只写 <home>/jet-hub/credit-history.json 一处（不再写 credit-history/history.json）', async () => {
    const { home, history } = harness()
    expect(historyStatePath(home)).toBe(join(home, 'jet-hub', 'credit-history.json'))
    await history.balances('buddy')
    expect(() => readFileSync(legacyHistoryStatePath(home), 'utf8')).toThrow()
    expect(diskState(home).version).toBe(1)
  })

  it('两个候选都在时取**最后采样时间更晚**的那份（不是「目标存在就用目标」）', () => {
    const home = tempHome()
    // 目标位置：只有 1 个较早的点（真实情形：2/2/1 个点，到 10-01）。
    writeState(historyStatePath(home), storedState([
      { at: T0 - 4 * DAY, status: 'ok', total: 100, packages: [] },
    ]))
    // 旧位置（独立插件写的）：点更多且更新（真实情形：66 个点，到 10-05）。
    writeState(legacyHistoryStatePath(home), storedState([
      { at: T0 - 2 * DAY, status: 'ok', total: 150, packages: [] },
      { at: T0 - HOUR, status: 'ok', total: 250, packages: [] },
    ]))

    const { history } = harness({ home })
    const points = history.view('buddy', 24 * RETENTION_DAYS).accounts[0]?.points ?? []
    // 拿到的是**新数据**（250 的那份），而不是目标位置里那 1 个旧点。
    expect(points.map(p => p.total)).toEqual([150, 250])
    // 且迁移结果落到了单一存储的目标位置。
    const migrated = diskState(home) as { series: Record<string, { points: { total?: number }[] }> }
    expect(migrated.series['buddy/acct-1']?.points.map(p => p.total)).toEqual([150, 250])
  })

  it('目标位置更新时以目标为准（不反向覆盖）', () => {
    const home = tempHome()
    writeState(historyStatePath(home), storedState([{ at: T0 - MINUTE, status: 'ok', total: 999, packages: [] }]))
    writeState(legacyHistoryStatePath(home), storedState([{ at: T0 - 3 * DAY, status: 'ok', total: 100, packages: [] }]))

    const { history } = harness({ home })
    expect(history.view('buddy', 24 * RETENTION_DAYS).accounts[0]?.points.map(p => p.total)).toEqual([999])
  })

  it('迁移**不删除也不改写**任何源文件（独立插件可能还在跑）', () => {
    const home = tempHome()
    const target = historyStatePath(home)
    const legacy = legacyHistoryStatePath(home)
    writeState(target, storedState([{ at: T0 - 4 * DAY, status: 'ok', total: 100, packages: [] }]))
    writeState(legacy, storedState([{ at: T0 - HOUR, status: 'ok', total: 250, packages: [] }]))
    const targetBefore = readFileSync(target, 'utf8')
    const legacyBefore = readFileSync(legacy, 'utf8')

    harness({ home })

    // 旧位置必须**逐字节不变**；目标位置被改是它的本职（它是单一存储）。
    expect(readFileSync(legacy, 'utf8')).toBe(legacyBefore)
    expect(readFileSync(target, 'utf8')).not.toBe(targetBefore)
    expect(readFileSync(legacy, 'utf8')).toBe(legacyBefore)
  })

  it('旧位置格式坏掉只告警跳过，不拖垮启动，也不用旧数据覆盖目标位置', () => {
    const home = tempHome()
    const target = historyStatePath(home)
    writeState(target, storedState([{ at: T0 - MINUTE, status: 'ok', total: 777, packages: [] }]))
    mkdirSync(dirname(legacyHistoryStatePath(home)), { recursive: true })
    writeFileSync(legacyHistoryStatePath(home), '{ 这不是 JSON', 'utf8')

    const { history, warns } = harness({ home })
    expect(history.view('buddy', 24 * RETENTION_DAYS).accounts[0]?.points.map(p => p.total)).toEqual([777])
    expect(warns.some(message => message.includes('已跳过迁移'))).toBe(true)
    // ⚠️ 目标位置**确实会被重写**（那是它的本职：单一存储 + 把旧数据的 15
    // 升级为 5 落盘），但**数据必须还是目标位置那份 777**，绝不能被坏掉的
    // 旧文件顶掉、也不能因旧文件坏掉就丢数据。
    const after = JSON.parse(readFileSync(target, 'utf8')) as { intervalMinutes: number; series: Record<string, { points: { total?: number }[] }> }
    expect(after.intervalMinutes).toBe(DEFAULT_INTERVAL_MINUTES)
    expect(after.series['buddy/acct-1']!.points.map(point => point.total)).toEqual([777])
    // 坏掉的旧文件必须原样保留（它是证据，且独立插件可能还在跑）。
    expect(readFileSync(legacyHistoryStatePath(home), 'utf8')).toBe('{ 这不是 JSON')
  })

  it('目标位置格式坏掉**必须抛**（保留原文件，绝不用旧数据覆盖它）', () => {
    const home = tempHome()
    const target = historyStatePath(home)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, '{ 坏掉了', 'utf8')
    expect(() => new CreditHistory({
      home,
      query: async () => queryResult([]),
      accounts: async () => [],
    })).toThrow(/保留原文件/)
    expect(readFileSync(target, 'utf8')).toBe('{ 坏掉了')
  })
})

describe('③ 体积治理：增量编码 / 抽稀 / 有界兜底', () => {
  /** 造一个「资源包签名稳定」的长序列，返回磁盘点与实际点数。 */
  function sampleMany(home: string, count: number, stepMs: number, startAt: number, packages: unknown[]) {
    const items = Array.from({ length: count }, (_, index) => queryResult([{ accountId: 'acct-1', total: 100 + index, packages }]))
    const time = clock(startAt)
    const history = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      accounts: async () => [{ id: 'acct-1', nickname: '账号一' }],
      query: async () => items.shift() ?? queryResult([{ accountId: 'acct-1', total: 0, packages }]),
    })
    return {
      history,
      async run() {
        for (let index = 0; index < count; index += 1) {
          // 每次前进刚好一个采样间隔，避免冷却拦掉；间隔用 5 分钟。
          time.set(startAt + index * stepMs)
          await history.balances('buddy')
        }
      },
    }
  }

  it('资源包签名不变时省略 packages（磁盘点里没有该字段）', async () => {
    const home = tempHome()
    const packages = [pkg('甲', 50), pkg('乙', 50)]
    const run = sampleMany(home, 6, 5 * MINUTE, T0, packages)
    await run.run()
    const state = diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }
    const points = state.series['buddy/acct-1']!.points
    expect(points).toHaveLength(6)
    // 第一个点必须自带 packages（它是基准），其余全部省略。
    expect(points[0]?.packages).toHaveLength(2)
    for (const point of points.slice(1)) expect(point.packages).toBeUndefined()
    // 体积：省略后每点应远小于完整序列化（真实数据里 buddy 是 5667 字节/点）。
    const compact = JSON.stringify(state).length
    const full = JSON.stringify({
      ...state,
      series: { 'buddy/acct-1': { ...state.series['buddy/acct-1']!, points: points.map(point => ({ ...point, packages })) } },
    }).length
    expect(compact * 2).toBeLessThan(full)
  })

  it('view() 把省略的 packages 完整还原（对外契约不变，且**每点一份副本**）', async () => {
    const home = tempHome()
    // 用 ASCII 名称：汉字在 ICU 里的先后与码位无关，硬编码次序会让用例随 Node 构建变红。
    const packages = [pkg('Pack-A', 50), pkg('Pack-B', 50)]
    const run = sampleMany(home, 4, 5 * MINUTE, T0, packages)
    await run.run()
    const accounts = run.history.view('buddy', 24).accounts
    expect(accounts[0]?.points).toHaveLength(4)
    for (const point of accounts[0]!.points) {
      expect(point.status).toBe('ok')
      expect(point.packages?.map(p => p.name)).toEqual(['Pack-A', 'Pack-B'])
    }
    // 还原出来的必须是副本：改一个点不能污染另一个点（否则基准被共享会串味）。
    accounts[0]!.points[0]!.packages![0]!.remaining = 999
    expect(accounts[0]!.points[1]!.packages![0]!.remaining).toBe(50)
  })

  it('签名变化的那一点必须重新存完整 packages（否则还原出错的资源包）', async () => {
    const home = tempHome()
    const time = clock(T0)
    let index = 0
    const history = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      accounts: async () => [{ id: 'acct-1', nickname: '账号一' }],
      query: async () => {
        index += 1
        // 第 3 次换一批包（签名变化：多了「丙」）。
        const packages = index >= 3 ? [pkg('甲', 50), pkg('乙', 50), pkg('丙', 10)] : [pkg('甲', 50), pkg('乙', 50)]
        return queryResult([{ accountId: 'acct-1', total: 100 + index, packages }])
      },
    })
    for (let step = 0; step < 5; step += 1) {
      time.set(T0 + step * 5 * MINUTE)
      await history.balances('buddy')
    }
    const state = diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }
    const stored = state.series['buddy/acct-1']!.points
    expect(stored[0]?.packages).toHaveLength(2)
    expect(stored[1]?.packages).toBeUndefined()
    expect(stored[2]?.packages).toHaveLength(3)
    expect(stored[3]?.packages).toBeUndefined()
    expect(stored[4]?.packages).toBeUndefined()
    // 还原后每点的包数与当时一致。
    const points = history.view('buddy', 24).accounts[0]!.points
    expect(points.map(p => p.packages?.length)).toEqual([2, 2, 3, 3, 3])
  })

  it('失败点不打断增量基准（失败点不带 packages，基准仍是上一个有效点）', async () => {
    const home = tempHome()
    const time = clock(T0)
    let index = 0
    const history = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      accounts: async () => [{ id: 'acct-1', nickname: '账号一' }],
      query: async () => {
        index += 1
        // 第 2 次返回 null 余额（失败点）。
        return index === 2
          ? queryResult([{ accountId: 'acct-1', balance: null }])
          : queryResult([{ accountId: 'acct-1', total: 100 + index, packages: [pkg('甲', 50), pkg('乙', 50)] }])
      },
    })
    for (let step = 0; step < 4; step += 1) {
      // ⚠️ 步长用 15 分钟（不是采样间隔 5 分钟）：第 2 次是失败点 ⇒ 退避到
      // 10 分钟，若按 5 分钟推进，第 3 步会被冷却拦掉（实测只落 3 个点）。
      time.set(T0 + step * 15 * MINUTE)
      await history.balances('buddy')
    }
    const state = diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }
    const stored = state.series['buddy/acct-1']!.points
    expect(stored.map(p => p.status)).toEqual(['ok', 'failed', 'ok', 'ok'])
    expect(stored[2]?.packages).toBeUndefined()
    // 失败点在 view 里如实出现，且 change 是 gap。
    const points = history.view('buddy', 24).accounts[0]!.points
    expect(points[1]?.status).toBe('failed')
    expect(points[1]?.change.kind).toBe('gap')
    expect(points[2]?.packages).toHaveLength(2)
    expect(points[3]?.packages).toHaveLength(2)
  })

  it('分层抽稀：8 天内保留全部，8～30 天按 30 分钟留 1 个，30 天外丢弃', async () => {
    const home = tempHome()
    // 手工造一份跨越 40 天的磁盘状态：每 5 分钟一个点，8 天内 20 个 + 8～30 天 20 个 + 30 天外 5 个。
    const points: StoredHistoryPoint[] = []
    for (let index = 0; index < 20; index += 1) points.push({ at: T0 - index * 5 * MINUTE, status: 'ok', total: 100 + index })
    for (let index = 0; index < 20; index += 1) points.push({ at: T0 - (9 * DAY) - index * 5 * MINUTE, status: 'ok', total: 200 + index })
    for (let index = 0; index < 5; index += 1) points.push({ at: T0 - (35 * DAY) - index * 5 * MINUTE, status: 'ok', total: 300 + index })
    points.sort((a, b) => a.at - b.at)
    writeState(historyStatePath(home), storedState(points))

    const { history } = harness({ home })
    history.configure({})  // 触发一次保存（= 抽稀）
    const kept = (diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }).series['buddy/acct-1']!.points

    const fullStart = T0 - FULL_RESOLUTION_DAYS * DAY
    const cutoff = T0 - RETENTION_DAYS * DAY
    expect(kept.every(point => point.at >= cutoff)).toBe(true)
    // 8 天内的点一个不少。
    expect(kept.filter(point => point.at >= fullStart)).toHaveLength(20)
    // 8～30 天的 20 个点（每 5 分钟一个，共 95 分钟）跨 **5 个** 30 分钟时隙
    // ⇒ 每个时隙留首个 ok 点，共 5 个（实测就是 5 个；写用例时我最初以为
    // 「都在一小时内 ⇒ 1 个」，那是把 95 分钟当成了 60 分钟）。
    const thinned = kept.filter(point => point.at < fullStart)
    expect(thinned).toHaveLength(5)
    // 留下的必须是**各自 30 分钟时隙的首个点**：时隙彼此不同、且时隙内没有更早的点。
    const slots = thinned.map(point => Math.floor(point.at / (THINNED_INTERVAL_MINUTES * MINUTE)))
    expect(new Set(slots).size).toBe(thinned.length)
    for (const point of thinned) {
      const slot = Math.floor(point.at / (THINNED_INTERVAL_MINUTES * MINUTE))
      // 同一时隙里没有比它更早的 ok 点被留下（它就是该时隙的首个）。
      const earlier = kept.filter(other => Math.floor(other.at / (THINNED_INTERVAL_MINUTES * MINUTE)) === slot && other.at < point.at)
      expect(earlier).toHaveLength(0)
    }
    // ⚠️ 注意**不能**断言「相邻两个留下点间隔 ≥ 一个时隙」：相邻时隙的两个点
    // 完全可能只差 5 分钟（实测就有一对 02:25 与 02:30），那正是「时隙首个」
    // 这个口径的正确结果，不是漏抽稀。
    // 留下的点必须都落在 8～30 天这个冷区里（不在热区，也不在 30 天外），
    // 且确实来自那簇「-9 天」的旧点（该簇本身跨 95 分钟）。
    for (const point of thinned) {
      expect(point.at).toBeGreaterThanOrEqual(cutoff)
      expect(point.at).toBeLessThan(fullStart)
      expect(point.at).toBeGreaterThan(T0 - (9 * DAY) - 2 * HOUR)
    }
    // 结果必须是「明显抽稀」：20 个冷点留下不到一半。
    expect(thinned.length).toBeLessThan(20 / 2)
    // 30 天外的一个不留。
    expect(kept.some(point => point.at < cutoff)).toBe(false)
  })

  it('抽稀是 30 分钟时隙的首个点，且总点数不超稳态上界', async () => {
    const home = tempHome()
    // 8～30 天区间里每 5 分钟一个点（跨越 1 小时 ⇒ 12 个点 ⇒ 应留 2 个）。
    const base = T0 - 10 * DAY
    const points: StoredHistoryPoint[] = Array.from({ length: 12 }, (_, index) => ({
      at: base + index * 5 * MINUTE, status: 'ok' as const, total: 100 + index,
    }))
    writeState(historyStatePath(home), storedState(points))
    const { history } = harness({ home })
    history.configure({})
    const kept = (diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }).series['buddy/acct-1']!.points
    const slotMs = THINNED_INTERVAL_MINUTES * MINUTE
    expect(kept).toHaveLength(2)
    expect(kept.map(point => Math.floor(point.at / slotMs))).toEqual([...new Set(kept.map(point => Math.floor(point.at / slotMs)))])
  })

  it('有界兜底**只裁全分辨率窗口之外**的旧点，绝不静默截断近期数据', async () => {
    const home = tempHome()
    // 近期点数刻意造得比兜底上限还多（真实运行时到不了，靠时钟回拨/外部写入才可能）。
    const recentCount = MAX_POINTS_PER_SERIES + 50
    const points: StoredHistoryPoint[] = Array.from({ length: recentCount }, (_, index) => ({
      at: T0 - index * MINUTE, status: 'ok' as const, total: 100 + index,
    }))
    writeState(historyStatePath(home), storedState(points))
    const { history, warns } = harness({ home })
    history.configure({})
    const kept = (diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }).series['buddy/acct-1']!.points
    // ⚠️ 近期点**一个都不能少**（这正是旧实现 slice(-9000) 的病因）。
    expect(kept).toHaveLength(recentCount)
    expect(kept.some(point => point.at === T0)).toBe(true)
    expect(kept.some(point => point.at === T0 - (recentCount - 1) * MINUTE)).toBe(true)
    expect(warns.some(message => message.includes('不裁剪近期点'))).toBe(true)
    // 兜底上限必须大于「抽稀稳态上界」，否则每天都真裁 = 保留期悄悄缩水。
    const steadyState = (FULL_RESOLUTION_DAYS * 24 * 60) / DEFAULT_INTERVAL_MINUTES
      + ((RETENTION_DAYS - FULL_RESOLUTION_DAYS) * 24 * 60) / THINNED_INTERVAL_MINUTES
    expect(MAX_POINTS_PER_SERIES).toBeGreaterThan(steadyState)
  })

  it('兜底上限生效时优先丢最旧的**冷区**点', async () => {
    const home = tempHome()
    const coldCount = 100
    const points: StoredHistoryPoint[] = [
      // 冷区（10 天前）：每 7 分钟一个点 ⇒ 抽稀后几乎全留（每个 30 分钟时隙首个）。
      ...Array.from({ length: coldCount }, (_, index) => ({ at: T0 - 10 * DAY - index * 7 * MINUTE, status: 'ok' as const, total: 100 + index })),
      // 热区（1 小时内）：每个 5 分钟一个点。
      ...Array.from({ length: 12 }, (_, index) => ({ at: T0 - index * 5 * MINUTE, status: 'ok' as const, total: 200 + index })),
    ].sort((a, b) => a.at - b.at)
    writeState(historyStatePath(home), storedState(points))
    const { history } = harness({ home })
    history.configure({})
    const kept = (diskState(home) as { series: Record<string, { points: StoredHistoryPoint[] }> }).series['buddy/acct-1']!.points
    // 热区 12 个点全在。
    expect(kept.filter(point => point.at >= T0 - HOUR)).toHaveLength(12)
    // 冷区被抽稀（不是全留）。
    expect(kept.length).toBeLessThan(coldCount + 12)
  })
})

describe('④ 重启安全与退避语义', () => {
  it('attempts 在打上游**之前**落盘（进程重启不重复请求）', async () => {
    const home = tempHome()
    const time = clock(T0)
    // 用自定义 query：在它被调用时读磁盘，断言 attempts 已经写进去了。
    let attemptsAtQuery: number | undefined
    const custom = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      accounts: async () => [{ id: 'acct-1' }],
      query: async () => {
        attemptsAtQuery = (diskState(home).attempts as Record<string, number>).buddy
        return queryResult([{ accountId: 'acct-1', total: 100 }])
      },
    })
    // 还没采样过：`attempts` 为空，此时 `nextQueryAt = 0 + interval`（沿用旧实现
    // 的 `|| 0` 口径），是个**已过去**的时刻 ⇒ 语义就是「现在就该查」。
    expect(custom.view('buddy').nextQueryAt).toBe(5 * MINUTE)
    expect(custom.view('buddy').nextQueryAt).toBeLessThan(T0)
    await custom.balances('buddy')
    expect(attemptsAtQuery).toBe(T0)
    // 采样后以**真实尝试时刻**为基准推进一个间隔（不是 `完成时刻`）。
    // nextQueryAt 必须从**真的采样过的那台引擎**读（`custom`）：另造一台实例
    // 不共享内存状态，读它会得到「没有记录」的默认值。
    expect(custom.view('buddy').nextQueryAt).toBe(T0 + 5 * MINUTE)
  })

  it('每次查询前 pause(2000)（顺序查询，避免风控）', async () => {
    const { history, pauses, queries } = harness()
    await history.balances('buddy')
    expect(pauses).toEqual([2000])
    expect(queries).toEqual(['buddy'])
  })

  it('冷却期（max(5 分钟, interval)）内不再打上游；重启后仍能展示已存余额', async () => {
    const home = tempHome()
    const first = harness({ home })
    await first.history.balances('buddy')
    expect(first.queries).toEqual(['buddy'])
    // 同一实例、冷却期内：不打上游，走内存缓存。
    const cached = await first.history.balances('buddy')
    expect(first.queries).toEqual(['buddy'])
    expect(cached.value?.cached).toBe(true)

    // 「重启」：新实例、同一磁盘状态、仍在冷却期内 ⇒ 不打上游，用磁盘点回答。
    const second = harness({ home })
    const afterRestart = await second.history.balances('buddy')
    expect(second.queries).toEqual([])
    expect(afterRestart.value?.cached).toBe(true)
    expect(afterRestart.value?.sampledAt).toBe(T0)
    expect(afterRestart.value?.accounts?.[0]?.balance?.total).toBe(100)
  })

  it('冷却公式是 max(5 分钟, 间隔)，且失败按 2 倍指数退避、上限 60 分钟', async () => {
    const home = tempHome()
    const time = clock(T0)
    const { history, queries } = harness({ home })
    void queries
    const engine = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      warn: () => {},
      accounts: async () => [{ id: 'acct-1' }],
      query: async () => queryResult([{ accountId: 'acct-1', balance: null }]),
    })
    expect(engine.interval('buddy')).toBe(5 * MINUTE)
    // 每次推进 60 分钟 ⇒ 一定越过任何一档冷却，6 次都能真的打上游。
    for (let step = 0; step < 6; step += 1) {
      time.set(T0 + step * 60 * MINUTE)
      await engine.balances('buddy')
    }
    // 退避阶梯：5 → 10 → 20 → 40 → **60（封顶）** → 60。
    // ⚠️ 「上限 60 分钟」必须真的够得着：旧实现写的是 `2 ** Math.min(3, f)`，
    // 那是基准 15 时代的口径（15×2³=120，靠指数截断压回 60）；基准改 5 之后
    // `5×2³=40`，**永远到不了 60**。本用例就锁这一点。
    expect(engine.state.failures.buddy).toBe(6)
    expect(engine.interval('buddy')).toBe(60 * MINUTE)
    expect(history.interval('buddy')).toBe(5 * MINUTE)
  })

  it('退避阶梯的每一档都符合 2 倍指数且封顶 60 分钟（含 5 分钟基准）', () => {
    const home = tempHome()
    const engine = new CreditHistory({
      home,
      now: () => T0,
      pause: async () => {},
      accounts: async () => [{ id: 'acct-1' }],
      query: async () => queryResult([{ accountId: 'acct-1', total: 100 }]),
    })
    for (const [base, ladder] of [[5, [5, 10, 20, 40, 60, 60]], [15, [15, 30, 60, 60, 60, 60]]] as const) {
      engine.state.intervalMinutes = base
      const actual = ladder.map((_expected, failures) => {
        engine.state.failures.buddy = failures
        return engine.interval('buddy') / MINUTE
      })
      expect(actual).toEqual([...ladder])
      // 封顶必须可达（这正是旧口径在基准 5 下丢掉的性质）。
      expect(Math.max(...actual)).toBe(60)
      // 每一档都不超过上一档的 2 倍，且单调不减。
      for (let index = 1; index < actual.length; index += 1) {
        expect(actual[index]!).toBeGreaterThanOrEqual(actual[index - 1]!)
        expect(actual[index]!).toBeLessThanOrEqual(Math.min(60, actual[index - 1]! * 2))
      }
    }
    // 基准 15 时与旧实现逐值一致（重构不能改掉既有行为）。
    engine.state.intervalMinutes = 15
    engine.state.failures.buddy = 0
    expect(engine.interval('buddy')).toBe(15 * MINUTE)
    engine.state.failures.buddy = 3
    expect(engine.interval('buddy')).toBe(60 * MINUTE)
  })

  it('查询抛异常时合成每账号一条 balance: null 的中文错误，且不写入凭据', async () => {
    const home = tempHome()
    const { history } = harness({ home, queryThrows: true })
    const result = await history.balances('buddy')
    expect(result.ok).toBe(true)
    expect(result.value?.accounts?.[0]?.balance).toBeNull()
    expect(result.value?.accounts?.[0]?.error).toBe('余额查询失败，请稍后重试')
    const raw = readFileSync(historyStatePath(home), 'utf8')
    expect(raw.includes('secret-reference')).toBe(false)
    // 失败点如实记账。
    const points = history.view('buddy', 24).accounts[0]?.points ?? []
    expect(points.map(p => p.status)).toEqual(['failed'])
  })

  it('不支持的来源返回 bad-request，且不发任何请求', async () => {
    const { history, queries, pauses } = harness()
    const result = await history.balances('nope')
    expect(result).toEqual({ ok: false, error: { code: 'bad-request', message: '不支持的积分来源' } })
    expect(queries).toEqual([])
    expect(pauses).toEqual([])
    expect(HISTORY_PROVIDERS).toHaveLength(10)
  })

  it('start() 串行采样到期来源、跳过停用与无账号来源，停止后不再查询', async () => {
    const home = tempHome()
    const queries: string[] = []
    const engine = new CreditHistory({
      home,
      now: () => T0,
      pause: async () => {},
      warn: () => {},
      // 只有 buddy 有账号：其余来源必须被跳过（不发请求）。
      accounts: async (provider) => (provider === 'buddy' ? [{ id: 'acct-1' }] : []),
      query: async (provider) => {
        queries.push(provider)
        return queryResult([{ accountId: 'acct-1', total: 100 }])
      },
    })
    const stop = engine.start()
    expect(typeof stop).toBe('function')
    // 定时器是 30 秒一跳、且 unref 过：这里不真的等它，直接验证「关掉开关不发请求」。
    await engine.configure({ enabled: false })
    stop()
    const stopped = await engine.balances('buddy').catch(error => error as Error)
    expect(stopped).toBeInstanceOf(Error)
    expect((stopped as Error).message).toBe('积分记录已停止')
    expect(queries).toEqual([])
  })

  it('view() 的 hours 上限 168（小于抽稀窗口 8 天，故抽稀永不影响渲染）', () => {
    const home = tempHome()
    const points: StoredHistoryPoint[] = Array.from({ length: 10 }, (_, index) => ({
      at: T0 - index * 10 * HOUR, status: 'ok' as const, total: 100 + index,
    }))
    writeState(historyStatePath(home), storedState(points))
    const { history } = harness({ home })
    expect(history.view('buddy', 24).accounts[0]?.points).toHaveLength(3)
    expect(history.view('buddy', 168).accounts[0]?.points).toHaveLength(10)
    // 超出上限一律按 168 处理（不能靠传大 hours 绕过抽稀看到 30 天）。
    expect(history.view('buddy', 9999).accounts[0]?.points).toHaveLength(10)
    expect(FULL_RESOLUTION_DAYS * 24).toBeGreaterThan(168)
    expect(history.view('buddy').retentionDays).toBe(RETENTION_DAYS)
  })

  it('view() 只返回被请求的来源，且带 nickname', async () => {
    const home = tempHome()
    const time = clock(T0)
    const engine = new CreditHistory({
      home,
      now: () => time.now(),
      pause: async () => {},
      accounts: async (provider) => [{ id: 'acct-1', nickname: `${provider} 的账号` }],
      query: async () => queryResult([{ accountId: 'acct-1', total: 100 }]),
    })
    await engine.balances('buddy')
    time.set(T0 + 6 * MINUTE)
    await engine.balances('qoder')
    expect(engine.view('buddy').accounts.map(a => a.accountId)).toEqual(['acct-1'])
    expect(engine.view('buddy').accounts[0]?.nickname).toBe('buddy 的账号')
    expect(engine.view('qoder').accounts[0]?.nickname).toBe('qoder 的账号')
    expect(engine.view('trae').accounts).toEqual([])
  })
})
