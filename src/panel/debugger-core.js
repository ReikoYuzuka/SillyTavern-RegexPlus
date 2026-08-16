// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * panel/debugger-core.js —— 调试器纯逻辑核心（可 node 离线测试）。
 *
 * 复刻原版 extensions/regex/index.js：
 *   - buildReplacementHtml（881-940）→ buildReplacementHtml 返回 HTML 字符串
 *   - executeRegexScriptForDebugging（942-1048）→ 纯函数版本
 *
 * 与原版差异说明：
 *   - 原版依赖 document.createDocumentFragment / innerText（浏览器 DOM）；
 *     这里返回 HTML 字符串，文本全部 escapeHtml（与原版 innerText/textContent 效果一致）。
 *   - regexFromString / escapeHtml 由调用方注入（浏览器用 ST utils，node 测试用自实现）。
 *   - 其余逻辑（统计口径 / diff 视图 / 错误回退）逐字复刻。
 */

/**
 * 复刻 buildReplacementHtml：把替换串拆成「字面量(green) + 回写(yellow)/原文(plain)」HTML。
 * @param {RegExpMatchArray} match
 * @param {string} pattern
 * @param {(s: string) => string} escapeHtml
 * @returns {string}
 */
export function buildReplacementHtml(match, pattern, escapeHtml) {
    let html = '';
    let lastIndex = 0;
    const backrefRegex = /\$\$|\$&|\$`|\$'|\$(\d{1,2})/g;

    let reMatch;
    while ((reMatch = backrefRegex.exec(pattern)) !== null) {
        // 回写引用前的部分为字面量
        const literalPart = pattern.substring(lastIndex, reMatch.index);
        if (literalPart) {
            html += `<mark class='green_hl'>${escapeHtml(literalPart)}</mark>`;
        }

        const backref = reMatch[0];
        if (backref === '$$') {
            html += escapeHtml('$');
        } else if (backref === '$&') {
            html += `<mark class='yellow_hl'>${escapeHtml(match[0])}</mark>`;
        } else if (backref === '$`') {
            html += escapeHtml(match.input.substring(0, match.index));
        } else if (backref === "$'") {
            html += escapeHtml(match.input.substring(match.index + match[0].length));
        } else {
            // 编号捕获组 $n
            const groupIndex = parseInt(reMatch[1], 10);
            if (groupIndex > 0 && groupIndex < match.length && match[groupIndex] !== undefined) {
                html += `<mark class='yellow_hl'>${escapeHtml(match[groupIndex])}</mark>`;
            } else {
                // 非法组号按字面量
                html += `<mark class='green_hl'>${escapeHtml(backref)}</mark>`;
            }
        }
        lastIndex = backrefRegex.lastIndex;
    }

    // 末尾字面量
    const finalLiteralPart = pattern.substring(lastIndex);
    if (finalLiteralPart) {
        html += `<mark class='green_hl'>${escapeHtml(finalLiteralPart)}</mark>`;
    }

    return html;
}

/**
 * 复刻 executeRegexScriptForDebugging（index.js:942-1048）。
 *
 * 注意（复刻差异，与真实引擎不同，保持与原版调试器一致）：
 *   - 不含 {{match}} 预转换、trimStrings、substituteRegex 宏替换、最终 substituteParams；
 *   - 展示「纯正则替换」近似结果 + diff 高亮 + Captured/Added/Removed 统计。
 *
 * @param {object} script 含 findRegex / replaceString
 * @param {string} text
 * @param {object} deps
 *   { regexFromString: (input) => RegExp|undefined, escapeHtml: (s) => string }
 * @returns {{ output: string, highlightedOutput: string, error: string|null,
 *   charsCaptured: number, charsAdded: number, charsRemoved: number }}
 */
export function executeRegexScriptForDebugging(script, text, { regexFromString, escapeHtml }) {
    const _text = String(text ?? '');
    let err;
    let originalRegex;

    try {
        originalRegex = regexFromString(script.findRegex);
        if (!originalRegex) throw new Error('Invalid regex string');
    } catch (e) {
        err = `Compile error: ${e.message}`;
        return { output: _text, highlightedOutput: _text, error: err, charsCaptured: 0, charsAdded: 0, charsRemoved: 0 };
    }

    const globalRegex = new RegExp(originalRegex.source, originalRegex.flags.includes('g') ? originalRegex.flags : originalRegex.flags + 'g');
    const matches = [..._text.matchAll(globalRegex)];

    if (matches.length === 0) {
        return { output: _text, highlightedOutput: escapeHtml(_text), error: null, charsCaptured: 0, charsAdded: 0, charsRemoved: 0 };
    }

    let outputText = '';
    let highlightedOutput = '';
    let lastIndex = 0;
    let totalCharsCaptured = 0;
    let totalCharsAdded = 0;
    let totalCharsRemoved = 0;

    try {
        for (const match of matches) {
            const originalMatchText = match[0];
            totalCharsCaptured += originalMatchText.length;

            // 匹配前的文本（不变部分）
            const precedingText = _text.substring(lastIndex, match.index);
            outputText += precedingText;
            highlightedOutput += escapeHtml(precedingText);

            // ---- 统计逻辑（index.js:981-1011） ----
            let charsAddedInMatch = 0;
            let charsKeptFromMatch = 0;
            const backrefRegex = /\$\$|\$&|\$`|\$'|\$(\d{1,2})/g;
            let lastPatternIndex = 0;
            let reMatch;
            let replacementForPlainText = '';

            while ((reMatch = backrefRegex.exec(script.replaceString)) !== null) {
                const literalPart = script.replaceString.substring(lastPatternIndex, reMatch.index);
                charsAddedInMatch += literalPart.length;
                replacementForPlainText += literalPart;
                const backref = reMatch[0];
                if (backref === '$$') {
                    replacementForPlainText += '$';
                } else if (backref === '$&') {
                    charsKeptFromMatch += (match[0] || '').length;
                    replacementForPlainText += (match[0] || '');
                } else if (backref === '$`') {
                    const part = match.input.substring(0, match.index);
                    charsKeptFromMatch += part.length;
                    replacementForPlainText += part;
                } else if (backref === "$'") {
                    const part = match.input.substring(match.index + match[0].length);
                    charsKeptFromMatch += part.length;
                    replacementForPlainText += part;
                } else {
                    const groupIndex = parseInt(reMatch[1], 10);
                    if (groupIndex > 0 && groupIndex < match.length && match[groupIndex] !== undefined) {
                        charsKeptFromMatch += match[groupIndex].length;
                        replacementForPlainText += match[groupIndex];
                    }
                }
                lastPatternIndex = backrefRegex.lastIndex;
            }
            const finalLiteralPart = script.replaceString.substring(lastPatternIndex);
            charsAddedInMatch += finalLiteralPart.length;
            replacementForPlainText += finalLiteralPart;

            totalCharsAdded += charsAddedInMatch;
            totalCharsRemoved += (originalMatchText.length - charsKeptFromMatch);

            outputText += replacementForPlainText;

            // ---- diff 视图（index.js:1019-1025） ----
            highlightedOutput += `<mark class='red_hl'>${escapeHtml(originalMatchText)}</mark>`;
            highlightedOutput += ' → ';
            highlightedOutput += buildReplacementHtml(match, script.replaceString, escapeHtml);

            lastIndex = match.index + originalMatchText.length;
        }

        // 末尾文本
        const trailingText = _text.substring(lastIndex);
        outputText += trailingText;
        highlightedOutput += escapeHtml(trailingText);
    } catch (e) {
        err = (err ? err + '; ' : '') + `Replace error: ${e.message}`;
        outputText = _text;
        highlightedOutput = escapeHtml(_text);
    }

    return {
        output: outputText,
        highlightedOutput,
        error: err,
        charsCaptured: totalCharsCaptured,
        charsAdded: totalCharsAdded,
        charsRemoved: totalCharsRemoved,
    };
}
