/** 会话日志事件的最小结构（只取本模块用到的字段；避免依赖非直接依赖包的类型）。 */
interface SessionEventLike {
    type?: unknown;
    time?: unknown;
    data?: unknown;
}
/** `ctx.on('session/event')` 推过来的 session 对象的最小结构。 */
interface SessionLike {
    id: string;
    seq: number;
    eventAt(seq: number): SessionEventLike | undefined;
}
/** `ctx.on` 的最小结构（cordis 的 EventEmitter 形态；回调注册用不到泛型）。 */
interface ContextLike {
    on(name: 'session/event', listener: (session: SessionLike) => void): unknown;
}
export declare class SessionProviderObserver {
    #private;
    /** 订阅 `session/event`。回调内纯同步、零 IO（重放只遍历内存事件）。 */
    attach(ctx: ContextLike): void;
    /**
     * 查询一个会话最近使用的供应商。
     *
     * @returns provider id（如 `'buddy'`）；内存与磁盘都查不到时 `undefined`
     *   （纯空白会话 / 会话文件已清），由调用方回落到默认行为。
     */
    providerOf(sessionId: string): string | undefined;
}
/** 创建并挂载观察器；返回查询句柄（jet-hub RPC 的 `session.provider` 用）。 */
export declare function observeSessionProviders(ctx: ContextLike): SessionProviderObserver;
export {};
