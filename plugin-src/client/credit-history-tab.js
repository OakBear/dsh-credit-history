/**
 * 「积分历史」Sidebar 标签页（betterSidebar）。
 *
 * ## 为什么这个文件存在（整合背景）
 *
 * 此前它是一个**独立插件**（`dsh-credit-history`）注册的标签页，靠自己的
 * `/api/credit-history` 端点取数。整合后标签页搬进本插件，数据改走
 * `jet-hub` 端点的 `history.read` / `history.configure`，与 Jet Hub 设置页
 * 共用同一个 `rpcCall` 与同一份 `/api/jet-hub` 通道。
 *
 * ## ⚠️ `betterSidebar` 用**惰性注入**，不进静态 `inject`
 *
 * `dsh-better-sidebar` 是**可选**依赖：headless / CLI profile 里没有它。
 * 若把它写进静态 `inject`，那些 profile 里本插件会**永久 pending**，
 * 整个插件（含 12 个 provider 的推理路由）都不再可用 —— 这与
 * `tests/unit/plugin.spec.ts` 里「`connection` 不得进静态 inject」是同一类
 * 规定（那条已被真实事故验证过）。
 *
 * ⇒ 这里用 `ctx.inject(['betterSidebar'], …)`：服务缺席时回调根本不执行，
 * 标签页自然不出现，而插件其余功能完全不受影响。
 */

import * as React from 'react'
import { CreditHistoryPanel, HistorySettings } from './credit-history-panel.js'

const h = React.createElement

/** 标签页 id（betterSidebar 用它去重与持久化顺序）。 */
export const CREDIT_HISTORY_TAB_ID = 'credit-history'

/**
 * 注册标签页。
 *
 * @param ctx - 客户端插件上下文（需能 `inject(['betterSidebar'])`）。
 * @param rpcCall - `(method, payload) => Promise<value>`，**已解包**的调用器
 *   （失败时抛错）。这与面板自身的契约一致，故面板无需认识 RPC 信封。
 */
export function installCreditHistoryTab(ctx, rpcCall) {
  ctx.inject(['betterSidebar'], (scope) => {
    scope.effect(() => scope.betterSidebar.registerTab({
      id: CREDIT_HISTORY_TAB_ID,
      title: '积分历史',
      description: '各 API 源的积分余额走势与消耗估算',
      /**
       * 排在 Jet Hub 自家的标签之后：这块是**只读走势图**，不是管理入口。
       */
      order: 30,
      /** 同 id 只允许开一个（它是"一份数据的一种视图"，多开会显示同样的内容）。 */
      single: true,
      settings: {
        /**
         * 齿轮里渲染**本插件自己的**设置面板，而不是声明式 `pluginToggles`：
         * 这两个控件写的是宿主侧采样器的状态，用声明式行会让 sidebar 自己再存
         * 一份同义的值，两者必然漂移（改一处另一处不同步）。
         */
        render: () => h(HistorySettings, { rpcCall }),
      },
      component: (props) => h(CreditHistoryPanel, {
        rpcCall,
        /**
         * 当前会话 id：面板用它向宿主查询「本会话最近用的是哪个供应商」，
         * 并把来源下拉框**预选**到那个供应商（不再是恒默认 `qodercn`）。
         * 与 dsh-turn-usage 的取法一致：会话作用域的 tab 挂在 `props.scope` 上。
         */
        sessionId: props.scope?.sessionId,
        /**
         * `visible` = 本标签**当前可见**（既是活动标签、且面板展开）。
         * 不可见时面板会停止 30s 轮询 —— 历史是本地文件读取，没必要在后台刷。
         */
        visible: props.visible !== false,
      }),
    }), 'jet-hub: credit history sidebar tab')
  })
}

export { CreditHistoryPanel, HistorySettings }
