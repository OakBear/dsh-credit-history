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
import type { CreditHistory } from './credit-history.js';
import type { SessionProviderObserver } from './session-provider-observer.js';
/** connection.fetch.register 捕获的 fetch handler（形状子集，便于单测打桩）。 */
export interface HistoryConnectionLike {
    fetch: {
        register(handler: {
            path: string;
            methods: string[];
            requestBody: 'buffered';
            fetch(request: {
                method?: string;
                headers: {
                    get(name: string): string | null;
                };
                json(): Promise<unknown>;
            }): Promise<Response>;
        }): unknown;
    };
}
/** 独立端点的固定路径。客户端 `rpcCall` 与它必须同源。 */
export declare const CREDIT_HISTORY_API_PATH = "/api/credit-history";
/**
 * 注册独立 RPC 端点。
 *
 * @param connection - ctx.connection（`fetch.register` 形状）。
 * @param history - 采样引擎实例（`view` / `configure` 是仅有的两个读改入口）。
 * @param observer - 会话供应商观察器；缺席时 `session.provider` 恒回 `null`。
 * @returns 端点 handler（即 `connection.fetch.register` 的返回值）。
 */
export declare function registerHistoryRpc(connection: HistoryConnectionLike, history: CreditHistory, observer?: SessionProviderObserver): unknown;
