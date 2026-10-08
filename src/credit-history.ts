/**
 * 积分历史引擎（宿主侧采样 + 单一存储 + 体积治理）。
 *
 * 本文件是**独立插件 `dsh-credit-history` 的宿主侧移植与强化**：逻辑与原
 * `lib/credit-history.js` 一一对应，但把三件事做实（每件背后都有实测数据）：
 *
 * ## ① 默认采样 5 分钟
 *
 * 原插件默认 15 分钟。用户明确要求「积分历史应当提升到每 5 分钟一次」，
 * 故新状态默认 `intervalMinutes: 5`，且**磁盘上的旧状态里那个 15 也要升级为 5**
 * （旧文件没有任何标记能区分「用户特意选的 15」与「老默认值 15」，故见
 * `sanitizeState` 的 `intervalSource` 判据）。`configure` 仍只接受 5 或 15。
 *
 * ## ② 单一存储库（**迁移必须按「最新采样时间」择优**）
 *
 * 状态文件固定写 `<home>/jet-hub/credit-history.json` —— 与 Jet Hub 的
 * `jet-hub/state.json`、`auto-checkin.json` 同目录，即**单一数据目录**。
 *
 * 旧位置有**两个**候选：
 *
 * | 候选 | 实测内容（2026-10-05 本机） |
 * |---|---|
 * | `<home>/jet-hub/credit-history.json` | 更早的历史：2/2/1 个点，最后采样 2026-10-01T14:29Z |
 * | `<home>/credit-history/history.json` | 独立插件写的**较新**数据：66/66/65 个点，最后采样 2026-10-05T05:56Z |
 *
 * ⇒「目标路径已存在就直接用」会**丢掉新数据**（实测目标是旧数据的子集）。
 * 正确做法：两个文件都读，取**最后一个采样点时间更晚**的那份（并列时取目标位置）。
 *
 * ⚠️ **两个源文件都不删除、不改写**：独立插件可能还在跑（本机实测它仍在写入），
 * 且保留原文件才可回滚。迁移只是把择优结果**另存**到目标位置。
 *
 * ## ③ 体积治理（已实测的真实问题）
 *
 * buddy 的一个采样点带 **17～21 个资源包**，实测 `JSON.stringify` **平均 5667
 * 字节/点**（最大 5740），而 qoder/qodercn 只有约 251～263 字节/点。旧的保存
 * 上限是每序列 `slice(-9000)` + 30 天保留；若直接改成 5 分钟采样，buddy 每天
 * 288 点 ⇒ 30 天 8640 点 ⇒ **约 49 MB** 的单文件 JSON（当前全库才 389710 字节）。
 * 三层治理：
 *
 * 1. **资源包增量编码**：某点的资源包**签名**（`name/unit/active/cycle`，与
 *    `changeBetween` 的 identity 判据同源）与**前一个有效点**相同时，**省略**
 *    `packages` 字段，只存其余字段；读时按前一个可用点还原。实测每点约
 *    **96 字节**（不含 `packages` 的基线 87 字节 + 少量 `total`），buddy 序列
 *    从 5667 字节/点降到约 326 字节/点（含签名变化的锚点）。
 *    `view()` 对外契约**不变**：每个 ok 点仍有完整 `packages`。
 * 2. **分层抽稀**：最近 `FULL_RESOLUTION_DAYS = 8` 天保留原始分辨率；
 *    8～30 天抽稀到 `THINNED_INTERVAL_MINUTES = 30` 分钟（每 6 个留 1 个，
 *    按 30 分钟时隙取首个）；超过 `RETENTION_DAYS = 30` 天丢弃。
 *    ⚠️ 抽稀窗口刻意设为 8 天，而图表最多只查 7 天（`view` 的 hours 上限 168），
 *    故**抽稀永不影响渲染窗口**。`retentionDays` 对外仍报 30。
 * 3. **有界兜底上限** `MAX_POINTS_PER_SERIES`：抽稀后的稳态上界是
 *    `2304（8 天 × 288）+ 1056（22 天 × 48）= 3360` 点/序列，故 4000 只对
 *    「稳态之外的增长」（时钟回拨、外部写入未来时间戳、配置被改成更密的间隔）
 *    生效，**正常运行时永不触发**，不会悄悄缩短 30 天保留。且兜底**只裁
 *    「全分辨率窗口之外」的旧点**，绝不会静默截断近期数据（`-9000` 的问题）。
 *
 * ## ④ 保留原插件的重启安全与退避语义
 *
 * - `attempts[provider]` 在**打上游之前**先落盘 ⇒ 进程重启不会重复请求；
 * - 失败按 `failures[provider]` 指数退避，上限 60 分钟；
 * - 冷却 `max(5 分钟, interval(provider))`；每次查询前 `pause(2000)`，且
 *   `enqueue` 把整条链串行化（顺序查询，避免并发触发风控）。
 *
 * 本模块**零网络**：`query` / `accounts` / `now` / `pause` 全部注入，文件系统
 * 只有状态文档读、写两处（均为可注入的 `home` 下的路径），故可完全离线单测。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 采样来源清单。
 *
 * ⚠️ 必须与客户端面板 `plugin-src/client/credit-history-panel.js` 的 `PROVIDERS`
 * **逐字一致**（本仓库已有「两份名单漂移」的真实缺陷：新增 provider 漏登记会让
 * 该来源的账号静默不采样）。新增 provider 时**两处一起改**。
 */
export const HISTORY_PROVIDERS: readonly string[] = [
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon',
]

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const EPSILON = 0.000001

/** 默认采样间隔（分钟）：用户要求「提升到每 5 分钟一次」。 */
export const DEFAULT_INTERVAL_MINUTES = 5
/** 允许的采样间隔（分钟）；其余值 `configure` 一律拒绝。 */
export const ALLOWED_INTERVAL_MINUTES: readonly number[] = [5, 15]
/** 对外保留天数（同时也是硬保留上限）。 */
export const RETENTION_DAYS = 30
/** 全分辨率窗口（天）：窗口内的点原样保留。 */
export const FULL_RESOLUTION_DAYS = 8
/** 8～30 天区间的抽稀目标分辨率（分钟）。 */
export const THINNED_INTERVAL_MINUTES = 30

/** 8 天全分辨率窗口内的点数上界（按最小采样间隔计）。 */
const FULL_RESOLUTION_POINTS = (FULL_RESOLUTION_DAYS * 24 * 60) / DEFAULT_INTERVAL_MINUTES
/** 8～30 天抽稀区间的点数上界。 */
const THINNED_POINTS = ((RETENTION_DAYS - FULL_RESOLUTION_DAYS) * 24 * 60) / THINNED_INTERVAL_MINUTES

/**
 * 单序列磁盘点数上限（**有界**兜底）。
 *
 * ⚠️ 与抽稀的关系：稳态上界是 `FULL_RESOLUTION_POINTS + THINNED_POINTS`，本值
 * 必须**大于**它 —— 否则兜底每天都会真的裁剪，把「30 天保留」悄悄缩水成十几
 * 天（这正是旧实现 `slice(-9000)` 的毛病：它不区分新旧，取不到近期数据就截）。
 * 4000 只对稳态之外的增长生效，正常运行时永不触发；触发时也只裁**全分辨率
 * 窗口之外**的旧点（见 `prune`）。
 */
export const MAX_POINTS_PER_SERIES = 4000

/** 状态文档文件名（与 `state.json` / `auto-checkin.json` 同目录）。 */
export const HISTORY_FILE_NAME = 'credit-history.json'

/** 单一存储的目标路径：`<home>/jet-hub/credit-history.json`。 */
export function historyStatePath(home: string): string {
  return join(home, 'jet-hub', HISTORY_FILE_NAME)
}

/** 独立插件的旧路径（只读迁移源，**不删不改**）。 */
export function legacyHistoryStatePath(home: string): string {
  return join(home, 'credit-history', 'history.json')
}

/** 资源包（对外契约，字段与原插件逐字一致）。 */
export interface CreditHistoryPackage {
  name: string
  unit: string
  active: boolean
  remaining: number | null
  total: number | null
  used: number
  cycleStartTime: string
  cycleEndTime: string
  expiredTime: string
  cycle: string
}

/**
 * 一个采样点。
 *
 * ⚠️ `packages` 只在 ok 点上出现（原插件语义）；磁盘上它可能被**省略**
 * （增量编码），`view()` 读时会还原，故对外永远是完整的。
 */
export interface CreditHistoryPoint {
  at: number
  status: 'ok' | 'failed'
  total?: number
  expiredTotal?: number
  packages?: CreditHistoryPackage[]
}

/** 相邻两点之间的变化语义。 */
export type ChangeKind = 'gap' | 'reset' | 'usage' | 'increase'

/** 相邻两点的变化（`changeBetween` 的返回值）。 */
export interface CreditHistoryChange {
  kind: ChangeKind
  minutes?: number
  amount?: number
}

/** 还原后的采样点：比对外契约多一个随点保存的采样间隔元数据。 */
export interface RestoredHistoryPoint extends CreditHistoryPoint {
  /** 写这个点时的采样间隔（分钟）；缺省时用当前设置。 */
  intervalMinutes?: number
}

/** `view()` 里的采样点：契约点 + 变化语义。 */
export type CreditHistoryPointView = RestoredHistoryPoint & { change: CreditHistoryChange }

/** `view()` 里的单个账号序列。 */
export interface CreditHistoryAccountView {
  provider: string
  accountId: string
  nickname?: string
  points: CreditHistoryPointView[]
}

/** `view()` 的返回值。 */
export interface CreditHistoryView {
  enabled: boolean
  intervalMinutes: number
  retentionDays: number
  nextQueryAt: number
  accounts: CreditHistoryAccountView[]
}

/** 查询结果里的单个账号（与冻结契约逐字一致）。 */
export interface CreditHistoryQueryAccount {
  accountId: string
  nickname?: string
  balance?: { total?: number; expiredTotal?: number; packages?: readonly unknown[] } | null
  error?: string
}

/** `query` 的返回值（与冻结契约逐字一致）。 */
export interface CreditHistoryQueryResult {
  ok: boolean
  value?: { accounts?: readonly CreditHistoryQueryAccount[] }
}

/**
 * `balances()` 的实际返回值。
 *
 * 在冻结契约之上多三项采样元数据（`sampledAt` / `nextQueryAt` / `cached`）与
 * 兜底错误码 —— 原插件就返回这些字段，客户端面板会读。结构上仍是
 * `CreditHistoryQueryResult` 的子类型，故总监的接线代码按冻结签名用即可。
 */
export interface CreditHistoryBalancesResult extends CreditHistoryQueryResult {
  value?: {
    accounts?: readonly CreditHistoryQueryAccount[]
    /** 本次（或缓存点）的采样时刻。 */
    sampledAt?: number
    /** 下一次允许查询的时刻。 */
    nextQueryAt?: number
    /** 是否来自磁盘/内存缓存（**没有**打上游）。 */
    cached?: boolean
  }
  error?: { code: string; message: string }
}

/** 引擎依赖（全部注入，故零网络、零真实计时）。 */
export interface CreditHistoryDeps {
  /** DSH profile home（状态目录的父目录）。 */
  home: string
  /** 打上游查一次余额（由装配层用 balance-reader 实现）。 */
  query(provider: string): Promise<CreditHistoryQueryResult>
  /** 列出某来源的账号（账号池）。 */
  accounts(provider: string): Promise<readonly { id: string; nickname?: string; credentialRef?: unknown }[]>
  /** 告警（默认丢弃；装配层接 `ctx.logger.warn`）。 */
  warn?(message: string): void
  /** 时钟（默认 `Date.now`）。 */
  now?(): number
  /** 等待（默认真实 `setTimeout`；查询前固定等 2000ms）。 */
  pause?(ms: number): Promise<void>
}

/**
 * 磁盘上的采样点（**增量编码后的形状**）。
 *
 * 与 `CreditHistoryPoint` 的差别只有两条：
 * ① 允许带 `intervalMinutes` 元数据；② `packages` 只在「资源包签名变化」的
 * 那个点上出现，其余点省略（读时按前一个可用点还原，见 `restorePoints`）。
 * 这里**不**把它写成 `CreditHistoryPoint & {...}`：增量形状里 ok 点的
 * `total` 语义上一定在，但类型上要容许缺省，故显式建模。
 */
export interface StoredHistoryPoint {
  at: number
  status: 'ok' | 'failed'
  total?: number
  expiredTotal?: number
  packages?: CreditHistoryPackage[]
  intervalMinutes?: number
}

/** 磁盘上的一个账号序列。 */
export interface StoredHistorySeries {
  provider: string
  accountId: string
  nickname?: string
  points: StoredHistoryPoint[]
}

/** 磁盘上的完整状态文档（内存结构 = 磁盘结构）。 */
export interface CreditHistoryState {
  version: number
  enabled: boolean
  intervalMinutes: number
  series: Record<string, StoredHistorySeries>
  attempts: Record<string, number>
  failures: Record<string, number>
  /**
   * 采样间隔的来源标记：`'user'` = 用户在本插件里显式 `configure` 过。
   *
   * ⚠️ 它存在的**唯一**理由是让「旧数据的 15 升级为 5」与「用户显式选的 15
   * 重启后仍是 15」这两件事同时成立：旧插件（以及本项目旧版本）只会写 15，
   * 且没有任何标记能区分两者，故**没有本标记的 15 一律升级为 5**。
   */
  intervalSource?: 'user'
}

/** 状态文档版本（与旧实现一致：非 1 即视为不兼容）。 */
export const HISTORY_STATE_VERSION = 1

// ---------------------------------------------------------------------------
// 纯逻辑：取值清洗、采样点构造、变化语义
// ---------------------------------------------------------------------------

/** 把 `unknown` 收窄成普通对象（不是数组、不是 null）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 有限数字才取，否则用兜底值。 */
function finiteOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 字符串才取，否则空串。 */
function stringOr(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 四位小数以上足够，避免浮点噪声写进磁盘（与原实现一致）。 */
function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

/** UTC+8 日界（与仓库其它每日额度逻辑一致）。 */
const day = (at: number): string => new Date(at).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })

/** 把一个（形状不可信的）资源包清洗成对外契约形状。 */
function sanitizePackage(raw: unknown): CreditHistoryPackage {
  const record = asRecord(raw) ?? {}
  const remaining = finiteOr(record.remaining, null)
  const cycleStartTime = stringOr(record.cycleStartTime)
  const cycleEndTime = stringOr(record.cycleEndTime)
  const expiredTime = stringOr(record.expiredTime)
  return {
    name: stringOr(record.name),
    unit: stringOr(record.unit) || '积分',
    active: record.active !== false,
    remaining,
    total: finiteOr(record.total, remaining),
    used: finiteOr(record.used, 0) ?? 0,
    cycleStartTime,
    cycleEndTime,
    expiredTime,
    cycle: `${cycleStartTime}/${cycleEndTime}/${expiredTime}`,
  }
}

/**
 * 只保留余额与资源包口径；凭据及服务端错误原文**不写入历史**。
 *
 * 失败（无余额 / 负数 / 非有限数）返回 `{ status: 'failed' }` —— 历史里的缺口
 * 本身就是信息，绝不能用 0 顶替。
 */
export function makePoint(
  item: { balance?: { total?: number; expiredTotal?: number; packages?: readonly unknown[] } | null },
  at: number,
): CreditHistoryPoint {
  const balance = item.balance
  const total = balance ? finiteOr(balance.total, null) : null
  if (!balance || total === null || total < 0) return { at, status: 'failed' }
  const packages = (balance.packages ?? []).map(sanitizePackage).sort((a, b) => a.name.localeCompare(b.name))
  return { at, status: 'ok', total, expiredTotal: finiteOr(balance.expiredTotal, 0) ?? 0, packages }
}

/**
 * 资源包签名：只由**不随用量变化**、且一旦变化就必须视为「换了批包」的字段组成。
 *
 * ⚠️ 与 `changeBetween` 里的 identity 判据**同源**（`name/unit/active/cycle`），
 * 这是增量编码安全的根据：签名相同 ⇒ `changeBetween` 不会判 `reset` ⇒ 省略
 * `remaining/used/...` 不会让消费语义被误读（净变化仍由 `total` 承载）。
 */
function packageSignature(packages: readonly CreditHistoryPackage[]): string {
  return JSON.stringify(packages.map(p => [p.name, p.unit, p.active, p.cycle]))
}

/**
 * 相邻两点的变化语义。
 *
 * `intervalMinutes` 是**当前点**的采样间隔（历史点各自带着写它时的间隔），
 * 判 gap 的阈值是它的 2.5 倍 —— 采样间隔升级到 5 分钟后，12.5 分钟以上的
 * 断档才算缺口。
 */
export function changeBetween(
  previous: CreditHistoryPoint | undefined,
  current: CreditHistoryPoint,
  intervalMinutes: number = DEFAULT_INTERVAL_MINUTES,
): CreditHistoryChange {
  if (!previous || previous.status !== 'ok' || current.status !== 'ok') return { kind: 'gap' }
  const minutes = (current.at - previous.at) / MINUTE
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > intervalMinutes * 2.5) return { kind: 'gap', minutes }
  if (day(previous.at) !== day(current.at)) return { kind: 'reset', minutes }
  const previousPackages = previous.packages ?? []
  const currentPackages = current.packages ?? []
  if (packageSignature(previousPackages) !== packageSignature(currentPackages)) return { kind: 'reset', minutes }
  const previousTotal = previous.total ?? 0
  const currentTotal = current.total ?? 0
  // 同时有资源包增加和减少时不能把净变化冒充纯消耗。
  const increase = currentTotal > previousTotal + EPSILON || currentPackages.some((p, index) => {
    const before = previousPackages[index]
    return p.remaining !== null && before !== undefined && before.remaining !== null
      && p.remaining > before.remaining + EPSILON
  })
  if (increase) return { kind: 'increase', minutes, amount: round(currentTotal - previousTotal) }
  return { kind: 'usage', minutes, amount: round(Math.max(0, previousTotal - currentTotal)) }
}

/**
 * 磁盘形状 → 对外契约形状（增量编码的**还原**点）。
 *
 * 规则与编码端严格对称：某 ok 点若没有 `packages`，就取**它之前最近一个自带
 * `packages` 的 ok 点**的副本（失败点不参与，也不打断基准）。完全没有基准
 * （例如基准点已被 30 天保留裁掉）时退化为空数组 —— 这只会发生在最旧的边界
 * 点上，`view()` 的渲染窗口内不可能出现。
 *
 * `from` 用于**只构造窗口内的对象**：窗口外的点仍然要被扫过以维护基准
 * （增量点是相对基准的差量），但不产生任何对象/数组分配。
 */
function restorePoints(
  stored: readonly StoredHistoryPoint[],
  fallbackIntervalMinutes: number,
  from: number = Number.NEGATIVE_INFINITY,
): RestoredHistoryPoint[] {
  const points: RestoredHistoryPoint[] = []
  let base: readonly CreditHistoryPackage[] | undefined
  for (const storedPoint of stored) {
    const intervalMinutes = storedPoint.intervalMinutes ?? fallbackIntervalMinutes
    if (storedPoint.status !== 'ok') {
      if (storedPoint.at >= from) points.push({ at: storedPoint.at, status: 'failed', intervalMinutes })
      continue
    }
    const own = storedPoint.packages
    if (own !== undefined) base = own
    if (storedPoint.at < from) continue
    const packages = own !== undefined ? own.map(p => ({ ...p })) : (base ?? []).map(p => ({ ...p }))
    points.push({
      at: storedPoint.at,
      status: 'ok',
      total: storedPoint.total,
      expiredTotal: storedPoint.expiredTotal,
      packages,
      intervalMinutes,
    })
  }
  return points
}

// ---------------------------------------------------------------------------
// 磁盘状态：读取、严格校验、择优迁移
// ---------------------------------------------------------------------------

/** 默认状态：**5 分钟**采样、启用、无序列。 */
function defaultState(): CreditHistoryState {
  return {
    version: HISTORY_STATE_VERSION,
    enabled: true,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    series: {},
    attempts: {},
    failures: {},
  }
}

/** 错误信息取字符串（诊断用，不把原始对象写进历史）。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取 Node 错误码（判 ENOENT 用）。 */
function errorCode(error: unknown): string | undefined {
  const code = asRecord(error)?.code
  return typeof code === 'string' ? code : undefined
}

/** 清洗一个磁盘点；结构不可信就丢弃（`undefined`）。 */
function sanitizeStoredPoint(raw: unknown): StoredHistoryPoint | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const at = finiteOr(record.at, null)
  if (at === null) return undefined
  const intervalMinutes = finiteOr(record.intervalMinutes, null)
  const point: StoredHistoryPoint = { at, status: 'failed' }
  if (intervalMinutes !== null && intervalMinutes > 0) point.intervalMinutes = intervalMinutes
  const total = finiteOr(record.total, null)
  if (record.status === 'ok' && total !== null && total >= 0) {
    point.status = 'ok'
    point.total = total
    point.expiredTotal = finiteOr(record.expiredTotal, 0) ?? 0
    if (Array.isArray(record.packages)) point.packages = record.packages.map(sanitizePackage)
  } else if (total !== null) {
    point.total = total
  }
  return point
}

/** 清洗一个序列；provider/accountId 缺一即丢弃整个序列。 */
function sanitizeStoredSeries(raw: unknown): StoredHistorySeries | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  const provider = stringOr(record.provider)
  const accountId = stringOr(record.accountId)
  if (!provider || !accountId) return undefined
  const points: StoredHistoryPoint[] = []
  if (Array.isArray(record.points)) {
    for (const rawPoint of record.points) {
      const point = sanitizeStoredPoint(rawPoint)
      if (point) points.push(point)
    }
  }
  const row: StoredHistorySeries = { provider, accountId, points }
  if (typeof record.nickname === 'string') row.nickname = record.nickname
  return row
}

/** 从 `unknown` 数字表里取有限值（丢弃脏项）。 */
function sanitizeCounters(raw: unknown, onlyNonNegative: boolean): Record<string, number> {
  const counters: Record<string, number> = {}
  const record = asRecord(raw)
  if (!record) return counters
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    if (onlyNonNegative && value < 0) continue
    counters[key] = value
  }
  return counters
}

/** 校验结果：清洗后的状态 + 「间隔是否被升级过」（决定要不要立刻回写）。 */
interface SanitizedState {
  state: CreditHistoryState
  /** 磁盘上写的是旧默认的 15，已被升级为 5 ⇒ 需要回写，让磁盘如实反映运行值。 */
  intervalUpgraded: boolean
}

/**
 * 严格校验并清洗一份状态文档；**不兼容就返回 `undefined`**（由调用方决定是
 * 抛错还是忽略）。判据与旧实现一致：`version` 必须是 1，`series` 与 `attempts`
 * 必须存在。
 *
 * ⚠️ 「旧状态里的 15 升级为 5」在这里落地：只有带 `intervalSource: 'user'`
 * 的状态才保留 15，其余（旧插件、本项目旧版本写的）一律升级为 5。
 */
function sanitizeState(raw: unknown): SanitizedState | undefined {
  const record = asRecord(raw)
  if (!record) return undefined
  if (record.version !== HISTORY_STATE_VERSION) return undefined
  const seriesRaw = asRecord(record.series)
  const attemptsRaw = asRecord(record.attempts)
  if (!seriesRaw || !attemptsRaw) return undefined
  const series: Record<string, StoredHistorySeries> = {}
  for (const [key, value] of Object.entries(seriesRaw)) {
    const row = sanitizeStoredSeries(value)
    if (row) series[key] = row
  }
  const state = defaultState()
  state.enabled = record.enabled !== false
  const storedInterval = record.intervalMinutes === 15 || record.intervalMinutes === 5 ? record.intervalMinutes : undefined
  const explicit = record.intervalSource === 'user'
  const intervalUpgraded = storedInterval === 15 && !explicit
  state.intervalMinutes = intervalUpgraded ? DEFAULT_INTERVAL_MINUTES : storedInterval ?? DEFAULT_INTERVAL_MINUTES
  if (explicit && state.intervalMinutes === 15) state.intervalSource = 'user'
  state.series = series
  state.attempts = sanitizeCounters(attemptsRaw, false)
  state.failures = sanitizeCounters(record.failures, true)
  return { state, intervalUpgraded }
}

/**
 * 读取并校验一个候选文件。
 *
 * - 文件不存在 → `undefined`（唯一的「正常缺失」）；
 * - 读不动 / JSON 坏 / 格式不兼容 → **抛中文错误**（绝不静默覆盖：原文件保持原样）。
 */
function readStateFile(file: string): SanitizedState | undefined {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new Error(`无法读取积分历史（${file}），保留原文件：${describeError(error)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new Error(`积分历史格式不兼容（${file}），保留原文件：${describeError(error)}`)
  }
  const sanitized = sanitizeState(parsed)
  if (!sanitized) throw new Error(`积分历史格式不兼容（${file}），保留原文件`)
  return sanitized
}

/** 一份状态里**最晚**的采样点时刻；没有点则 `-Infinity`。 */
function newestSampleAt(state: CreditHistoryState | undefined): number {
  if (!state) return Number.NEGATIVE_INFINITY
  let newest = Number.NEGATIVE_INFINITY
  for (const row of Object.values(state.series)) {
    for (const point of row.points) if (point.at > newest) newest = point.at
  }
  return newest
}

// ---------------------------------------------------------------------------
// 引擎
// ---------------------------------------------------------------------------

/** 状态从哪里来（决定要不要把结果另存到单一存储的目标位置）。 */
type StateSource = 'target' | 'legacy' | 'default'

export class CreditHistory {
  /** 单一存储的状态文档路径（`<home>/jet-hub/credit-history.json`）。 */
  readonly path: string
  /** 内存状态（结构即磁盘结构，测试与装配层可直接读）。 */
  readonly state: CreditHistoryState

  private readonly deps: CreditHistoryDeps
  private cache: Map<string, { signature: string; result: CreditHistoryBalancesResult }>
  private tail: Promise<unknown>
  private closed: boolean
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly source: StateSource
  /** 装载时是否把旧数据的 15 升级成了 5（决定构造期要不要回写一次）。 */
  private intervalUpgraded: boolean

  constructor(deps: CreditHistoryDeps) {
    this.deps = deps
    this.path = historyStatePath(deps.home)
    this.state = defaultState()
    this.cache = new Map()
    this.tail = Promise.resolve()
    this.closed = false
    this.intervalUpgraded = false
    this.source = this.load()
    // 两种情况要立刻回写单一存储：
    // ① 磁盘状态来自旧位置（迁移）；
    // ② 采样间隔被升级（旧数据的 15 → 5），让磁盘如实反映运行值。
    // ⚠️ 源文件既不删除也不改写（独立插件可能还在跑，且要可回滚）。
    if (this.source === 'legacy' || this.intervalUpgraded) this.save()
  }

  // ---- 状态装载 -----------------------------------------------------------

  private load(): StateSource {
    // 目标位置是权威数据：格式坏了**必须抛**（保留原文件，绝不用旧数据覆盖它）。
    const target = readStateFile(this.path)
    const legacyPath = legacyHistoryStatePath(this.deps.home)
    let legacy: SanitizedState | undefined
    try {
      legacy = readStateFile(legacyPath)
    } catch (error) {
      // 迁移源不是权威数据：读不动就告警跳过，不能让整个插件起不来。
      this.warn(`积分历史：旧位置文件无法解析，已跳过迁移（${legacyPath}）：${describeError(error)}`)
    }
    let chosen: SanitizedState | undefined
    let source: StateSource = 'default'
    if (target && legacy) {
      // ⚠️ **按最新采样时间择优**，不能只看文件是否存在：
      // 本机实测目标位置只有 2/2/1 个点（到 2026-10-01），而旧位置有 66/66/65 个点
      // （到 2026-10-05）——「目标存在就用目标」会直接丢掉四天的新数据。
      if (newestSampleAt(legacy.state) > newestSampleAt(target.state)) {
        chosen = legacy
        source = 'legacy'
      } else {
        chosen = target
        source = 'target'
      }
    } else if (target) {
      chosen = target
      source = 'target'
    } else if (legacy) {
      chosen = legacy
      source = 'legacy'
    }
    if (chosen) {
      Object.assign(this.state, chosen.state)
      // ⚠️ 「旧数据的 15 升级为 5」必须**立刻落盘**：只在内存里改的话，用户
      // 下次启动又读到 15、又走一遍升级逻辑，行为随「进程活了多久」而变化。
      this.intervalUpgraded = chosen.intervalUpgraded
    }
    return source
  }

  // ---- 基础设施 -----------------------------------------------------------

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private warn(message: string): void {
    this.deps.warn?.(message)
  }

  private pause(ms: number): Promise<void> {
    if (this.deps.pause) return this.deps.pause(ms)
    return new Promise<void>(resolve => { setTimeout(resolve, ms) })
  }

  /** 全局串行队列：并发调用共享同一条链（避免同时打上游触发风控）。 */
  private enqueue<T>(fn: () => T | Promise<T>): Promise<T> {
    const job = this.tail.then(() => {
      if (this.closed) throw new Error('积分记录已停止')
      return fn()
    })
    this.tail = job.catch(() => undefined)
    return job
  }

  // ---- 体积治理 -----------------------------------------------------------

  /**
   * 分层抽稀 + 有界兜底（每次保存前跑一次）。
   *
   * 顺序：① 丢 30 天外；② 8 天内原样；③ 8～30 天按 30 分钟时隙留首个 ok 点
   * （失败点在冷区不占位、也不保留 —— 缺口信息由 `changeBetween` 的 `gap`
   * 在新旧交界处给出）；④ 超上限时只裁「全分辨率窗口之外」的旧点。
   */
  private prune(): void {
    const now = this.now()
    const cutoff = now - RETENTION_DAYS * DAY
    const fullStart = now - FULL_RESOLUTION_DAYS * DAY
    const slotMs = THINNED_INTERVAL_MINUTES * MINUTE
    for (const [key, row] of Object.entries(this.state.series)) {
      let kept: StoredHistoryPoint[] = []
      let slot = Number.NaN
      for (const point of row.points) {
        if (point.at < cutoff) continue
        if (point.at >= fullStart) {
          kept.push(point)
          continue
        }
        if (point.status !== 'ok') continue
        const currentSlot = Math.floor(point.at / slotMs)
        if (currentSlot === slot) continue
        slot = currentSlot
        kept.push(point)
      }
      if (kept.length > MAX_POINTS_PER_SERIES) kept = this.trimExcess(key, kept, fullStart)
      if (kept.length === 0) delete this.state.series[key]
      else row.points = kept
    }
  }

  /**
   * 有界兜底的裁剪：**只裁全分辨率窗口之外的旧点**，且从最旧的一端开始。
   *
   * 到不了「必须裁近期点」的情形：全分辨率窗口在最小间隔下最多
   * `FULL_RESOLUTION_POINTS` 个点，小于上限。真出现（系统时钟被回拨、
   * 外部写入了未来时间戳）时**宁可超出上限也不丢近期点** —— 近期点正是用户
   * 能看到的图表窗口，这正是旧实现 `slice(-9000)` 的病因。
   */
  private trimExcess(key: string, kept: StoredHistoryPoint[], fullStart: number): StoredHistoryPoint[] {
    let excess = kept.length - MAX_POINTS_PER_SERIES
    const result: StoredHistoryPoint[] = []
    for (const point of kept) {
      if (excess > 0 && point.at < fullStart) {
        excess -= 1
        continue
      }
      result.push(point)
    }
    if (excess > 0) {
      this.warn(`积分历史：序列 ${key} 的近期点数超过兜底上限（${MAX_POINTS_PER_SERIES}），本次不裁剪近期点`)
    }
    return result
  }

  /**
   * 增量编码：资源包签名与前一个**自带 `packages` 的 ok 点**相同时省略
   * `packages`。
   *
   * ⚠️ 基准的选择必须与 `restorePoints` 完全一致（都是「之前最近一个自带
   * `packages` 的 ok 点」），否则会还原出错误的资源包。
   * ⚠️ **不能只看紧邻的上一个点**：上一个点很可能**正是被省略的那个**
   * （编码一旦连续生效，它就没有 `packages`）—— 拿它当基准会判「不相等」，
   * 于是每个点都重新存一份完整资源包，增量编码**完全失效**
   * （实测：写用例时 6 个点里 4 个仍然携带完整 `packages`）。
   */
  private encode(existing: readonly StoredHistoryPoint[], point: CreditHistoryPoint): StoredHistoryPoint {
    const stored: StoredHistoryPoint = { ...point, intervalMinutes: this.state.intervalMinutes }
    if (point.status !== 'ok') return stored
    let base: StoredHistoryPoint | undefined
    for (let index = existing.length - 1; index >= 0; index -= 1) {
      const candidate = existing[index]
      if (candidate && candidate.status === 'ok' && candidate.packages !== undefined) {
        base = candidate
        break
      }
    }
    if (base !== undefined && packageSignature(base.packages ?? []) === packageSignature(point.packages ?? [])) {
      delete stored.packages
    }
    return stored
  }

  /** 原子落盘（临时文件 + rename；权限 0600）。 */
  save(): void {
    this.prune()
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temporary, this.path)
  }

  // ---- 采样 ---------------------------------------------------------------

  /**
   * 该来源当前的下次查询间隔：失败按 2 倍指数退避，**上限 60 分钟**。
   *
   * ⚠️ **指数不额外截断**（旧实现写的是 `2 ** Math.min(3, failures)`）：
   * 那个 `min(3)` 是「基准 15 分钟」时代的产物 —— `15 × 2³ = 120`，靠它把
   * 指数压到 3 才有意义。但基准改成 **5** 之后 `5 × 2³ = 40`，于是
   * **「上限 60 分钟」永远达不到**：阶梯实测为 `5 → 10 → 20 → 40 → 40 → 40`。
   * 现值用外壳的 `Math.min(60, …)` 封顶（`2 ** failures` 溢出为 `Infinity` 时
   * 同样得到 60），阶梯为 `5 → 10 → 20 → 40 → 60 → 60`，与文档一致；
   * 基准 15 时的阶梯（`15 → 30 → 60`）与旧实现**逐值相同**。
   */
  interval(provider: string): number {
    return Math.min(60, this.state.intervalMinutes * 2 ** (this.state.failures[provider] ?? 0)) * MINUTE
  }

  /**
   * 查一次余额（并落盘采样点）。
   *
   * 顺序与原插件逐条一致：
   * ① 冷却期（`max(5 分钟, interval)`）内**不打上游** —— 有内存结果就原样返回，
   *    否则用磁盘上最后一个点回答（重启后也能立刻展示已存余额）；
   * ② `pause(2000)` 之后再查（顺序查询，避免风控）；
   * ③ `attempts` **先落盘**再打上游 ⇒ 重启不会重复请求。
   */
  balances(provider: string): Promise<CreditHistoryBalancesResult> {
    if (!HISTORY_PROVIDERS.includes(provider)) {
      return Promise.resolve({ ok: false, error: { code: 'bad-request', message: '不支持的积分来源' } })
    }
    return this.enqueue(async (): Promise<CreditHistoryBalancesResult> => {
      const entries = await this.deps.accounts(provider)
      const signature = entries.map(entry => `${entry.id}:${String(entry.credentialRef)}`).sort().join('|')
      const cached = this.cache.get(provider)
      const last = this.state.attempts[provider] ?? 0
      const cooldown = Math.max(5 * MINUTE, this.interval(provider))
      if (this.now() - last < cooldown) {
        if (cached && cached.signature === signature) {
          const value = cached.result.value
          return { ...cached.result, value: { ...value, cached: true, sampledAt: last, nextQueryAt: last + cooldown } }
        }
        // 重启后可展示已存余额，无需马上重查远端。
        return {
          ok: true,
          value: {
            cached: true,
            sampledAt: last,
            nextQueryAt: last + cooldown,
            accounts: entries.map(entry => {
              const row = this.state.series[`${provider}/${entry.id}`]
              const lastAt = row?.points.at(-1)?.at
              const point = row ? restorePoints(row.points, this.state.intervalMinutes, lastAt ?? Number.NEGATIVE_INFINITY).at(-1) : undefined
              const ok = point?.status === 'ok'
              return {
                accountId: entry.id,
                nickname: entry.nickname,
                balance: ok ? { total: point.total, packages: point.packages, expiredTotal: point.expiredTotal ?? 0 } : null,
                error: ok ? undefined : '等待下次低频采样',
              }
            }),
          },
        }
      }
      await this.pause(2000)
      const at = this.now()
      this.state.attempts[provider] = at
      // 先落盘查询时间，进程重启也不会反复请求。
      this.save()
      // 注入的 `query` 只承诺冻结契约的窄形状；采样元数据由本方法补上，
      // 故这里按**宽**形状持有（注入实现是装配层的适配器，它不做这件事）。
      let result: CreditHistoryBalancesResult
      try {
        result = await this.deps.query(provider)
      } catch {
        result = {
          ok: true,
          value: {
            accounts: entries.map(entry => ({
              accountId: entry.id,
              nickname: entry.nickname,
              balance: null,
              error: '余额查询失败，请稍后重试',
            })),
          },
        }
      }
      if (this.closed) return result
      const items = result.ok ? result.value?.accounts ?? [] : []
      const completedAt = this.now()
      for (const entry of entries) {
        const item = items.find(candidate => candidate.accountId === entry.id) ?? { balance: null }
        const key = `${provider}/${entry.id}`
        const row = this.state.series[key] ?? { provider, accountId: entry.id, points: [] }
        this.state.series[key] = row
        row.nickname = entry.nickname
        row.points.push(this.encode(row.points, makePoint(item, completedAt)))
      }
      const success = items.some(candidate => candidate.balance && Number.isFinite(candidate.balance.total))
      this.state.failures[provider] = success || entries.length === 0 ? 0 : (this.state.failures[provider] ?? 0) + 1
      this.save()
      if (result.ok) {
        result.value = { ...result.value, sampledAt: completedAt, nextQueryAt: at + this.interval(provider), cached: false }
      }
      this.cache.set(provider, { signature, result })
      return result
    })
  }

  /**
   * 读某来源的历史（**本地文件读取，绝不打上游**）。
   *
   * `hours` 上限 168（7 天）—— 比抽稀窗口（8 天）小，故抽稀**永不影响渲染
   * 结果。返回的每个 ok 点都带完整 `packages`（增量编码已在此还原）。
   */
  view(provider: string, hours = 24): CreditHistoryView {
    const cutoff = this.now() - Math.max(1, Math.min(168, Number(hours) || 24)) * HOUR
    const accounts: CreditHistoryAccountView[] = []
    for (const row of Object.values(this.state.series)) {
      if (row.provider !== provider) continue
      const points = restorePoints(row.points, this.state.intervalMinutes, cutoff)
      const views = points.map((point, index) => ({
        ...point,
        change: changeBetween(index > 0 ? points[index - 1] : undefined, point, point.intervalMinutes ?? this.state.intervalMinutes),
      }))
      const account: CreditHistoryAccountView = { provider: row.provider, accountId: row.accountId, points: views }
      if (row.nickname !== undefined) account.nickname = row.nickname
      accounts.push(account)
    }
    return {
      enabled: this.state.enabled,
      intervalMinutes: this.state.intervalMinutes,
      retentionDays: RETENTION_DAYS,
      nextQueryAt: (this.state.attempts[provider] ?? 0) + this.interval(provider),
      accounts,
    }
  }

  /** 改设置：间隔只接受 5 / 15（中文报错），其余字段原样保留。 */
  configure(payload: { enabled?: boolean; intervalMinutes?: number }): Promise<{ enabled: boolean; intervalMinutes: number }> {
    return this.enqueue(() => {
      if (payload.intervalMinutes !== undefined && !ALLOWED_INTERVAL_MINUTES.includes(payload.intervalMinutes)) {
        throw new Error('仅支持 5 或 15 分钟采样')
      }
      if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
      if (payload.intervalMinutes !== undefined) {
        this.state.intervalMinutes = payload.intervalMinutes
        // 记下「这是用户显式选的」，下次启动就不会再被「旧数据的 15 升级为 5」改掉。
        this.state.intervalSource = 'user'
      }
      if (payload.enabled !== undefined) this.state.enabled = payload.enabled
      this.save()
      return { enabled: this.state.enabled, intervalMinutes: this.state.intervalMinutes }
    })
  }

  /**
   * 起后台采样（返回停止函数）。
   *
   * 每 30 秒醒一次，按 `HISTORY_PROVIDERS` 顺序串行查询到期且**有账号**的
   * 来源；关掉开关或停止后一个请求都不发。
   */
  start(): () => void {
    let running = false
    const tick = async (): Promise<void> => {
      if (running || this.closed || !this.state.enabled) return
      running = true
      try {
        for (const provider of HISTORY_PROVIDERS) {
          if (this.closed || !this.state.enabled) break
          if (this.now() - (this.state.attempts[provider] ?? 0) < this.interval(provider)) continue
          if ((await this.deps.accounts(provider)).length === 0) continue
          await this.balances(provider)
        }
      } catch (error) {
        this.warn(`积分记录失败：${describeError(error)}`)
      } finally {
        running = false
      }
    }
    this.timer = setInterval(() => void tick(), 30_000)
    this.timer.unref?.()
    return () => {
      this.closed = true
      if (this.timer !== undefined) clearInterval(this.timer)
    }
  }
}
