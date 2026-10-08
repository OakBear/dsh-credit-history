/**
 * 独立积分历史插件 `dsh-credit-history` 的宿主侧入口。
 *
 * ## 职责（拆分后的边界）
 *
 * - **取数**：加载私有宿主插件（dsh-codearts-auth）lib 下的**只读协议纯函数**
 *   （`credits` / `*-credits` / `*-product` / `ttl-cache` / `buddy-balance-rank`），
 *   自建 per-provider reader 循环。⚠️ 只 import 纯协议模块 —— 绝不 import
 *   `jet-hub-rpc.js` / `account-pool.js` 等依赖 `@deepseek-ai/dsh-credentials`
 *   静态解析的模块（那些模块从插件部署位置加载即 ERR_MODULE_NOT_FOUND，
 *   本会话实测），CodeArts 协议细节也因此留在私有仓库内。
 * - **缓存**：自建徽标等价物（TTL 缓存 + 在飞去重 + 失败不缓存），语义与宿主
 *   `usage-badge.js` 对齐：成功 120s / 全失败 15s，`DSH_JET_HUB_BADGE_TTL_MS`
 *   可覆盖（0 合法，不能用 `||` 兜底）。
 * - **装配**：`attachCreditHistory` 建引擎并排定采样（单一取数入口就是上面的
 *   badge 读数 —— 不重新引入旧版 balance-reader 双取数缺陷）；
 *   `registerHistoryRpc` 注册独立端点 `/api/credit-history`。
 * - **会话供应商观察**：`observeSessionProviders` 挂 `session/event`，供面板
 *   按当前会话自动切换来源。
 *
 * ## 与 v1（拆分前）的差别
 *
 * v1 的 `lib/balance-reader.js` 用
 * `createRequire(join(pluginRoot,'package.json')).resolve('@deepseek-ai/dsh-credentials')`
 * 解析凭据模块；当前部署树里该解析失效（插件树内的 `@deepseek-ai` 作用域是
 * 空目录）。本版改为**多策略回退**：先按 v1 解析，失败则从 dsh 主包作用域
 * 解析（`dirname(process.execPath)` 推导），详见 `resolveCredentialsModule`。
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HISTORY_FILE_NAME } from './credit-history.js';
import { attachCreditHistory } from './credit-history-rpc.js';
import { observeSessionProviders } from './session-provider-observer.js';
import { registerHistoryRpc } from './rpc-server.js';
export const name = 'dsh-credit-history';
export const inject = ['accountPool', 'credentials', 'connection'];
// ────────────────────────── 宿主模块加载 ──────────────────────────
/**
 * 解析 `@deepseek-ai/dsh-credentials` 的真身路径。
 *
 * 三个策略按序尝试，命中即返回：
 * 1. **v1 策略**：从宿主插件 root 的作用域解析（插件树自带该依赖时命中，
 *    历史部署形态如此）；
 * 2. **dsh 主包策略**：`dirname(process.execPath)` 推导全局 prefix 下的
 *    `@deepseek-ai/dsh` 主包，从它的作用域解析 —— 当前部署树实测只有这条路
 *    通（宿主进程自己就是这么解析的，运行中的 dsh web 无 NODE_PATH）；
 * 3. 同 2，但兼容非 `lib/node_modules` 的布局（prefix 直下 node_modules）。
 *
 * 全部失败时抛出**可读**错误：这属于部署环境问题，报错信息要能让人直接定位
 * 到「凭据模块没找到」，而不是一个裸的 MODULE_NOT_FOUND。
 */
function resolveCredentialsModule(pluginRoot) {
    const moduleName = '@deepseek-ai/dsh-credentials';
    const attempts = [
        {
            label: '宿主插件作用域',
            run: () => createRequire(join(pluginRoot, 'package.json')).resolve(moduleName),
        },
        {
            label: 'dsh 主包作用域',
            run: () => {
                // process.execPath = <prefix>/bin/node（dsh web 经 node 启动），
                // 全局包在 <prefix>/lib/node_modules。
                const pkg = join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
                if (!existsSync(pkg))
                    throw new Error(`dsh 主包不存在：${pkg}`);
                return createRequire(pkg).resolve(moduleName);
            },
        },
        {
            label: 'dsh 主包作用域（扁平布局）',
            run: () => {
                const pkg = join(dirname(process.execPath), '..', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
                if (!existsSync(pkg))
                    throw new Error(`dsh 主包不存在：${pkg}`);
                return createRequire(pkg).resolve(moduleName);
            },
        },
    ];
    const failures = [];
    for (const attempt of attempts) {
        try {
            return attempt.run();
        }
        catch (error) {
            failures.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`无法加载凭据模块 ${moduleName}（${failures.join('；')}）`);
}
/**
 * 加载宿主 lib 下的只读协议纯函数。
 *
 * ⚠️ 模块清单是**白名单**：只 import 余额查询必须的纯模块。往清单里加模块前
 * 先确认它（连同其传递依赖）不静态 import `@deepseek-ai/dsh-credentials` 或
 * 其它只在 dsh 主包作用域可解析的包 —— 否则从部署位置 import 即
 * ERR_MODULE_NOT_FOUND（`jet-hub-rpc.js` 就是前车之鉴）。
 *
 * @param profileDir - dsh profile 目录（从这里 resolve 宿主插件）。
 */
async function loadBalanceModules(profileDir) {
    const require = createRequire(join(profileDir, 'package.json'));
    const pluginRoot = dirname(require.resolve('dsh-codearts-auth/package.json'));
    const names = [
        'credits', 'product', 'codearts-credits',
        'lobsterai-credits', 'lobsterai-product',
        'qoder-credits', 'qoder-product',
        'trae-credits', 'trae-product',
        'cline-credits', 'cline-product',
        'loomy-credits', 'loomy-product',
        'raccoon-credits', 'raccoon-product',
        // TTL 缓存（纯数据结构）与窗口天数（buddy 系/lobsterai/trae 共用口径）。
        'ttl-cache', 'buddy-balance-rank',
    ];
    const modules = {};
    for (const name of names) {
        Object.assign(modules, await import(pathToFileURL(join(pluginRoot, 'lib', `${name}.js`)).href));
    }
    Object.assign(modules, await import(pathToFileURL(resolveCredentialsModule(pluginRoot)).href));
    return modules;
}
/** 徽标读数缓存时长：默认 120 秒（宿主 usage-badge 同款）。 */
const BADGE_TTL_MS = 120_000;
/** 全部账号都失败时的缓存时长：15 秒（宿主 usage-badge 同款）。 */
const BADGE_FAILURE_TTL_MS = 15_000;
/**
 * 非负毫秒数：非法值（空 / 非数字 / 负数）回落默认。
 *
 * ⚠️ **不能写成 `Number(raw) || 默认值`**：`0` 是合法值（不缓存、每次重读），
 * `||` 会把 0 静默换成默认值 —— 与宿主 `badgeTtlMs` 同一个坑。
 */
function nonNegativeMs(raw, fallback) {
    if (typeof raw !== 'string' || raw.trim().length === 0)
        return fallback;
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function badgeTtlMs(env = process.env) {
    return nonNegativeMs(env.DSH_JET_HUB_BADGE_TTL_MS, BADGE_TTL_MS);
}
function badgeFailureTtlMs(env = process.env) {
    return nonNegativeMs(env.DSH_JET_HUB_BADGE_TTL_MS, BADGE_FAILURE_TTL_MS);
}
/**
 * 「这一份读数是不是整批失败」。
 *
 * 没有启用账号（accounts 为空）**不算**失败 —— 那是稳定状态，短 TTL 会让
 * 采样每轮都白打一次；只要有一个账号读到数就算成功（多账号下一个凭据过期
 * 是常态，不该拖累整批的重试节奏）。宿主 usage-badge 同款判据。
 */
function isAllFailed(snapshot) {
    return snapshot.accounts.length > 0 && snapshot.accounts.every((row) => row.error !== undefined);
}
/** 需要「长期 / 临时」窗口天数的 provider（口径与宿主 credits.balances 一致）。 */
const WINDOW_PROVIDERS = new Set(['buddy', 'workbuddy', 'lobsterai', 'trae']);
/**
 * 构造积分历史用的徽标等价物（**唯一**取数入口）。
 *
 * 语义与宿主 `usage-badge` 对齐：
 * - 每 provider 一个 `TtlCache`（懒建）＋在飞去重＋**失败不缓存**；
 * - 成功 120s / 整批失败 15s（`DSH_JET_HUB_BADGE_TTL_MS` 覆盖，0 合法）；
 * - 只保留启用账号（`enabled !== false`），`disabledCount` 如实上报；
 * - `windowDays` 只给窗口系 provider（buddy / workbuddy / lobsterai / trae），
 *   经宿主 `buddyExpiringWindowDays()` 读取（`DSH_BUDDY_EXPIRING_WINDOW_DAYS`
 *   覆盖同款生效）。
 *
 * ⚠️ 采样引擎经 `createHistoryBalanceSource` 消费这里的读数，因此采样与
 * 「如果宿主徽标还在」共用同一套冷却节奏 —— 不再出现旧版双取数的重复打上游。
 */
function createHistoryBadge(deps) {
    const now = deps.now ?? (() => Date.now());
    const ttlMs = badgeTtlMs();
    const failureTtlMs = badgeFailureTtlMs();
    const reader = createBalanceReader(deps);
    const caches = new Map();
    /** 该 provider 的缓存实例（懒建：只有真的被采样到的来源才占内存）。 */
    function cacheFor(provider) {
        const existing = caches.get(provider);
        if (existing !== undefined)
            return existing;
        const created = new deps.modules.TtlCache({
            ttlMs,
            ttlFor: (snapshot) => (isAllFailed(snapshot) ? failureTtlMs : ttlMs),
            now,
            load: () => loadSnapshot(provider),
        });
        caches.set(provider, created);
        return created;
    }
    /** 缓存未命中时的加载：跑 reader 循环，再按宿主口径折算成快照。 */
    async function loadSnapshot(provider) {
        const balances = await reader(provider);
        if (!balances.ok) {
            // reader 只回 ok:true（单账号失败记在行内）；ok:false 属于防御分支。
            throw new Error('余额查询失败');
        }
        const pool = deps.accounts(provider);
        const enabledIds = new Set(pool.filter((entry) => entry.enabled !== false).map((entry) => entry.id));
        const accounts = balances.value.accounts.filter((row) => enabledIds.has(row.accountId));
        return {
            at: now(),
            accounts,
            disabledCount: pool.length - enabledIds.size,
            ...(WINDOW_PROVIDERS.has(provider) ? { windowDays: deps.modules.buddyExpiringWindowDays() } : {}),
        };
    }
    return {
        async read(provider, options = {}) {
            const cache = cacheFor(provider);
            const force = options.force === true;
            // 「是不是吃的缓存」必须在 get() 之前问（命中时 peek 才有值）。
            const hit = force ? undefined : cache.peek();
            let snapshot;
            try {
                snapshot = await cache.get(force ? { force: true } : {});
            }
            catch (error) {
                // 失败已被 TtlCache 拒绝缓存；这里折成 HistoryBadgeLike 的失败信封。
                return {
                    ok: false,
                    error: {
                        code: 'credit-history/failed',
                        message: error instanceof Error ? error.message : String(error),
                    },
                };
            }
            return {
                ok: true,
                value: {
                    provider,
                    generatedAt: snapshot.at,
                    cached: hit !== undefined,
                    accounts: snapshot.accounts,
                    disabledCount: snapshot.disabledCount,
                    ...(snapshot.windowDays === undefined ? {} : { windowDays: snapshot.windowDays }),
                },
            };
        },
    };
}
// ────────────────────────── per-provider reader（v1 逐字移植） ──────────────────────────
/**
 * 自建 per-provider 余额查询循环（v1 `balance-reader.js` 的逐字移植）。
 *
 * 错误文案是**契约**：面板与历史记录都按这些字符串展示，改动会让老用户看到
 * 突兀的新文案。`cline` 的 reader 返回 `{balance, error?}` 对象（宿主函数
 * 自带原因），其余是 `simple` 包装（查询函数以 null 表示「查不到」）。
 */
function createBalanceReader(deps) {
    const m = deps.modules;
    const pause = deps.pause ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const simple = (fn) => async (credential) => ({ balance: await fn(credential) });
    const readers = {
        buddy: simple((c) => m.fetchCreditBalance(c, m.CODEBUDDY)),
        workbuddy: simple((c) => m.fetchCreditBalance(c, m.WORKBUDDY)),
        lobsterai: simple((c) => m.fetchLobsteraiCreditBalance(c, m.LOBSTERAI)),
        qoder: simple((c) => m.fetchQoderCreditBalance(c, m.QODER)),
        qodercn: simple((c) => m.fetchQoderCreditBalance(c, m.QODER_CN)),
        trae: simple((c) => m.fetchTraeCreditBalance(c, m.TRAE)),
        cline: (c) => m.fetchClineCreditBalance(c, m.CLINE),
        loomy: simple((c) => m.fetchLoomyCreditBalance(c, m.LOOMY)),
        raccoon: simple((c) => m.fetchRaccoonCreditBalance(m.RACCOON, c)),
        codearts: async (c) => {
            const result = await m.fetchCodeArtsAccountInfoDetailed(c);
            if (!result.ok)
                return { balance: null, error: result.message ?? '账户信息查询失败' };
            if (!result.info?.isCreditPackage)
                return { balance: null, error: '非积分计费账户，无积分余额' };
            return { balance: result.info.credit || null };
        },
    };
    return async (provider) => {
        if (!readers[provider])
            throw new Error('不支持的积分来源');
        const items = [];
        for (const entry of await deps.accounts(provider)) {
            // 此等待只属于后台采样；手动查询（若有）完全不经过这里。
            await pause(2000);
            let value;
            try {
                const credential = await deps.resolve(m.credentialRef(entry.credentialRef ?? ''));
                value = credential
                    ? await readers[provider](JSON.parse(credential.value))
                    : { balance: null, error: '凭据未配置' };
            }
            catch {
                value = { balance: null, error: '余额查询失败' };
            }
            items.push({ accountId: entry.id, nickname: entry.nickname, ...value });
        }
        return { ok: true, value: { accounts: items } };
    };
}
// ────────────────────────── 插件入口 ──────────────────────────
/**
 * 插件安装（v1 `apply` 的蓝本 + 拆分后的装配改动）。
 *
 * 顺序：pending-restart 守门 → profileContext / 账号池断言 → 加载宿主纯模块 →
 * 建徽标等价物 → `attachCreditHistory`（建引擎 + 排采样）→ 挂会话观察器 →
 * 注册独立 RPC 端点。
 */
export async function apply(ctx) {
    // 安装时不与仍在内存中的旧补丁同时采样；下一次进程启动自然解除。
    try {
        const pending = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../.pending-restart.json'), 'utf8'));
        if (pending.processId === process.pid) {
            ctx.logger?.info?.('独立积分历史已安装，等待本次 dsh 重启后启用。');
            return;
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    const profile = ctx.get('profileContext');
    if (!profile?.dir || !profile.home)
        throw new Error('积分历史需要 dsh profileContext');
    const pool = ctx.accountPool;
    if (typeof pool?.listAccounts !== 'function')
        throw new Error('积分历史需要启用 Jet Hub 账号插件');
    const modules = await loadBalanceModules(profile.dir);
    const accounts = (provider) => pool.listAccounts(provider);
    const badge = createHistoryBadge({
        modules,
        accounts,
        resolve: (ref) => ctx.credentials.resolve(ref),
        warn: (message) => ctx.logger?.warn?.(message),
    });
    // 单一取数入口：引擎经 createHistoryBalanceSource 消费 badge 读数。
    const history = attachCreditHistory(ctx, badge, accounts, {
        home: profile.home,
    });
    if (history === undefined)
        return; // home 无法定位；attachCreditHistory 已告警。
    // 会话供应商观察（session/event 实时路径 + 磁盘兜底），供面板按会话切源。
    const observer = observeSessionProviders(ctx);
    ctx.effect?.(() => registerHistoryRpc(ctx.connection, history, observer), 'credit-history: own RPC endpoint');
    ctx.logger?.info?.(`独立积分历史已启用；默认 ${history.state.intervalMinutes} 分钟采样，`
        + `端点 /api/credit-history（存储 ${HISTORY_FILE_NAME}）。`);
}
