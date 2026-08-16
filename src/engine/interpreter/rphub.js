// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * rphub 语义解释器 —— 对照 RP-Hub app.js processRegex（2913-2991）。
 *
 * RP-Hub 语义核心：
 *   双 false（markdownOnly 与 promptOnly 均 false）= 仅显示通道（美化优先）。
 *   与 st 语义的核心差异（引擎设计.md §3）：
 *     - rphub：双 false 仅显示（prompt 干净）
 *     - st：   双 false 双通道
 *
 * 逐条对照（RP-Hub-main/assets/js/app.js）：
 *   - 2917  replaceUserNamePlaceholder（{{user}} 替换，rphub 每次先跑）
 *   - 2919-2923  NAI画图正则排最后（内置分组在合并阶段已按 TYPE_ORDER 排最后；此处不再重复）
 *   - 2927  enabled === false 才跳过（undefined 视为启用）
 *   - 2931  placement 未定义 → 默认 [1,2]（全生效，兼容旧数据）
 *   - 2936-2938  userOnly 判定 + 双通道过滤
 *   - 2941-2942  minDepth/maxDepth（undefined/null 跳过）
 *   - 2946-2950  字段别名（regex/findRegex、flags/regexFlags、replacement/replaceString）
 *   - 2955-2963  /pattern/flags 字面量解析 + flags 验证
 *   - 2965       normalizeRegexModifiers（内联 (?s)/(?i)/(?m) 移到 flags）
 *   - 2967       new RegExp(pattern, flags)
 *   - 2973-2984  保护替换（正则不含 < > ``` 时启用）+ 异常捕获跳过
 *
 * 与原版的语义差异（见汇报）：
 *   - 原版 processRegex 的 isDisplay 通道没有 role 时 placement 过滤不生效（role null 时
 *     两条过滤都跳过）；本引擎 run() 统一由调用方解析 role → placement，解释器只按
 *     rphub 的 placement.includes 语义判定。
 *   - 超时预算（原版无）。
 */

import { runInterruptibleReplace, withBudget, BudgetInterrupted } from '../budget.js';
import { transformUnprotectedText } from '../protect.js';

const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => performance.now()
    : () => Date.now();

/**
 * rphub 模式的通道/字段判定（对照 app.js:2931-2942）。
 * @param {object} script
 * @param {{ isDisplay?: boolean, isPrompt?: boolean, role?: number|string, depth?: number }} ctx
 * @param {{ allowUserOnlyDoubleFalse?: boolean }} opts 默认 true（设计语义：双 false 仅显示）
 * @returns {boolean}
 */
export function rphubShouldRun(
    script,
    { isDisplay = false, isPrompt = false, role = null, depth = 0 },
    { allowUserOnlyDoubleFalse = true } = {},
) {
    // enabled === false 才跳过（app.js:2927）
    if (script.enabled === false) return false;

    // placement 检查（app.js:2931-2933）：1=user, 2=AI；undefined → 默认 [1,2]
    if (role !== null && role !== undefined) {
        const placement = Array.isArray(script.placement) && script.placement.length > 0
            ? script.placement
            : [1, 2];
        if (!placement.includes(Number(role))) return false;
    }

    // 通道判定（app.js:2936-2938）
    const userOnly = script.markdownOnly || (!script.markdownOnly && !script.promptOnly);
    if (isDisplay && script.promptOnly) return false;
    if (isPrompt && userOnly && allowUserOnlyDoubleFalse) return false;

    // 深度过滤（app.js:2941-2942）
    if (script.minDepth !== null && script.minDepth !== undefined && depth < script.minDepth) return false;
    if (script.maxDepth !== null && script.maxDepth !== undefined && depth > script.maxDepth) return false;

    return true;
}

/**
 * 提取 rphub 字段（对照 app.js:2946-2963）。
 * @returns {{ regexPattern: string|null, flags: string, replacement: string, sourceLiteral: boolean }}
 */
export function extractRphubFields(script, { normalizeRegexModifiers } = {}) {
    // 字段别名（app.js:2946-2950）
    let regexPattern = script.regex || script.findRegex;
    let flags = script.flags || script.regexFlags || 'g';
    const replacement = script.hasOwnProperty('replacement')
        ? script.replacement
        : (script.replaceString || '');

    if (!regexPattern) return { regexPattern: null, flags, replacement, sourceLiteral: false };

    // /pattern/flags 字面量解析（app.js:2955-2963）
    if (regexPattern.startsWith('/') && regexPattern.lastIndexOf('/') > 0) {
        const lastSlash = regexPattern.lastIndexOf('/');
        const potentialFlags = regexPattern.substring(lastSlash + 1);
        if (/^[gimsuy]*$/.test(potentialFlags)) {
            flags = potentialFlags;
            regexPattern = regexPattern.substring(1, lastSlash);
        }
    }

    // 内联修饰符归一（app.js:2965）
    if (normalizeRegexModifiers) {
        ({ pattern: regexPattern, flags } = normalizeRegexModifiers(regexPattern, flags));
    }

    return { regexPattern, flags, replacement, sourceLiteral: true };
}

/**
 * 替换模板展开 —— 逐字复刻 JS String.prototype.replace 的字符串替换语义
 * （RP-Hub app.js:2979/2982 用 part.replace(re, replacement) / result.replace(re, replacement)）：
 *   $$  → $        $&   → 匹配串
 *   $`  → 匹配前段  $'   → 匹配后段
 *   $n  → 第 n 捕获组（n=1..99；超出组数 → 空串，与 JS 一致）
 *   $<name> → 命名捕获组（缺失 → 空串）
 *
 * 兼容两种 match 形状：
 *   - buildArgs 数组（引擎 runInterruptibleReplace 传入）：[full, g1..gN, index, input, groups]
 *   - 原生 RegExpExecArray（测试/外部直用时）：m.index / m.input / m.groups 为属性
 *
 * @param {string} template 替换模板
 * @param {any[]|RegExpExecArray} m 匹配结果
 * @returns {string}
 */
export function expandReplacement(template, m) {
    if (typeof template !== 'string' || template.length === 0) return '';

    // 归一化两种形状（I1 修复：原生 RegExpExecArray 有 `index` 数字属性，buildArgs 数组无——
    // 用 `'index' in m` 判别，避免 ≥3 捕获组的原生数组被误判为 buildArgs 形状导致 $1/$2/$3 全错）
    const isNative = typeof m === 'object' && m !== null && 'index' in m && typeof m.index === 'number';
    const groupsArr = isNative ? Array.from(m).slice(1) : m.slice(1, m.length - 3);
    const index = isNative ? m.index : m[m.length - 3];
    const input = isNative ? m.input : m[m.length - 2];
    const groups = isNative ? m.groups : m[m.length - 1];
    const groupCount = groupsArr.length;

    return template.replace(/\$(?:\d{1,2}|<[^>]+>|\$|&|`|')/g, (full) => {
        const token = full.slice(1); // 去掉前导 $
        if (token[0] >= '0' && token[0] <= '9') {
            const n = parseInt(token, 10);
            if (n === 0) return full; // $0 非 JS 占位语法，字面保留（与 String.replace 一致）
            if (n > groupCount) return ''; // 超出捕获组数 → 空串（与 JS 一致）
            return groupsArr[n - 1] ?? '';
        }
        if (token[0] === '<') {
            const name = token.slice(1, -1);
            const value = groups && typeof groups === 'object' ? groups[name] : undefined;
            return typeof value === 'undefined' || value === null ? '' : String(value);
        }
        if (token === '$') return '$';
        if (token === '&') return m[0] ?? '';
        if (token === '`') return String(input).slice(0, index);
        if (token === "'") return String(input).slice(index + String(m[0] ?? '').length);
        return full;
    });
}

/**
 * 单脚本执行（rphub 语义，对照 app.js:2967-2988）。
 * @param {object} script
 * @param {string} text
 * @param {object} [options]
 *   { budgetMs, record, characterOverride, allowProtection, protectEnabled, protectItems,
 *     precheckEnabled, precheckBypassKeys }
 *   allowProtection：正则含 < > 或 ``` 时跳过保护（app.js:2973，与 regexPattern 相关，原版语义）；
 *   protectEnabled：保护替换总开关（设置 rp_hub_protect_enabled，缺省 true = 启用）；
 *   protectItems：保护项勾选（设置 rp_hub_protect_items，PROTECT_ITEM_KEYS 子集；
 *     缺省 = 全部；空数组 = 无任何保护项 → 等同直接替换）。
 *   precheckEnabled：ReDoS 静态预检总开关（设置 rp_hub_precheck_enabled，缺省 true）；
 *   precheckBypassKeys：预检绕过脚本键表（设置 rp_hub_precheck_bypass；键 = script.id || scriptName）。
 * @returns {{ text: string, changed: boolean, timedOut: boolean, reason?: string|null, elapsedMs?: number }}
 */
export function runRegexScriptRphub(script, text, options = {}) {
    const {
        budgetMs = 50,
        record,
        allowProtection = true,
        protectEnabled = true,
        protectItems,
        precheckEnabled = true,
        precheckBypassKeys = [],
        skipBlankSegments = false,
    } = options;

    const { regexPattern, flags, replacement } = extractRphubFields(script);
    if (!regexPattern) {
        return { text, changed: false, timedOut: false, reason: null, elapsedMs: 0 };
    }

    const budgetResult = withBudget({
        scriptName: script.scriptName || script.name || script.id,
        pattern: regexPattern,
        flags,
        budgetMs,
        record,
        precheckEnabled,
        precheckBypassKeys,
        scriptKey: script.id || script.scriptName || script.name,
        run: () => {
            // 保护启用条件（app.js:2973）：正则不含 < > 且不含 ``` 才启用；
            // 额外受「保护替换」总开关（protectEnabled）与勾选项（protectItems）约束
            const useProtection = allowProtection
                && protectEnabled
                && !/[<>]/.test(regexPattern)
                && !regexPattern.includes('```')
                && !(Array.isArray(protectItems) && protectItems.length === 0);

            // 替换回调：展开 $n/$&/$$/$`/$'/$<name>（对照 JS String.replace 字符串替换语义）
            const makeReplacer = () => (args) => expandReplacement(replacement, args);

            if (useProtection) {
                // transformUnprotectedText 多片段替换（app.js:2976-2979），按勾选项保护
                const start = now();
                const textOut = transformUnprotectedText(text, (part) => {
                    // 空白段守卫（rp_hub_skip_blank_segments，默认开启）：保护替换按 HTML 标签
                    // 把文本切成普通片段，孤立 \n 空白片段会被「整段匹配型」美化正则
                    // （如 ^([\s\S]+)$ 无 \S 守卫）包成空卡片（与妹生活 / 刚满十八空卡同源，
                    // legacy 渲染模式下的同源路径）。skipBlankSegments=true 时空白片段原样
                    // 保留、不交给脚本 —— 与 two_pass_121 阶段②/③ 的 runScriptOnMasked
                    // 守卫语义一致（两条渲染模式共用同一设置）。
                    if (skipBlankSegments === true && /^\s*$/.test(part)) {
                        return part;
                    }
                    const re = new RegExp(regexPattern, flags);
                    const r = runInterruptibleReplace(part, re, makeReplacer(), budgetMs, start);
                    if (!r.done) throw new BudgetInterrupted();
                    return r.text;
                }, protectItems);
                return { done: true, text: textOut };
            }

            // 无保护直接替换（app.js:2982）
            const re = new RegExp(regexPattern, flags);
            return runInterruptibleReplace(text, re, makeReplacer(), budgetMs);
        },
    });

    if (budgetResult.timedOut) {
        return {
            text,
            changed: false,
            timedOut: true,
            reason: budgetResult.reason,
            elapsedMs: budgetResult.elapsedMs,
        };
    }

    return {
        text: budgetResult.text,
        changed: budgetResult.text !== text,
        timedOut: false,
        reason: null,
        elapsedMs: budgetResult.elapsedMs,
    };
}
