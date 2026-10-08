/**
 * 积分历史引擎（宿主侧采样 + 单一存储 + 体积治理）。
 *
 * 本文件是**独立插件 `dsh-credit-history` 的宿主侧移植与强化**：逻辑与原
 * `lib/credit-history.js` 一一对应，但把三件事做实（每件背后都有实测数据）：
 *
 * ## ① 默认采样 5 分钟
 *
 * 原插件默认 15 分钟。用户明确要求「积分历史应当提升到每 5 分钟一次」，
 * 故新状态默认 `intervalMinutes: 5`，且**磁盘上的旧状态里那个 15 也要升级为 5**
 * （旧文件没有任何标记能区分「用户特意选的 15」与「老默认值 15」，故见
 * `sanitizeState` 的 `intervalSource` 判据）。`configure` 仍只接受 5 或 15。
 *
 * ## ② 单一存储库（**迁移必须按「最新采样时间」择优**）
 *
 * 状态文件固定写 `<home>/jet-hub/credit-history.json` —— 与 Jet Hub 的
 * `jet-hub/state.json`、`auto-checkin.json` 同目录，即**单一数据目录**。
 *
 * 旧位置有**两个**候选：
 *
 * | 候选 | 实测内容（2026-10-05 本机） |
 * |---|---|
 * | `<home>/jet-hub/credit-history.json` | 更早的历史：2/2/1 个点，最后采样 2026-10-01T14:29Z |
 * | `<home>/credit-history/history.json` | 独立插件写的**较新**数据：66/66/65 个点，最后采样 2026-10-05T05:56Z |
 *
 * ⇒「目标路径已存在就直接用」会**丢掉新数据**（实测目标是旧数据的子集）。
 * 正确做法：两个文件都读，取**最后一个采样点时间更晚**的那份（并列时取目标位置）。
 *
 * ⚠️ **两个源文件都不删除、不改写**：独立插件可能还在跑（本机实测它仍在写入），
 * 且保留原文件才可回滚。迁移只是把择优结果**另存**到目标位置。
 *
 * ## ③ 体积治理（已实测的真实问题）
 *
 * buddy 的一个采样点带 **17～21 个资源包**，实测 `JSON.stringify` **平均 5667
 * 字节/点**（最大 5740），而 qoder/qodercn 只有约 251～263 字节/点。旧的保存
 * 上限是每序列 `slice(-9000)` + 30 天保留；若直接改成 5 分钟采样，buddy 每天
 * 288 点 ⇒ 30 天 8640 点 ⇒ **约 49 MB** 的单文件 JSON（当前全库才 389710 字节）。
 * 三层治理：
 *
 * 1. **资源包增量编码**：某点的资源包**签名**（`name/unit/active/cycle`，与
 *    `changeBetween` 的 identity 判据同源）与**前一个有效点**相同时，**省略**
 *    `packages` 字段，只存其余字段；读时按前一个可用点还原。实测每点约
 *    **96 字节**（不含 `packages` 的基线 87 字节 + 少量 `total`），buddy 序列
 *    从 5667 字节/点降到约 326 字节/点（含签名变化的锚点）。
 *    `view()` 对外契约**不变**：每个 ok 点仍有完整 `packages`。
 * 2. **分层抽稀**：最近 `FULL_RESOLUTION_DAYS = 8` 天保留原始分辨率；
 *    8～30 天抽稀到 `THINNED_INTERVAL_MINUTES = 30` 分钟（每 6 个留 1 个，
 *    按 30 分钟时隙取首个）；超过 `RETENTION_DAYS = 30` 天丢弃。
 *    ⚠️ 抽稀窗口刻意设为 8 天，而图表最多只查 7 天（`view` 的 hours 上限 168），
 *    故**抽稀永不影响渲染窗口**。`retentionDays` 对外仍报 30。
 * 3. **有界兜底上限** `MAX_POINTS_PER_SERIES`：抽稀后的稳态上界是
 *    `2304（8 天 × 288）+ 1056（22 天 × 48）= 3360` 点/序列，故 4000 只对
 *    「稳态之外的增长」（时钟回拨、外部写入未来时间戳、配置被改成更密的间隔）
 *    生效，**正常运行时永不触发**，不会悄悄缩短 30 天保留。且兜底**只裁
 *    「全分辨率窗口之外」的旧点**，绝不会静默截断近期数据（`-9000` 的问题）。
 *
 * ## ④ 保留原插件的重启安全与退避语义
 *
 * - `attempts[provider]` 在**打上游之前**先落盘 ⇒ 进程重启不会重复请求；
 * - 失败按 `failures[provider]` 指数退避，上限 60 分钟；
 * - 冷却 `max(5 分钟, interval(provider))`；每次查询前 `pause(2000)`，且
 *   `enqueue` 把整条链串行化（顺序查询，避免并发触发风控）。
 *
 * 本模块**零网络**：`query` / `accounts` / `now` / `pause` 全部注入，文件系统
 * 只有状态文档读、写两处（均为可注入的 `home` 下的路径），故可完全离线单测。
 */
/**
 * 采样来源清单。
 *
 * ⚠️ 必须与客户端面板 `plugin-src/client/credit-history-panel.js` 的 `PROVIDERS`
 * **逐字一致**（本仓库已有「两份名单漂移」的真实缺陷：新增 provider 漏登记会让
 * 该来源的账号静默不采样）。新增 provider 时**两处一起改**。
 */
export declare const HISTORY_PROVIDERS: readonly string[];
/** 默认采样间隔（分钟）：用户要求「提升到每 5 分钟一次」。 */
export declare const DEFAULT_INTERVAL_MINUTES = 5;
/** 允许的采样间隔（分钟）；其余值 `configure` 一律拒绝。 */
export declare const ALLOWED_INTERVAL_MINUTES: readonly number[];
/** 对外保留天数（同时也是硬保留上限）。 */
export declare const RETENTION_DAYS = 30;
/** 全分辨率窗口（天）：窗口内的点原样保留。 */
export declare const FULL_RESOLUTION_DAYS = 8;
/** 8～30 天区间的抽稀目标分辨率（分钟）。 */
export declare const THINNED_INTERVAL_MINUTES = 30;
/**
 * 单序列磁盘点数上限（**有界**兜底）。
 *
 * ⚠️ 与抽稀的关系：稳态上界是 `FULL_RESOLUTION_POINTS + THINNED_POINTS`，本值
 * 必须**大于**它 —— 否则兜底每天都会真的裁剪，把「30 天保留」悄悄缩水成十几
 * 天（这正是旧实现 `slice(-9000)` 的毛病：它不区分新旧，取不到近期数据就截）。
 * 4000 只对稳态之外的增长生效，正常运行时永不触发；触发时也只裁**全分辨率
 * 窗口之外**的旧点（见 `prune`）。
 */
export declare const MAX_POINTS_PER_SERIES = 4000;
/** 状态文档文件名（与 `state.json` / `auto-checkin.json` 同目录）。 */
export declare const HISTORY_FILE_NAME = "credit-history.json";
/** 单一存储的目标路径：`<home>/jet-hub/credit-history.json`。 */
export declare function historyStatePath(home: string): string;
/** 独立插件的旧路径（只读迁移源，**不删不改**）。 */
export declare function legacyHistoryStatePath(home: string): string;
/** 资源包（对外契约，字段与原插件逐字一致）。 */
export interface CreditHistoryPackage {
    name: string;
    unit: string;
    active: boolean;
    remaining: number | null;
    total: number | null;
    used: number;
    cycleStartTime: string;
    cycleEndTime: string;
    expiredTime: string;
    cycle: string;
}
/**
 * 一个采样点。
 *
 * ⚠️ `packages` 只在 ok 点上出现（原插件语义）；磁盘上它可能被**省略**
 * （增量编码），`view()` 读时会还原，故对外永远是完整的。
 */
export interface CreditHistoryPoint {
    at: number;
    status: 'ok' | 'failed';
    total?: number;
    expiredTotal?: number;
    packages?: CreditHistoryPackage[];
}
/** 相邻两点之间的变化语义。 */
export type ChangeKind = 'gap' | 'reset' | 'usage' | 'increase';
/** 相邻两点的变化（`changeBetween` 的返回值）。 */
export interface CreditHistoryChange {
    kind: ChangeKind;
    minutes?: number;
    amount?: number;
}
/** 还原后的采样点：比对外契约多一个随点保存的采样间隔元数据。 */
export interface RestoredHistoryPoint extends CreditHistoryPoint {
    /** 写这个点时的采样间隔（分钟）；缺省时用当前设置。 */
    intervalMinutes?: number;
}
/** `view()` 里的采样点：契约点 + 变化语义。 */
export type CreditHistoryPointView = RestoredHistoryPoint & {
    change: CreditHistoryChange;
};
/** `view()` 里的单个账号序列。 */
export interface CreditHistoryAccountView {
    provider: string;
    accountId: string;
    nickname?: string;
    points: CreditHistoryPointView[];
}
/** `view()` 的返回值。 */
export interface CreditHistoryView {
    enabled: boolean;
    intervalMinutes: number;
    retentionDays: number;
    nextQueryAt: number;
    accounts: CreditHistoryAccountView[];
}
/** 查询结果里的单个账号（与冻结契约逐字一致）。 */
export interface CreditHistoryQueryAccount {
    accountId: string;
    nickname?: string;
    balance?: {
        total?: number;
        expiredTotal?: number;
        packages?: readonly unknown[];
    } | null;
    error?: string;
}
/** `query` 的返回值（与冻结契约逐字一致）。 */
export interface CreditHistoryQueryResult {
    ok: boolean;
    value?: {
        accounts?: readonly CreditHistoryQueryAccount[];
    };
}
/**
 * `balances()` 的实际返回值。
 *
 * 在冻结契约之上多三项采样元数据（`sampledAt` / `nextQueryAt` / `cached`）与
 * 兜底错误码 —— 原插件就返回这些字段，客户端面板会读。结构上仍是
 * `CreditHistoryQueryResult` 的子类型，故总监的接线代码按冻结签名用即可。
 */
export interface CreditHistoryBalancesResult extends CreditHistoryQueryResult {
    value?: {
        accounts?: readonly CreditHistoryQueryAccount[];
        /** 本次（或缓存点）的采样时刻。 */
        sampledAt?: number;
        /** 下一次允许查询的时刻。 */
        nextQueryAt?: number;
        /** 是否来自磁盘/内存缓存（**没有**打上游）。 */
        cached?: boolean;
    };
    error?: {
        code: string;
        message: string;
    };
}
/** 引擎依赖（全部注入，故零网络、零真实计时）。 */
export interface CreditHistoryDeps {
    /** DSH profile home（状态目录的父目录）。 */
    home: string;
    /** 打上游查一次余额（由装配层用 balance-reader 实现）。 */
    query(provider: string): Promise<CreditHistoryQueryResult>;
    /** 列出某来源的账号（账号池）。 */
    accounts(provider: string): Promise<readonly {
        id: string;
        nickname?: string;
        credentialRef?: unknown;
    }[]>;
    /** 告警（默认丢弃；装配层接 `ctx.logger.warn`）。 */
    warn?(message: string): void;
    /** 时钟（默认 `Date.now`）。 */
    now?(): number;
    /** 等待（默认真实 `setTimeout`；查询前固定等 2000ms）。 */
    pause?(ms: number): Promise<void>;
}
/**
 * 磁盘上的采样点（**增量编码后的形状**）。
 *
 * 与 `CreditHistoryPoint` 的差别只有两条：
 * ① 允许带 `intervalMinutes` 元数据；② `packages` 只在「资源包签名变化」的
 * 那个点上出现，其余点省略（读时按前一个可用点还原，见 `restorePoints`）。
 * 这里**不**把它写成 `CreditHistoryPoint & {...}`：增量形状里 ok 点的
 * `total` 语义上一定在，但类型上要容许缺省，故显式建模。
 */
export interface StoredHistoryPoint {
    at: number;
    status: 'ok' | 'failed';
    total?: number;
    expiredTotal?: number;
    packages?: CreditHistoryPackage[];
    intervalMinutes?: number;
}
/** 磁盘上的一个账号序列。 */
export interface StoredHistorySeries {
    provider: string;
    accountId: string;
    nickname?: string;
    points: StoredHistoryPoint[];
}
/** 磁盘上的完整状态文档（内存结构 = 磁盘结构）。 */
export interface CreditHistoryState {
    version: number;
    enabled: boolean;
    intervalMinutes: number;
    series: Record<string, StoredHistorySeries>;
    attempts: Record<string, number>;
    failures: Record<string, number>;
    /**
     * 采样间隔的来源标记：`'user'` = 用户在本插件里显式 `configure` 过。
     *
     * ⚠️ 它存在的**唯一**理由是让「旧数据的 15 升级为 5」与「用户显式选的 15
     * 重启后仍是 15」这两件事同时成立：旧插件（以及本项目旧版本）只会写 15，
     * 且没有任何标记能区分两者，故**没有本标记的 15 一律升级为 5**。
     */
    intervalSource?: 'user';
}
/** 状态文档版本（与旧实现一致：非 1 即视为不兼容）。 */
export declare const HISTORY_STATE_VERSION = 1;
/**
 * 只保留余额与资源包口径；凭据及服务端错误原文**不写入历史**。
 *
 * 失败（无余额 / 负数 / 非有限数）返回 `{ status: 'failed' }` —— 历史里的缺口
 * 本身就是信息，绝不能用 0 顶替。
 */
export declare function makePoint(item: {
    balance?: {
        total?: number;
        expiredTotal?: number;
        packages?: readonly unknown[];
    } | null;
}, at: number): CreditHistoryPoint;
/**
 * 相邻两点的变化语义。
 *
 * `intervalMinutes` 是**当前点**的采样间隔（历史点各自带着写它时的间隔），
 * 判 gap 的阈值是它的 2.5 倍 —— 采样间隔升级到 5 分钟后，12.5 分钟以上的
 * 断档才算缺口。
 */
export declare function changeBetween(previous: CreditHistoryPoint | undefined, current: CreditHistoryPoint, intervalMinutes?: number): CreditHistoryChange;
export declare class CreditHistory {
    /** 单一存储的状态文档路径（`<home>/jet-hub/credit-history.json`）。 */
    readonly path: string;
    /** 内存状态（结构即磁盘结构，测试与装配层可直接读）。 */
    readonly state: CreditHistoryState;
    private readonly deps;
    private cache;
    private tail;
    private closed;
    private timer;
    private readonly source;
    /** 装载时是否把旧数据的 15 升级成了 5（决定构造期要不要回写一次）。 */
    private intervalUpgraded;
    constructor(deps: CreditHistoryDeps);
    private load;
    private now;
    private warn;
    private pause;
    /** 全局串行队列：并发调用共享同一条链（避免同时打上游触发风控）。 */
    private enqueue;
    /**
     * 分层抽稀 + 有界兜底（每次保存前跑一次）。
     *
     * 顺序：① 丢 30 天外；② 8 天内原样；③ 8～30 天按 30 分钟时隙留首个 ok 点
     * （失败点在冷区不占位、也不保留 —— 缺口信息由 `changeBetween` 的 `gap`
     * 在新旧交界处给出）；④ 超上限时只裁「全分辨率窗口之外」的旧点。
     */
    private prune;
    /**
     * 有界兜底的裁剪：**只裁全分辨率窗口之外的旧点**，且从最旧的一端开始。
     *
     * 到不了「必须裁近期点」的情形：全分辨率窗口在最小间隔下最多
     * `FULL_RESOLUTION_POINTS` 个点，小于上限。真出现（系统时钟被回拨、
     * 外部写入了未来时间戳）时**宁可超出上限也不丢近期点** —— 近期点正是用户
     * 能看到的图表窗口，这正是旧实现 `slice(-9000)` 的病因。
     */
    private trimExcess;
    /**
     * 增量编码：资源包签名与前一个**自带 `packages` 的 ok 点**相同时省略
     * `packages`。
     *
     * ⚠️ 基准的选择必须与 `restorePoints` 完全一致（都是「之前最近一个自带
     * `packages` 的 ok 点」），否则会还原出错误的资源包。
     * ⚠️ **不能只看紧邻的上一个点**：上一个点很可能**正是被省略的那个**
     * （编码一旦连续生效，它就没有 `packages`）—— 拿它当基准会判「不相等」，
     * 于是每个点都重新存一份完整资源包，增量编码**完全失效**
     * （实测：写用例时 6 个点里 4 个仍然携带完整 `packages`）。
     */
    private encode;
    /** 原子落盘（临时文件 + rename；权限 0600）。 */
    save(): void;
    /**
     * 该来源当前的下次查询间隔：失败按 2 倍指数退避，**上限 60 分钟**。
     *
     * ⚠️ **指数不额外截断**（旧实现写的是 `2 ** Math.min(3, failures)`）：
     * 那个 `min(3)` 是「基准 15 分钟」时代的产物 —— `15 × 2³ = 120`，靠它把
     * 指数压到 3 才有意义。但基准改成 **5** 之后 `5 × 2³ = 40`，于是
     * **「上限 60 分钟」永远达不到**：阶梯实测为 `5 → 10 → 20 → 40 → 40 → 40`。
     * 现值用外壳的 `Math.min(60, …)` 封顶（`2 ** failures` 溢出为 `Infinity` 时
     * 同样得到 60），阶梯为 `5 → 10 → 20 → 40 → 60 → 60`，与文档一致；
     * 基准 15 时的阶梯（`15 → 30 → 60`）与旧实现**逐值相同**。
     */
    interval(provider: string): number;
    /**
     * 查一次余额（并落盘采样点）。
     *
     * 顺序与原插件逐条一致：
     * ① 冷却期（`max(5 分钟, interval)`）内**不打上游** —— 有内存结果就原样返回，
     *    否则用磁盘上最后一个点回答（重启后也能立刻展示已存余额）；
     * ② `pause(2000)` 之后再查（顺序查询，避免风控）；
     * ③ `attempts` **先落盘**再打上游 ⇒ 重启不会重复请求。
     */
    balances(provider: string): Promise<CreditHistoryBalancesResult>;
    /**
     * 读某来源的历史（**本地文件读取，绝不打上游**）。
     *
     * `hours` 上限 168（7 天）—— 比抽稀窗口（8 天）小，故抽稀**永不影响渲染
     * 结果。返回的每个 ok 点都带完整 `packages`（增量编码已在此还原）。
     */
    view(provider: string, hours?: number): CreditHistoryView;
    /** 改设置：间隔只接受 5 / 15（中文报错），其余字段原样保留。 */
    configure(payload: {
        enabled?: boolean;
        intervalMinutes?: number;
    }): Promise<{
        enabled: boolean;
        intervalMinutes: number;
    }>;
    /**
     * 起后台采样（返回停止函数）。
     *
     * 每 30 秒醒一次，按 `HISTORY_PROVIDERS` 顺序串行查询到期且**有账号**的
     * 来源；关掉开关或停止后一个请求都不发。
     */
    start(): () => void;
}
