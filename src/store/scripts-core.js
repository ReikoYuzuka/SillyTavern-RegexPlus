// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * scripts-core.js —— 三类脚本合并的纯函数核心（可 node 离线测试）。
 *
 * 对照基准（原版正则功能全貌.md A.1）：
 *   - SCRIPT_TYPES：GLOBAL=0 / PRESET=2 / SCOPED=1；枚举顺序即执行优先级，
 *     合并顺序 = Global → Preset → Scoped（Object.values 插入序 0,2,1）。
 *   - allow 白名单：scoped 由 character_allowed_regex（avatar 数组），
 *     preset 由 preset_allowed_regex（Record<apiId, string[]>）。
 *   - 内置 RP 分组：仅 rphub 模式追加；插入位置由 rp_hub_rp_position 决定
 *     （0=最前；1/2/3=第 N 位之后；默认 3=最后，见 内置RP分组.md §3）。
 *   - 三类顺序来源（引擎设计.md §7，order_source）：
 *     - 'spreset'（默认）：检测到 window.__regexScriptOrder（外部 order）时按它执行
 *       （默认 [2,0,1] = 预设→全局→角色），未检测到 → 回退原版顺序；
 *     - 'st'：忽略 SPreset，永远原版顺序（Global→Preset→Scoped）。
 *   - 用户完整自定义（rp_hub_full_order，引擎设计.md §7 / 内置RP分组.md §3）：
 *     四类（preset/global/scoped/rp）排列存在且合法时**优先**用它（脱离 order_source
 *     与 rp_position，SPreset 亦不参与）；解析优先级 full_order > order_source+rp_position。
 *
 * 本模块不 import 任何 ST 全局，仅导出纯函数；ST 存取包装在 scripts.js / settings.js。
 */

/** 与原版 engine.js:11-16 一致的类型枚举（顺序即优先级）。 */
export const SCRIPT_TYPES = {
    GLOBAL: 0,
    PRESET: 2,
    SCOPED: 1,
};
export const SCRIPT_TYPE_UNKNOWN = -1;

/** 原版执行顺序（回退基准）：global → preset → scoped。 */
export const TYPE_ORDER = [SCRIPT_TYPES.GLOBAL, SCRIPT_TYPES.PRESET, SCRIPT_TYPES.SCOPED];

/** 执行顺序来源：'spreset'（默认，检测到 __regexScriptOrder 则跟随）| 'st'（永远原版顺序）。 */
export const DEFAULT_ORDER_SOURCE = 'spreset';
export const ORDER_SOURCE_SPRESET = 'spreset';
export const ORDER_SOURCE_ST = 'st';

// ---------------------------------------------------------------------------
// 脚本自定义字段本地存储（rp_hub_script_extras，方法 2 指纹键控）
// ---------------------------------------------------------------------------
// scoped（存卡）/ preset（存预设）脚本上的「我们自定义字段」（当前 = rp_preprocess，
// 未来扩展同机制）不再写卡/预设文件，改存本地（localStorage 默认，extension_settings
// 可选）extension_settings.rp_hub_script_extras，键 = 指纹（类型 + 稳定标识 + 脚本名 +
// findRegex hash）。优先级：本地 extras > 卡/预设自带字段（本机配置优先）；本地无 → 保持
// 卡/预设历史字段（换机器兜底 fallback）。

/** 自定义字段清单（当前仅 rp_preprocess；未来新增字段加入此数组，指纹 key 不变）。 */
export const SCRIPT_EXTRAS_FIELDS = ['rp_preprocess'];

/**
 * djb2 字符串 hash（无符号 32 位 → 十进制字符串）。
 * 用于指纹 key 的 findRegex 段：内容相同 → 同 hash；任一字符变化 → 不同 hash。
 * @param {string} str
 * @returns {string} 十进制 hash 字符串
 */
export function djb2Hash(str) {
    let h = 5381;
    const s = String(str ?? '');
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return String(h);
}

/**
 * 构建脚本指纹 key（纯函数，node 可测）。
 * 原则：类型 + 稳定标识 + 脚本名 + findRegex hash —— 任一脚本内容变化才失配。
 *   - scoped（局部/存卡）：`scoped:<avatar>|<scriptName>|<findRegex hash>`
 *   - preset（存预设）：`preset:<presetName>|<scriptName>|<findRegex hash>`
 *   - global（不绑定卡）：`global:<scriptName>|<findRegex hash>`
 * @param {object} arg
 * @param {'scoped'|'preset'|'global'} arg.kind 脚本类型
 * @param {string} [arg.avatar] 卡 avatar（文件名；scoped 用）
 * @param {string} [arg.presetName] 预设名（preset 用）
 * @param {string} [arg.scriptName] 脚本名
 * @param {string} [arg.findRegex] findRegex（参与 hash）
 * @returns {string|null} 指纹 key；非法 kind / 缺 scriptName → null
 */
export function buildScriptFingerprint({ kind, avatar = '', presetName = '', scriptName = '', findRegex = '' }) {
    const name = String(scriptName ?? '').trim();
    if (!name) return null;
    const hash = djb2Hash(findRegex);
    switch (kind) {
        case 'scoped':
            return `scoped:${String(avatar ?? '')}|${name}|${hash}`;
        case 'preset':
            return `preset:${String(presetName ?? '')}|${name}|${hash}`;
        case 'global':
            return `global:${name}|${hash}`;
        default:
            return null;
    }
}

/**
 * 把本地 extras 叠加到脚本（纯函数，node 可测）。
 * extras 存在 → `{ ...script, ...extras }`（本地覆盖卡/预设自带字段）；
 * extras 缺失/非对象 → 原样返回（保持卡/预设历史字段作为 fallback）。
 * 只叠加自定义字段（extras 内仅含 SCRIPT_EXTRAS_FIELDS 对应的字段），不碰其它。
 * @param {object} script
 * @param {object|null} extras 本地 extras 对象（如 { rp_preprocess: {...} }）或 null
 * @returns {object}
 */
export function applyScriptExtras(script, extras) {
    if (!script || typeof script !== 'object') return script;
    if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return script;
    return { ...script, ...extras };
}

/**
 * 归一执行顺序来源：'st' / 'spreset'，缺省/非法 → DEFAULT_ORDER_SOURCE（'spreset'）。
 * @param {*} value rp_hub_order_source 存储值
 * @returns {'spreset'|'st'}
 */
export function normalizeOrderSource(value) {
    return value === ORDER_SOURCE_ST ? ORDER_SOURCE_ST : DEFAULT_ORDER_SOURCE;
}

/**
 * 归一 extras 存储模式：'local'（localStorage，默认）/ 'settings'（extension_settings）。
 * 非法/缺省 → 'local'。
 * @param {*} value rp_hub_extras_storage 存储值
 * @returns {'local'|'settings'}
 */
export function normalizeExtrasStorageMode(value) {
    return value === 'settings' ? 'settings' : 'local';
}

/**
 * 按 order_source 决定三类（Global/Preset/Scoped）执行顺序（纯函数核心）。
 *
 * 优先级（引擎设计.md §7）：
 *   - 'st'：忽略 SPreset，永远原版顺序 TYPE_ORDER（Global→Preset→Scoped）；
 *   - 'spreset'：外部顺序存在（order 或 externalOrder 显式传入，即检测到
 *     window.__regexScriptOrder）→ 按 resolveScriptOrder 校验后的顺序执行；
 *     否则回退原版顺序。
 *
 * @param {object} [args]
 * @param {'spreset'|'st'} [args.orderSource] 顺序来源（缺省 'spreset'）
 * @param {*|number[]} [args.order]           外部脚本顺序（浏览器里即 window.__regexScriptOrder）
 * @param {*|number[]} [args.externalOrder]   order 的别名（测试可注入；order 优先）
 * @returns {number[]} 三类标准排序数组（SCRIPT_TYPES 枚举值，长度恒为 3）
 */
export function resolveOrderSource({ orderSource = DEFAULT_ORDER_SOURCE, order, externalOrder } = {}) {
    if (orderSource === ORDER_SOURCE_ST) return [...TYPE_ORDER];
    const external = order !== undefined ? order : externalOrder;
    if (external === undefined) return [...TYPE_ORDER];
    return resolveScriptOrder(external);
}

/**
 * SPreset 兼容（方案 A：跟随）：把外部脚本顺序解析为三类标准排序数组。
 *
 * SPreset（预设绑定正则辅助）会劫持 Object.values 让 ST 原版 getRegexScripts 按
 * window.__regexScriptOrder 返回（默认 [2,0,1] = PRESET→GLOBAL→SCOPED）。值域即
 * SCRIPT_TYPES 枚举 {0,1,2}，合法输入必须是三元素的排列。
 *
 * @param {*} externalOrder 外部顺序（浏览器里即 window.__regexScriptOrder）。
 *   合法：三元素排列，每个元素为 {0,1,2}（接受数字或数字字符串）。
 *   缺省/非法：非数组、长度≠3、缺项、超范围、重复、含非数字 → 回退原版顺序。
 * @returns {number[]} 三类标准排序数组（SCRIPT_TYPES 枚举值，长度恒为 3）
 */
export function resolveScriptOrder(externalOrder) {
    if (Array.isArray(externalOrder) && externalOrder.length === 3) {
        const normalized = externalOrder.map((v) => (
            typeof v === 'number' ? v
                : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v)
                    : NaN
        ));
        const allValid = normalized.every((v) => Number.isInteger(v) &&
            (v === SCRIPT_TYPES.GLOBAL || v === SCRIPT_TYPES.PRESET || v === SCRIPT_TYPES.SCOPED));
        if (allValid && new Set(normalized).size === 3) {
            return normalized;
        }
    }
    return [...TYPE_ORDER];
}

/**
 * 浏览器环境读取 SPreset 设置的全局顺序。
 * node 单测无 window → 返回 undefined（走原版顺序）；测试也可直接给
 * resolveScriptOrder / mergeScripts 传 order 参数绕过此读取，保持纯函数可测。
 * @returns {*} window.__regexScriptOrder 的值（node 下为 undefined）
 */
export function getExternalRegexScriptOrder() {
    try {
        return (typeof window !== 'undefined' && window) ? window.__regexScriptOrder : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 三类脚本合并（纯函数核心）。
 *
 * 合并顺序（三类 Global/Preset/Scoped）按 order_source 判定（引擎设计.md §7）：
 *   - 'st'：忽略 SPreset，永远原版顺序 TYPE_ORDER（Global→Preset→Scoped）；
 *   - 'spreset'（默认）：检测到 window.__regexScriptOrder（外部 order）时按它执行
 *     （resolveScriptOrder 校验，非法回退原版）；未检测到 → 回退原版顺序。
 *
 * 每条脚本打 `rp_source` 类型标签（'global' | 'preset' | 'scoped'）—— 引擎
 * 「1→2→1 渲染管线」（rp_hub_render_mode='two_pass_121'）按此把预设脚本分到
 * 阶段①/③、卡内嵌（scoped）+ 全局（global）分到阶段②。
 *
 * @param {object} args
 * @param {object[]} [args.global]  全局脚本（extension_settings.regex）
 * @param {object[]} [args.preset]  当前 preset 脚本
 * @param {object[]} [args.scoped]  当前角色卡 scoped 脚本
 * @param {'st'|'rphub'} [args.mode] 语义模式（rphub 时把 disabled 归一为 enabled）
 * @param {*|number[]} [args.order] 外部脚本顺序（三类，即 window.__regexScriptOrder）
 * @param {'spreset'|'st'} [args.orderSource] 执行顺序来源（缺省 'spreset'）
 * @returns {object[]} 合并后的脚本数组（三类按顺序，每条带 rp_source 标签）
 */
export function mergeScripts({
    global = [],
    preset = [],
    scoped = [],
    mode = 'st',
    order,
    orderSource = DEFAULT_ORDER_SOURCE,
} = {}) {
    const buckets = {
        [SCRIPT_TYPES.GLOBAL]: global,
        [SCRIPT_TYPES.PRESET]: preset,
        [SCRIPT_TYPES.SCOPED]: scoped,
    };

    const sourceNameOf = (type) => (
        type === SCRIPT_TYPES.GLOBAL ? 'global'
            : type === SCRIPT_TYPES.PRESET ? 'preset'
                : 'scoped'
    );

    const scripts = resolveOrderSource({ orderSource, order })
        .flatMap((type) => (buckets[type] ?? []).map((s) => (
            !s || typeof s !== 'object' ? s : { ...s, rp_source: sourceNameOf(type) }
        )));

    if (mode === 'rphub') {
        // rphub 解释器只认 enabled（app.js:2927「enabled === false 才跳过」）；
        // ST 存储脚本用 disabled 字段 —— 归一为 enabled，保证禁用开关在 rphub 语义下同样生效。
        return scripts.map((s) => {
            if (!s || typeof s !== 'object') return s;
            const isDisabled = s.enabled === false || s.disabled === true;
            return { ...s, enabled: !isDisabled };
        });
    }
    return scripts;
}

/** scoped 白名单判定（原版 engine.js:115：character_allowed_regex.includes(avatar)）。 */
export function resolveScopedAllowed(character_allowed_regex, avatar) {
    return !!avatar && Array.isArray(character_allowed_regex) && character_allowed_regex.includes(avatar);
}

/** preset 白名单判定（原版 engine.js:122：preset_allowed_regex[apiId].includes(name)）。 */
export function resolvePresetAllowed(preset_allowed_regex, apiId, presetName) {
    if (!apiId || !presetName) return false;
    return Array.isArray(preset_allowed_regex?.[apiId]) && preset_allowed_regex[apiId].includes(presetName);
}
