/**
 * 正则编译工具 —— 逐字复刻原版 ST 语义。
 *
 * 参考：
 *   - regexFromString：public/scripts/utils.js:1388-1403（原版）
 *   - RegexProvider：public/scripts/extensions/regex/engine.js:40-90（原版 LRU 编译缓存）
 *
 * 与原版的差异：
 *   - 原版 RegexProvider 直接 import { regexFromString } from utils.js（浏览器环境）；
 *     这里把 regexFromString 复制为本模块自包含实现，保证引擎纯函数、可 node 测试。
 */

/**
 * Instantiates a regular expression from a string.
 * 逐字复刻自 public/scripts/utils.js regexFromString。
 * @param {string} input 正则字符串（支持 `/pattern/flags` 字面量或裸正则）
 * @returns {RegExp|undefined} 编译失败返回 undefined（与原版一致）
 */
export function regexFromString(input) {
    try {
        // Parse input
        const m = input.match(/(\/?)(.+)\1([a-z]*)/i);

        // Invalid flags
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
            return RegExp(input);
        }

        // Create the regular expression
        return new RegExp(m[2], m[3]);
    } catch {
        return undefined;
    }
}

/**
 * 编译缓存（LRU，容量可配），逐字复刻原版 RegexProvider。
 * 原版为 class（engine.js:40-90），这里保留等价行为：
 *   - get(regexString) -> RegExp|null：缓存命中走 LRU 刷新；未命中编译并插入；
 *   - global/sticky 正则取用时 lastIndex 复位为 0；
 *   - 编译失败返回 null（原版 `if (!regex) return null`）。
 */
export class RegexProvider {
    #cache = new Map();
    #maxSize;

    /** 单例（对照原版 engine.js:46 static instance = new RegexProvider()）。 */
    static instance = new RegexProvider();

    /**
     * @param {number} [maxSize=1000] LRU 容量（原版默认 1000）
     */
    constructor(maxSize = 1000) {
        this.#maxSize = maxSize;
    }

    /**
     * @param {string} regexString
     * @returns {RegExp|null}
     */
    get(regexString) {
        const isCached = this.#cache.has(regexString);
        const regex = isCached
            ? this.#cache.get(regexString)
            : regexFromString(regexString);

        if (!regex) {
            return null;
        }

        if (isCached) {
            // LRU: Move to end by re-inserting
            this.#cache.delete(regexString);
            this.#cache.set(regexString, regex);
        } else {
            // Evict oldest if at capacity
            if (this.#cache.size >= this.#maxSize) {
                const firstKey = this.#cache.keys().next().value;
                this.#cache.delete(firstKey);
            }
            this.#cache.set(regexString, regex);
        }

        // Reset lastIndex for global/sticky regexes
        if (regex.global || regex.sticky) {
            regex.lastIndex = 0;
        }

        return regex;
    }

    clear() {
        this.#cache.clear();
    }

    get size() {
        return this.#cache.size;
    }
}
