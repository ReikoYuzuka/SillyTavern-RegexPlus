/**
 * stream/segment-detector.js —— 流式段状态机（纯函数，node 可测）。
 *
 * 职责：把「AI 流式输出的累计文本」解析为段边界事件，供段级渲染（segment-render.js）
 * 驱动。对应可行性报告 §5.2：
 *
 *   IDLE ──起始标签──▶ IN（段内，节流持续渲染）──闭合标签──▶ CLOSED（定格渲染该段）
 *   CLOSED ──新起始标签──▶ IN（多组标签依次接管，如 think → content）
 *   CLOSED ──后续普通文本──▶ 保持 CLOSED（不再接管，尾部交回酒馆原生通道）
 *
 * 两种匹配模式（与配置 rp_hub_stream_match 对应，settings.js normalizeStreamMatch）：
 *   - basic（标准）：多组标签对（start/end），字面 indexOf 匹配，零正则开销；
 *     每组标签对独立产生开/闭事件；支持单标签扩展（只填 start → 到文本末尾；
 *     只填 end → 开头到该标签）。
 *   - advanced（高级）：自定义正则列表（regexFromString 语义，支持 /pattern/flags），
 *     取【最左匹配】为段边界（匹配一次即闭合段 → TAIL）。
 *
 * 关键约束（沿用可行性报告 §2.3 / §5.2）：
 *   - 未闭合中间态不触发渲染（段未闭合即流式继续 → 无渲染动作，机制性规避不完整文本）；
 *   - 段闭合才产出「可渲染段」；CLOSED 后不再接管新内容（尾部交回酒馆）；
 *   - 增量扫描 + 回退窗口（跨帧标签补全，如 `<con` → `<content>`）+ 位置去重
 *     （防重复检测同一标签），控制流式长回复累积开销（报告 §7 风险1）。
 *
 * 本模块不 import 任何 ST 全局 / DOM，只导出纯函数。
 */

/** 段状态：空闲（未进段）/ 段内（起始标签已出现，未闭合）/ 已闭合（等待新段或交回酒馆）/ 尾部（高级模式闭合后）。 */
export const SEGMENT_STATE_IDLE = 'idle';
export const SEGMENT_STATE_IN = 'in';
export const SEGMENT_STATE_CLOSED = 'closed';
export const SEGMENT_STATE_TAIL = 'tail';

/** 段边界事件类型：'open'（检测到起始标签，段内开始）/ 'closed'（检测到闭合标签，段定格）。 */
export const SEGMENT_EVENT_OPEN = 'open';
export const SEGMENT_EVENT_CLOSED = 'closed';

/**
 * 归一匹配配置（纯函数，node 可测）：接收 settings.normalizeStreamMatch 的输出，
 * 保持本模块独立可测 —— 非法/缺省 → 空配置（不接管任何段）。
 * @param {object|null|undefined} match rp_hub_stream_match 归一后的值
 * @returns {{ mode: 'basic'|'advanced', rules: Array<{start:string,end:string}>, rx: Array<{pattern:string}> }}
 */
export function normalizeMatchConfig(match) {
    if (!match || typeof match !== 'object' || Array.isArray(match)) {
        return { mode: 'basic', rules: [], rx: [] };
    }
    const rules = (Array.isArray(match.rules) ? match.rules : [])
        .filter((r) => r && typeof r === 'object')
        .map((r) => ({ start: String(r.start ?? ''), end: String(r.end ?? '') }))
        .filter((r) => r.start || r.end);
    const rx = (Array.isArray(match.rx) ? match.rx : [])
        .filter((x) => x && typeof x === 'object')
        .map((x) => ({ pattern: String(x.pattern ?? '') }))
        .filter((x) => x.pattern);
    // mode 决定用哪组（与 settings.normalizeStreamMatch 语义一致）：basic 只保留 rules、
    // advanced 只保留 rx，另一组清空 —— 避免歧义（检测器只按 mode 读一组）。
    if (match.mode === 'advanced') {
        return { mode: 'advanced', rules: [], rx };
    }
    return { mode: 'basic', rules, rx: [] };
}

/** 匹配配置是否为空（无任何可检测段 → 流式不接管任何段 = 等效关闭）。 */
export function isEmptyMatchConfig(config) {
    const c = normalizeMatchConfig(config);
    if (c.mode === 'advanced') return c.rx.length === 0;
    return c.rules.length === 0;
}

/** 正则编译（regexFromString 语义：支持 /pattern/flags 定界符；编译失败 → null）。 */
export function compileStreamRegex(pattern) {
    try {
        const m = String(pattern ?? '').match(/(\/?)(.+)\1([a-z]*)/i);
        if (m && m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) {
            return new RegExp(m[2], m[3]);
        }
        if (m) return new RegExp(m[2], m[3]);
        return new RegExp(String(pattern ?? ''));
    } catch {
        return null;
    }
}

/**
 * 创建段检测器状态机（纯函数工厂，node 可测）。
 * 事件流式驱动：每 token 把累计文本喂给 advance(text) 即可，内部做增量扫描。
 *
 * @param {object} [options]
 * @param {object} [options.match] 匹配配置（rp_hub_stream_match 归一值；缺省 = 空配置不接管）
 * @param {string} [options.prefix] continue 场景的前缀基准（GENERATION_STARTED 时读
 *   chat[lastMesId].mes 尾部；事件载荷拼接前缀后检测，报告 §7 风险6）
 * @returns {object} 检测器实例：
 *   - advance(text)：text = 当前累计文本（含前缀）；返回本次产生的事件数组
 *     [{ type: 'open'|'closed', ruleIndex, segment, occurrence }]
 *     - open：起始标签出现（segment = 从标签到当前末尾，节流持续渲染用）
 *     - closed：闭合后的完整段（segment = 含标签整串，定格渲染用）
 *     - occurrence：段出现序号（0 起；同一条消息内多段递增，供段容器/渲染表键控）
 *   - getState()：当前段状态（idle/in/closed/tail）
 *   - getClosedSegments()：已闭合段列表（含标签整串，按闭合顺序）
 *   - getCurrentRuleIndex()：当前 IN 段规则索引（非 IN 态 null）
 *   - getCurrentOccurrence()：当前 IN 段出现序号（非 IN 态 -1）
 *   - getInSegmentText()：段内持续渲染文本（IN 态：从段起点到当前末尾；否则 null）
 *   - isEmpty()：匹配配置是否为空
 */
export function createSegmentDetector({ match, prefix = '' } = {}) {
    const config = normalizeMatchConfig(match);
    let buffer = String(prefix ?? '');
    let state = SEGMENT_STATE_IDLE;
    let scanFrom = 0;            // 已消费位置（标签结束处；增量扫描基准）
    let closedSegments = [];     // 已闭合段（含标签整串，按闭合顺序）
    let currentRuleIndex = null; // IN 态当前段规则索引
    let segmentStart = -1;       // IN 态当前段起点（buffer 内索引）
    let occurrenceCounter = -1;   // 段出现序号（0 起；每新段起始自增：open / 单结束 / advanced 闭合）
    let currentOccurrence = -1;   // IN 态当前段序号（段内渲染/段容器键控用；非 IN 态 -1）
    const handledStarts = new Set(); // 已处理标签的起始位置（跨帧去重）

    // 最长标签长度（回退窗口：跨帧标签补全，如 `<con` → `<content>` 需要回退扫描）
    let maxTagLen = 0;
    for (const r of config.rules) {
        if (r.start) maxTagLen = Math.max(maxTagLen, r.start.length);
        if (r.end) maxTagLen = Math.max(maxTagLen, r.end.length);
    }

    // 编译高级正则（一次性）
    const compiledRx = config.mode === 'advanced'
        ? config.rx.map((x) => ({ re: compileStreamRegex(x.pattern), pattern: x.pattern })).filter((x) => x.re)
        : [];

    /** 回退窗口扫描起点（覆盖跨帧部分标签）。 */
    function scanStart() {
        return Math.max(0, scanFrom - maxTagLen);
    }

    /** basic：从回退窗口起找最左「未处理」的起始标签。返回 { ruleIndex, index } 或 null。 */
    function findNextStart() {
        let best = null;
        const from = scanStart();
        config.rules.forEach((rule, ruleIndex) => {
            if (!rule.start) return;
            const idx = buffer.indexOf(rule.start, from);
            if (idx !== -1 && !handledStarts.has(idx) && (best === null || idx < best.index)) {
                best = { ruleIndex, index: idx };
            }
        });
        return best;
    }

    /** basic：找 rule 的闭合标签（回退窗口起，未处理）。返回 index 或 -1。 */
    function findRuleEnd(rule) {
        if (!rule.end) return -1;
        const from = scanStart();
        let idx = buffer.indexOf(rule.end, from);
        while (idx !== -1 && handledStarts.has(idx)) {
            idx = buffer.indexOf(rule.end, idx + rule.end.length);
        }
        return idx;
    }

    /** basic：提取含标签整串的闭合段（从 segmentStart 到 end 标签结尾）。 */
    function extractClosedSegment(rule, startIdx, endIdx) {
        if (rule.start && rule.end) return buffer.slice(startIdx, endIdx + rule.end.length);
        if (rule.start) return buffer.slice(startIdx); // 单开始：到末尾（永不闭合，理论不进这里）
        if (rule.end) return buffer.slice(0, endIdx + rule.end.length); // 单结束：开头到标签
        return '';
    }

    /** 高级模式：跨所有正则找最左未处理匹配。返回 { ruleIndex, match } 或 null。 */
    function scanAdvanced() {
        let best = null;
        compiledRx.forEach((entry, ruleIndex) => {
            entry.re.lastIndex = 0;
            const m = entry.re.exec(buffer);
            if (m && !handledStarts.has(m.index) && (best === null || m.index < best.match.index)) {
                best = { ruleIndex, match: m };
            }
        });
        return best;
    }

    /** 单次推进：返回事件数组。一次调用把当前 buffer 里所有已确定的状态转换处理完。 */
    function advance(text) {
        const next = String(text ?? '');
        buffer = next; // 流式只增；变短（防御）以新文本为准
        const events = [];

        if (config.mode === 'advanced') {
            // 高级模式：正则最左匹配即闭合段（贪婪/整段匹配天然要求完整输入）
            if (state === SEGMENT_STATE_IDLE) {
                const found = scanAdvanced();
                if (found) {
                    const segment = found.match[0];
                    closedSegments.push(segment);
                    handledStarts.add(found.match.index);
                    occurrenceCounter++;
                    events.push({ type: SEGMENT_EVENT_CLOSED, ruleIndex: found.ruleIndex, segment, occurrence: occurrenceCounter });
                    state = SEGMENT_STATE_TAIL; // 正则段闭合即接管结束
                }
            }
            scanFrom = buffer.length;
            return events;
        }

        // basic 模式：循环推进（每次处理一个状态转换，直到无可推进）
        let guard = 0;
        while (guard++ < 100) { // 防御：同帧大量连续标签（理论罕见）
            if (state === SEGMENT_STATE_IDLE) {
                const hit = findNextStart();
                if (hit) {
                    currentRuleIndex = hit.ruleIndex;
                    segmentStart = hit.index;
                    state = SEGMENT_STATE_IN;
                    handledStarts.add(hit.index);
                    occurrenceCounter++;
                    currentOccurrence = occurrenceCounter;
                    scanFrom = hit.index + config.rules[hit.ruleIndex].start.length;
                    events.push({
                        type: SEGMENT_EVENT_OPEN,
                        ruleIndex: hit.ruleIndex,
                        segment: buffer.slice(hit.index),
                        occurrence: currentOccurrence,
                    });
                    continue; // 继续找该段闭合
                }
                // 无起始标签：检查单结束规则（只填 end）→ 开头到 end 是一个段
                const singleEnd = config.rules.findIndex((r) => !r.start && r.end);
                if (singleEnd !== -1) {
                    const endIdx = findRuleEnd(config.rules[singleEnd]);
                    if (endIdx !== -1) {
                        const segment = buffer.slice(0, endIdx + config.rules[singleEnd].end.length);
                        closedSegments.push(segment);
                        handledStarts.add(endIdx);
                        occurrenceCounter++;
                        events.push({ type: SEGMENT_EVENT_CLOSED, ruleIndex: singleEnd, segment, occurrence: occurrenceCounter });
                        state = SEGMENT_STATE_CLOSED;
                        currentOccurrence = -1;
                        scanFrom = endIdx + config.rules[singleEnd].end.length;
                        continue; // 同帧继续：闭合后可能紧跟新起始
                    }
                }
                scanFrom = buffer.length; // 无新标签 → 下次只扫新增（回退窗口覆盖跨帧）
                break;
            } else if (state === SEGMENT_STATE_IN) {
                const rule = config.rules[currentRuleIndex];
                if (rule && rule.end) {
                    const endIdx = findRuleEnd(rule);
                    if (endIdx !== -1) {
                        const segment = extractClosedSegment(rule, segmentStart, endIdx);
                        closedSegments.push(segment);
                        handledStarts.add(endIdx);
                        events.push({ type: SEGMENT_EVENT_CLOSED, ruleIndex: currentRuleIndex, segment, occurrence: currentOccurrence });
                        scanFrom = endIdx + rule.end.length;
                        // 闭合 → CLOSED：等待下一个起始标签（多组依次）或交回酒馆（不接管新内容）
                        state = SEGMENT_STATE_CLOSED;
                        currentRuleIndex = null;
                        segmentStart = -1;
                        currentOccurrence = -1;
                        continue;
                    }
                    scanFrom = buffer.length; // 未闭合：等更多 token（段内持续渲染由 getInSegmentText 提供）
                    break;
                }
                // 单开始规则（无 end）：段到末尾，永不闭合；等流式结束（P2 finalize 处理）
                scanFrom = buffer.length;
                break;
            } else if (state === SEGMENT_STATE_CLOSED) {
                // 已闭合：找下一个起始标签（多组依次）；找不到 → 保持 CLOSED（尾部交回酒馆，
                // 不再产 open/closed，P2 据此不接管新内容）
                const hit = findNextStart();
                if (hit) {
                    currentRuleIndex = hit.ruleIndex;
                    segmentStart = hit.index;
                    state = SEGMENT_STATE_IN;
                    handledStarts.add(hit.index);
                    occurrenceCounter++;
                    currentOccurrence = occurrenceCounter;
                    scanFrom = hit.index + config.rules[hit.ruleIndex].start.length;
                    events.push({
                        type: SEGMENT_EVENT_OPEN,
                        ruleIndex: hit.ruleIndex,
                        segment: buffer.slice(hit.index),
                        occurrence: currentOccurrence,
                    });
                    continue;
                }
                scanFrom = buffer.length;
                break;
            } else {
                // TAIL：停止接管（高级模式闭合后；尾部交回酒馆原生通道）
                scanFrom = buffer.length;
                break;
            }
        }
        return events;
    }

    return {
        advance,
        getState: () => state,
        getClosedSegments: () => [...closedSegments],
        /** 当前 IN 段规则索引（非 IN 态 null）。段内渲染不再由调用方猜测规则。 */
        getCurrentRuleIndex: () => currentRuleIndex,
        /** 当前 IN 段出现序号（非 IN 态 -1）。段容器/渲染表按出现序号键控。 */
        getCurrentOccurrence: () => currentOccurrence,
        getInSegmentText: () => {
            if (state !== SEGMENT_STATE_IN || currentRuleIndex === null || segmentStart === -1) return null;
            const rule = config.rules[currentRuleIndex];
            if (!rule || !rule.start) return null;
            return buffer.slice(segmentStart);
        },
        isEmpty: () => isEmptyMatchConfig(config),
    };
}

/**
 * 段状态机推进的便捷包装：把「增量累计文本」逐次喂给检测器，返回本次的
 * 可渲染信息（闭合段事件 + 段内持续渲染文本 + 状态 + 段内规则/序号）。
 * @param {object} detector createSegmentDetector 的实例
 * @param {string} cumulativeText 当前累计文本（含 continue 前缀）
 * @returns {{ events: Array<object>, inSegmentText: string|null, state: string, currentRuleIndex: number|null, currentOccurrence: number }}
 */
export function feedSegmentDetector(detector, cumulativeText) {
    if (!detector || typeof detector.advance !== 'function') {
        return { events: [], inSegmentText: null, state: SEGMENT_STATE_IDLE, currentRuleIndex: null, currentOccurrence: -1 };
    }
    const events = detector.advance(cumulativeText);
    return {
        events,
        inSegmentText: detector.getInSegmentText(),
        state: detector.getState(),
        currentRuleIndex: typeof detector.getCurrentRuleIndex === 'function' ? detector.getCurrentRuleIndex() : null,
        currentOccurrence: typeof detector.getCurrentOccurrence === 'function' ? detector.getCurrentOccurrence() : -1,
    };
}
