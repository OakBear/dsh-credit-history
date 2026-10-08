import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * 「积分历史」Sidebar 标签页的**接线**（客户端入口 `apply` → registerTab）。
 *
 * ## 为什么需要这个文件
 *
 * 此前没有任何用例真正**执行**过客户端 `plugin-src/client/index.js` 的
 * `apply()` —— 现有断言都是"读源码文本、查字符串在不在"。那类断言有个致命
 * 盲区：**整段接线被删掉时它们可以依然全绿**。
 *
 * 这不是假想。走势图 worker 交付时明确报告过：面板文件写好了、单测 25 条全绿，
 * 但 `index.js` 根本没 import 它，**面板在界面上根本不出现**。
 * 也就是说："文件存在 + 单测通过" ≠ "标签页真的注册了"。
 *
 * 故这里用**替身 react** 把模块真 import 进来、真跑一遍 `apply`，断言
 * `betterSidebar.registerTab` 被调用、且参数是面板真正需要的那几个。
 *
 * ## 为什么能测（react 不在依赖里）
 *
 * `vi.mock('react', factory)` 提供了工厂函数，故 vitest 不需要真的解析
 * `react` 包。替身只要给出 `createElement` 即可：本模块只在**渲染时**用到它，
 * 而"注册"这一步不渲染，故断言的是注册参数而不是 DOM。
 */

const here = dirname(fileURLToPath(import.meta.url))
const readSource = (rel: string) => readFileSync(resolve(here, '../..', rel), 'utf8')

/**
 * ⚠️ 必须在 import 被测模块**之前**补上 `document`。
 *
 * `apply()` 的第一句就 `ctx.effect(() => installJetHubStyles())`，而它会
 * `document.createElement('style')`。缺了它整条 apply 在**第二行**就抛
 * `document is not defined` —— 标签页自然也没注册。
 *
 * 但这**不是产品缺陷**：真实运行环境是浏览器，`document` 必然存在。
 * 这是测试环境（`environment: 'node'`）的缺口，故由用例自己补最小替身。
 */
const styles: any[] = []
;(globalThis as any).document = {
  createElement: () => ({ textContent: '', remove: () => {} }),
  head: { appendChild: (el: unknown) => { styles.push(el) } },
}

/** 记录所有 `registerTab` 入参，供断言。 */
const registered: any[] = []

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useState: (initial: unknown) => [initial, () => {}],
  useEffect: () => {},
  useRef: (initial: unknown) => ({ current: initial }),
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
}))

/** 最小 cordis 客户端上下文：够 `installCreditHistoryTab` 跑完。 */
const makeCtx = () => {
  const effects: unknown[] = []
  const ctx: any = {
    injected: [] as string[][],
    slots: { inject: () => {}, register: () => {} },
    effect: (fn: () => unknown) => { const d = fn(); effects.push(d); return d },
    inject: (names: string[], callback: (scope: any) => void) => {
      ctx.injected.push(names)
      // ⚠️ 真实 `ctx.inject(names, cb)` 传入的是**派生作用域**，不是原 ctx。
      // 替身若不传参或传 undefined，被测代码会在 `scope.effect(...)` 上抛
      // TypeError —— 而现象是"用例红、代码其实没问题"（本仓库踩过）。
      callback(ctx)
    },
    connection: undefined,
  }
  ctx.betterSidebar = {
    registerTab: (options: unknown) => { registered.push(options); return () => {} },
  }
  return { ctx, effects }
}

/**
 * ⚠️ 入口模块在**模块作用域**只 import 一次，不放进取例体内。
 *
 * `plugin-src/client/index.js` 会连带拉进整个 `jet-hub.js`（几十万字节的模块
 * 图）。首次解析在满负载的全量套件里实测超过 5 秒，正好撞上 vitest 默认的
 * `testTimeout` —— 表现是「单独跑绿、全量跑红」的**假失败**（真踩过）。
 * 放在模块作用域（收集阶段）就与每个用例的超时预算无关了。
 */
const entryModule = (await import('../../plugin-src/client/index.js')) as any
const loadEntry = async () => entryModule

describe('客户端 apply：积分历史标签页的接线', () => {
  it('⚠️ apply() 真的会把标签页注册进 betterSidebar', async () => {
    registered.length = 0
    const mod = await loadEntry()
    mod.apply(makeCtx().ctx)

    expect(registered, 'apply() 跑完后没有注册任何标签页 —— 面板在界面上不会出现').toHaveLength(1)
    const tab = registered[0]
    expect(tab.id).toBe('credit-history')
    expect(tab.title).toBe('积分历史')
  })

  it('⚠️ 注册参数必须齐全（id/title/description/order/single/settings/component）', async () => {
    registered.length = 0
    const mod = await loadEntry()
    mod.apply(makeCtx().ctx)

    const tab = registered[0]
    // 每个字段都对应一个真实后果：id 缺了无法去重与持久化顺序；
    // component 缺了点是空白页；settings 缺了齿轮里没有采样设置。
    expect(Object.keys(tab).sort()).toEqual(
      ['component', 'description', 'id', 'order', 'settings', 'single', 'title'])
    expect(typeof tab.component).toBe('function')
    expect(typeof tab.settings.render).toBe('function')
    expect(tab.single).toBe(true)
    expect(tab.order).toBe(30)
    // 文案必须是中文用户文案，不是内部标识符
    expect(tab.description).toContain('积分')
  })

  it('⚠️ betterSidebar 必须走惰性注入，不进 cordis 静态 inject', async () => {
    // ⚠️ 这里判的是 index.js 的 `export const inject`（**cordis 运行期服务注入**），
    // 不是 package.json 的 `dsh.client.inject`（那是**构建期模块加载顺序**，
    // 里面**应当**有 dsh-better-sidebar 以保证打包顺序）。
    // 两者同名不同义，混起来会把正确的配置判成缺陷。
    //
    // 危害：静态 inject 里出现 betterSidebar ⇒ headless / CLI profile 里没有该包，
    // 本插件会**永久 pending**，12 个 provider 的推理路由一起失效。
    const entry = readSource('plugin-src/client/index.js')
    const staticInject = /export const inject = \[([^\]]*)\]/.exec(entry)
    expect(staticInject, '找不到 index.js 的静态 inject 声明').not.toBeNull()
    expect(staticInject![1]).not.toContain('betterSidebar')

    registered.length = 0
    const mod = await loadEntry()
    const { ctx } = makeCtx()
    mod.apply(ctx)
    expect(ctx.injected, 'betterSidebar 未通过 ctx.inject 惰性请求').toContainEqual(['betterSidebar'])
  })

  it('⚠️ betterSidebar 缺席时不得抛错（headless profile 必须能正常加载）', async () => {
    registered.length = 0
    const mod = await loadEntry()
    const { ctx } = makeCtx()
    delete ctx.betterSidebar
    // 真实 cordis 在服务缺席时**不执行回调**；这里复刻该语义。
    ctx.inject = (names: string[], callback: (scope: any) => void) => {
      ctx.injected.push(names)
      if (ctx.betterSidebar !== undefined) callback(ctx)
    }
    expect(() => mod.apply(ctx)).not.toThrow()
    expect(registered).toHaveLength(0)
  })

  it('⚠️ 面板与设置面板共用同一个 rpcCall（整合的核心：同一条通道）', async () => {
    registered.length = 0
    const mod = await loadEntry()
    mod.apply(makeCtx().ctx)

    const tab = registered[0]
    // 两个渲染入口都必须能跑通，且**渲染本身不发起请求**（取数在 effect 里）。
    // 若在这里就发请求，每次 React 重渲染都会多打一次上游。
    expect(() => tab.component({ visible: true })).not.toThrow()
    expect(() => tab.settings.render()).not.toThrow()

    // 反向保护：整合后客户端**不得**再自带一条独立 RPC 通道。
    // ⚠️ 不能断言源码里不出现 "credit-history" 字样 —— index.js 的注释里
    // 恰好提到旧通道 `/api/credit-history` 作为合并背景说明。
    // 要判的是**真的还有没有另开通道的调用**。
    const tabSource = readSource('plugin-src/client/credit-history-tab.js')
    expect(tabSource, '标签页自行开了 RPC 通道').not.toMatch(/\.rpc\.call\(/)
    // 入口必须把共享的 rpcCall 传进去
    expect(readSource('plugin-src/client/index.js')).toContain('installCreditHistoryTab(ctx, rpcCall)')
  })
})
