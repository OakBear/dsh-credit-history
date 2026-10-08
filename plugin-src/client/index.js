/**
 * 独立插件 `dsh-credit-history` 的客户端入口。
 *
 * ## 职责
 *
 * 只有一件事：把「积分历史」标签页注册到 `betterSidebar`，并给它一条**自己的**
 * RPC 通道 `/api/credit-history`（宿主侧由 `registerHistoryRpc` 注册；两端的
 * 路径必须同源，见 `lib/rpc-server.js` 的 `CREDIT_HISTORY_API_PATH`）。
 *
 * ## ⚠️ `betterSidebar` 用**惰性注入**，不进静态 `inject`
 *
 * `dsh-better-sidebar` 是**可选**依赖：headless / CLI profile 里没有它。
 * 若把它写进静态 `inject`，那些 profile 里本插件会**永久 pending**，
 * 插件完全不可用 —— 而标签页缺席只是少一个入口，完全可接受。
 *
 * ⇒ 静态 `inject` 只有 `['connection']`；`betterSidebar` 走
 * `ctx.inject(['betterSidebar'], …)`（服务缺席时回调根本不执行）。
 */
import { installCreditHistoryTab } from './credit-history-tab.js'

export const name = 'dsh-credit-history-client'

/** 客户端运行期需要的 cordis 服务：只有 `connection`（自带端点的 RPC 通道）。 */
export const inject = ['connection']

/**
 * 客户端安装：自建 rpcCall（解包信封、失败抛错），再惰性注入 betterSidebar
 * 注册标签页。
 *
 * @param ctx - 客户端插件上下文。
 */
export function apply(ctx) {
  /** 已解包的 RPC 调用器：面板契约是「失败抛错、成功回 value」。 */
  const rpcCall = async (method, payload) => {
    const result = await ctx.connection.rpc.call('/api', 'credit-history', { method, payload })
    if (!result?.ok) throw new Error(result?.error?.message || '无法读取积分历史')
    return result.value
  }

  // installCreditHistoryTab 内部自己走 `ctx.inject(['betterSidebar'], …)` 惰性
  // 注入：服务缺席（headless）时回调不执行，标签页不出现，插件其余部分不受影响。
  installCreditHistoryTab(ctx, rpcCall)
}
