/**
 * rp-mode.js —— 模式判定（rphub / st）+ 后端 cardId 匹配 + 缓存 + 降级。
 *
 * formatDetail 数据流（引擎设计.md §3 / 接口总结.md）：
 *   - 后端：`GET /v1/cards/{cardId}?fields=` 响应顶层 `formatDetail: rphub|st|unknown`；
 *     `marks/{contentHash}` 为手动标记（rphub 强制），命中已由 upload/analyze 写入 formatDetail。
 *   - 前端判定：当前角色（ST 卡）→ 匹配后端 cardId → 取 formatDetail。
 *
 * 匹配策略（本阶段实现，局限见汇报）：
 *   1. 精确：`lookupCardIdByName`（新增后端路由 `GET /v1/cards/by-name/{name}`，按
 *      index.json 的 characterName 精确匹配，返回该名下最新导入的 cardId + formatDetail）。
 *      —— 主路径：ST 角色名 = 后端 characterName 时直连。
 *   2. 内容哈希：`lookupCardIdByContentHash`（`GET /v1/cards/exists/{contentHash}`）。
 *      前端无法对 writeBack PNG 计算原字节 sha256（writeBack 卡 = 重新打包，字节不同），
 *      因此本阶段不主动计算；仅当插件调用方（未来 UI 阶段）能把原卡字节传进来时可用。
 *   3. 降级：后端不可达 / 卡未导入 / 名称不匹配 / 无 contentHash → 按用户配置的
 *      降级目标（settings.getDegradeTarget()：'st' 缺省 | 'rphub' | 'none'）：
 *        - 'st'：降级为 st（不启用 RP 内置，不阻塞）；
 *        - 'rphub'：仍按 RP 语义（明确知道是 RP 卡但后端暂不可达时用）；
 *        - 'none'：禁止降级 —— formatDetail 返回 null，调用方按「无法判定」处理，
 *          引擎侧按 st 行为但不启用 RP 内置，面板状态行显示「判定失败」。
 *      三条降级路径（not_found / unreachable / no_content_hash）均输出 console.warn
 *      （含卡名 + 原因 + 降级结果），成功路径不输出。
 *
 * 缓存：按角色 avatar（或名称）缓存 { cardId, formatDetail, contentHash, marked, ts }；
 * CHAT_CHANGED / SETTINGS_UPDATED 时失效。单次会话内避免重复 HTTP。
 */

export const BASE = '/api/plugins/rp-hub-compat/v1';

/** 降级目标取值（与 settings.js DEGRADE_TARGET_* 一致；rp-mode 独立维护避免 node 测试
 *  引入 st-bridge 依赖链）。 */
export const DEGRADE_TARGET_ST = 'st';
export const DEGRADE_TARGET_RPHUB = 'rphub';
export const DEGRADE_TARGET_NONE = 'none';

/**
 * 降级路径的 mode 解析（纯函数，node 可测）：手动标记强制 rphub，否则按配置降级目标。
 * @param {{ marked?: boolean, degradeTarget?: 'st'|'rphub'|'none' }} arg
 * @returns {'rphub'|'st'|null} null = 禁止降级（判定失败，调用方按「无法判定」处理）
 */
export function resolveDegradeMode({ marked = false, degradeTarget = DEGRADE_TARGET_ST } = {}) {
    if (marked === true) return 'rphub'; // 手动标记强制（与后端 upload 语义一致）
    if (degradeTarget === DEGRADE_TARGET_RPHUB) return 'rphub';
    if (degradeTarget === DEGRADE_TARGET_NONE) return null;
    return 'st';
}

/**
 * 判定结果：手动标记强制 rphub；否则后端已知（rphub/st）取权威值；unknown / 缺失 →
 * 按配置降级目标。
 * @param {{ backendDetail?: string, marked?: boolean, degradeTarget?: 'st'|'rphub'|'none' }} arg
 * @returns {'rphub'|'st'|null}
 */
export function resolveFormatDetail({ backendDetail, marked = false, degradeTarget = DEGRADE_TARGET_ST } = {}) {
    if (marked === true) return 'rphub'; // 手动标记强制（与后端 upload 语义一致，优先于一切）
    if (backendDetail === 'rphub' || backendDetail === 'st') return backendDetail;
    return resolveDegradeMode({ marked, degradeTarget }); // unknown / 缺失 / 降级
}

/**
 * 按名称在后端 index 中查找（纯函数：解析 index 形状 → 匹配 → 排序取最新）。
 * @param {object} index { cards: { [cardId]: { characterName, importedAt, formatDetail, ... } } }
 * @param {string} name 角色名
 * @returns {{ cardId: string, formatDetail: string }|null} 匹配到则返回，未匹配返回 null
 */
export function matchByNameInIndex(index, name) {
    if (!index || typeof index !== 'object') return null;
    const cards = index.cards;
    if (!cards || typeof cards !== 'object') return null;
    const matches = [];
    for (const [cardId, meta] of Object.entries(cards)) {
        if (meta && typeof meta === 'object' && meta.characterName === name) {
            matches.push({ cardId, formatDetail: meta.formatDetail || 'st', importedAt: meta.importedAt || '' });
        }
    }
    if (matches.length === 0) return null;
    // 同名多卡（重复导入）：取 importedAt 最新
    matches.sort((a, b) => (a.importedAt < b.importedAt ? 1 : a.importedAt > b.importedAt ? -1 : 0));
    return { cardId: matches[0].cardId, formatDetail: matches[0].formatDetail };
}

/** 与 matchByNameInIndex 等价的 hash 匹配（重复导入共享 contentHash，取任一即可）。 */
export function matchByHashInIndex(index, contentHash) {
    if (!index || !contentHash || typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) return null;
    const cards = index.cards;
    if (!cards || typeof cards !== 'object') return null;
    for (const [cardId, meta] of Object.entries(cards)) {
        if (meta && meta.contentHash === contentHash) return { cardId, formatDetail: meta.formatDetail || 'st' };
    }
    return null;
}

// ---------------------------------------------------------------------------
// 面板状态提示（M6）：formatDetail + marked → 状态行文案与按钮动作
// ---------------------------------------------------------------------------

/**
 * RP 内置分组状态行映射（纯函数，node 可测）。
 * @param {{ formatDetail?: 'rphub'|'st'|null, marked?: boolean }} arg
 * @returns {{ kind: 'active'|'inactive'|'undetermined', text: string, action: { label: string, mark: boolean }|null }}
 *   - rphub：RP 模式生效中；仅手动标记（marked）时给「取消 RP 标记」按钮。
 *   - st/unknown/缺失：非 RP 模式提示 + 「标记为 RP」按钮。
 *   - null（降级目标 'none'，判定失败）：显示「判定失败」+ 「标记为 RP」按钮。
 *   - 无角色/组聊：不返回 action（由面板按角色态决定整行显隐）。
 */
export function rpModeStatusView({ formatDetail, marked = false } = {}) {
    if (formatDetail === 'rphub') {
        return {
            kind: 'active',
            text: 'RP 模式生效中（RP 内置已启用）',
            action: marked === true ? { label: '取消 RP 标记', mark: false } : null,
        };
    }
    if (formatDetail === null) {
        // 降级目标 'none'（禁止降级）：后端判定失败，无法确定模式
        return {
            kind: 'undetermined',
            text: '模式判定失败（降级已禁用，后端未返回有效结果）',
            action: { label: '标记为 RP', mark: true },
        };
    }
    return {
        kind: 'inactive',
        text: '当前卡非 RP 模式，RP 内置正则不生效',
        action: { label: '标记为 RP', mark: true },
    };
}

/** marks 单条标记接口 URL（纯函数）：PUT = 设置标记，DELETE = 取消标记。 */
export function markUrl(contentHash) {
    return `${BASE}/marks/${encodeURIComponent(contentHash)}`;
}

/**
 * RP 内置总开关「打开」时的联动决策（纯函数，node 可测）。
 *
 * M6.5 方案 2 联动：st/unknown 卡打开 RP 内置总开关（regex_rp_toggle）→ 先自动标记为
 * rphub（PUT marks），成功才真正打开；contentHash 不可得 → 无法标记，回滚 + 提示。
 * 关闭方向不联动（标记是卡的持久判定，与开关独立；取消用状态行「取消 RP 标记」按钮）。
 *
 * @param {object} args
 * @param {boolean} [args.enable]          用户操作的开关目标状态（true = 打开）
 * @param {string} [args.formatDetail]     当前卡模式（'rphub' | 'st' | 'unknown' | 缺失）
 * @param {string|null} [args.contentHash] 当前卡 contentHash（不可得为 null/空串/缺失）
 * @param {boolean} [args.hasCharacter]    是否有当前角色（无角色/组聊为 false）
 * @param {string} [args.reason]           fetchCardInfo 判定原因（'not_found'|'unreachable'|
 *                                         'no_content_hash'|'ok'）；blocked 时透传给 UI 提示，
 *                                         缺省回落 'no_content_hash'（兼容无 reason 调用方）
 * @returns {{ action: 'direct'|'mark_then_open'|'blocked', reason?: string }}
 *   - 'direct'：维持现有行为直接切换（已是 rphub / 关闭方向 / 无角色组聊）
 *   - 'mark_then_open'：先 PUT 标记为 rphub，成功后再打开
 *   - 'blocked'：st/unknown 且 contentHash 不可得 → 无法标记，回滚 + toastr 提示；
 *     reason 细化：not_found（后端 404）／unreachable（后端不可达）／no_content_hash（缺省）
 */
export function decideRpToggleAction({ enable, formatDetail, contentHash, hasCharacter = true, reason } = {}) {
    if (enable !== true) return { action: 'direct' }; // 关闭方向：不联动（不自动取消标记）
    if (!hasCharacter) return { action: 'direct' };    // 无角色 / 组聊：开关与状态行保持现状
    if (formatDetail === 'rphub') return { action: 'direct' }; // 已是 rphub：直接打开
    // st / unknown / 缺失：需标记才能让 RP 内置真正生效；contentHash 不可得（缺失或非
    // 64 位十六进制，后者 PUT 必 400 INVALID_CONTENT_HASH）→ 无法标记。
    // reason 细化：透传 fetchCardInfo 的判定原因，无 reason 时回落 no_content_hash。
    if (typeof contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(contentHash)) {
        return { action: 'blocked', reason: reason || 'no_content_hash' };
    }
    return { action: 'mark_then_open' };
}

// ---------------------------------------------------------------------------
// ST 侧：缓存 + HTTP（依赖 fetch / 全局，仅浏览器可用）
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000;
const modeCache = new Map(); // key(avatar|name) -> { cardId, formatDetail, contentHash, marked, ts }

export function clearModeCache() {
    modeCache.clear();
}

function cacheGet(key) {
    const hit = modeCache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit;
    return null;
}

/**
 * 当前角色的模式信息（formatDetail + contentHash + marked + reason，带缓存）。
 * degradeTarget 透传给 fetchCardInfo（判定失败时按配置目标降级；浏览器调用方
 * 传入 settings.getDegradeTarget()，缺省 'st'）。
 * @param {object} opts
 * @param {string} [opts.avatar] 角色 avatar（缓存键；缺省用名称）
 * @param {string} [opts.name]   角色名
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl] 可注入（测试用）
 * @param {'st'|'rphub'|'none'} [opts.degradeTarget] 降级目标（缺省 'st'）
 * @returns {Promise<{ formatDetail: 'rphub'|'st'|null, contentHash: string|null, marked: boolean, reason: string }>}
 */
export async function getFormatDetail({ avatar, name, fetchImpl = fetch, degradeTarget = DEGRADE_TARGET_ST } = {}) {
    // RM2 说明：缓存键不含 degradeTarget —— 降级目标变化后必须由调用方 clearModeCache() 失效缓存
    // （panel/ui.js 的 degrade_target handler 已调用；pipeline CHAT_CHANGED 亦失效）。此依赖为显式约定。
    const cacheKey = avatar || name || '__unknown__';
    const cached = cacheGet(cacheKey);
    if (cached) return { formatDetail: cached.formatDetail, contentHash: cached.contentHash, marked: cached.marked, reason: cached.reason };
    const info = await fetchCardInfo({ avatar, name, fetchImpl, degradeTarget });
    modeCache.set(cacheKey, { cardId: null, formatDetail: info.formatDetail, contentHash: info.contentHash, marked: info.marked, reason: info.reason, ts: Date.now() });
    return info;
}

/** 降级原因 → 日志说明文案。 */
const DEGRADE_REASON_TEXT = {
    not_found: '后端未匹配到该卡',
    unreachable: '后端不可达',
    no_content_hash: '后端未返回合法 contentHash',
};

/**
 * 降级路径控制台日志：卡名 + 原因 + 降级结果。
 * 例：`[rp-hub-compat] formatDetail 降级：卡「X」原因 not_found（后端未匹配到该卡）→ 降为 st`
 * @param {'not_found'|'unreachable'|'no_content_hash'} reason
 * @param {string} characterName 卡名（无角色时传入占位文案）
 * @param {'rphub'|'st'|null} formatDetail 实际降级结果
 */
function logDegrade(reason, characterName, formatDetail) {
    const targetText = formatDetail === null
        ? '判定失败（禁止降级，formatDetail=null）'
        : `降为 ${formatDetail}`;
    console.warn(
        `[rp-hub-compat] formatDetail 降级：卡「${characterName}」原因 ${reason}（${DEGRADE_REASON_TEXT[reason] ?? reason}）→ ${targetText}`,
    );
}

/**
 * 无缓存直接取（供 CHAT_CHANGED 后首次判定内部使用）。
 *
 * 返回 { formatDetail, contentHash, marked, reason }，其中 reason 区分失败原因（供
 * UI toastr 精确提示）：
 *   - 'not_found'：后端 404（by-name 未命中 → 卡未导入或角色名不匹配）
 *   - 'unreachable'：网络错误 / 其它非 2xx（后端插件未启用或服务未启动）
 *   - 'no_content_hash'：200 但 contentHash 缺失或非法（非 64 位十六进制）
 *   - 'ok'：成功（contentHash 可得）
 * 三条降级路径（not_found / unreachable / no_content_hash）的 formatDetail 均按
 * degradeTarget 降级（'st' → st；'rphub' → rphub；'none' → null），并输出 console.warn。
 * @param {object} opts
 * @param {string} [opts.name] 角色名
 * @param {string} [opts.avatar] 角色 avatar（无 name 时用）
 * @param {(url: string, init?: object) => Promise<Response>} [opts.fetchImpl] 可注入（测试用）
 * @param {'st'|'rphub'|'none'} [opts.degradeTarget] 降级目标（缺省 'st'）
 */
async function fetchCardInfo({ avatar, name, fetchImpl = fetch, degradeTarget = DEGRADE_TARGET_ST } = {}) {
    const characterName = name || avatar;
    if (!characterName) {
        const formatDetail = resolveDegradeMode({ degradeTarget });
        logDegrade('no_content_hash', '（无角色）', formatDetail);
        return { formatDetail, contentHash: null, marked: false, reason: 'no_content_hash' };
    }
    try {
        const res = await fetchImpl(`${BASE}/cards/by-name/${encodeURIComponent(characterName)}`);
        if (res.status === 404) {
            const formatDetail = resolveDegradeMode({ degradeTarget });
            logDegrade('not_found', characterName, formatDetail);
            return { formatDetail, contentHash: null, marked: false, reason: 'not_found' };
        }
        if (!res.ok) {
            const formatDetail = resolveDegradeMode({ degradeTarget });
            logDegrade('unreachable', characterName, formatDetail);
            return { formatDetail, contentHash: null, marked: false, reason: 'unreachable' };
        }
        const data = await res.json();
        const contentHash = data?.contentHash ?? null;
        // contentHash 应为 64 位十六进制（sha256）；缺失/非法 → 无法标记，视为降级路径
        const hashOk = typeof contentHash === 'string' && /^[0-9a-f]{64}$/.test(contentHash);
        const marked = data?.marked === true;
        if (!hashOk) {
            const formatDetail = resolveDegradeMode({ marked, degradeTarget });
            logDegrade('no_content_hash', characterName, formatDetail);
            return { formatDetail, contentHash, marked, reason: 'no_content_hash' };
        }
        return {
            formatDetail: resolveFormatDetail({ backendDetail: data?.formatDetail, marked, degradeTarget }),
            contentHash,
            marked,
            reason: 'ok',
        };
    } catch (err) {
        const formatDetail = resolveDegradeMode({ degradeTarget });
        logDegrade('unreachable', characterName, formatDetail);
        return { formatDetail, contentHash: null, marked: false, reason: 'unreachable' };
    }
}
