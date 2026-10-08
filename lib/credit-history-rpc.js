/**
 * 积分历史的**宿主侧接线**：把采样引擎接到 Jet Hub 自己的取数与存储上。
 *
 * ## 为什么这个文件存在（整合背景）
 *
 * 此前「积分历史」是一个**独立插件**（`dsh-credit-history`），它有自己的
 * RPC 端点（`/api/credit-history`）、自己的采样定时器，并在
 * `lib/balance-reader.js` 里**重新实现了一遍 provider 分派** —— 做法是
 * 加载本插件的只读内部模块（`credits` / `qoder-credits` / `trae-credits` …）
 * 再自己逐账号打上游。
 *
 * 于是同一个账号的同一份余额会被**打两次**：徽标/面板走 `credits.balances`，
 * 历史采样走自己那套。两者的冷却与缓存互不知情（独立插件的冷却是
 * `max(5min, interval)`，徽标是 120s TTL），所以「同一时刻问上游两次」是常态。
 *
 * 整合后**只有一个取数入口**：采样器直接复用装配层已经建好的 `usageBadge`
 * （它的 `collectBalances` 就是内部 `handleMethod('credits.balances', …)`），
 * 于是采样与徽标**共用同一份 TTL 缓存与在飞去重** —— 采样命中的那一轮不会
 * 产生任何上游请求，用户手动刷新徽标也会顺带满足采样的需求。
 *
 * ⚠️ **本文件不复制任何 provider 分支**：与本仓库既有的
 * 「取数直接复用内部 `handleMethod`，不另写 provider 分派」同一条规则。
 *
 * ## 与独立版的差别（有意为之）
 *
 * | 项 | 独立插件 | 整合后 |
 * |---|---|---|
 * | 取数 | 自己加载内部模块再打上游 | `usageBadge.read()`（共用 120s TTL 缓存） |
 * | 存储 | `$DSH_HOME/credit-history/history.json` | `$DSH_HOME/jet-hub/credit-history.json`（与账号池同一目录） |
 * | 采样间隔 | 默认 15 分钟 | 默认 **5 分钟** |
 * | 端点 | `/api/credit-history`（独立插件注册） | `jet-hub` 端点的 `history.read` / `history.configure` |
 *
 * 端点合并不是为了省事：Jet Hub 已有的 `/api/jet-hub` 通道**已经**是这条
 * 数据的自然归属（同一个账号池、同一个凭据解析器、同一份显示偏好），
 * 再注册一个平行端点只会让「哪一份才是权威」重新变成问题。
 */
import { resolveDshHome } from './home.js';
import { CreditHistory, HISTORY_PROVIDERS } from './credit-history.js';
/**
 * 构造采样用的取数适配器。
 *
 * @param badge - 装配层建好的徽标读数服务（**唯一**取数入口）。
 * @param warn - 告警出口（读数失败时记一条，便于排查「曲线为什么断了」）。
 */
export function createHistoryBalanceSource(badge, warn) {
    return {
        async query(provider) {
            const result = await badge.read(provider);
            if (!result.ok) {
                /**
                 * 整批失败：**原样回报 `ok: false`**，让引擎按「本次无数据」记一个
                 * `status: 'failed'` 的点。
                 *
                 * ⚠️ 这里**不抛异常**（虽然引擎的 `catch` 也会兜成同一形态）：
                 * 走返回值的路径保留了 `error.message`，便于在历史里看清是哪一种失败；
                 * 且省掉一层异常控制流 —— `createHistoryBalanceSource` 是每 5 分钟
                 * 跑一次的常驻路径，不该靠异常驱动正常分支。
                 *
                 * ⚠️ **绝不能**把它折成「余额 0」：曲线掉到 0 是用户最容易被骗的形态，
                 * 也是 `balance: null` 与 `balance: 0` 必须严格区分的原因。
                 */
                warn?.(`[jet-hub] 积分历史：${provider} 读数失败（记为失败点）：${result.error.message}`);
                return { ok: false, error: { code: result.error.code, message: result.error.message } };
            }
            // 读数形状由 `HistoryBadgeLike` 契约保证（宿主 lib 的 `credits.balances` 结果）。
            const value = result.value;
            return {
                ok: true,
                value: {
                    /**
                     * ⚠️ **逐行保真搬运**，不做任何折算：
                     * - `balance: null`（+ `error`）必须原样保留 —— 它是「这个账号没读到」，
                     *   与 `balance.total === 0`（真的没额度了）是两件事，曲线上前者是断点、
                     *   后者是掉到 0，引擎的 `makePoint` 正是靠 `Number.isFinite(total)`
                     *   区分它们；
                     * - `error` 一并带上，好在排查「这个账号为什么一直没有点」时看到原因。
                     */
                    accounts: value.accounts.map((row) => ({
                        accountId: row.accountId,
                        nickname: row.nickname,
                        balance: row.balance,
                        /**
                         * 宿主的 `error` 是 `{code,message}` 对象（更早版本是字符串）；
                         * 引擎的口径是 **字符串**，这里统一压成 `message`（退化时用
                         * `code`，再退化用 `String(error)`），不丢排查线索。
                         */
                        ...(row.error === undefined
                            ? {}
                            : {
                                error: typeof row.error === 'string'
                                    ? row.error
                                    : row.error.message ?? row.error.code ?? String(row.error),
                            }),
                    })),
                },
            };
        },
    };
}
/**
 * 装配积分历史：建引擎、排定采样。
 *
 * 返回值是引擎实例（`undefined` = 本 profile 无法定位数据目录，已降级为
 * 「不启用采样」，只记一条告警）。调用方把它接到 RPC 分支上。
 *
 * ⚠️ 与 `autoCheckin` 同款：`ctx.effect` **可选调用**（本仓库大量单测的 ctx
 * 桩是最小化的，直接调会让无关用例报 `ctx.effect is not a function`）。
 */
export function attachCreditHistory(ctx, badge, listAccountsByProvider, deps = {}) {
    let history = deps.history;
    if (history === undefined) {
        const home = deps.home ?? resolveDshHome(ctx);
        if (typeof home !== 'string' || home.length === 0) {
            // 与 `createJetHubStore` 同款降级：定位不到 home 时只告警，不让插件 apply() 失败。
            ctx.logger?.warn?.('[jet-hub] 无法定位 DSH home，积分历史采样未启用');
            return undefined;
        }
        const source = deps.source ?? createHistoryBalanceSource(badge, (message) => ctx.logger?.warn?.(message));
        history = new CreditHistory({
            home,
            query: (provider) => source.query(provider),
            /**
             * 只把**启用**账号交给引擎。
             *
             * ⚠️ 必须与 `usageBadge` 的过滤口径一致（`enabled !== false`）：徽标读数
             * 里已经滤掉停用账号，若这里把停用账号也交给引擎，引擎会为它在
             * `accounts` 里找不到对应读数，从而记下一个**假的失败点** ——
             * 曲线会凭空多出「查询失败」，而用户只是停用了那个账号。
             */
            accounts: async (provider) => listAccountsByProvider(provider)
                .filter((entry) => entry.enabled !== false)
                .map((entry) => ({ id: entry.id, nickname: entry.nickname, credentialRef: entry.credentialRef })),
            warn: (message) => ctx.logger?.warn?.(message),
            ...deps.now === undefined ? {} : { now: deps.now },
            ...deps.pause === undefined ? {} : { pause: deps.pause },
        });
    }
    ctx.effect?.(() => history.start(), 'jet-hub: credit history sampler');
    // 直接读状态里的生效间隔，不为打一行日志而走一次 `view()`（那会顺带做
    // 抽稀与还原，纯属浪费）。`HISTORY_PROVIDERS` 仍从这里引，用于启动时的自查。
    ctx.logger?.info?.(`[jet-hub] 积分历史已并入（默认 ${history.state.intervalMinutes} 分钟采样，`
        + `${HISTORY_PROVIDERS.length} 个来源；与用量徽标共用同一份余额缓存，`
        + '存储为 jet-hub/credit-history.json）');
    return history;
}
