/** 独立端点的固定路径。客户端 `rpcCall` 与它必须同源。 */
export const CREDIT_HISTORY_API_PATH = '/api/credit-history';
/**
 * 注册独立 RPC 端点。
 *
 * @param connection - ctx.connection（`fetch.register` 形状）。
 * @param history - 采样引擎实例（`view` / `configure` 是仅有的两个读改入口）。
 * @param observer - 会话供应商观察器；缺席时 `session.provider` 恒回 `null`。
 * @returns 端点 handler（即 `connection.fetch.register` 的返回值）。
 */
export function registerHistoryRpc(connection, history, observer) {
    return connection.fetch.register({
        path: CREDIT_HISTORY_API_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            if (request.method !== 'POST')
                return new Response('method not allowed', { status: 405 });
            if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
                return new Response('JSON required', { status: 415 });
            }
            let message;
            try {
                message = await request.json();
            }
            catch {
                return new Response('invalid JSON', { status: 400 });
            }
            const reply = (result) => Response.json({ type: 'server-response', rpcId: message.rpcId, result });
            const envelope = message;
            if (envelope?.type !== 'client-request'
                || typeof envelope.rpcId !== 'string'
                || envelope.method !== 'credit-history'
                || !envelope.payload
                || typeof envelope.payload.method !== 'string') {
                return reply({ ok: false, error: { code: 'bad-request', message: '无效的历史请求', details: {} } });
            }
            try {
                const { method, payload = {} } = envelope.payload;
                const body = payload;
                let value;
                if (method === 'history.read') {
                    // 本地文件读取，绝不打上游；`view` 是同步的（含增量还原与抽稀）。
                    // ⚠️ 与整合期逐字同款：provider 非字符串一律按空串处理并**拒绝**
                    //（「全部来源」这种查询没有定义），hours 缺省回 24。
                    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
                    if (provider.length === 0) {
                        return reply({ ok: false, error: { code: 'bad-request', message: 'provider 不能为空' } });
                    }
                    value = history.view(provider, typeof body.hours === 'number' ? body.hours : 24);
                }
                else if (method === 'history.configure') {
                    // 非法值拒绝而不是静默回落：合法间隔只有 5 / 15，中文报错由引擎给，
                    // 这里原样透传，错误码与整合期同为 bad-request（设置类失败不是
                    // 「服务坏了」，前端只展示 message）。
                    try {
                        value = await history.configure(body);
                    }
                    catch (configError) {
                        return reply({
                            ok: false,
                            error: {
                                code: 'bad-request',
                                message: configError instanceof Error ? configError.message : String(configError),
                            },
                        });
                    }
                }
                else if (method === 'session.provider') {
                    // 按当前会话自动切源：`providerOf` 未命中（进程刚启动、内存负缓存）
                    // 时回 `null`，面板种子效应自己回退到默认来源。**不报错** —— 这是
                    // 「拿不到」而不是「坏了」，报错会让面板把可用的默认来源也拒掉。
                    // sessionId 不做格式校验：观察器对未知 id 一律 undefined，假 id 只是
                    // 白解压一次目录遍历，不构成注入面（与整合期同款）。
                    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
                    const provider = observer?.providerOf(sessionId);
                    value = { provider: provider === undefined ? null : provider };
                }
                else {
                    throw new Error('历史页面只支持本地读取和设置；手动查询请使用 Jet Hub');
                }
                return reply({ ok: true, value });
            }
            catch (error) {
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
                });
            }
        },
    });
}
