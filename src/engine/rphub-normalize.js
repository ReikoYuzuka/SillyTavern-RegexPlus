/**
 * rphub 正则修饰符归一 —— 逐字复刻 RP-Hub core-utils.js:269-279 normalizeRegexModifiers。
 *
 * 作用：把模式中的内联修饰符 (?s)/(?i)/(?m) 移除并合并到 flags。
 */

/**
 * @param {string} pattern 正则模式
 * @param {string} [flags='g'] 现有 flags
 * @returns {{ pattern: string, flags: string }}
 */
export function normalizeRegexModifiers(pattern, flags = 'g') {
    let normalizedPattern = pattern;
    let normalizedFlags = flags;
    for (const modifier of ['s', 'i', 'm']) {
        const marker = `(?${modifier})`;
        if (!normalizedPattern.includes(marker)) continue;
        normalizedPattern = normalizedPattern.split(marker).join('');
        if (!normalizedFlags.includes(modifier)) normalizedFlags += modifier;
    }
    return { pattern: normalizedPattern, flags: normalizedFlags };
}
