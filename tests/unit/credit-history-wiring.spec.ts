import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachCreditHistory,
  createHistoryBalanceSource,
} from '../../src/credit-history-rpc.js'
import { CreditHistory } from '../../src/credit-history.js'
import type { HistoryAccountEntry, HistoryBadgeLike } from '../../src/credit-history-rpc.js'

/**
 * 积分历史**整合接线**的回归（本次「并成一个插件」的核心不变量）。
 *
 * 这些用例锁的是**接缝**，不是引擎内部（引擎自己的用例在
 * `tests/unit/credit-history.spec.ts`）。接缝上出错的形态都很隐蔽：
 * 曲线掉到 0、停用账号凭空多出失败点、采样绕过缓存重复打上游 ——
 * 三者都不会报错，只会让用户看到错的数。
 *
 * 1. **取数只有一条路**：采样走 `usageBadge.read()`（**不传 `force`**），
 *    因此与徽标共用同一份 120s TTL 缓存。若哪天有人给采样加上 `force: true`，
 *    「每 5 分钟问上游一次」会变成「每次采样都问上游」，本文件第一条用法就会红。
 * 2. **失败不折成 0**：整批失败 → `ok: false`（引擎记 failed 点）；
 *    单账号失败 → `balance: null` 原样带着 `error` 往下传。
 * 3. **停用账号不进采样**：与徽标读数同一口径（`enabled !== false`），
 *    否则引擎会为它在读数里找不到行而记一个**假失败点**。
 * 4. **存储落在 jet-hub 目录**（单一数据目录，与 `state.json` 同处）。
 */

/** 构造账号池条目（本地类型：`provider`/`createdAt` 是宿主池的字段，装配层不读）。 */
function account(id: string, enabled = true): HistoryAccountEntry {
  return {
    id,
    provider: 'buddy',
    nickname: id,
    enabled,
    credentialRef: `${id.toUpperCase()}_REF`,
    createdAt: 1,
  } as HistoryAccountEntry & { provider: string; createdAt: number }
}

/** 造一个只读一次的徽标桩，并记录它收到的 `options`。 */
function badgeStub(
  accounts: Array<{
    accountId: string
    nickname?: string
    balance: unknown
    error?: unknown
  }>,
  options: Array<{ force?: boolean } | undefined> = [],
): Pick<HistoryBadgeLike, 'read'> {
  return {
    async read(provider: string, opts?: { force?: boolean }) {
      options.push(opts)
      return {
        ok: true,
        value: {
          provider,
          generatedAt: 1_700_000_000_000,
          cached: false,
          accounts,
          disabledCount: 0,
          preference: 'auto',
          autoCheckin: { enabled: false, running: false, ranToday: false },
        },
      } as never
    },
  }
}

/** 最小 ctx 桩：`attachCreditHistory` 只用到 `logger` 与（可选）`effect`。 */
function ctxStub(): {
  logger: { warn: (m: string) => void; info: (m: string) => void }
  warnings: string[]
  effect?: (fn: () => unknown) => unknown
} {
  const warnings: string[] = []
  return {
    warnings,
    logger: { warn: (m: string) => warnings.push(m), info: () => {} },
    // ⚠️ 刻意**不提供** `effect`：本仓库大量单测的 ctx 桩就是这种最小形态，
    //    `attachCreditHistory` 必须容忍（`ctx.effect?.(…)`），否则会连带
    //    弄红一堆无关用例。
  }
}

/** 引擎每次打上游前固定 `pause(2000)`；单测里真等会让每个用例慢 2 秒。 */
const NO_WAIT = { pause: async () => {} }

/** 每个用例一个隔离 home。 */
function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-credit-history-wiring-'))
}

describe('取数适配器：复用徽标缓存，不另开上游通道', () => {
  it('⚠️ 采样**不传** force（传了就会绕过 120s 缓存、每个点都打一次上游）', async () => {
    const options: Array<{ force?: boolean } | undefined> = []
    const source = createHistoryBalanceSource(badgeStub([{ accountId: 'a', nickname: 'A', balance: { total: 10, packages: [], expiredTotal: 0 } }], options))
    await source.query('buddy')
    expect(options).toEqual([undefined])
    // 反向验证的锚点：只要有 `{force:true}` 从这里冒出来，本条即失败。
    expect(options.every(o => o?.force !== true)).toBe(true)
  })

  it('余额行**逐字搬运**：balance: null 与 error 都保留（绝不折成 0）', async () => {
    const source = createHistoryBalanceSource(badgeStub([
      { accountId: 'ok', nickname: '正常', balance: { total: 0, packages: [], expiredTotal: 0 } },
      { accountId: 'bad', nickname: '失败', balance: null, error: '凭据已过期' },
    ]))
    const result = await source.query('buddy')
    expect(result.ok).toBe(true)
    expect(result.value?.accounts).toEqual([
      { accountId: 'ok', nickname: '正常', balance: { total: 0, packages: [], expiredTotal: 0 } },
      { accountId: 'bad', nickname: '失败', balance: null, error: '凭据已过期' },
    ])
  })

  it('整批失败 → ok: false（引擎据此记 failed 点，而不是把曲线拉到 0）', async () => {
    const warnings: string[] = []
    const source = createHistoryBalanceSource(
      { async read() { return { ok: false, error: { code: 'upstream', message: '网关 502' } } } } as never,
      message => warnings.push(message),
    )
    const result = await source.query('buddy')
    expect(result.ok).toBe(false)
    // 失败必须被记一条告警：曲线断掉时这是唯一的排查线索。
    expect(warnings.join('\n')).toContain('网关 502')
  })
})

describe('装配：采样器落到 jet-hub 目录，且与徽标同源', () => {
  it('默认 5 分钟，且状态文件写在 <home>/jet-hub/credit-history.json', () => {
    const home = freshHome()
    const history = attachCreditHistory(ctxStub() as never, badgeStub([]), () => [], { home, ...NO_WAIT })
    expect(history).toBeDefined()
    expect(history!.state.intervalMinutes).toBe(5)
    expect(history!.path).toBe(join(home, 'jet-hub', 'credit-history.json'))
  })

  it('⚠️ 停用账号不进采样（否则引擎记假失败点：读数里根本没有那一行）', async () => {
    const home = freshHome()
    const queried: string[] = []
    const history = attachCreditHistory(
      ctxStub() as never,
      { async read(provider: string) { queried.push(provider); return { ok: false, error: { code: 'x', message: 'x' } } } } as never,
      () => [account('enabled-1'), account('disabled-1', false)],
      { home, ...NO_WAIT },
    )
    // 直接问装配进去的 `accounts` 回调（私有依赖，经引擎的公开行为间接验证：
    // 采一个 5 分钟间隔的点，看哪些账号被写了行）。
    await history!.balances('buddy')
    const seriesKeys = Object.keys(history!.state.series)
    expect(seriesKeys.some(key => key.includes('enabled-1'))).toBe(true)
    expect(seriesKeys.some(key => key.includes('disabled-1'))).toBe(false)
  })

  it('采集一个点后：失败被记成 failed 而**不是** total: 0', async () => {
    const home = freshHome()
    const history = attachCreditHistory(
      ctxStub() as never,
      { async read() { return { ok: false, error: { code: 'x', message: '查询失败' } } } } as never,
      () => [account('a1')],
      { home, ...NO_WAIT },
    )
    await history!.balances('buddy')
    const row = Object.values(history!.state.series)[0]
    expect(row.points).toHaveLength(1)
    expect(row.points[0].status).toBe('failed')
    // 关键：失败点**不带** total，不是 0。
    expect(row.points[0]).not.toHaveProperty('total')
  })

  it('定位不到 home 时降级为「不启用」并告警，不让插件装配失败', () => {
    const ctx = ctxStub()
    // 既不传 home，又让 `resolveJetHubHome` 走到环境变量兜底 —— 用空串拦掉。
    const history = attachCreditHistory(ctx as never, badgeStub([]), () => [], { home: '', ...NO_WAIT })
    expect(history).toBeUndefined()
    expect(ctx.warnings.join('\n')).toContain('无法定位 DSH home')
  })

  it('可重复装配（多个实例共享同一份文件而不互相清空）', () => {
    const home = freshHome()
    const first = attachCreditHistory(ctxStub() as never, badgeStub([]), () => [], { home, ...NO_WAIT })
    const second = attachCreditHistory(ctxStub() as never, badgeStub([]), () => [], { home, ...NO_WAIT })
    expect(first!.path).toBe(second!.path)
    // 两个实例都指向同一份文档 —— 这正是「单一存储库」的含义。
    expect(first!.path).toBe(join(home, 'jet-hub', 'credit-history.json'))
  })
})

describe('单一存储库：与账号池同一个数据目录', () => {
  it('采样落盘后，文件就在 jet-hub 目录里（与 state.json 同处）', async () => {
    const home = freshHome()
    mkdirSync(join(home, 'jet-hub'), { recursive: true })
    writeFileSync(join(home, 'jet-hub', 'state.json'), '{"accounts":[]}')
    const history = attachCreditHistory(
      ctxStub() as never,
      badgeStub([{ accountId: 'a1', nickname: 'A', balance: { total: 42, packages: [], expiredTotal: 0 } }]),
      () => [account('a1')],
      { home, ...NO_WAIT },
    )
    await history!.balances('buddy')
    const path = join(home, 'jet-hub', 'credit-history.json')
    expect(existsSync(path)).toBe(true)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { series: Record<string, { points: unknown[] }> }
    expect(Object.values(parsed.series)[0].points).toHaveLength(1)
    /**
     * ⚠️ 关键：**不得**再写独立插件那个位置。
     * 那条路径还存在是为了让用户随时能回滚到独立插件（迁移不删源文件），
     * 但整合后的 dsh-codearts-auth **只写** jet-hub 这一处。
     */
    expect(existsSync(join(home, 'credit-history', 'history.json'))).toBe(false)
  })

  it('引擎实例可被外部直接注入（单测/迁移场景），此时不再自行构造', () => {
    const home = freshHome()
    const injected = new CreditHistory({
      home,
      query: async () => ({ ok: true, value: { accounts: [] } }),
      accounts: async () => [],
    })
    const returned = attachCreditHistory(ctxStub() as never, badgeStub([]), () => [], { history: injected })
    expect(returned).toBe(injected)
  })
})
