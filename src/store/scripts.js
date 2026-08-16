// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * scripts.js —— 三类脚本存储读写（ST 全局包装）+ 合并。
 *
 * 存储位置（原版模型，数据层 A）：
 *   - GLOBAL：extension_settings.regex（本地设置）
 *   - SCOPED：characters[this_chid].data.extensions.regex_scripts（角色卡）
 *   - PRESET：presetManager.readPresetExtensionField({ path: 'regex_scripts' }）（当前 preset）
 *
 * 合并顺序（scripts-core.mergeScripts）：Global → Preset → Scoped（按「执行顺序来源」
 * 判定，默认 SPreset：window.__regexScriptOrder 存在时按它执行）。
 * allow 开关：scoped 用 extension_settings.character_allowed_regex（avatar 数组），
 * preset 用 extension_settings.preset_allowed_regex（Record<apiId, string[]>）。
 *
 * 脚本自定义字段本地存储（方法 2 指纹键控）：scoped/preset/global 脚本上的自定义字段
 * （当前 = rp_preprocess）剥离到本地 extras，不写卡/预设文件。存储位置可配置：
 *   - 'local'（默认）：localStorage 键 rp_hub_script_extras（JSON 序列化）—— 关闭重开不丢，
 *     不受 settings.json 刷新/持久化问题影响；
 *   - 'settings'：extension_settings.rp_hub_script_extras —— 随 ST settings.json 持久化。
 * 切换存储位置时自动迁移已有数据（migrateScriptExtrasStorage）。
 */

import { characters, extension_settings, getPresetManager, this_chid, saveSettingsDebounced, writeExtensionField } from '../st-bridge.js';
import { uuidv4 } from '../../../../../utils.js';
import {
    SCRIPT_TYPES,
    SCRIPT_TYPE_UNKNOWN,
    mergeScripts,
    resolveScriptOrder,
    resolveOrderSource,
    getExternalRegexScriptOrder,
    resolveScopedAllowed,
    resolvePresetAllowed,
    buildScriptFingerprint,
    applyScriptExtras,
    SCRIPT_EXTRAS_FIELDS,
} from './scripts-core.js';
import {
    getOrderSource,
    getExtrasStorageMode,
} from './settings.js';

export { SCRIPT_TYPES, SCRIPT_TYPE_UNKNOWN, mergeScripts, resolveScriptOrder, resolveOrderSource, getExternalRegexScriptOrder };

/** 原版 SCRIPT_TYPES 枚举数值映射（供外部使用）。 */
export const regex_placement = Object.freeze({
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
});

/**
 * 按类型读取脚本（逐字复刻原版 getScriptsByType，engine.js:108-133）。
 * @param {number} scriptType
 * @param {{ allowedOnly?: boolean }} [options]
 * @returns {object[]}
 */
export function getScriptsByType(scriptType, { allowedOnly = false } = {}) {
    switch (scriptType) {
        case SCRIPT_TYPE_UNKNOWN:
            return [];
        case SCRIPT_TYPES.GLOBAL:
            return Array.isArray(extension_settings.regex) ? extension_settings.regex : [];
        case SCRIPT_TYPES.SCOPED: {
            const avatar = characters?.[this_chid]?.avatar;
            if (allowedOnly && !resolveScopedAllowed(extension_settings.character_allowed_regex, avatar)) {
                return [];
            }
            const scoped = characters?.[this_chid]?.data?.extensions?.regex_scripts;
            return Array.isArray(scoped) ? scoped : [];
        }
        case SCRIPT_TYPES.PRESET: {
            const apiId = getCurrentPresetAPI();
            const presetName = getCurrentPresetName();
            if (allowedOnly && !resolvePresetAllowed(extension_settings.preset_allowed_regex, apiId, presetName)) {
                return [];
            }
            const presetManager = getPresetManager();
            const presetScripts = presetManager?.readPresetExtensionField({ path: 'regex_scripts' });
            return Array.isArray(presetScripts) ? presetScripts : [];
        }
        default:
            console.warn(`getScriptsByType: Invalid script type ${scriptType}`);
            return [];
    }
}

/**
 * 写回脚本到对应类型存储（逐字复刻原版 saveScriptsByType，engine.js:141-159）。
 * @param {object[]} scripts
 * @param {number} scriptType
 * @returns {Promise<void>}
 */
export async function saveScriptsByType(scripts, scriptType) {
    switch (scriptType) {
        case SCRIPT_TYPES.GLOBAL:
            extension_settings.regex = scripts;
            saveSettingsDebounced();
            break;
        case SCRIPT_TYPES.SCOPED:
            await writeExtensionField(this_chid, 'regex_scripts', scripts);
            break;
        case SCRIPT_TYPES.PRESET: {
            const presetManager = getPresetManager();
            await presetManager.writePresetExtensionField({ path: 'regex_scripts', value: scripts });
            break;
        }
        default:
            console.warn(`saveScriptsByType: Invalid script type ${scriptType}`);
            break;
    }
}

/**
 * 合并全部脚本供引擎使用（allowedOnly=true：白名单过滤后）。
 *
 * 解析优先级（引擎设计.md §7）：三类按「执行顺序来源」判定（默认跟随 SPreset ——
 * window.__regexScriptOrder 存在时三类按该顺序合并（默认 [2,0,1] = preset→global→scoped），
 * 否则回退原版（global→preset→scoped）；设置区可选 'st' 永远原版顺序）。
 *
 * @param {{ allowedOnly?: boolean, mode?: 'st'|'rphub' }} [options]
 * @returns {object[]}
 */
export function getRegexScripts({ allowedOnly = true, mode = 'st' } = {}) {
    const sources = {
        global: getScriptsByType(SCRIPT_TYPES.GLOBAL, { allowedOnly }),
        preset: getScriptsByType(SCRIPT_TYPES.PRESET, { allowedOnly }),
        scoped: getScriptsByType(SCRIPT_TYPES.SCOPED, { allowedOnly }),
    };
    // 方法 2 指纹键控：逐条叠加本地 extras（本地 > 卡/预设自带字段；本地无 → fallback 自带）
    const sourcesOverlaid = {
        global: sources.global.map((s) => overlayScriptExtras(s, 'global')),
        preset: sources.preset.map((s) => overlayScriptExtras(s, 'preset')),
        scoped: sources.scoped.map((s) => overlayScriptExtras(s, 'scoped')),
    };
    return mergeScripts({
        ...sourcesOverlaid,
        mode,
        order: getExternalRegexScriptOrder(),
        orderSource: getOrderSource(),
    });
}

// ---------------------------------------------------------------------------
// 脚本自定义字段本地存储（rp_hub_script_extras，方法 2 指纹键控）
// ---------------------------------------------------------------------------
// scoped（存卡）/ preset（存预设）脚本上的「我们自定义字段」（当前 = rp_preprocess，
// 未来扩展同机制）改存本地 extras，键 = 指纹（类型 + 稳定标识 + 脚本名 + findRegex hash）。
// 本机配置优先；换机器/卡重导后脚本内容未变仍命中同指纹；内容变了 → 新指纹 → 旧 extras
// 残留可清理（编辑器保存时处理）。
//
// 存储位置可配置（rp_hub_extras_storage，settings.getExtrasStorageMode）：
//   - 'local'（默认）：localStorage 键 rp_hub_script_extras（JSON 序列化）。关闭重开不丢，
//     不受 settings.json 刷新/持久化问题影响（用户反馈「关闭重开保存记录不见了」的根因排查：
//     extension_settings 链路本身正常，但 settings.json 可能在退出/覆盖时被旧快照回写丢失
//     新键 —— localStorage 天然免疫该问题，故设为默认）。
//   - 'settings'：extension_settings.rp_hub_script_extras（随 ST settings.json 持久化）。
// 切换模式时自动迁移（migrateScriptExtrasStorage）。

/** 本地 extras 存储键（localStorage 与 extension_settings 共用同名键，模式决定落点）。 */
export const SCRIPT_EXTRAS_KEY = 'rp_hub_script_extras';

/** 读存储模式（settings.js 的 getExtrasStorageMode，'local' 缺省）。 */
function extrasMode() {
    try {
        return getExtrasStorageMode();
    } catch {
        return 'local';
    }
}

/** 读 localStorage 的 extras（JSON 解析失败 → {}）。 */
function readLocalExtras() {
    try {
        const raw = localStorage.getItem(SCRIPT_EXTRAS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** 写 localStorage 的 extras（序列化失败忽略）。 */
function writeLocalExtras(store) {
    try {
        localStorage.setItem(SCRIPT_EXTRAS_KEY, JSON.stringify(store));
    } catch {
        // localStorage 不可用/写满时静默降级（内存态保留，本次会话仍生效）
    }
}

/** 'local' 模式的进程内缓存（避免每次 getScriptExtrasStore 重新解析，且保证变更可落盘）。 */
let localExtrasCache = null;

/**
 * 惰性读取/初始化本地 extras 存储（按模式）。返回 store 对象（可变引用）。
 * 'settings' 模式：extension_settings[SCRIPT_EXTRAS_KEY]（只补缺省值）。
 * 'local' 模式：localStorage JSON 反序列化 + 进程内缓存（变更后需 persistScriptExtrasStore(store) 落盘）。
 */
function getScriptExtrasStore() {
    if (extrasMode() === 'settings') {
        const store = extension_settings[SCRIPT_EXTRAS_KEY];
        if (!store || typeof store !== 'object' || Array.isArray(store)) {
            extension_settings[SCRIPT_EXTRAS_KEY] = {};
        }
        return extension_settings[SCRIPT_EXTRAS_KEY];
    }
    if (!localExtrasCache) {
        localExtrasCache = readLocalExtras();
    }
    return localExtrasCache;
}

/**
 * 持久化 extras 存储（'settings' 模式由 saveSettingsDebounced 负责；'local' 模式把传入
 * store（或缓存）写入 localStorage）。
 * @param {object} [store] 变更后的 store（缺省取缓存）
 */
function persistScriptExtrasStore(store) {
    if (extrasMode() === 'settings') {
        saveSettingsDebounced();
        return;
    }
    writeLocalExtras(store || localExtrasCache || readLocalExtras());
}

/** 重置 local 模式缓存（迁移/清空后强制重读）。 */
function resetLocalExtrasCache() {
    localExtrasCache = null;
}

/**
 * 切换 extras 存储模式：把当前模式的 extras 迁移到新模式（纯增量）。
 * - 读旧模式 store → 合并进新模式 store（新模式已有同 key 以新模式的为准，避免覆盖用户
 *   在新模式下新建的条目；迁移仅补缺失 key）。
 * - 迁移完成后清空旧模式（避免残留双份）。
 * @param {'local'|'settings'} toMode 目标模式（settings.setExtrasStorageMode 已持久化后调用）
 * @returns {number} 迁移的条目数
 */
export function migrateScriptExtrasStorage(toMode) {
    const fromMode = toMode === 'local' ? 'settings' : 'local';
    let fromStore;
    let toStore;
    if (fromMode === 'settings') {
        fromStore = extension_settings[SCRIPT_EXTRAS_KEY];
        toStore = readLocalExtras();
    } else {
        fromStore = localExtrasCache || readLocalExtras();
        // 🔴-1 修复：首次切到 'settings' 时 extension_settings[SCRIPT_EXTRAS_KEY] 可能为 undefined，
        // 原实现直接用它做 `key in toStore` 会抛 TypeError（Cannot use 'in' operator ... in undefined）。
        toStore = extension_settings[SCRIPT_EXTRAS_KEY] ?? {};
    }
    const migrated = {};
    if (fromStore && typeof fromStore === 'object' && !Array.isArray(fromStore)) {
        for (const [key, value] of Object.entries(fromStore)) {
            if (value && typeof value === 'object' && !(key in toStore)) {
                migrated[key] = value;
            }
        }
    }
    const merged = { ...toStore, ...migrated };
    if (toMode === 'local') {
        localExtrasCache = merged;
        writeLocalExtras(merged);
    } else {
        extension_settings[SCRIPT_EXTRAS_KEY] = merged;
        saveSettingsDebounced();
    }
    // 清空旧模式
    if (fromMode === 'settings') {
        delete extension_settings[SCRIPT_EXTRAS_KEY];
        saveSettingsDebounced();
    } else {
        resetLocalExtrasCache();
        try { localStorage.removeItem(SCRIPT_EXTRAS_KEY); } catch { /* 忽略 */ }
    }
    return Object.keys(migrated).length;
}

/**
 * 当前指纹上下文（类型相关稳定标识）：
 *   - scoped：characters[this_chid].avatar（文件名，比 name 稳定）
 *   - preset：getCurrentPresetName()（与 preset 存取同源）
 *   - global：无上下文（指纹不含）
 * @param {'scoped'|'preset'|'global'} kind
 * @returns {{ avatar?: string, presetName?: string }}
 */
export function getScriptFingerprintContext(kind) {
    if (kind === 'scoped') {
        return { avatar: String(characters?.[this_chid]?.avatar ?? '') };
    }
    if (kind === 'preset') {
        return { presetName: String(getCurrentPresetName() ?? '') };
    }
    return {};
}

/**
 * 取脚本的本地 extras（按指纹查存储；无 → null）。
 * @param {object} script 脚本对象（读 scriptName / findRegex）
 * @param {'scoped'|'preset'|'global'} kind
 * @param {object} [context] 指纹上下文（缺省取当前上下文）
 * @returns {object|null}
 */
export function getScriptExtras(script, kind, context) {
    if (!script || typeof script !== 'object') return null;
    const key = buildScriptFingerprint({
        kind,
        ...(context || getScriptFingerprintContext(kind)),
        scriptName: script.scriptName,
        findRegex: script.findRegex,
    });
    if (!key) return null;
    const extras = getScriptExtrasStore()[key];
    return extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : null;
}

/**
 * 叠加本地 extras 到脚本（本地覆盖卡/预设自带字段；本地无 → 原样）。
 * 只在**引擎读取**（getRegexScripts）与**编辑器回填**（fillEditorFromScript）调用；
 * 绝不写回存储（保存链路单独用 saveScriptExtras 处理）。
 * @param {object} script
 * @param {'scoped'|'preset'|'global'} kind
 * @param {object} [context]
 * @returns {object} 叠加后的脚本（无 extras 时原对象引用）
 */
export function overlayScriptExtras(script, kind, context) {
    return applyScriptExtras(script, getScriptExtras(script, kind, context));
}

/**
 * 保存脚本的自定义字段到本地 extras（编辑器保存链路）：
 *   - 脚本含自定义字段（rp_preprocess 等）→ 写入 extras[key]；且从脚本对象**剥离**
 *     （不写卡/预设文件——方法 2 核心；历史卡内自带字段由剥离覆盖清除）
 *   - 脚本不含自定义字段（用户关闭预处理）→ 删除 extras[key]（本地也清掉）
 * @param {object} script 脚本对象（读 scriptName / findRegex；可含 rp_preprocess）
 * @param {'scoped'|'preset'|'global'} kind
 * @param {object} [context]
 * @returns {object} 剥离自定义字段后的脚本（供写卡/预设）
 */
export function saveScriptExtras(script, kind, context) {
    if (!script || typeof script !== 'object') return script;
    const key = buildScriptFingerprint({
        kind,
        ...(context || getScriptFingerprintContext(kind)),
        scriptName: script.scriptName,
        findRegex: script.findRegex,
    });
    const store = getScriptExtrasStore();
    const fields = SCRIPT_EXTRAS_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(script, f));
    const cleaned = { ...script };
    if (key) {
        if (fields.length > 0) {
            const entry = {};
            for (const f of fields) entry[f] = cleaned[f];
            store[key] = entry;
        } else {
            delete store[key];
        }
    }
    for (const f of fields) delete cleaned[f];
    persistScriptExtrasStore(store);
    return cleaned;
}

/**
 * 删除脚本的本地 extras（编辑器删除链路；含移动 source 侧清理）。
 * @param {object} script
 * @param {'scoped'|'preset'|'global'} kind
 * @param {object} [context]
 */
export function clearScriptExtras(script, kind, context) {
    if (!script || typeof script !== 'object') return;
    const key = buildScriptFingerprint({
        kind,
        ...(context || getScriptFingerprintContext(kind)),
        scriptName: script.scriptName,
        findRegex: script.findRegex,
    });
    if (key) {
        const store = getScriptExtrasStore();
        delete store[key];
        persistScriptExtrasStore(store);
    }
}

/**
 * 编辑保存时旧指纹清理：脚本改名/改 findRegex → 指纹变化 → 旧 extras 残留。
 * 用「改动前脚本」的原 scriptName/findRegex 算旧 key 并清除。
 * @param {object} oldScript 改动前脚本
 * @param {'scoped'|'preset'|'global'} kind
 * @param {object} [context]
 */
export function clearScriptExtrasByFingerprint(oldScript, kind, context) {
    clearScriptExtras(oldScript, kind, context);
}

// ---------------------------------------------------------------------------
// allow 白名单 helpers（逐字复刻原版 engine.js:166-259）
// ---------------------------------------------------------------------------

export function isScopedScriptsAllowed(character) {
    return resolveScopedAllowed(extension_settings.character_allowed_regex, character?.avatar);
}

export function allowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar) return;
    if (!Array.isArray(extension_settings.character_allowed_regex)) {
        extension_settings.character_allowed_regex = [];
    }
    if (!extension_settings.character_allowed_regex.includes(avatar)) {
        extension_settings.character_allowed_regex.push(avatar);
        saveSettingsDebounced();
    }
}

export function disallowScopedScripts(character) {
    const avatar = character?.avatar;
    if (!avatar || !Array.isArray(extension_settings.character_allowed_regex)) return;
    const index = extension_settings.character_allowed_regex.indexOf(avatar);
    if (index !== -1) {
        extension_settings.character_allowed_regex.splice(index, 1);
        saveSettingsDebounced();
    }
}

export function isPresetScriptsAllowed(apiId, presetName) {
    return resolvePresetAllowed(extension_settings.preset_allowed_regex, apiId, presetName);
}

export function allowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName) return;
    if (!Array.isArray(extension_settings.preset_allowed_regex?.[apiId])) {
        extension_settings.preset_allowed_regex[apiId] = [];
    }
    if (!extension_settings.preset_allowed_regex[apiId].includes(presetName)) {
        extension_settings.preset_allowed_regex[apiId].push(presetName);
        saveSettingsDebounced();
    }
}

export function disallowPresetScripts(apiId, presetName) {
    if (!apiId || !presetName || !Array.isArray(extension_settings.preset_allowed_regex?.[apiId])) return;
    const index = extension_settings.preset_allowed_regex[apiId].indexOf(presetName);
    if (index !== -1) {
        extension_settings.preset_allowed_regex[apiId].splice(index, 1);
        saveSettingsDebounced();
    }
}

export function getCurrentPresetAPI() {
    return getPresetManager()?.apiId ?? null;
}

export function getCurrentPresetName() {
    return getPresetManager()?.getSelectedPresetName() ?? null;
}
