import type { HistoryConnectionLike } from './rpc-server.js';
export declare const name = "dsh-credit-history";
export declare const inject: string[];
/** 账号池条目（宿主 `ProviderAccountEntry` 的形状子集）。 */
interface PoolAccount {
    id: string;
    nickname?: string;
    credentialRef?: string;
    enabled?: boolean;
}
/** 宿主 ctx 的最小结构（cordis Context 的形状子集；`apply` 入口处断言）。 */
interface HostCtx {
    get(name: string): unknown;
    accountPool?: {
        listAccounts(provider: string): readonly PoolAccount[];
    };
    credentials: {
        resolve(ref: string): Promise<{
            value: string;
        } | undefined>;
    };
    connection: HistoryConnectionLike;
    logger?: {
        info?(message: string): void;
        warn?(message: string): void;
    };
    effect?(fn: () => void, label?: string): unknown;
    /** cordis 事件订阅（会话供应商观察器用；形状对齐 ContextLike）。 */
    on(name: 'session/event', listener: (session: {
        id: string;
        seq: number;
        eventAt(seq: number): {
            type?: unknown;
            time?: unknown;
            data?: unknown;
        } | undefined;
    }) => void): unknown;
}
/**
 * 插件安装（v1 `apply` 的蓝本 + 拆分后的装配改动）。
 *
 * 顺序：pending-restart 守门 → profileContext / 账号池断言 → 加载宿主纯模块 →
 * 建徽标等价物 → `attachCreditHistory`（建引擎 + 排采样）→ 挂会话观察器 →
 * 注册独立 RPC 端点。
 */
export declare function apply(ctx: HostCtx): Promise<void>;
export {};
