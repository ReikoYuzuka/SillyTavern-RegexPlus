/**
 * st 语义解释器 —— 逐字复刻原版 ST regex 扩展（engine.js）的过滤与替换机制。
 *
 * 对照基准：
 *   - 分流：engine.js:348-355（getRegexedString 的通道判定）
 *   - 编辑：engine.js:356-359（isEdit && !runOnEdit 跳过）
 *   - 深度：engine.js:362-372（minDepth/maxDepth 边界逐字复刻）
 *   - placement 过滤：engine.js:374
 *   - 单脚本执行：engine.js:391-448（runRegexScript，含 {{match}}/$n/$<name>/trimStrings/最终宏替换）
 *   - 编译缓存：regex-util.js RegexProvider（engine.js:40-90）
 *   - 宏替换：macros.js（默认最小实现；可注入 ST 完整宏引擎）
 *
 * 与原版的语义差异（逐条列出，见汇报）：
 *   1. 「general 脚本（双 false）」通道语义：
 *        ST 原文 —— 仅在 !isMarkdown && !isPrompt（既非显示也非 prompt 的“清理/存储”场合）执行，
 *        因为 ST 在 cleanUpMessage/发送时先跑 general 并把结果写回消息，显示/prompt 读取的是
 *        已处理文本（间接双通道）。
 *        本引擎 —— 事件介入模型下显示/prompt 是两次独立调用，为使 net 效果等价（设计文档
 *        “双 false = 双通道”），默认在显示通道与 prompt 通道都执行 general（stGeneralMode='both'）。
 *        需要严格复刻原文时可用 stGeneralMode='verbatim'（仅在既非显示也非 prompt 时执行）。
 *   2. placement 未传时：原版 getRegexedString 直接早退返回原文；本引擎跳过 placement 过滤。
 *   3. trimStrings / {{match}} / $n 的宏处理使用默认最小宏引擎，完整 ST 宏引擎待管道阶段注入。
 */

import { runInterruptibleReplace, withBudget } from '../budget.js';
import { sanitizeRegexMacro, defaultSubstituteParams, defaultSubstituteParamsExtended } from '../macros.js';
import { RegexProvider } from '../regex-util.js';

/**
 * 通道判定（对照 engine.js:348-355）。
 * @param {object} script
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean }} ctx
 * @param {{ generalMode?: 'both'|'verbatim' }} opts
 * @returns {boolean}
 */
export function stChannelOk(script, { isMarkdown, isPrompt }, { generalMode = 'both' } = {}) {
    if (generalMode === 'verbatim') {
        // 逐字复刻 engine.js:348-355
        return (
            (script.markdownOnly && isMarkdown) ||
            (script.promptOnly && isPrompt) ||
            (!script.markdownOnly && !script.promptOnly && !isMarkdown && !isPrompt)
        );
    }
    // net-effect 双通道：general 在显示与 prompt 通道都执行
    return (
        (script.markdownOnly && isMarkdown) ||
        (script.promptOnly && isPrompt) ||
        (!script.markdownOnly && !script.promptOnly)
    );
}

/**
 * 单脚本的完整过滤判定（st 模式）。
 * @param {object} script
 * @param {object} ctx { placement, isMarkdown, isPrompt, isEdit, depth }
 * @param {{ generalMode?: 'both'|'verbatim' }} opts
 * @returns {boolean}
 */
export function stShouldRun(script, { placement, isMarkdown, isPrompt, isEdit, depth }, opts = {}) {
    if (!stChannelOk(script, { isMarkdown, isPrompt }, opts)) return false;

    // 编辑链路（engine.js:356-359）
    if (isEdit && !script.runOnEdit) return false;

    // 深度过滤（engine.js:362-372 逐字复刻）
    if (typeof depth === 'number') {
        if (!isNaN(script.minDepth) && script.minDepth !== null && script.minDepth >= -1 && depth < script.minDepth) {
            return false;
        }
        if (!isNaN(script.maxDepth) && script.maxDepth !== null && script.maxDepth >= 0 && depth > script.maxDepth) {
            return false;
        }
    }

    // placement 过滤（engine.js:374）
    if (placement !== undefined && placement !== null) {
        if (Array.isArray(script.placement) && !script.placement.includes(placement)) return false;
        if (!Array.isArray(script.placement)) return false;
    }

    return true;
}

/**
 * 单脚本执行（对照 engine.js:391-448 runRegexScript）。
 * @param {object} script
 * @param {string} text
 * @param {object} [options]
 *   { characterOverride?, substituteParams?, substituteParamsExtended?, provider?, budgetMs?, record?,
 *     precheckEnabled?, precheckBypassKeys? }
 * @returns {{ text: string, changed: boolean, timedOut: boolean, reason?: string|null, elapsedMs?: number }}
 */
export function runRegexScriptSt(script, text, options = {}) {
    const {
        characterOverride,
        substituteParams = defaultSubstituteParams,
        substituteParamsExtended = defaultSubstituteParamsExtended,
        provider,
        budgetMs = 50,
        record,
        precheckEnabled = true,
        precheckBypassKeys = [],
    } = options;
    const cache = provider || RegexProvider.instance;

    let newString = text;
    // 早退（engine.js:393）：!regexScript || disabled || !findRegex || !rawString
    if (!script || !!script.disabled || !script?.findRegex || !text) {
        return { text: newString, changed: false, timedOut: false, reason: null, elapsedMs: 0 };
    }

    // find 串宏替换三态（engine.js:397-410 + substitute_find_regex）
    const getRegexString = () => {
        switch (Number(script.substituteRegex)) {
            case 0: // NONE
                return script.findRegex;
            case 1: // RAW
                return substituteParamsExtended(script.findRegex);
            case 2: // ESCAPED
                return substituteParamsExtended(script.findRegex, {}, sanitizeRegexMacro);
            default:
                console.warn(`runRegexScript: Unknown substituteRegex value ${script.substituteRegex}. Using raw regex.`);
                return script.findRegex;
        }
    };
    const regexString = getRegexString();
    const findRegex = cache.get(regexString);
    if (!findRegex) {
        // 编译失败跳过（engine.js:414-416）
        return { text: newString, changed: false, timedOut: false, reason: 'compile-error', elapsedMs: 0 };
    }

    const budgetResult = withBudget({
        scriptName: script.scriptName || script.id,
        pattern: findRegex.source,
        flags: findRegex.flags,
        budgetMs,
        record,
        precheckEnabled,
        precheckBypassKeys,
        scriptKey: script.id || script.scriptName,
        run: () => {
            // 替换回调（engine.js:419-445）
            const replacer = (args) => {
                let match = args[0];
                // {{match}} → $0（engine.js:421）
                const replaceString = String(script.replaceString ?? '').replace(/{{match}}/gi, '$0');
                // $n / $<name> → trim 后的匹配文本（engine.js:422-441）
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
                // 最终宏替换（engine.js:444）
                return substituteParams(replaceWithGroups);
            };
            return runInterruptibleReplace(text, findRegex, replacer, budgetMs);
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

    newString = budgetResult.text;
    return {
        text: newString,
        changed: newString !== text,
        timedOut: false,
        reason: null,
        elapsedMs: budgetResult.elapsedMs,
    };
}

/**
 * trim 过滤（对照 engine.js:457-465 filterString）。
 */
export function filterString(rawString, trimStrings, { characterOverride, substituteParams } = {}) {
    let finalString = rawString;
    (Array.isArray(trimStrings) ? trimStrings : []).forEach((trimString) => {
        const subTrimString = substituteParams(trimString, { name2Override: characterOverride });
        finalString = finalString.replaceAll(subTrimString, '');
    });
    return finalString;
}
