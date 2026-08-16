/**
 * 保护替换 —— 逐字复刻 RP-Hub core-utils.js 的 transformUnprotectedText / protectedContentPattern。
 *
 * 目的（引擎设计.md §5）：美化正则把 AI 输出替换成 ```html 代码块后，后续正则不能破坏代码块
 * （历史 bug：正则把代码块拆坏 → 渲染器不识别）。仅 rphub 模式启用；st 模式无保护（与原版一致）。
 *
 * 来源：RP-Hub-main/assets/js/core-utils.js:281-287，逐字保留语义：
 *   - protectedContentPattern 提取受保护片段：完整 HTML 文档 / script / style /
 *     <cot>/<think> 块（支持错误闭合）/ markdown 代码块 / 行内代码 / HTML 标签；
 *   - transformUnprotectedText 把文本按保护块切分，只对非保护片段应用替换。
 *
 * 保护可配置化（引擎设计.md §5 待办，2026-08-12 定稿）：
 *   - PROTECT_ITEMS 把静态 PROTECTED_SOURCE 拆成 7 类可按需拼装的片段；每类对应一个
 *     可勾选保护项（完整 HTML 文档 / script / style / cot|think / markdown 代码块 /
 *     行内代码 / HTML 标签）。
 *   - buildProtectedSource(items) 按勾选项拼接保护模式（规范顺序，与默认全开逐字一致）。
 *   - transformUnprotectedText(text, transform, items)：items 缺省 = 全部（默认全开，
 *     行为与原版逐字一致）；items = 空数组 → 无任何保护，直接对全文 transform。
 *
 * 调用方（rphub 解释器）另按 RP-Hub app.js 语义判断是否启用保护：
 *   当正则模式本身含 <、> 或 ``` 时跳过保护直接替换；且受「保护替换」总开关
 *   （rp_hub_protect_enabled，settings.js）与勾选项（rp_hub_protect_items）约束。
 */

/** 7 类保护项 → 正则源片段（全选拼接后与旧静态 PROTECTED_SOURCE 逐字一致）。 */
export const PROTECT_ITEMS = {
    /** 完整 HTML 文档：<!DOCTYPE html>…</html> 或 <html …>…</html>。 */
    html_doc: '<!DOCTYPE html>[\\s\\S]*?<\\/html>|<html\\b[^>]*>[\\s\\S]*?<\\/html>',
    /** <script …>…</script> 块。 */
    script: '<script\\b[^>]*>[\\s\\S]*?<\\/script>',
    /** <style …>…</style> 块。 */
    style: '<style\\b[^>]*>[\\s\\S]*?<\\/style>',
    /** <cot>/<think> 块（支持错误闭合：遇关闭标签 / 新开块 / 文本结尾）。 */
    cot_think: '<(?:cot|think)>[\\s\\S]*?(?:<\\/(?:cot|think)>|<(?:cot|think)>|$)',
    /** markdown 代码块（```…```）。 */
    code_block: '```[\\s\\S]*?```',
    /** 行内代码（`…`）。 */
    inline_code: '`[^`]+`',
    /** 单个 HTML 标签（开/闭/自闭合）。 */
    html_tag: '<\\/?[a-zA-Z][\\w:-]*[^>]*>',
};

/** 保护项展示名（面板勾选列表用）。 */
export const PROTECT_ITEM_LABELS = {
    html_doc: '完整 HTML 文档',
    script: 'script',
    style: 'style',
    cot_think: 'cot/think',
    code_block: '代码块',
    inline_code: '行内代码',
    html_tag: 'HTML 标签',
};

/** 保护项规范顺序（拼接顺序与旧静态 PROTECTED_SOURCE 一致）。 */
export const PROTECT_ITEM_KEYS = Object.keys(PROTECT_ITEMS);

/** 默认保护项 = 全部（默认全开，行为与原版逐字一致）。 */
export const DEFAULT_PROTECT_ITEMS = [...PROTECT_ITEM_KEYS];

/**
 * 按勾选项拼接保护模式源。
 * @param {string[]|undefined|null} [items] 保护项键（PROTECT_ITEM_KEYS 子集）；
 *   缺省 = 全部；非数组 / 未知项忽略；空数组 → ''（无任何保护）。
 * @returns {string} 用 | 拼接的正则源片段
 */
export function buildProtectedSource(items) {
    if (items === undefined || items === null) {
        return PROTECT_ITEM_KEYS.map((k) => PROTECT_ITEMS[k]).join('|');
    }
    if (!Array.isArray(items)) return '';
    const set = new Set(items.filter((k) => Object.prototype.hasOwnProperty.call(PROTECT_ITEMS, k)));
    return PROTECT_ITEM_KEYS.filter((k) => set.has(k)).map((k) => PROTECT_ITEMS[k]).join('|');
}

/** 默认（全开）保护模式 —— 与旧静态 PROTECTED_SOURCE 逐字一致。 */
const PROTECTED_SOURCE = buildProtectedSource();

/** 逐字复刻 core-utils.js:281（gi 标志）。 */
export const protectedContentPattern = new RegExp(`(${PROTECTED_SOURCE})`, 'gi');

/** 逐字复刻 core-utils.js:282（i 标志，锚定整个片段）。 */
export const exactProtectedContentPattern = new RegExp(`^(${PROTECTED_SOURCE})$`, 'i');

/**
 * 按勾选项构建拆分模式。
 * @param {string[]|undefined} [items] 保护项键；缺省 = 全部
 * @returns {RegExp|null} null = 无任何保护项（不应拆分，直接全文 transform）
 */
export function buildProtectedContentPattern(items) {
    const source = buildProtectedSource(items);
    if (!source) return null;
    return new RegExp(`(${source})`, 'gi');
}

/**
 * 按勾选项构建精确匹配模式。
 * @param {string[]|undefined} [items] 保护项键；缺省 = 全部
 * @returns {RegExp|null} null = 无任何保护项
 */
export function buildExactProtectedContentPattern(items) {
    const source = buildProtectedSource(items);
    if (!source) return null;
    return new RegExp(`^(${source})$`, 'i');
}

/**
 * 只对非受保护片段应用 transform。
 * 逐字复刻 core-utils.js:284-287（缺省 items = 全部，与原版逐字一致）。
 * @param {string} text 原文
 * @param {(part: string) => string} transform 对普通文本片段的替换函数
 * @param {string[]|undefined} [items] 保护项键（勾选项）；空数组 = 无保护，直接对全文 transform
 * @returns {string}
 */
export function transformUnprotectedText(text, transform, items) {
    const useDefault = items === undefined || items === null;
    const splitPattern = useDefault ? protectedContentPattern : buildProtectedContentPattern(items);

    // 无任何保护项（空勾选）→ 直接对全文 transform（无保护语义）
    if (!splitPattern) {
        return transform(String(text || ''));
    }

    const exactPattern = useDefault ? exactProtectedContentPattern : buildExactProtectedContentPattern(items);
    return String(text || '')
        .split(splitPattern)
        .map((part) => (!part || exactPattern.test(part) ? part : transform(part)))
        .join('');
}
