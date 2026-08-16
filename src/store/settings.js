/**
 * store/settings.js —— 插件自有设置（extension_settings 顶层键，与 rp_hub_* 风格一致）。
 *
 * 现有键（scripts.js）：rp_hub_script_extras（脚本自定义字段本地存储）—— 扁平键。
 * 本模块沿用同一风格：
 *   - rp_hub_compat_cleanPrompt: boolean —— 是否对提示词（prompt）施加引擎剥离（C2 管道）。
 *       默认 true = 剥离：GENERATE_AFTER_DATA 对整段 prompt 施加 isPrompt 引擎处理
 *       （删 fox_selc / 剥 think 等预设隐藏行为按酒馆标准生效）；
 *       false = 不剥离：prompt 原样（AI 可见选项标签等原文，用户选择权）。
 *       msg.mes 恒存原始文本（C2），与本开关无关。
 *   - rp_hub_order_source: 'spreset' | 'st' —— 三类（预设/全局/角色）执行顺序来源。
 *       默认 'spreset'：检测到 window.__regexScriptOrder 则跟随（SPreset），否则回退原版；
 *       'st'：永远原版顺序（Global→Preset→Scoped）。
 *   - rp_hub_protect_enabled: boolean —— 保护替换总开关（引擎设计.md §5「保护可配置化」）。
 *       默认 true = 启用保护（rphub 模式把受保护内容留原样，只替换普通文本）；
 *       false = 关闭保护（rphub 模式也直接对全文替换，正则可改动 HTML/代码块等）。
 *       仍受 rphub.js 原有「正则含 < > ``` 时跳过保护」约束。
 *   - rp_hub_protect_items: string[] | 不存在 —— 保护项勾选（PROTECT_ITEM_KEYS 子集：
 *       html_doc / script / style / cot_think / code_block / inline_code / html_tag）。
 *       缺省 = 全部（默认全开，与保护未配置时逐字一致）；空数组 = 无任何保护项。
 *       未知项读取时剔除。
 *   - rp_hub_degrade_target: 'st' | 'rphub' | 'none' —— 后端判定失败（卡未导入 /
 *       后端不可达 / 无 contentHash）时的降级目标（rp-mode.fetchCardInfo）。
 *       默认 'st' = 降级为 st（现状）；'rphub' = 仍按 RP 语义（明确知道是 RP 卡但
 *       后端暂不可达时用）；'none' = 禁止降级（判定失败时 formatDetail 返回 null，
 *       调用方按「无法判定」处理，引擎侧按 st 行为）。
 *   - rp_hub_budget_ms: number（1-5000）—— 每条正则执行预算（毫秒，超时预算可配置化，
 *       引擎设计.md §6）。默认 50 = 与原版内置预算一致；设小值让慢正则更早超时跳过，
 *       设大值给重型正则更多时间。非法（非正整数 / 超范围 1-5000）回退默认 50。
 *   - rp_hub_precheck_enabled: boolean —— ReDoS 静态预检总开关（budget.js 防线 1）。
 *       默认 true = 启用（嵌套量词形态正则执行前被拦截，根本不会执行，防灾难性回溯）；
 *       false = 关闭预检（跳过该防线 —— 被误伤的正则得以放行，但承担病理正则卡死风险）。
 *   - rp_hub_precheck_bypass: string[] —— 绕过预检的脚本键列表（脚本键 = script.id ||
 *       scriptName）。被预检误伤的正则把对应键加入本表后放行（绝区零「状态栏」类正则）。
 *       非数组 → []；去空串去重。
 *   - rp_hub_panel_escape: boolean —— 正则面板逃逸模式（cocktail 兼容，cocktail-main-分析.md
 *       冲突清单 #1）。默认 true：面板挂到 #regex_container 的父容器（#extensions_settings2）
 *       而非其内部 —— 脱离 cocktail regex-refresh-optimizer 的捕获阶段拦截域
 *       （getRegexContainer().contains(t) 判据失效），我们面板全部交互恢复正常
 *       （cocktail 不认识的控件不 stopEvent）；false：旧行为，挂回 #regex_container 内部
 *       （与 ST regex 扩展 / cocktail 共存的 DOM 标识重叠问题由用户自行取舍）。
 *   - rp_hub_extras_storage: 'local' | 'settings' —— 脚本自定义字段本地存储位置。
 *       默认 'local' = localStorage（关闭重开不丢，不受 settings.json 刷新影响）；
 *       'settings' = extension_settings（随 ST settings.json 持久化）。
 *       切换时把已有 extras 迁移到新模式（scripts.js migrateScriptExtrasStorage）。
 *   - rp_hub_auto_protect_script: boolean —— 引擎级自动脚本区保护总开关
 *       （两条线路隔离，默认 true = 启用）。显示美化正则（rphub 显示通道 / st markdownOnly）
 *       未配 rp_preprocess 时，引擎自动对 <script>...</script> 做占位符掩蔽 —— 正文保持
 *       完整连续（^ 锚定不失效），脚本区对本条正则隐形（不被污染，狐策点不动根源修复）。
 *       false = 关闭（回归现状：正则全消息跑，可能污染脚本，由用户自行负责）。
 *       与手动配的 rp_preprocess 不冲突：手动配置优先，未配置时引擎自动保护。
 *       ⚠️ 仅 legacy 渲染模式生效（two_pass_121 模式下由 1→2→1 管线的界面段藏走替代，
 *       不单独作用）。
 *   - rp_hub_render_mode: 'two_pass_121' | 'legacy' —— 渲染模式。
 *       默认 'two_pass_121'（1→2→1 两阶段管线，用户最终方案）：预设第一遍生成界面 +
 *       纯文本清理 → 界面段（完整 HTML 文档 / ```html 围栏）占位符藏走 → 卡内嵌（scoped）
 *       + 全局（global）在剩余纯正文上跑美化（^ 锚定不失效、界面段不可见）→ 预设第二遍
 *       （勾 rp_skip_second_pass 的跳过）→ 界面段按原位置拼回。界面与美化正文并存，各管各的。
 *       'legacy' = 现状：顺序混跑 + 自动隔离脚本区（rp_hub_auto_protect_script 生效）。
 *       非法值归一回退 'two_pass_121'。
 *   - rp_hub_second_pass_enabled: boolean —— 阶段③（预设第二遍）总开关。
 *       默认 false = 关闭（用户反馈「前端卡卡的」→ 默认只跑一次阶段①，减小前端压力）；
 *       true = 开启（预设正则第二遍再跑一遍，受 rp_hub_second_pass_filter / rp_skip_second_pass
 *       约束）。与 rp_hub_second_pass_filter（决定哪些进第二遍）独立叠加：总开关关 = 整个第二遍跳过。
 *
 * 归一/判定逻辑在 scripts-core.js（纯函数，可 node 测试）与 engine/protect.js
 * （PROTECT_ITEMS / buildProtectedSource 纯函数）；本模块只做 ST 存取包装。
 * 仅浏览器加载（依赖 st-bridge）；node 单测测试 scripts-core 的纯函数。
 */

import { extension_settings, saveSettingsDebounced } from '../st-bridge.js';
import { normalizeOrderSource, normalizeExtrasStorageMode } from './scripts-core.js';
import { PROTECT_ITEM_KEYS, DEFAULT_PROTECT_ITEMS } from '../engine/protect.js';
import { DEFAULT_CLEAN_RULES as DEFAULT_CLEAN_RULES_IMPORT } from '../engine/engine.js';

/** 存储键（extension_settings 顶层）。 */
export const CLEAN_PROMPT_KEY = 'rp_hub_compat_cleanPrompt';
export const ORDER_SOURCE_KEY = 'rp_hub_order_source';
export const PROTECT_ENABLED_KEY = 'rp_hub_protect_enabled';
export const PROTECT_ITEMS_KEY = 'rp_hub_protect_items';
export const DEGRADE_TARGET_KEY = 'rp_hub_degrade_target';
export const BUDGET_MS_KEY = 'rp_hub_budget_ms';
export const PRECHECK_ENABLED_KEY = 'rp_hub_precheck_enabled';
export const PRECHECK_BYPASS_KEY = 'rp_hub_precheck_bypass';
export const PANEL_ESCAPE_KEY = 'rp_hub_panel_escape';
export const EXTRAS_STORAGE_KEY = 'rp_hub_extras_storage';
export const AUTO_PROTECT_SCRIPT_KEY = 'rp_hub_auto_protect_script';
export const RENDER_MODE_KEY = 'rp_hub_render_mode';
export const EXCLUDE_FIRST_MESSAGE_KEY = 'rp_hub_exclude_first_message';
export const EXCLUDE_FIRST_FULLTEXT_KEY = 'rp_hub_exclude_first_fulltext_only';

/** 超时预算缺省值（毫秒）与允许范围（引擎设计.md §6「每条正则预算默认 50ms」）。 */
export const DEFAULT_BUDGET_MS = 50;
export const MIN_BUDGET_MS = 1;
export const MAX_BUDGET_MS = 5000;

/** 降级目标取值（rp-mode.fetchCardInfo 判定失败时按此降级）。 */
export const DEGRADE_TARGET_ST = 'st';
export const DEGRADE_TARGET_RPHUB = 'rphub';
export const DEGRADE_TARGET_NONE = 'none';
export const DEGRADE_TARGETS = [DEGRADE_TARGET_ST, DEGRADE_TARGET_RPHUB, DEGRADE_TARGET_NONE];

/**
 * 降级目标归一（纯函数，可 node 测试）：非法值回退缺省 'st'。
 * @param {*} value 存储值
 * @returns {'st'|'rphub'|'none'}
 */
export function normalizeDegradeTarget(value) {
    return DEGRADE_TARGETS.includes(value) ? value : DEGRADE_TARGET_ST;
}

/**
 * 保护项勾选归一（纯函数，可 node 测试）：非数组 → 全部；未知项剔除；空数组保留
 * （空勾选 = 无任何保护，与总开关关闭功能等价但语义独立）。
 * @param {*} items 存储值
 * @returns {string[]} 规范顺序数组
 */
export function normalizeProtectItems(items) {
    if (!Array.isArray(items)) return [...DEFAULT_PROTECT_ITEMS];
    const set = new Set(items.filter((k) => PROTECT_ITEM_KEYS.includes(k)));
    return PROTECT_ITEM_KEYS.filter((k) => set.has(k));
}

/** 读取 cleanPrompt 开关（缺省 true = 对 prompt 施加引擎剥离；false = prompt 原样）。 */
export function isCleanPromptEnabled() {
    const v = extension_settings?.[CLEAN_PROMPT_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置 cleanPrompt 开关并持久化。 */
export function setCleanPromptEnabled(enabled) {
    extension_settings[CLEAN_PROMPT_KEY] = !!enabled;
    saveSettingsDebounced();
}

/** 读取执行顺序来源（'spreset' 缺省 | 'st'）。 */
export function getOrderSource() {
    return normalizeOrderSource(extension_settings?.[ORDER_SOURCE_KEY]);
}

/** 设置执行顺序来源并持久化（非法值归一为缺省 'spreset'）。 */
export function setOrderSource(source) {
    extension_settings[ORDER_SOURCE_KEY] = normalizeOrderSource(source);
    saveSettingsDebounced();
}

/**
 * 读取脚本自定义字段存储位置（'local' 缺省 = localStorage | 'settings' = extension_settings）。
 * 缺省 'local'：关闭重开不丢，不受 settings.json 刷新/持久化问题影响。
 * @returns {'local'|'settings'}
 */
export function getExtrasStorageMode() {
    return normalizeExtrasStorageMode(extension_settings?.[EXTRAS_STORAGE_KEY]);
}

/** 设置存储位置并持久化（非法值归一为缺省 'local'）。 */
export function setExtrasStorageMode(mode) {
    extension_settings[EXTRAS_STORAGE_KEY] = normalizeExtrasStorageMode(mode);
    saveSettingsDebounced();
}

/** 存储位置归一（纯函数，转发 scripts-core；node 测试用）。 */
export { normalizeExtrasStorageMode } from './scripts-core.js';

/**
 * 读取引擎级自动脚本区保护总开关（缺省 true = 启用；两条线路隔离）。
 * @returns {boolean}
 */
export function isAutoProtectScriptEnabled() {
    const v = extension_settings?.[AUTO_PROTECT_SCRIPT_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置引擎级自动脚本区保护总开关并持久化。 */
export function setAutoProtectScriptEnabled(enabled) {
    extension_settings[AUTO_PROTECT_SCRIPT_KEY] = !!enabled;
    saveSettingsDebounced();
}

/**
 * 读取「排除第0楼」总开关（缺省 true = 启用）。
 * 启用后，第 0 楼（开场白 = 首条非系统消息）的 scoped 正则按「精细/暴力」两档处理
 * （见 isExcludeFirstFulltextOnly）：默认精细 = 只跳过带全文负前瞻的正则（沉浸式容器类），
 * 隐藏状态 / 状态面板生成等普通 scoped 照常执行（不误伤与妹生活）。
 * 预设/全局正则不受影响。
 * @returns {boolean}
 */
export function isExcludeFirstMessageEnabled() {
    const v = extension_settings?.[EXCLUDE_FIRST_MESSAGE_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置「排除第0楼」总开关并持久化。 */
export function setExcludeFirstMessageEnabled(enabled) {
    extension_settings[EXCLUDE_FIRST_MESSAGE_KEY] = !!enabled;
    saveSettingsDebounced();
}

/**
 * 读取「排除第0楼」精细/暴力档位（缺省 true = 精细）。
 * 精细（true）= 只跳过「带全文负前瞻 (?![\s\S]*」的 scoped 正则（沉浸式容器类，会被尾部
 * 预置 UI 面板误伤），保留普通 scoped（隐藏状态 / 状态面板生成）。
 * 暴力（false）= 跳过全部 scoped 正则（与妹生活等卡的状态面板会被误伤，仅特殊场景用）。
 * 仅在「排除第0楼」总开关开启时生效。
 * @returns {boolean}
 */
export function isExcludeFirstFulltextOnly() {
    const v = extension_settings?.[EXCLUDE_FIRST_FULLTEXT_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置「排除第0楼」精细/暴力档位并持久化。 */
export function setExcludeFirstFulltextOnly(fulltextOnly) {
    extension_settings[EXCLUDE_FIRST_FULLTEXT_KEY] = !!fulltextOnly;
    saveSettingsDebounced();
}

/** 渲染模式取值：'two_pass_121'（默认，1→2→1 两阶段管线）| 'legacy'（现状顺序混跑）。 */
export const RENDER_MODE_TWO_PASS = 'two_pass_121';
export const RENDER_MODE_LEGACY = 'legacy';
export const RENDER_MODES = [RENDER_MODE_TWO_PASS, RENDER_MODE_LEGACY];

/**
 * 渲染模式归一（纯函数，可 node 测试）：非法/缺省回退默认 'two_pass_121'。
 * @param {*} value rp_hub_render_mode 存储值
 * @returns {'two_pass_121'|'legacy'}
 */
export function normalizeRenderMode(value) {
    return RENDER_MODES.includes(value) ? value : RENDER_MODE_TWO_PASS;
}

/**
 * 读取渲染模式（默认 'two_pass_121' = 1→2→1 两阶段管线；'legacy' = 现状顺序混跑
 * + 自动隔离脚本区）。
 * @returns {'two_pass_121'|'legacy'}
 */
export function getRenderMode() {
    return normalizeRenderMode(extension_settings?.[RENDER_MODE_KEY]);
}

/** 设置渲染模式并持久化（非法值归一为默认 'two_pass_121'）。 */
export function setRenderMode(mode) {
    extension_settings[RENDER_MODE_KEY] = normalizeRenderMode(mode);
    saveSettingsDebounced();
}

/* ---------- 渲染遍次过滤规则（rp_hub_pass_rules，1→2→1 管线的接管分桶） ---------- */

/** 遍次过滤规则存储键：`{ first: [rule...], second: [rule...] }`。 */
export const PASS_RULES_KEY = 'rp_hub_pass_rules';

/** 规则字段取值：source = 脚本来源（preset/scoped/global）；name = 脚本名子串（大小写不敏感）。 */
export const PASS_RULE_FIELD_SOURCE = 'source';
export const PASS_RULE_FIELD_NAME = 'name';
export const PASS_RULE_MODE_INCLUDE = 'include';
export const PASS_RULE_MODE_EXCLUDE = 'exclude';

/**
 * 内置默认遍次规则（写进 UI 作为默认值，可见/可删/可改）：
 *   第一遍 / 第二遍都默认只进「来源 = preset」的脚本 —— 等价现状硬编码分桶
 *   （预设进 ①/③，阶段② = 剩余 scoped+global 美化桶）。
 */
export const DEFAULT_PASS_RULES = Object.freeze({
    first: Object.freeze([{ field: PASS_RULE_FIELD_SOURCE, match: 'preset', mode: PASS_RULE_MODE_INCLUDE }]),
    second: Object.freeze([{ field: PASS_RULE_FIELD_SOURCE, match: 'preset', mode: PASS_RULE_MODE_INCLUDE }]),
});

/**
 * 单条规则归一（纯函数，可 node 测试）：field 非 source/name → null；match 空 → null；
 * mode 非 exclude → include（安全默认）。
 * @param {*} rule 原始规则
 * @returns {{ field: 'source'|'name', match: string, mode: 'include'|'exclude' }|null}
 */
export function normalizePassRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const field = rule.field === PASS_RULE_FIELD_NAME
        ? PASS_RULE_FIELD_NAME
        : (rule.field === PASS_RULE_FIELD_SOURCE ? PASS_RULE_FIELD_SOURCE : null);
    const match = String(rule.match ?? '').trim();
    if (!field || !match) return null;
    return {
        field,
        match,
        mode: rule.mode === PASS_RULE_MODE_EXCLUDE ? PASS_RULE_MODE_EXCLUDE : PASS_RULE_MODE_INCLUDE,
    };
}

/**
 * 遍次过滤规则归一（纯函数，可 node 测试）：
 *   - 缺失 / 非对象 / 数组 → 内置默认（fresh install 显示默认 preset 规则）；
 *   - first/second 数组逐条归一（非法规则剔除）；归一后为空的列表**保持空**
 *     （规则为空 = 该遍回退现状默认分桶，由引擎 shouldEnterPass 的 defaultSource 处理）。
 * @param {*} value rp_hub_pass_rules 存储值
 * @returns {{ first: object[], second: object[] }}
 */
export function normalizePassRules(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { first: [...DEFAULT_PASS_RULES.first], second: [...DEFAULT_PASS_RULES.second] };
    }
    const norm = (list) => (Array.isArray(list) ? list.map(normalizePassRule).filter(Boolean) : []);
    return { first: norm(value.first), second: norm(value.second) };
}

/**
 * 读取遍次过滤规则（缺省/非法 → 内置默认；空列表保持空 → 引擎回退默认分桶）。
 * @returns {{ first: object[], second: object[] }}
 */
export function getPassRules() {
    return normalizePassRules(extension_settings?.[PASS_RULES_KEY]);
}

/** 设置遍次过滤规则并持久化（非法值归一）。 */
export function setPassRules(rules) {
    extension_settings[PASS_RULES_KEY] = normalizePassRules(rules);
    saveSettingsDebounced();
}

/** 重置为内置默认规则（「恢复默认」按钮用）。 */
export function resetPassRules() {
    extension_settings[PASS_RULES_KEY] = { first: [...DEFAULT_PASS_RULES.first], second: [...DEFAULT_PASS_RULES.second] };
    saveSettingsDebounced();
}

/* ---------- 清洗规则（rp_hub_clean_rules，1→2→1 阶段② 藏走代码块的正则列表） ---------- */

/**
 * 清洗规则存储键：`Array<{ pattern: string, replaceEnabled?: boolean, replace?: string|null }>`
 * 每条 = 一个正则表达式（匹配到的代码块被藏走）+ 该规则的替换配置：
 *   - replaceEnabled=false（默认）→ 拼回时恢复原位；
 *   - replaceEnabled=true → 拼回时该规则匹配的段替换为 replace（空 = 删除段，不恢复原段）。
 * 兼容遗留 string[]（历史数据）→ 视为无替换配置。
 */
export const CLEAN_RULES_KEY = 'rp_hub_clean_rules';

/**
 * 内置默认清洗规则（文档 + 围栏 + script + 裸围栏 + content 标签，定义在 engine.js ——
 * 引擎与存储单一来源）：
 *   - ```html 围栏代码块（狐策/表裏/NC-MAP 产物的围栏形态）
 *   - 完整 HTML 文档（<html>...</html> / <!DOCTYPE ...>...</html> 裸文档形态）
 *   - <script>...</script> 块
 *   - 裸 ``` 围栏 + <content>/</content> 正文包装标签
 * 阶段② 按此把界面段藏走，卡内嵌美化正则看不到它们（正文连续、^ 锚定不失效）。
 */
export const DEFAULT_CLEAN_RULES = Object.freeze(DEFAULT_CLEAN_RULES_IMPORT.map((r) => ({ ...r })));

/**
 * 单条清洗规则归一（纯函数，可 node 测试）：
 *   - 字符串（遗留 string[]）→ { pattern, replaceEnabled:false, replace:null }；
 *   - 对象 → pattern 非空且编译通过才保留；replaceEnabled 仅 true 生效；
 *     replace 仅 string 保留（空串合法 = 删除段）。
 * @param {*} rule 原始规则
 * @returns {{ pattern: string, replaceEnabled: boolean, replace: string|null }|null}
 */
export function normalizeCleanRule(rule) {
    if (typeof rule === 'string') {
        const p = rule.trim();
        if (!p) return null;
        try { new RegExp(p); } catch { return null; }
        return { pattern: p, replaceEnabled: false, replace: null };
    }
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const p = String(rule.pattern ?? '').trim();
    if (!p) return null;
    try { new RegExp(p); } catch { return null; } // 编译失败剔除
    return {
        pattern: p,
        replaceEnabled: rule.replaceEnabled === true,
        replace: typeof rule.replace === 'string' ? rule.replace : null,
    };
}

/**
 * 清洗规则归一（纯函数，可 node 测试）：非数组 → 内置默认；逐条归一（非法剔除）。
 * 归一后为空数组 → 引擎「不藏任何」（清洗跳过）。
 * @param {*} value rp_hub_clean_rules 存储值
 * @returns {Array<{ pattern: string, replaceEnabled: boolean, replace: string|null }>}
 */
export function normalizeCleanRules(value) {
    if (!Array.isArray(value)) return [...DEFAULT_CLEAN_RULES];
    return value.map(normalizeCleanRule).filter(Boolean);
}

/**
 * 读取清洗规则（缺省/非法 → 内置默认；空数组 = 引擎不藏任何）。
 * @returns {Array<{ pattern: string, replaceEnabled: boolean, replace: string|null }>}
 */
export function getCleanRules() {
    return normalizeCleanRules(extension_settings?.[CLEAN_RULES_KEY]);
}

/** 设置清洗规则并持久化（非法值归一）。 */
export function setCleanRules(rules) {
    extension_settings[CLEAN_RULES_KEY] = normalizeCleanRules(rules);
    saveSettingsDebounced();
}

/** 重置为内置默认清洗规则（「恢复默认」按钮用）。 */
export function resetCleanRules() {
    extension_settings[CLEAN_RULES_KEY] = DEFAULT_CLEAN_RULES.map((r) => ({ ...r }));
    saveSettingsDebounced();
}

/* ---------- 第二次预设过滤（rp_hub_second_pass_filter，1→2→1 阶段③ 用哪些预设正则） ---------- */

/** 第二次预设过滤存储键。 */
export const SECOND_PASS_FILTER_KEY = 'rp_hub_second_pass_filter';

/** 模式取值：'all'（全部预设第二遍跑一遍，现状默认）| 'custom'（按下方维度过滤）。 */
export const SECOND_PASS_FILTER_MODE_ALL = 'all';
export const SECOND_PASS_FILTER_MODE_CUSTOM = 'custom';
export const SECOND_PASS_FILTER_MODE_INCLUDE = 'include';
export const SECOND_PASS_FILTER_MODE_EXCLUDE = 'exclude';

/**
 * 默认第二次预设过滤：mode='all'（全部预设第二遍跑一遍，现状不变）。
 * 结构（custom 模式的维度，维度之间 OR —— 任一命中即算匹配，见引擎 shouldRunSecondPass）：
 *   - positions：按排序位置（索引 0 开始，第 0 个 = 第一个）。语法：
 *       1 = 第2个；1,3 = 第2和4；1~ = 第2到末尾；1~4 = 第2到第5（~ 范围、, 逗号分隔）
 *   - nameSimple：名称简单模式（子串包含，大小写不敏感）
 *   - nameRegex：名称高级模式（自定义正则）
 *   - mode2：include = 匹配到的进第二遍；exclude = 匹配到的不进
 */
export const DEFAULT_SECOND_PASS_FILTER = Object.freeze({
    mode: SECOND_PASS_FILTER_MODE_ALL,
    positions: '',
    nameSimple: '',
    nameRegex: '',
    mode2: SECOND_PASS_FILTER_MODE_INCLUDE,
});

/**
 * 第二次预设过滤归一（纯函数，可 node 测试）：非法/缺失 → 默认 all。
 * 所有维度字段 trim；mode 非 custom → all；mode2 非 exclude → include。
 * ⚠️ custom 模式但三维度全空：引擎视为无过滤（全部第二遍跑，等价 all，避免误伤）。
 * @param {*} value rp_hub_second_pass_filter 存储值
 * @returns {{ mode: 'all'|'custom', positions: string, nameSimple: string, nameRegex: string, mode2: 'include'|'exclude' }}
 */
export function normalizeSecondPassFilter(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_SECOND_PASS_FILTER };
    return {
        mode: value.mode === SECOND_PASS_FILTER_MODE_CUSTOM ? SECOND_PASS_FILTER_MODE_CUSTOM : SECOND_PASS_FILTER_MODE_ALL,
        positions: String(value.positions ?? '').trim(),
        nameSimple: String(value.nameSimple ?? '').trim(),
        nameRegex: String(value.nameRegex ?? '').trim(),
        mode2: value.mode2 === SECOND_PASS_FILTER_MODE_EXCLUDE ? SECOND_PASS_FILTER_MODE_EXCLUDE : SECOND_PASS_FILTER_MODE_INCLUDE,
    };
}

/**
 * 读取第二次预设过滤（缺省/非法 → 默认 all）。
 * @returns {{ mode: 'all'|'custom', positions: string, nameSimple: string, nameRegex: string, mode2: 'include'|'exclude' }}
 */
export function getSecondPassFilter() {
    return normalizeSecondPassFilter(extension_settings?.[SECOND_PASS_FILTER_KEY]);
}

/** 设置第二次预设过滤并持久化（非法值归一）。 */
export function setSecondPassFilter(filter) {
    extension_settings[SECOND_PASS_FILTER_KEY] = normalizeSecondPassFilter(filter);
    saveSettingsDebounced();
}

/** 重置为默认（mode='all'，全部预设第二遍跑一遍）。 */
export function resetSecondPassFilter() {
    extension_settings[SECOND_PASS_FILTER_KEY] = { ...DEFAULT_SECOND_PASS_FILTER };
    saveSettingsDebounced();
}

/* ---------- 阶段③（预设第二遍）总开关（rp_hub_second_pass_enabled，默认关闭） ---------- */

/** 阶段③（预设第二遍）总开关存储键。 */
export const SECOND_PASS_ENABLED_KEY = 'rp_hub_second_pass_enabled';

/**
 * 阶段③ 总开关归一（纯函数，可 node 测试）：仅 ===true 视为开启；缺省/非法 → false（默认关闭）。
 * 用户反馈「前端卡卡的」→ 默认关闭 = 预设只跑一次（阶段①），减小前端压力。
 * @param {*} value rp_hub_second_pass_enabled 存储值
 * @returns {boolean}
 */
export function normalizeSecondPassEnabled(value) {
    return value === true;
}

/**
 * 读取阶段③ 总开关（默认 false = 关闭；开启后第二遍按 rp_hub_second_pass_filter /
 * rp_skip_second_pass 约束跑）。
 * @returns {boolean}
 */
export function isSecondPassEnabled() {
    return normalizeSecondPassEnabled(extension_settings?.[SECOND_PASS_ENABLED_KEY]);
}

/** 设置阶段③ 总开关并持久化。 */
export function setSecondPassEnabled(enabled) {
    extension_settings[SECOND_PASS_ENABLED_KEY] = !!enabled;
    saveSettingsDebounced();
}

/* ---------- 空白段守卫（rp_hub_skip_blank_segments，默认开启） ---------- */

/**
 * 空白段守卫存储键。
 * 阶段②/③ 执行脚本时，纯空白段（整段无可见字符）是否跳过不执行。
 * 默认开启 = 引擎兜底：藏走界面段后残留的孤立 \n 纯段不交给脚本，
 * 防「整段匹配型」美化正则（如 ^([\s\S]+)$ 无 \S 守卫）把它们包成空卡片（与妹生活 / 刚满十八空卡同源）。
 * 显式 false 关闭 = 空白段照常交给脚本（需要空白段被处理的脚本场景用）。
 */
export const SKIP_BLANK_SEGMENTS_KEY = 'rp_hub_skip_blank_segments';

/**
 * 空白段守卫归一（纯函数，可 node 测试）：缺省 true（默认开启）；显式 ===false 关闭；
 * 其余非法值（0/'true'/1 等）→ false（关闭，行为同旧版）。
 * @param {*} value rp_hub_skip_blank_segments 存储值
 * @returns {boolean}
 */
export function normalizeSkipBlankSegments(value) {
    if (value === undefined || value === null) return true; // 缺省 true（默认开启）
    return value === true;
}

/**
 * 读取空白段守卫（默认 true = 开启：藏走界面段后残留的孤立 \n 纯段不交给脚本，
 * 防「整段匹配型」美化正则（如 ^([\s\S]+)$ 无 \S 守卫）把它们包成空卡片 ——
 * 与妹生活 / 刚满十八 空卡同源）。
 * @returns {boolean}
 */
export function isSkipBlankSegments() {
    return normalizeSkipBlankSegments(extension_settings?.[SKIP_BLANK_SEGMENTS_KEY]);
}

/** 设置空白段守卫并持久化。 */
export function setSkipBlankSegments(enabled) {
    extension_settings[SKIP_BLANK_SEGMENTS_KEY] = !!enabled;
    saveSettingsDebounced();
}

/**
 * 读取保护替换总开关（缺省 true = 启用）。
 * @returns {boolean}
 */
export function isProtectEnabled() {
    const v = extension_settings?.[PROTECT_ENABLED_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置保护替换总开关并持久化。 */
export function setProtectEnabled(enabled) {
    extension_settings[PROTECT_ENABLED_KEY] = !!enabled;
    saveSettingsDebounced();
}

/**
 * 读取保护项勾选（缺省全部 = 默认全开；空数组 = 无任何保护项；未知项剔除）。
 * @returns {string[]} PROTECT_ITEM_KEYS 的规范顺序子集
 */
export function getProtectItems() {
    return normalizeProtectItems(extension_settings?.[PROTECT_ITEMS_KEY]);
}

/** 设置保护项勾选并持久化（非法值归一；空数组 = 无任何保护项）。 */
export function setProtectItems(items) {
    extension_settings[PROTECT_ITEMS_KEY] = normalizeProtectItems(items);
    saveSettingsDebounced();
}

/**
 * 读取降级目标（'st' 缺省 | 'rphub' | 'none'；非法值回退 'st'）。
 * 供 rp-mode.fetchCardInfo 判定失败时按配置目标降级（见 rp-mode.js）。
 * @returns {'st'|'rphub'|'none'}
 */
export function getDegradeTarget() {
    return normalizeDegradeTarget(extension_settings?.[DEGRADE_TARGET_KEY]);
}

/** 设置降级目标并持久化（非法值归一为缺省 'st'）。 */
export function setDegradeTarget(target) {
    extension_settings[DEGRADE_TARGET_KEY] = normalizeDegradeTarget(target);
    saveSettingsDebounced();
}

/**
 * 超时预算归一（纯函数，可 node 测试）：非正整数 / 超范围（1-5000）回退缺省 50。
 * @param {*} value 存储值
 * @returns {number} 1-5000 的整数毫秒数
 */
export function normalizeBudgetMs(value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < MIN_BUDGET_MS || n > MAX_BUDGET_MS) {
        return DEFAULT_BUDGET_MS;
    }
    return n;
}

/**
 * 读取超时预算（缺省 50ms；非法/超范围值回退缺省）。
 * 供 runtime.engineRun 每次运行注入 engine.run 的 budgetMs。
 * @returns {number} 1-5000 的整数毫秒数
 */
export function getBudgetMs() {
    return normalizeBudgetMs(extension_settings?.[BUDGET_MS_KEY]);
}

/** 设置超时预算并持久化（非法值归一为缺省 50）。 */
export function setBudgetMs(ms) {
    extension_settings[BUDGET_MS_KEY] = normalizeBudgetMs(ms);
    saveSettingsDebounced();
}

/**
 * ReDoS 预检绕过键归一（纯函数，可 node 测试）：非数组 → []；去空串去重。
 * 预检绕过键 = 脚本键（script.id || scriptName）—— 与 diagnose-core.scriptKeyOf 一致。
 * @param {*} keys 存储值
 * @returns {string[]} 去空串去重后的键数组
 */
export function normalizePrecheckBypass(keys) {
    if (!Array.isArray(keys)) return [];
    return [...new Set(keys.map((k) => String(k ?? '').trim()).filter(Boolean))];
}

/**
 * 读取 ReDoS 预检总开关（缺省 true = 启用静态预检）。
 * @returns {boolean}
 */
export function isPrecheckEnabled() {
    const v = extension_settings?.[PRECHECK_ENABLED_KEY];
    return v === undefined || v === null ? true : !!v;
}

/** 设置 ReDoS 预检总开关并持久化。 */
export function setPrecheckEnabled(enabled) {
    extension_settings[PRECHECK_ENABLED_KEY] = !!enabled;
    saveSettingsDebounced();
}

/**
 * 读取 ReDoS 预检绕过键表（缺省 [] = 无绕过）。
 * @returns {string[]}
 */
export function getPrecheckBypass() {
    return normalizePrecheckBypass(extension_settings?.[PRECHECK_BYPASS_KEY]);
}

/** 设置 ReDoS 预检绕过键表并持久化（非法值归一为 []）。 */
export function setPrecheckBypass(keys) {
    extension_settings[PRECHECK_BYPASS_KEY] = normalizePrecheckBypass(keys);
    saveSettingsDebounced();
}

/**
 * 读取正则面板逃逸模式（cocktail 兼容，缺省 true = 逃逸）。
 * true：面板挂 #regex_container 父容器（脱离 cocktail 拦截域）；false：挂回容器内部（旧行为）。
 * @returns {boolean}
 */
export function isPanelEscapeEnabled() {
    return extension_settings?.[PANEL_ESCAPE_KEY] !== false;
}

/** 设置面板逃逸模式并持久化。 */
export function setPanelEscapeEnabled(enabled) {
    extension_settings[PANEL_ESCAPE_KEY] = !!enabled;
    saveSettingsDebounced();
}

/* ---------- 流式实时渲染（rp_hub_stream_render_enabled / rp_hub_stream_match / rp_hub_stream_excludes） ---------- */

/**
 * 流式实时渲染总开关存储键。默认 false = 模式一「完整渲染」（现状零影响）。
 * 与 rp_hub_render_mode（整条消息渲染管线）语义正交，不扩展其枚举（见可行性报告 §4.1）：
 *   - rp_hub_render_mode：引擎如何分桶/清洗/拼回（two_pass_121 / legacy）；
 *   - rp_hub_stream_render_enabled：流式期间是否做段级接管（true 时按 rp_hub_stream_match
 *     检测段边界，段内容交引擎段级渲染，闭合后交回酒馆原生通道）。
 */
export const STREAM_RENDER_ENABLED_KEY = 'rp_hub_stream_render_enabled';

/** 流式匹配配置存储键：{ mode: 'basic'|'advanced', rules: [{start,end}], rx: [{pattern}] }。 */
export const STREAM_MATCH_KEY = 'rp_hub_stream_match';

/** 流式排除规则（预处理）存储键：Array<{ pattern, action: 'hide'|'delete'|'replace', replace? }>。 */
export const STREAM_EXCLUDES_KEY = 'rp_hub_stream_excludes';

/**
 * 流式渲染总开关归一（纯函数，node 可测）：仅 ===true 视为开启；缺省/非法 → false。
 * 默认 false = 完整渲染（模式一），流式期间零干预。
 * @param {*} value 存储值
 * @returns {boolean}
 */
export function normalizeStreamRenderEnabled(value) {
    return value === true;
}

/**
 * 读取流式实时渲染总开关（默认 false = 完整渲染；true = 流式期间按匹配配置段级渲染）。
 * @returns {boolean}
 */
export function isStreamRenderEnabled() {
    return normalizeStreamRenderEnabled(extension_settings?.[STREAM_RENDER_ENABLED_KEY]);
}

/** 设置流式渲染总开关并持久化。 */
export function setStreamRenderEnabled(enabled) {
    extension_settings[STREAM_RENDER_ENABLED_KEY] = !!enabled;
    saveSettingsDebounced();
}

/** 匹配配置模式取值：'basic'（标准，标签对）| 'advanced'（高级，正则）。 */
export const STREAM_MATCH_MODE_BASIC = 'basic';
export const STREAM_MATCH_MODE_ADVANCED = 'advanced';

/**
 * 内置默认流式匹配配置：标准模式预填正文标签对 `<content>` + `</content>`。
 * 理由：用户消息形态 `<think_fox~>…</think_fox~>\n<content>正文</content>` —— 流式实时渲染的
 * 核心是「正文段（content 内）实时交引擎渲染」，默认开箱即用即匹配正文标签；思维链段/其余
 * 内容按需自行添加标签对或切高级正则。
 */
export const DEFAULT_STREAM_MATCH = Object.freeze({
    mode: STREAM_MATCH_MODE_BASIC,
    rules: Object.freeze([{ start: '<content>', end: '</content>' }]),
    rx: Object.freeze([]),
});

/**
 * 单条标准标签对归一（纯函数，node 可测）：start/end 至少一个非空（单标签扩展，
 * 与 rp_preprocess collectPreprocessLocators 语义一致，engine.js:195-196）；均空 → null。
 * @param {*} rule 原始规则
 * @returns {{ start: string, end: string }|null}
 */
export function normalizeStreamTagRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const start = String(rule.start ?? '').trim();
    const end = String(rule.end ?? '').trim();
    if (!start && !end) return null;
    return { start, end };
}

/**
 * 单条高级正则归一（纯函数，node 可测）：pattern 空 / 编译失败 → null。
 * 编译用 new RegExp(pattern, 'g')（对齐 collectPreprocessLocators advanced 分支，engine.js:179）。
 * @param {*} item 原始规则（兼容字符串遗留 → 视为 pattern）
 * @returns {{ pattern: string }|null}
 */
export function normalizeStreamRx(item) {
    const pattern = typeof item === 'string'
        ? item.trim()
        : (item && typeof item === 'object' && !Array.isArray(item) ? String(item.pattern ?? '').trim() : '');
    if (!pattern) return null;
    try { new RegExp(pattern, 'g'); } catch { return null; }
    return { pattern };
}

/**
 * 流式匹配配置归一（纯函数，node 可测）：
 *   - 缺失 / 非对象 / 数组 → 内置默认（标准模式预填正文标签 <content>，开箱即用）；
 *   - mode 非 advanced → basic；rules/rx 逐条归一（非法剔除）；
 *   - 用户显式配置的 rules/rx 全空 → 空配置（等效未配置，流式不接管任何段 —— 用户主动清空）。
 * @param {*} value rp_hub_stream_match 存储值
 * @returns {{ mode: 'basic'|'advanced', rules: Array<{start:string,end:string}>, rx: Array<{pattern:string}> }}
 */
export function normalizeStreamMatch(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        // 缺失 → 内置默认（预填正文标签 <content>；深拷贝防共享引用被外部修改）
        return {
            mode: DEFAULT_STREAM_MATCH.mode,
            rules: DEFAULT_STREAM_MATCH.rules.map((r) => ({ ...r })),
            rx: [],
        };
    }
    // mode 决定用哪组（与 rp_preprocess 的 mode 切换一致）：basic 只保留 rules、advanced 只保留 rx，
    // 另一组清空 —— 避免「basic 模式但 rx 残留」的歧义（引擎只按 mode 读一组）。
    if (value.mode === STREAM_MATCH_MODE_ADVANCED) {
        return {
            mode: STREAM_MATCH_MODE_ADVANCED,
            rules: [],
            rx: (Array.isArray(value.rx) ? value.rx.map(normalizeStreamRx).filter(Boolean) : []),
        };
    }
    return {
        mode: STREAM_MATCH_MODE_BASIC,
        rules: (Array.isArray(value.rules) ? value.rules.map(normalizeStreamTagRule).filter(Boolean) : []),
        rx: [],
    };
}

/**
 * 读取流式匹配配置（缺省/非法 → 默认 basic 空配置）。
 * @returns {{ mode: 'basic'|'advanced', rules: Array<{start:string,end:string}>, rx: Array<{pattern:string}> }}
 */
export function getStreamMatch() {
    return normalizeStreamMatch(extension_settings?.[STREAM_MATCH_KEY]);
}

/** 设置流式匹配配置并持久化（非法值归一）。 */
export function setStreamMatch(match) {
    extension_settings[STREAM_MATCH_KEY] = normalizeStreamMatch(match);
    saveSettingsDebounced();
}

/** 排除规则动作取值：'hide'（藏走，段保留对本条隐身）/ 'delete'（删除段）/ 'replace'（替换为 replace）。 */
export const STREAM_EXCLUDE_ACTION_HIDE = 'hide';
export const STREAM_EXCLUDE_ACTION_DELETE = 'delete';
export const STREAM_EXCLUDE_ACTION_REPLACE = 'replace';

/**
 * 单条排除规则归一（纯函数，node 可测）：
 *   - pattern 空 / 编译失败 → null；
 *   - action 非 delete/replace → hide（安全默认）；
 *   - replace 仅 string 保留（空串合法 = 删除，对应 delete 语义）。
 * @param {*} rule 原始规则
 * @returns {{ pattern: string, action: 'hide'|'delete'|'replace', replace: string|null }|null}
 */
export function normalizeStreamExclude(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return null;
    const pattern = String(rule.pattern ?? '').trim();
    if (!pattern) return null;
    try { new RegExp(pattern, 'g'); } catch { return null; }
    const action = rule.action === STREAM_EXCLUDE_ACTION_DELETE || rule.action === STREAM_EXCLUDE_ACTION_REPLACE
        ? rule.action
        : STREAM_EXCLUDE_ACTION_HIDE;
    return {
        pattern,
        action,
        replace: typeof rule.replace === 'string' ? rule.replace : null,
    };
}

/**
 * 排除规则归一（纯函数，node 可测）：非数组 → []；逐条归一（非法剔除）。
 * @param {*} value rp_hub_stream_excludes 存储值
 * @returns {Array<{ pattern: string, action: 'hide'|'delete'|'replace', replace: string|null }>}
 */
export function normalizeStreamExcludes(value) {
    if (!Array.isArray(value)) return [];
    return value.map(normalizeStreamExclude).filter(Boolean);
}

/**
 * 读取流式排除规则（缺省/非法 → [] = 无排除）。
 * @returns {Array<{ pattern: string, action: 'hide'|'delete'|'replace', replace: string|null }>}
 */
export function getStreamExcludes() {
    return normalizeStreamExcludes(extension_settings?.[STREAM_EXCLUDES_KEY]);
}

/** 设置流式排除规则并持久化（非法值归一）。 */
export function setStreamExcludes(excludes) {
    extension_settings[STREAM_EXCLUDES_KEY] = normalizeStreamExcludes(excludes);
    saveSettingsDebounced();
}
