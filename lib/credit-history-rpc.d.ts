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
import { CreditHistory, type CreditHistoryQueryResult } from './credit-history.js';
/**
 * 采样器与徽标**共用的**取数适配器。
 *
 * `usageBadge.read()` 返回的是**已折算**的徽标快照（只含启用账号 + 订阅读数
 * + 偏好 + 签到状态），而采样只需要其中的余额行。这里做一次**形状转换**。
 *
 * ⚠️ **失败语义必须原样保留**：
 * - 整批失败（`ok: false`）→ 原样返回 `{ok: false, error}`，让引擎记一个
 *   `status: 'failed'` 的点，**不能**折成「余额 0」（曲线掉到 0 是用户最容易
 *   被骗的形态）。⚠️ 用**返回值**而不是抛错：这是一条每 5 分钟常驻的路径，
 *   失败是预期内的正常结果，不该走异常控制流；而且返回值路径能把上游的
 *   `error.message` 一路带到历史记录里，排查时看得见原因。引擎对
 *   `ok: false` 与「抛错」的处理**结果相同**（都记 failed 点）。
 * - 单账号失败（`balance: null` + `error`）→ 原样带着 `error` 交给引擎。
 *
 * ⚠️ **不传 `force`**：采样是后台行为，绕过 120s 缓存去追「此刻最新」的读数
 * 就退化成了独立插件的那种重复打上游。缓存内那份读数对「每 5 分钟记一个点」
 * 完全够用，且时间轴用的仍是引擎自己的完成时刻，落盘数据如实。
 */
/** 宿主 ctx 的最小结构（cordis Context 的形状子集，全部可选访问）。 */
export interface CreditHistoryHostCtx {
    get?(name: string): unknown;
    effect?(fn: () => void, label?: string): unknown;
    logger?: {
        info?(message: string): void;
        warn?(message: string): void;
        error?(message: string): void;
    };
}
/**
 * 徽标读数服务的最小结构（宿主 `UsageBadge.read` 的**形状子集**）。
 *
 * ⚠️ 本插件**不 import 宿主类型**：CodeArts 内部协议细节留在私有仓库，
 * 这里只约束「读数长什么样」。宿主 dsh-codearts-auth 的 lib 在运行时天然满足。
 */
export interface HistoryBadgeLike {
    read(provider: string, options?: {
        force?: boolean;
    }): Promise<{
        ok: true;
        value: unknown;
    } | {
        ok: false;
        error: {
            code: string;
            message: string;
        };
    }>;
}
/**
 * 账号条目的最小结构（宿主账号池条目的**形状子集**）。
 * `enabled !== false` 的过滤口径与宿主装配层一致。
 */
export interface HistoryAccountEntry {
    id: string;
    nickname?: string;
    credentialRef?: string;
    enabled?: boolean;
}
export interface HistoryBalanceSource {
    query(provider: string): Promise<CreditHistoryQueryResult>;
}
/**
 * 构造采样用的取数适配器。
 *
 * @param badge - 装配层建好的徽标读数服务（**唯一**取数入口）。
 * @param warn - 告警出口（读数失败时记一条，便于排查「曲线为什么断了」）。
 */
export declare function createHistoryBalanceSource(badge: HistoryBadgeLike, warn?: (message: string) => void): HistoryBalanceSource;
/** 采样器启动所需的最小依赖（便于单测传入桩）。 */
export interface CreditHistoryWiringDeps {
    /** 直接给引擎实例（单测用）；给出时不再自行构造。 */
    history?: CreditHistory;
    /** 取数适配器（`history` 省略时必填，省略则按 `badge` 现造）。 */
    source?: HistoryBalanceSource;
    /** DSH home（省略时按 `resolveDshHome` 解析）。 */
    home?: string;
    /**
     * 时钟与等待（默认 `Date.now` / 真实 `setTimeout`）。
     *
     * ⚠️ 只为**测试**而开的口子：引擎每次打上游前固定 `pause(2000)`（顺序查询、
     * 避免风控），真等在单测里会让每个用例都慢 2 秒。生产路径**不要**传这两个。
     */
    now?(): number;
    pause?(ms: number): Promise<void>;
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
export declare function attachCreditHistory(ctx: CreditHistoryHostCtx, badge: HistoryBadgeLike, listAccountsByProvider: (provider: string) => readonly HistoryAccountEntry[], deps?: CreditHistoryWiringDeps): CreditHistory | undefined;
