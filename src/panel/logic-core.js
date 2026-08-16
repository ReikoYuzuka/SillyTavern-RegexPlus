/**
 * panel/logic-core.js —— 面板纯逻辑核心（可 node 离线测试）。
 *
 * 覆盖（对照原版 extensions/regex/index.js 逐字复刻）：
 *   - 编辑器字段表单默认值 / 收集（collectRegexScriptData，index.js:848-868）
 *   - 编辑器回填（fillEditorFields，index.js:772-795）
 *   - 导入解析（onRegexImportObjectChange 核心，index.js:1499-1533）
 *   - Regex Preset 分组操作（savePreset/applyPreset/applyPresetList/deletePreset
 *     /regexListToPresetItems/hasStateChanged/captureCurrentState，index.js:47-476）
 *   - 调试器规则分组（partitionByType，index.js:1066-1088）
 *   - 嵌入脚本白名单逻辑（checkChar/PresetEmbeddedRegexScripts 判定，
 *     index.js:1606-1677）
 *
 * 本模块不 import 任何 ST 全局（也不 import st-bridge），
 * 所有副作用（弹窗/存储/事件/网络）由 ui.js 注入回调实现。
 */

import { SCRIPT_TYPES } from '../store/scripts-core.js';

// ---------------------------------------------------------------------------
// 编辑器：表单默认值与收集
// ---------------------------------------------------------------------------

/** 编辑器新建默认值（index.js:797-809）：markdownOnly=true、runOnEdit=true、placement=[1]。 */
export const EDITOR_NEW_DEFAULTS = Object.freeze({
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
    placement: [1],
});

/**
 * 解析 trimStrings 文本域（\n 分隔，去空行）。
 * @param {string} value
 * @returns {string[]}
 */
export function splitTrimStrings(value) {
    return String(value ?? '').split('\n').filter((e) => e.length !== 0) || [];
}

/**
 * 从编辑器 DOM 值收集新脚本（index.js:848-868 逐字复刻 + 预处理扩展）。
 * @param {object} fields { scriptName, findRegex, replaceString, trimStrings,
 *   placement, disabled, markdownOnly, promptOnly, runOnEdit, substituteRegex,
 *   minDepth, maxDepth, rp_preprocess_enabled, rp_preprocess_mode,
 *   rp_preprocess_rules, rp_preprocess_rx } 均为原始 DOM 值
 * @param {string} existingId 已有 id（编辑时）或空（新建时生成新 id）
 * @param {() => string} generateId uuidv4 生成器（注入）
 * @returns {object} 完整 RegexScriptData（含 rp_preprocess 或旧 rp_scope_* 字段）
 */
export function collectRegexScriptData(fields, existingId, generateId) {
    const placement = (Array.isArray(fields.placement) ? fields.placement : [])
        .map((e) => parseInt(String(e), 10))
        .filter((e) => !isNaN(e));
    const data = {
        id: existingId ? String(existingId) : generateId(),
        scriptName: String(fields.scriptName ?? ''),
        findRegex: String(fields.findRegex ?? ''),
        replaceString: String(fields.replaceString ?? ''),
        trimStrings: splitTrimStrings(String(fields.trimStrings ?? '')),
        placement,
        disabled: !!fields.disabled,
        markdownOnly: !!fields.markdownOnly,
        promptOnly: !!fields.promptOnly,
        runOnEdit: !!fields.runOnEdit,
        substituteRegex: Number(fields.substituteRegex) || 0,
        // 1→2→1 渲染模式（two_pass_121）：预设脚本第二遍是否不执行（缺省 false =
        // 第二遍执行；仅预设脚本有意义，卡内嵌/全局脚本在两遍管线中只在阶段②跑一次）
        rp_skip_second_pass: fields.rp_skip_second_pass === true,
        minDepth: parseInt(String(fields.minDepth ?? ''), 10),
        maxDepth: parseInt(String(fields.maxDepth ?? ''), 10),
    };
    // 预处理：仅 enabled 时写 rp_preprocess（否则不写；旧 rp_scope_* 字段在启用时迁移进 rules）
    if (fields.rp_preprocess_enabled === true || fields.rp_preprocess_enabled === 'true') {
        if (fields.rp_preprocess_mode === 'advanced') {
            const rx = (Array.isArray(fields.rp_preprocess_rx) ? fields.rp_preprocess_rx : [])
                .map((x) => {
                    if (typeof x === 'string') {
                        // 兼容旧字符串数组
                        const s = String(x).trim();
                        return s ? { pattern: s, exclude: false, replaceEnabled: false, replace: null } : null;
                    }
                    if (!x || typeof x !== 'object') return null;
                    const pattern = String(x.pattern ?? '').trim();
                    if (!pattern) return null;
                    return {
                        pattern,
                        exclude: x.exclude === true,
                        replaceEnabled: x.replaceEnabled === true,
                        replace: typeof x.replace === 'string' ? x.replace : null,
                    };
                })
                .filter(Boolean);
            if (rx.length > 0) data.rp_preprocess = { enabled: true, mode: 'advanced', rx };
        } else {
            const rules = (Array.isArray(fields.rp_preprocess_rules) ? fields.rp_preprocess_rules : [])
                .map((r) => {
                    const start = String(r?.start ?? '').trim();
                    const end = String(r?.end ?? '').trim();
                    // 单标签扩展：至少一个非空
                    return { start, end, includeTags: r?.includeTags !== false, exclude: r?.exclude === true };
                })
                .filter((r) => r.start || r.end);
            if (rules.length > 0) data.rp_preprocess = { enabled: true, mode: 'basic', rules };
        }
    }
    return data;
}

/**
 * 把已有脚本回填为编辑器字段值（index.js:772-795 逐字复刻）。
 * @param {object|null} script 已有脚本；null 表示新建
 * @returns {object} 回填值（含 defaults 合并）
 */
export function fillEditorFields(script) {
    if (!script) {
        return {
            scriptName: '',
            findRegex: '',
            replaceString: '',
            trimStrings: '',
            ...EDITOR_NEW_DEFAULTS,
            rp_skip_second_pass: false,
            minDepth: '',
            maxDepth: '',
            rp_preprocess_enabled: false,
            rp_preprocess_mode: 'basic',
            rp_preprocess_rules: [],
            rp_preprocess_rx: [],
        };
    }
    // 预处理回填：新结构 rp_preprocess 优先；旧字段 rp_scope_start/rp_scope_end（单对）迁移为
    // basic 模式单条规则（includeTags 默认 true）—— 向后兼容旧数据。
    let ppEnabled = false;
    let ppMode = 'basic';
    let ppRules = [];
    let ppRx = [];
    const pp = script.rp_preprocess;
    if (pp && typeof pp === 'object' && pp.enabled === true) {
        ppEnabled = true;
        ppMode = pp.mode === 'advanced' ? 'advanced' : 'basic';
        ppRules = Array.isArray(pp.rules)
            ? pp.rules.map((r) => ({
                start: String(r?.start ?? ''),
                end: String(r?.end ?? ''),
                includeTags: r?.includeTags !== false,
                exclude: r?.exclude === true,
            }))
            : [];
        // rx 兼容旧字符串数组：字符串 → { pattern, exclude:false, replaceEnabled:false, replace:null }
        ppRx = Array.isArray(pp.rx) ? pp.rx.map((x) => {
            if (typeof x === 'string') return { pattern: String(x), exclude: false, replaceEnabled: false, replace: null };
            if (!x || typeof x !== 'object') return { pattern: '', exclude: false, replaceEnabled: false, replace: null };
            return {
                pattern: String(x.pattern ?? ''),
                exclude: x.exclude === true,
                replaceEnabled: x.replaceEnabled === true,
                replace: typeof x.replace === 'string' ? x.replace : null,
            };
        }) : [];
    } else if (typeof script.rp_scope_start === 'string' && script.rp_scope_start.length > 0
        && typeof script.rp_scope_end === 'string' && script.rp_scope_end.length > 0) {
        // 旧字段迁移：rp_scope_start/rp_scope_end → rp_preprocess.rules[0]（includeTags 默认 true）
        ppEnabled = true;
        ppMode = 'basic';
        ppRules = [{ start: script.rp_scope_start, end: script.rp_scope_end, includeTags: true, exclude: false }];
    }
    return {
        scriptName: script.scriptName || '',
        findRegex: script.findRegex || '',
        replaceString: script.replaceString || '',
        trimStrings: Array.isArray(script.trimStrings) ? script.trimStrings.join('\n') : '',
        disabled: script.disabled ?? false,
        markdownOnly: script.markdownOnly ?? false,
        promptOnly: script.promptOnly ?? false,
        runOnEdit: script.runOnEdit ?? false,
        substituteRegex: script.substituteRegex ?? 0,
        rp_skip_second_pass: script.rp_skip_second_pass === true,
        minDepth: script.minDepth ?? '',
        maxDepth: script.maxDepth ?? '',
        placement: Array.isArray(script.placement) ? script.placement : [],
        rp_preprocess_enabled: ppEnabled,
        rp_preprocess_mode: ppMode,
        rp_preprocess_rules: ppRules,
        rp_preprocess_rx: ppRx,
    };
}

// ---------------------------------------------------------------------------
// 导入解析
// ---------------------------------------------------------------------------

/**
 * 解析导入文件内容（onRegexImportObjectChange 的纯逻辑核心，index.js:1499-1533）。
 * @param {string} jsonText 文件文本
 * @param {(obj: object) => object} normalize 归一函数（注入：强制换 UUID + 默认字段）
 * @param {(obj: object) => object} append 追加函数（注入：push 到目标数组）
 * @returns {{ imported: string[], error?: string }}
 *   返回导入成功的脚本名列表；数组内单条失败不影响其余（原版数组循环语义）。
 */
export function parseImportJson(jsonText, normalize, append) {
    if (typeof jsonText !== 'string' || jsonText.length === 0) {
        return { imported: [], error: 'Invalid JSON file.' };
    }
    let parsed;
    try {
        parsed = JSON.parse(jsonText);
    } catch (error) {
        return { imported: [], error: 'Invalid JSON file.' };
    }

    const imported = [];
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
        if (!item || typeof item !== 'object' || !item.scriptName) {
            // 原版：单条无 scriptName → toastr.error('Invalid regex object.') 并中断该条
            continue;
        }
        const normalized = normalize(item);
        append(normalized);
        imported.push(String(normalized.scriptName));
    }
    return { imported };
}

/**
 * 归一导入对象：强制分配新 UUID（index.js:1506）。字段兜底由调用方决定。
 * @param {object} obj
 * @param {() => string} generateId
 * @returns {object} 新 id 的副本
 */
export function normalizeImportedScript(obj, generateId) {
    return { ...obj, id: generateId() };
}

// ---------------------------------------------------------------------------
// Regex Preset 分组（index.js:47-476 纯逻辑部分）
// ---------------------------------------------------------------------------

/** 把脚本列表转为 preset 条目（index.js:400-406：排除 disabled）。 */
export function regexListToPresetItems(list) {
    if (!Array.isArray(list)) return null;
    return list.filter((x) => !x.disabled).map((s) => ({ id: s.id }));
}

/** 捕获当前启用脚本 id 状态（index.js:73-83）。 */
export function captureCurrentState(getScriptsByType) {
    const byType = (type) => regexListToPresetItems(getScriptsByType(type));
    const global = byType(SCRIPT_TYPES.GLOBAL) ?? [];
    const scoped = byType(SCRIPT_TYPES.SCOPED) ?? [];
    const preset = byType(SCRIPT_TYPES.PRESET) ?? [];
    return {
        global: global.map((item) => item.id).sort(),
        scoped: scoped.map((item) => item.id).sort(),
        preset: preset.map((item) => item.id).sort(),
    };
}

/** 比较两个状态（index.js:91-108）。 */
export function hasStateChanged(state1, state2) {
    if (!state1 || !state2) return false;
    const a = (s) => s.global || [];
    const b = (s) => s.scoped || [];
    const c = (s) => s.preset || [];
    // PL3 修复：补齐 preset 长度比较——否则「新增启用预设脚本」检测不到，切预设时改动被静默丢弃
    if (a(state1).length !== a(state2).length || b(state1).length !== b(state2).length || c(state1).length !== c(state2).length) {
        return true;
    }
    const includes = (arr, id) => arr.includes(id);
    return !a(state1).every((id) => includes(a(state2), id)) ||
        !b(state1).every((id) => includes(b(state2), id)) ||
        !c(state1).every((id) => includes(c(state2), id));
}

/** 构建 preset 对象（index.js:429-436）。 */
export function buildPreset({ id, name, getScriptsByType }) {
    return {
        id: String(id),
        name: String(name),
        isSelected: false,
        global: regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.GLOBAL)),
        scoped: regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.SCOPED)),
        preset: regexListToPresetItems(getScriptsByType(SCRIPT_TYPES.PRESET)),
    };
}

/**
 * 应用 preset 列表到目标列表（index.js:344-362 applyPresetList）：
 * 启用 preset 中列出的脚本 + 按 preset 顺序重排。
 * @param {object[]} presetList
 * @param {object[]} targetList
 * @returns {object[]} 修改后的数组（直接改动入参并返回）
 */
export function applyPresetList({ presetList, targetList }) {
    if (!Array.isArray(targetList) || !Array.isArray(presetList)) {
        return targetList;
    }
    targetList.forEach((script) => {
        script.disabled = !presetList.some((p) => p.id === script.id);
    });
    targetList.sort((a, b) => {
        const aIndex = presetList.findIndex((p) => p.id === a.id);
        const bIndex = presetList.findIndex((p) => p.id === b.id);
        return aIndex - bIndex || targetList.indexOf(a) - targetList.indexOf(b);
    });
    return targetList;
}

// ---------------------------------------------------------------------------
// 调试器：规则按类型分组（index.js:1066-1088）
// ---------------------------------------------------------------------------

/**
 * 把全部脚本按所属类型分组（含 `type` 标注的深拷贝）。
 * @param {object[]} allScripts getRegexScripts() 结果
 * @param {object} getScriptsByType
 * @returns {{ global: object[], scoped: object[], preset: object[] }}
 */
export function partitionByType(allScripts, getScriptsByType) {
    const globalIds = new Set(getScriptsByType(SCRIPT_TYPES.GLOBAL).map((s) => s.id));
    const scopedIds = new Set(getScriptsByType(SCRIPT_TYPES.SCOPED).map((s) => s.id));
    const presetIds = new Set(getScriptsByType(SCRIPT_TYPES.PRESET).map((s) => s.id));

    const global = [];
    const scoped = [];
    const preset = [];
    for (const script of allScripts) {
        if (!script || typeof script !== 'object') continue;
        const copy = structuredClone(script);
        if (globalIds.has(script.id)) {
            copy.type = SCRIPT_TYPES.GLOBAL;
            global.push(copy);
        } else if (scopedIds.has(script.id)) {
            copy.type = SCRIPT_TYPES.SCOPED;
            scoped.push(copy);
        } else if (presetIds.has(script.id)) {
            copy.type = SCRIPT_TYPES.PRESET;
            preset.push(copy);
        }
    }
    return { global, scoped, preset };
}

// ---------------------------------------------------------------------------
// 嵌入脚本白名单逻辑（index.js:1606-1677 判定部分）
// ---------------------------------------------------------------------------

/**
 * 角色嵌入脚本一次性询问键（index.js:1615 `AlertRegex_${avatar}`）。
 * @param {string} avatar
 * @returns {string}
 */
export function embeddedCheckKey(avatar) {
    return `AlertRegex_${avatar}`;
}

/**
 * 预设嵌入脚本一次性询问键（index.js:1657 `AlertRegex_${apiId}_${name}`）。
 * @param {string} apiId
 * @param {string} name
 * @returns {string}
 */
export function presetCheckKey(apiId, name) {
    return `AlertRegex_${apiId}_${name}`;
}

/**
 * accountStorage 键长度收敛（localStorage 键上限约 512 字符；超长时截断 + 哈希）。
 * @param {string} key
 * @returns {string}
 */
export function normalizeStorageKey(key) {
    const s = String(key ?? '');
    if (s.length <= 500) return s;
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) {
        hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
    }
    return s.slice(0, 400) + '#' + Math.abs(hash).toString(36);
}

/**
 * 角色嵌入脚本询问判定（checkCharEmbeddedRegexScripts 的纯判定部分）。
 * @returns {boolean} true 表示应弹出「允许使用」询问
 *   （有 scoped 脚本 && 未允许 && 本次会话尚未询问过）
 */
export function shouldAskCharEmbedded(scripts, allowed, alreadyAsked) {
    return Array.isArray(scripts) && scripts.length > 0 && !allowed && !alreadyAsked;
}

/**
 * 预设嵌入脚本询问判定（checkPresetEmbeddedRegexScripts 的纯判定部分）。
 * @returns {{ ask: boolean, notifyReload: boolean }}
 *   ask：应弹出允许询问；notifyReload：已允许且有启用脚本 → 提示重载聊天
 */
export function shouldAskPresetEmbedded(scripts, allowed, alreadyAsked) {
    if (Array.isArray(scripts) && scripts.length > 0) {
        if (!allowed && !alreadyAsked) {
            return { ask: true, notifyReload: false };
        }
        if (allowed && scripts.filter((script) => !script.disabled).length > 0) {
            return { ask: false, notifyReload: true };
        }
    }
    return { ask: false, notifyReload: false };
}

// ---------------------------------------------------------------------------
// 其他小工具
// ---------------------------------------------------------------------------

/** sanitizeFileName（index.js:19）。 */
export function sanitizeFileName(name) {
    return String(name ?? '').replace(/[\s.<>:"/\\|?*\x00-\x1F\x7F]/g, '_').toLowerCase();
}

/** 导出文件名：单个脚本（index.js:701）。 */
export function exportFileNameForScript(script) {
    return `regex-${sanitizeFileName(script.scriptName)}.json`;
}

/** 批量导出文件名（index.js:1906）。 */
export function bulkExportFileName() {
    return `regex-${new Date().toISOString()}.json`;
}
