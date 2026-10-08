/**
 * 独立积分历史插件的**自有 RPC 端点**。
 *
 * ## 与整合期（jet-hub）端点的关系
 *
 * 整合进 dsh-codearts-auth 时，`history.read` / `history.configure` /
 * `session.provider` 三个方法挂在 `/api/jet-hub` 通道下，靠
 * `connection.rpc.call('/api', 'jet-hub', …)` 走；拆回独立插件后这条通道
 * **不存在**（宿主插件保持私有且已移除积分历史），故本插件自带一个独立的
 * fetch 端点 `/api/credit-history`，客户端也改用
 * `connection.rpc.call('/api', 'credit-history', …)`。
 *
 * ## 形状
 *
 * 信封校验、错误码、405/415/400 三道门与整合期的实现逐字同款，只有两处
 * 有意差异：
 * - 通道名从 `'jet-hub'` 换成 `'credit-history'`（信封里的 `message.method`
 *   字段），路径也从 `/api/jet-hub` 换成本插件的 `/api/credit-history`；
 * - 新增 `session.provider` 分支：供面板「按当前会话自动切换来源」。`observer`
 *   缺席时该分支返回 `{provider: null}`——面板的种子效应在拿不到会话供应商时
 *   本来就回退到默认来源，语义不变。
 */
import type { CreditHistory } from './credit-history.js'
import type { SessionProviderObserver } from './session-provider-observer.js'

/** connection.fetch.register 捕获的 fetch handler（形状子集，便于单测打桩）。 */
export interface HistoryConnectionLike {
  fetch: {
    register(handler: {
      path: string
      methods: string[]
      requestBody: 'buffered'
      fetch(request: {
        method?: string
        headers: { get(name: string): string | null }
        json(): Promise<unknown>
      }): Promise<Response>
    }): unknown
  }
}

/** RPC 信封的 payload 最小结构。 */
interface HistoryPayload {
  method?: unknown
  payload?: unknown
}

/** 独立端点的固定路径。客户端 `rpcCall` 与它必须同源。 */
export const CREDIT_HISTORY_API_PATH = '/api/credit-history'

/**
 * 注册独立 RPC 端点。
 *
 * @param connection - ctx.connection（`fetch.register` 形状）。
 * @param history - 采样引擎实例（`view` / `configure` 是仅有的两个读改入口）。
 * @param observer - 会话供应商观察器；缺席时 `session.provider` 恒回 `null`。
 * @returns 端点 handler（即 `connection.fetch.register` 的返回值）。
 */
export function registerHistoryRpc(
  connection: HistoryConnectionLike,
  history: CreditHistory,
  observer?: SessionProviderObserver,
): unknown {
  return connection.fetch.register({
    path: CREDIT_HISTORY_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return new Response('JSON required', { status: 415 })
      }
      let message: unknown
      try {
        message = await request.json()
      } catch {
        return new Response('invalid JSON', { status: 400 })
      }
      const reply = (result: unknown): Response =>
        Response.json({ type: 'server-response', rpcId: (message as { rpcId?: unknown }).rpcId, result })
      const envelope = message as
        | { type?: unknown; rpcId?: unknown; method?: unknown; payload?: HistoryPayload }
        | undefined
      if (
        envelope?.type !== 'client-request'
        || typeof envelope.rpcId !== 'string'
        || envelope.method !== 'credit-history'
        || !envelope.payload
        || typeof envelope.payload.method !== 'string'
      ) {
        return reply({ ok: false, error: { code: 'bad-request', message: '无效的历史请求', details: {} } })
      }
      try {
        const { method, payload = {} } = envelope.payload
        const body = payload as {
          provider?: unknown
          hours?: unknown
          sessionId?: unknown
          [key: string]: unknown
        }
        let value: unknown
        if (method === 'history.read') {
          // 本地文件读取，绝不打上游；`view` 是同步的（含增量还原与抽稀）。
          // ⚠️ 与整合期逐字同款：provider 非字符串一律按空串处理并**拒绝**
          //（「全部来源」这种查询没有定义），hours 缺省回 24。
          const provider = typeof body.provider === 'string' ? body.provider.trim() : ''
          if (provider.length === 0) {
            return reply({ ok: false, error: { code: 'bad-request', message: 'provider 不能为空' } })
          }
          value = history.view(provider, typeof body.hours === 'number' ? body.hours : 24)
        }
        else if (method === 'history.configure') {
          // 非法值拒绝而不是静默回落：合法间隔只有 5 / 15，中文报错由引擎给，
          // 这里原样透传，错误码与整合期同为 bad-request（设置类失败不是
          // 「服务坏了」，前端只展示 message）。
          try {
            value = await history.configure(body as { enabled?: boolean; intervalMinutes?: number })
          } catch (configError) {
            return reply({
              ok: false,
              error: {
                code: 'bad-request',
                message: configError instanceof Error ? configError.message : String(configError),
              },
            })
          }
        }
        else if (method === 'session.provider') {
          // 按当前会话自动切源：`providerOf` 未命中（进程刚启动、内存负缓存）
          // 时回 `null`，面板种子效应自己回退到默认来源。**不报错** —— 这是
          // 「拿不到」而不是「坏了」，报错会让面板把可用的默认来源也拒掉。
          // sessionId 不做格式校验：观察器对未知 id 一律 undefined，假 id 只是
          // 白解压一次目录遍历，不构成注入面（与整合期同款）。
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
          const provider = observer?.providerOf(sessionId)
          value = { provider: provider === undefined ? null : provider }
        }
        else {
          throw new Error('历史页面只支持本地读取和设置；手动查询请使用 Jet Hub')
        }
        return reply({ ok: true, value })
      } catch (error) {
        return reply({
          ok: false,
          error: {
            code: 'credit-history/failed',
            message: error instanceof Error ? error.message : String(error),
            /**
             * ⚠️ `details` 恒为空对象：不要把 `error.stack` 塞进去 —— 信封会
             * 原样发给浏览器，堆栈可能带绝对路径。这是从整合期继承的纪律。
             */
            details: {},
          },
        })
      }
    },
  })
}
