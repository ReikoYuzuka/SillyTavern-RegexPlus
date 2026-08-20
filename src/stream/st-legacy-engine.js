// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * stream/st-legacy-engine.js —— ST 原版纯文本正则轻量流式引擎（纯函数模块）。
 *
 * 职责：
 *   - 逐字复刻原版 ST regex 扩展（engine.js:334-465）的 getRegexedString 语义；
 *   - 仅执行纯文本线性 replace，纯文本进、纯文本出，零 DOM 依赖，零副作用；
 *   - 专供 ST 卡（mode === 'st'）在流式传输每帧中被 legacy-hook 调用；
 *   - 绝不执行 two_pass_121 藏走/拼回，绝不执行 HTML 围栏化（这些留在生成结束后权威覆盖）。
 */

import { RegexProvider } from '../engine/regex-util.js';
import { sanitizeRegexMacro, defaultSubstituteParams, defaultSubstituteParamsExtended } from '../engine/macros.js';

const substitute_find_regex = Object.freeze({
    NONE: 0,
    RAW: 1,
    ESCAPED: 2,
});

/**
 * trim 过滤（复刻原版 engine.js:457-465）。
 */
function filterString(rawString, trimStrings, { characterOverride, substituteParams = defaultSubstituteParams } = {}) {
    let finalString = rawString;
    if (Array.isArray(trimStrings)) {
        for (const trimString of trimStrings) {
            const subTrimString = substituteParams(trimString, { name2Override: characterOverride });
            finalString = finalString.replaceAll(subTrimString, '');
        }
    }
    return finalString;
}

/**
 * 单脚本执行（复刻原版 engine.js:391-448）。
 */
export function runRegexScriptLegacy(script, rawString, {
    characterOverride,
    substituteParams = defaultSubstituteParams,
    substituteParamsExtended = defaultSubstituteParamsExtended,
    provider = RegexProvider.instance,
} = {}) {
    let newString = rawString;
    if (!script || !!script.disabled || script.enabled === false || !script.findRegex || !rawString) {
        return newString;
    }

    const getRegexString = () => {
        switch (Number(script.substituteRegex)) {
            case substitute_find_regex.NONE:
                return script.findRegex;
            case substitute_find_regex.RAW:
                return substituteParamsExtended(script.findRegex);
            case substitute_find_regex.ESCAPED:
                return substituteParamsExtended(script.findRegex, {}, sanitizeRegexMacro);
            default:
                return script.findRegex;
        }
    };

    const regexString = getRegexString();
    const findRegex = provider.get(regexString);
    if (!findRegex) {
        return newString;
    }

    newString = rawString.replace(findRegex, function (match) {
        const args = [...arguments];
        const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
        const replaceWithGroups = replaceString.replaceAll(/\$(\d+)|\$<([^>]+)>/g, (_, num, groupName) => {
            if (num) {
                match = args[Number(num)];
            } else if (groupName) {
                const groups = args[args.length - 1];
                match = groups && typeof groups === 'object' && groups[groupName];
            }

            if (!match) {
                return '';
            }

            return filterString(match, script.trimStrings, { characterOverride, substituteParams });
        });

        return substituteParams(replaceWithGroups);
    });

    return newString;
}

/**
 * 轻量流式引擎入口（原版 getRegexedString 等价实现，读取合并脚本集）。
 * @param {string} rawString 待处理原始流式累积文本
 * @param {number} placement 位置枚举（流式通常传 2 = AI_OUTPUT）
 * @param {object} [options]
 * @param {string} [options.characterOverride] 角色名覆写
 * @param {boolean} [options.isMarkdown=true] 是否 Markdown 显示通道
 * @param {boolean} [options.isPrompt=false] 是否 Prompt 通道
 * @param {boolean} [options.isEdit=false] 是否编辑通道
 * @param {number} [options.depth] 消息深度
 * @param {Array<object>} [options.scripts] 合并后的脚本集
 * @returns {string} 正则替换后的纯文本
 */
export function getRegexedStringLegacy(rawString, placement, {
    characterOverride,
    isMarkdown = true,
    isPrompt = false,
    isEdit = false,
    depth,
    scripts = [],
    substituteParams = defaultSubstituteParams,
    substituteParamsExtended = defaultSubstituteParamsExtended,
    provider = RegexProvider.instance,
} = {}) {
    if (typeof rawString !== 'string') return '';
    let finalString = rawString;
    if (!rawString || placement === undefined) return finalString;

    for (const script of scripts) {
        if (!script || !!script.disabled || script.enabled === false) continue;

        // 通道过滤（复刻原版 engine.js:348-354）
        if (
            (script.markdownOnly && isMarkdown) ||
            (script.promptOnly && isPrompt) ||
            (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
        ) {
            if (isEdit && !script.runOnEdit) continue;

            // 深度过滤（复刻原版 engine.js:362-372）
            if (typeof depth === 'number') {
                if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
                    continue;
                }
                if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
                    continue;
                }
            }

            // placement 过滤（复刻原版 engine.js:374）
            if (Array.isArray(script.placement) && script.placement.includes(placement)) {
                finalString = runRegexScriptLegacy(script, finalString, {
                    characterOverride,
                    substituteParams,
                    substituteParamsExtended,
                    provider,
                });
            }
        }
    }

    return finalString;
}
