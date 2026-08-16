/**
 * 宏替换 —— ST 语义的最小默认实现（供纯函数引擎使用）。
 *
 * 背景：原版 runRegexScript 的替换链最终调用 `substituteParams`（ST script.js 的完整宏引擎，
 * evaluateMacros 含 ~50+ 宏）。本引擎是纯函数、可 node 测试、不依赖 ST DOM，因此：
 *
 *   - 提供最小默认实现（defaultSubstituteParams / defaultSubstituteParamsExtended），覆盖
 *     正则场景最常见的宏：{{newline}} {{pipe}} {{user}} {{char}} {{name}} {{time}} {{date}}
 *     {{timestamp}} {{roll}} {{random}}；
 *   - 未识别宏保持原样（与 ST 一致：未知宏不被替换）；
 *   - run() 接受 `macros` 注入项（{ substituteParams, substituteParamsExtended }），
 *     管道阶段可直接注入 ST 的完整宏引擎以达成 100% 一致 —— 汇报中列为简化点。
 */

const now = (typeof performance !== 'undefined' && typeof performance.now === 'function')
    ? () => new Date()
    : () => new Date();

function evaluateMacros(content, { name2Override } = {}) {
    if (typeof content !== 'string' || content.length === 0) return content;
    return content.replace(/{{([^{}]+)}}/g, (full, key) => {
        const trimmed = String(key).trim();
        const lower = trimmed.toLowerCase();
        const colon = trimmed.indexOf(':');
        const arg = colon !== -1 ? trimmed.slice(colon + 1) : '';
        switch (lower) {
            case 'newline':
                return '\n';
            case 'pipe':
                return '|';
            case 'user':
                return name2Override || 'User';
            case 'name':
                return name2Override || 'User';
            case 'char':
                return 'Char';
            case 'time': {
                const d = now();
                return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
            case 'time_24h': {
                const d = now();
                return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
            case 'date': {
                const d = now();
                return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            }
            case 'timestamp': {
                const d = now();
                return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            }
            case 'roll': {
                const sides = parseInt(arg, 10);
                return String(Math.floor(Math.random() * (sides > 0 ? sides : 100)) + 1);
            }
            case 'random':
                return String(Math.floor(Math.random() * 1000000));
            default:
                // 未知宏保持原样（与 ST 一致）
                return full;
        }
    });
}

/**
 * 最小 substituteParams（对应 ST script.js substituteParams）。
 * @param {string} content
 * @param {object} [options] { name2Override }
 * @returns {string}
 */
export function defaultSubstituteParams(content, { name2Override } = {}) {
    return evaluateMacros(content, { name2Override });
}

/**
 * 最小 substituteParamsExtended（对应 ST script.js substituteParamsExtended）。
 * 本最小实现与 defaultSubstituteParams 等价；完整版可注入 ST 原函数。
 * @param {string} content
 * @param {object} [options] { name2Override }
 * @param {(x: string) => string} [sanitize] 若提供，对宏结果应用转义（如 sanitizeRegexMacro）
 * @returns {string}
 */
export function defaultSubstituteParamsExtended(content, { name2Override } = {}, sanitize) {
    if (typeof content !== 'string' || content.length === 0) return content;
    if (!sanitize) return evaluateMacros(content, { name2Override });
    return content.replace(/{{([^{}]+)}}/g, (full, key) => {
        const replaced = evaluateMacros(full, { name2Override });
        return replaced === full ? full : sanitize(replaced);
    });
}

/**
 * ESCAPED 模式的宏值转义 —— 逐字复刻原版 engine.js:304-324 sanitizeRegexMacro。
 * @param {string} x
 * @returns {string}
 */
export function sanitizeRegexMacro(x) {
    return (x && typeof x === 'string') ?
        x.replaceAll(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/gs, function (s) {
            switch (s) {
                case '\n':
                    return '\\n';
                case '\r':
                    return '\\r';
                case '\t':
                    return '\\t';
                case '\v':
                    return '\\v';
                case '\f':
                    return '\\f';
                case '\0':
                    return '\\0';
                default:
                    return '\\' + s;
            }
        }) : x;
}
