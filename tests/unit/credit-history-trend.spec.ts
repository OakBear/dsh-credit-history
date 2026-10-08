import { describe, expect, it } from 'vitest'
import {
  buildTrend,
  changeKindOf,
  isValidSample,
  niceTicks,
  axisLayout,
} from '../../plugin-src/client/trend-geometry.js'

/**
 * 走势图「空缺合并」的判据。
 *
 * ## 用户要求（原话）
 * > 一段时间空缺的话，就把它合并在一起，不需要把它显示为空缺
 *
 * 修复前的实现（`credit-history-panel.js` 的 `Trend`）把有效采样按「相邻失败 /
 * `gap`」切成 `runs`，每段各画一条 polyline + 一块面积，并在断点处画**竖直虚线**
 * （源码注释原文：`dashed vertical break, so the line and the area visibly stop
 * instead of bridging a long absence of samples`）。于是长时间没采样时，图上就是
 * 一段一段断开、中间竖一道虚线的样子 —— 那正是用户说的「显示为空缺」。
 *
 * ## 为什么判据在这个模块里
 * 单测环境是 `node`、**`react` 不在依赖内**，组件渲染不了。所以一切要被断言的
 * 判据都必须落在不依赖 React 的纯函数里才**真跑得到**覆盖（本仓库既有惯例：
 * `new-account.js` / `model-bulk.js` / `account-model-link.js`）。
 *
 * ## 契约
 * 1. 一整串采样**只产出 1 段**曲线（`runs.length === 1`），无论中间有多少
 *    `gap` / 失败采样 / `reset`；
 * 2. `breaks` **恒为空** —— 不再有任何虚线断点；
 * 3. x 轴仍按**真实时间**线性映射：空缺是一条更长的线段，**不被压缩**；
 * 4. 面积同样跨越空缺填充（不开口）；
 * 5. 退化输入（空数组 / 单点）不抛错。
 */

const BASE = Date.UTC(2026, 8, 30, 4, 0, 0) // 2026-09-30 12:00 (+08:00)
const MIN = 60000

/** 一个有效采样：有余额、有区间变化。 */
const ok = (minutes: number, total: number, change?: { kind: string; minutes?: number; amount?: number }) => ({
  at: BASE + minutes * MIN,
  status: 'ok',
  total,
  expiredTotal: 0,
  packages: [],
  change: change ?? { kind: 'usage', minutes, amount: 5 },
})

/** 一个失败采样：**没有 `total`**（宿主 `makePoint` 在查询失败时的真实形态）。 */
const failed = (minutes: number) => ({ at: BASE + minutes * MIN, status: 'failed' })

const SIZE = { width: 320, height: 200 }

/**
 * **反向验证用的「修复前」参考实现**（原样复刻已删除的那段逻辑）。
 *
 * 它存在的意义不是被测代码，而是**证明上面的判据有区分力**：如果判据只是把
 * 「实现现在的行为」抄一遍（同义反复），这个变异体也会通过。零 `gap` 的场景下
 * 两者理应收敛，所以每个用例都同时断言「变异体确实违反契约」。
 *
 * 注意它走的是 `points`（含失败采样），与原实现一致 —— 原实现的注释明确写了
 * 「walking `plot` would hide every failure boundary」。
 */
function legacyBreakAtGaps(points: any[]) {
  const runs = []
  let run = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const prev = points[i - 1]
    const broken = i > 0 && (prev.status !== 'ok' || p.status !== 'ok' || p.change?.kind === 'gap')
    if (broken && run.length) { runs.push(run); run = [] }
    if (p.status === 'ok') run.push(p)
  }
  if (run.length) runs.push(run)

  const breaks = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.status !== 'ok') { breaks.push({ at: p.at, failure: true }); continue }
    if (i > 0 && points[i - 1].status === 'ok' && p.change?.kind === 'gap') {
      breaks.push({ at: (points[i - 1].at + p.at) / 2, failure: false })
    }
  }
  return { runs, lines: runs.filter(r => r.length >= 2), breaks }
}

describe('buildTrend —— 长时间空缺被合并（不再显示为空缺）', () => {
  // 12:00 与 12:05 各一次采样，之后**沉寂约 8 小时**（远超 5 分钟采样的 gap
  // 阈值），20:00 才恢复。这就是用户报障的形态。
  const gapped = [
    ok(0, 1000),
    ok(5, 995),
    { ...ok(480, 700), change: { kind: 'gap', minutes: 475 } },
    ok(485, 695),
    ok(490, 690),
  ]

  it('整串只产出 1 段曲线（缺口不再切段）', () => {
    const t = buildTrend(gapped, SIZE)
    expect(t.runs).toHaveLength(1)
    expect(t.lines).toHaveLength(1)
    expect(t.curves).toHaveLength(1)
  })

  it('曲线是一条连续折线，首尾顶点都在（空缺被跨越）', () => {
    const t = buildTrend(gapped, SIZE)
    const vertices = t.curves[0].polyline.trim().split(/\s+/)
    // 5 个有效采样 → 5 个顶点。空缺**不插顶点、也不断开**。
    expect(vertices).toHaveLength(5)
    expect(t.curves[0].points).toHaveLength(5)
  })

  it('breaks 恒为空 —— 没有任何虚线断点', () => {
    expect(buildTrend(gapped, SIZE).breaks).toEqual([])
    // 缺口 + 失败 + 跨日混在一起也一样空。
    expect(buildTrend([
      ok(0, 1000), failed(5), failed(10),
      { ...ok(480, 700), change: { kind: 'gap', minutes: 470 } },
      { ...ok(600, 300), change: { kind: 'reset', minutes: 120 } },
    ], SIZE).breaks).toEqual([])
  })

  it('面积同样跨越空缺填充（不开口）', () => {
    const t = buildTrend(gapped, SIZE)
    const first = t.curves[0].points[0]
    const last = t.curves[0].points[t.curves[0].points.length - 1]
    const polygon = t.curves[0].area
    const { padLeft, innerW, padTop, innerH } = t.layout
    // 面积从首点垂到末点：底边横跨首尾两点的真实时间位置。
    const bottom = padTop + innerH
    expect(polygon.startsWith(`${t.scale.xOf(first).toFixed(1)},${bottom} `)).toBe(true)
    expect(polygon.endsWith(` ${t.scale.xOf(last).toFixed(1)},${bottom}`)).toBe(true)
    // 首尾恰好落在绘图区两端（真实时间域被完整使用，没有因缺口被砍掉）。
    expect(t.scale.xOf(first)).toBeCloseTo(padLeft, 6)
    expect(t.scale.xOf(last)).toBeCloseTo(padLeft + innerW, 6)
    // 面积**只有一块** —— 修复前每个 run 一块，空缺处会留下一个开口。
    expect(t.curves).toHaveLength(1)
  })

  it('x 轴保持真实时间比例：空缺处是更长的线段，不被压缩', () => {
    const t = buildTrend(gapped, SIZE)
    const pts = t.curves[0].points
    // 相邻区间：0→5 分钟（密集），5→480 分钟（空缺），480→485、485→490（密集）。
    const gapWidth = t.scale.xOf(pts[2]) - t.scale.xOf(pts[1])
    const denseWidth = t.scale.xOf(pts[1]) - t.scale.xOf(pts[0])
    // 475 分钟的间隔 vs 5 分钟的间隔 → 前者必须是后者的 95 倍，而不是「等宽」。
    expect(gapWidth / denseWidth).toBeCloseTo(95, 3)
    // 逐点核对真实时间比例（不是均分）。
    const { minAt, maxAt } = t.domain
    const { padLeft, innerW } = t.layout
    for (const p of pts) {
      expect(t.scale.xOf(p)).toBeCloseTo(padLeft + ((p.at - minAt) / (maxAt - minAt)) * innerW, 6)
    }
    // 8 小时沉寂后恢复的那个点**不**落在画布正中 —— 均分才是「压缩时间」的错误做法。
    expect(t.scale.xOf(pts[2])).not.toBeCloseTo(padLeft + innerW / 2, 1)
  })

  it('缺口区间不参与加粗高亮（它不是可估算的连续消耗）', () => {
    const t = buildTrend(gapped, SIZE)
    // 4 个区间里跨 5→480 那个是 gap → 只剩 3 个真实相邻区间。
    expect(t.segments).toHaveLength(3)
    expect(t.segments.some((s: any) => s.b.at === BASE + 480 * MIN)).toBe(false)
  })

  it('反向验证：修复前的切段实现在同一组输入上违反契约', () => {
    const legacy = legacyBreakAtGaps(gapped)
    expect(legacy.runs).toHaveLength(2)          // ← 被切成两段
    expect(legacy.lines).toHaveLength(2)         // ← 画两条线（视觉上断开）
    expect(legacy.breaks).toHaveLength(1)        // ← 画一条虚线断点
    expect(legacy.runs).not.toHaveLength(buildTrend(gapped, SIZE).runs.length)
    expect(legacy.breaks).not.toEqual(buildTrend(gapped, SIZE).breaks)
  })
})

describe('buildTrend —— 失败采样被跨越而不是打断曲线', () => {
  const withFailures = [
    ok(0, 800),
    failed(5),
    failed(10),
    failed(15),
    ok(20, 780),
    ok(25, 770),
  ]

  it('中间夹着连续失败采样仍只有 1 段', () => {
    const t = buildTrend(withFailures, SIZE)
    expect(t.runs).toHaveLength(1)
    expect(t.lines).toHaveLength(1)
    expect(t.breaks).toEqual([])
  })

  it('失败采样不进曲线（没有 total），但它的时间仍留在 x 域里', () => {
    const t = buildTrend(withFailures, SIZE)
    expect(t.valid).toHaveLength(3)
    expect(t.curves[0].points).toHaveLength(3)
    expect(t.valid.every(isValidSample)).toBe(true)
    // x 域起点含全部采样：首个采样即 12:00，故曲线从它开始。
    expect(t.domain.minAt).toBe(BASE)
    expect(t.domain.maxAt).toBe(BASE + 25 * MIN)
  })

  it('失败采样的区间不被当成「连续消耗」加粗', () => {
    const t = buildTrend(withFailures, SIZE)
    // 有效点 0/20/25 分钟，区间两段：0→20 跨度含失败，仍算真实相邻区间。
    expect(t.segments).toHaveLength(2)
  })

  it('反向验证：修复前会被 3 个失败采样切成两段并画 3 条虚线', () => {
    const legacy = legacyBreakAtGaps(withFailures)
    expect(legacy.runs).toHaveLength(2)
    expect(legacy.breaks).toHaveLength(3)
    expect(legacy.breaks.every(b => b.failure)).toBe(true)
  })
})

describe('buildTrend —— reset（跨日 / 资源包变化）保持连续', () => {
  const crossing = [
    ok(0, 500),
    { ...ok(60, 480), change: { kind: 'usage', minutes: 60, amount: 20 } },
    { ...ok(120, 300), change: { kind: 'reset', minutes: 60 } },
    { ...ok(180, 310), change: { kind: 'increase', minutes: 60, amount: 10 } },
  ]

  it('相邻 reset 不切段、不留断点', () => {
    const t = buildTrend(crossing, SIZE)
    expect(t.runs).toHaveLength(1)
    expect(t.lines).toHaveLength(1)
    expect(t.breaks).toEqual([])
    expect(t.curves[0].points).toHaveLength(4)
  })

  it('reset 与 increase 的区间仍被作色（reset 走 warn 色，非 usage）', () => {
    const t = buildTrend(crossing, SIZE)
    expect(t.segments).toHaveLength(3)
    expect(t.segments.filter((s: any) => s.usage)).toHaveLength(1)
  })

  it('反向验证：reset 原本就不切段（回归对照）', () => {
    // reset 在修复前**也**是连续的 —— 这条用来固定「本次改动没有顺手改坏它」。
    expect(legacyBreakAtGaps(crossing).runs).toHaveLength(1)
    expect(legacyBreakAtGaps(crossing).breaks).toEqual([])
  })
})

describe('buildTrend —— 退化输入不抛错', () => {
  it('空数组返回完整结构', () => {
    const t = buildTrend([], SIZE)
    expect(t.ready).toBe(false)
    expect(t.runs).toEqual([])
    expect(t.lines).toEqual([])
    expect(t.curves).toEqual([])
    expect(t.breaks).toEqual([])
    expect(t.ticks.length).toBeGreaterThan(0)
    expect(Number.isFinite(t.scale.xOf({ at: BASE, total: 0 }))).toBe(true)
  })

  it('单点：不抛错，但不发单顶点折线（那个点由逐点圆圈画）', () => {
    const t = buildTrend([ok(0, 100)], SIZE)
    expect(t.ready).toBe(false)
    expect(t.runs).toHaveLength(1)
    expect(t.lines).toEqual([])
    expect(t.curves).toEqual([])
    expect(t.breaks).toEqual([])
    // 单点也让 x 轴有最小跨度，避免除零。
    expect(t.domain.maxAt).toBeGreaterThan(t.domain.minAt)
  })

  it('全是失败采样：不抛错且不画线', () => {
    const t = buildTrend([failed(0), failed(5)], SIZE)
    expect(t.valid).toEqual([])
    expect(t.runs).toEqual([])
    expect(t.breaks).toEqual([])
    expect(t.ready).toBe(false)
  })

  it('非数组 / 缺字段 / 尺寸为 0 都不抛错', () => {
    expect(() => buildTrend(undefined)).not.toThrow()
    expect(() => buildTrend(null, {})).not.toThrow()
    expect(() => buildTrend([{}, { at: NaN }], { width: 0, height: 0 })).not.toThrow()
    const t = buildTrend([{ at: BASE, total: 5 }, { at: BASE + MIN, total: 1 }], { width: 0, height: 0 })
    // 宽度有下限，绘图区永不为负。
    expect(t.layout.innerW).toBeGreaterThan(0)
    expect(t.layout.innerH).toBeGreaterThan(0)
  })

  it('余额完全不变时上下留白不为零（否则曲线贴边）', () => {
    const t = buildTrend([ok(0, 1286), ok(5, 1286)], SIZE)
    expect(t.domain.high).toBeGreaterThan(t.domain.low)
  })
})

describe('changeKindOf / isValidSample —— 统一判定入口', () => {
  it('有效采样的四种区间类型原样返回', () => {
    expect(changeKindOf(ok(5, 100, { kind: 'usage' }))).toBe('usage')
    expect(changeKindOf(ok(5, 100, { kind: 'increase' }))).toBe('increase')
    expect(changeKindOf(ok(5, 100, { kind: 'reset' }))).toBe('reset')
    expect(changeKindOf(ok(5, 100, { kind: 'gap', minutes: 400 }))).toBe('gap')
  })

  it('失败采样 → failed；未知 kind → unknown（不得当成断点）', () => {
    expect(changeKindOf(failed(0))).toBe('failed')
    expect(changeKindOf(ok(5, 100, { kind: 'brand-new-kind-from-host' }))).toBe('unknown')
    // 宿主漏发 `change`（老数据 / 字段被裁）时不能当断点，也不能崩。
    expect(changeKindOf({ at: BASE, status: 'ok', total: 100 })).toBe('unknown')
    expect(changeKindOf(undefined)).toBe('failed')
  })

  it('isValidSample 要求 ok 且 total 是有限数', () => {
    expect(isValidSample(ok(0, 0))).toBe(true)
    expect(isValidSample(failed(0))).toBe(false)
    expect(isValidSample({ at: BASE, status: 'ok' })).toBe(false)
    expect(isValidSample({ at: BASE, status: 'ok', total: NaN })).toBe(false)
  })
})

describe('坐标轴（沿用行为，未因本次改动变化）', () => {
  it('niceTicks 落在 1/2/5×10ⁿ 档位', () => {
    // 100/4 = 25 → 归到 5×10¹ = 50 的档位（所以是 0/50/100，不是 0/25/50/75/100）。
    expect(niceTicks(0, 100)).toEqual([0, 50, 100])
    // 1000/4 = 250 → 归一化 2.5 落在「≤5」档 → 5×10² = 500（档位向上取，不会出现 250）。
    expect(niceTicks(0, 1000)).toEqual([0, 500, 1000])
    expect(niceTicks(10, 10)).toEqual([10])
  })

  it('⚠️ niceTicks 的 minStep 抬升粒度，且抬升后仍落在档位上', () => {
    // 恒定余额会得到极窄的定义域（如 [0,1]），4 等分后步长 0.5 —— 积分是整数
    // 计数的，半个积分不存在。minStep=1 把粒度抬到 1。
    expect(niceTicks(0, 1, 4, 1)).toEqual([0, 1])
    // ⚠️ 顺序是可观察的：必须**先**对 `span/count` 与 minStep 取大**再**归档位。
    // 反过来写（先归档位再抬到 minStep）会得到非档位步长，刻度列表随之不同：
    //   low=0 high=12 minStep=7 → 正确 [0,10]（步长 10），错误 [0,7]（步长 7）。
    //   low=0 high=4  minStep=3 → 正确 [0]（步长 5，只落一个），错误 [0,3]。
    // ⚠️ 必须用 3/7 这类**本身不在 1/2/5×10ⁿ 档位**的 minStep 才能区分；
    // 真实调用点只传 0/1，用 0/1 写的用例对这两种顺序**等价**（我第一版就是
    // 这么写的，变异实验里没抓住）。⚠️ 也不能只断言"是 5 的倍数" —— 错误实现
    // 的 7 同样会出现在某些输入里，必须断言**具体的刻度列表**。
    expect(niceTicks(0, 12, 4, 7)).toEqual([0, 10])
    expect(niceTicks(0, 4, 4, 3)).toEqual([0])
  })

  it('⚠️ 恒定整数余额不得出现小数刻度（本机 qoder 账号 66 点全为 0）', () => {
    // 真实数据触发过：一个账号余额恒为 0 ⇒ range=0 ⇒ 定义域塌成 [0,1] ⇒
    // 轴标签渲染成「0 / 0.5 / 1」。用户看到**半个积分**，而积分是整数计数的。
    for (const total of [0, 1, 3, 100, 400, 500]) {
      const t = buildTrend(Array.from({ length: 6 }, (_, i) => ok(i * 60, total)), { width: 600, height: 220 })
      const fractional = t.tickLabels.filter((l: string) => l.includes('.'))
      expect(fractional, `恒定余额 ${total} 出现小数刻度：${JSON.stringify(t.tickLabels)}`).toEqual([])
    }
  })

  it('⚠️ 余额本就带小数时不得被强制取整（buddy 真实值 2191.54）', () => {
    // 反向约束：不能为了消掉小数刻度而一律 Number.isInteger 化 ——
    // 那样相邻两个刻度会挤成同一个标签（如 2,200 / 2,200 / 2,200）。
    const totals = [2191.54, 2191.54, 2204.94, 2204.94, 2289.36, 2289.36]
    const t = buildTrend(totals.map((total, i) => ok(i * 60, total)), { width: 600, height: 220 })
    expect(t.tickLabels.length).toBeGreaterThan(1)
    expect(new Set(t.tickLabels).size, `刻度标签重复：${JSON.stringify(t.tickLabels)}`).toBe(t.tickLabels.length)
  })

  it('⚠️ 近恒定的小数余额必须仍有刻度（y 轴不能塌成空）', () => {
    // 这是「一律强制整数」这种过度修复的**唯一可测表现形式**：
    // 余额是 2191.54 这种小数、且几乎不动（range≈0.04）时，若把粒度下限
    // 硬设成 1，`niceTicks` 会返回**空数组** —— y 轴一个刻度都没有。
    // ⚠️ 上面那条（较大量级的波动）**抓不到**这个，因为它的小数位足够多、
    // 强制取整后仍有多个不同标签。必须用「近恒定 + 带小数」这个组合才暴露。
    const totals = [2191.54, 2191.54, 2191.56, 2191.54, 2191.58, 2191.56]
    const t = buildTrend(totals.map((total, i) => ok(i * 60, total)), { width: 600, height: 220 })
    expect(t.ticks.length, '近恒定小数余额下 y 轴没有任何刻度').toBeGreaterThan(0)
    expect(t.tickLabels.length).toBe(t.ticks.length)
    // 刻度必须落在数据实际覆盖的区间内（不能因为取整而漂到整数上去）
    for (const v of t.ticks) {
      expect(v).toBeGreaterThanOrEqual(t.domain.low)
      expect(v).toBeLessThanOrEqual(t.domain.high)
    }
  })

  it('axisLayout 在放得下时用完整数字', () => {
    expect(axisLayout([0, 250, 500, 750, 1000], 400).labels).toEqual(['0', '250', '500', '750', '1,000'])
  })

  it('axisLayout 在窄栏里缩写，且留白封顶（绘图区不塌缩）', () => {
    // 完整数字是 "1,000,000,000"（13 字符 ≈ 83px），窄栏放不下 → 必须缩写。
    const big = axisLayout([1e9, 2e9, 3e9], 120)
    expect(big.labels.every((l: string) => l.includes('亿'))).toBe(true)
    const cap = Math.max(40, Math.round(120 * 0.45))
    expect(big.padLeft).toBeLessThanOrEqual(cap)
    expect(big.padLeft).toBeGreaterThanOrEqual(40)
  })
})
