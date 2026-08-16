// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * stream/segment-render.js —— 流式段级渲染（排除规则预处理 + 引擎段级调用 + 内存渲染表）。
 *
 * 对应可行性报告 §5.3：
 *   - 排除规则预处理：对「提取出的段文本」逐条应用（hide/delete/replace 三动作，
 *     语义对齐 engine.js applyScopeLocator / applyOutsideSegments，§4.3），再交给引擎；
 *   - 引擎段级调用：复用 runtime.engineRun（同一脚本集/解释器/预算/预检/渲染模式），
 *     不新增 engine.run 变体 —— 引擎本体零改造（报告 §2.1）；
 *   - 渲染为 HTML：与正式链路 coverMessage 同路径（fenceForMode + renderDisplayHtml），
 *     使流式期间呈现的段结果与结束后正式渲染同段结果尽可能一致（防闪烁关键）；
 *   - 不写持久化缓存：段渲染结果只存【内存段渲染表】Map<messageId, Array<{segmentType,
 *     html}>>，绝不写 msg.extra.rph_display / display_text / rph_display_fp / rph_done
 *     （这些仍由正式链路管理，避免流式中间态污染持久化数据，§5.3 要点）。
 *
 * 排除规则应用（applyStreamExcludes）为纯函数（node 可测）；引擎调用封装
 * （renderSegment）依赖 runtime / renderDisplayHtml，浏览器环境才可用。
 */

/**
 * 对段文本逐条掩蔽排除规则（纯函数，node 可测）。
 * 三动作语义（对齐 engine.js §4.3 映射）：
 *   - hide（藏走）：匹配段保留原样，但对该条隐藏 —— 用于段级渲染时"引擎看不到"的内容。
 *     hide 语义 = 匹配段用占位符掩蔽（记录 { ph, seg }），**引擎跑掩蔽文本**，
 *     输出上再还原占位符（对齐 applyOutsideSegments 的掩蔽-处理-还原）；
 *   - delete（删除）：匹配段从输出中去掉（replace 为空）。
 *   - replace（替换）：匹配段替换为指定文本（replace 为空 = 删除）。
 *
 * 顺序应用、并集语义（对齐 applyScoped engine.js:388-402：后一条在前一条输出上执行）。
 * 应用时机：**剥离标签之前**（对含标签整串的段文本应用，标签型 pattern 才能命中；
 * 段文本由 S1 统一为含标签整串，与正式链路同一输入形态）。
 *
 * @param {string} text 段文本（含标签整串）
 * @param {Array<{pattern:string, action:'hide'|'delete'|'replace', replace?:string|null}>} excludes
 *   排除规则（settings.normalizeStreamExcludes 归一值）
 * @returns {{ text: string, placeholders: Array<{ ph: string, seg: string }> }}
 *   掩蔽后的文本 + hide 占位符表（调用方在引擎输出上 restoreStreamPlaceholders 还原）
 */
export function maskStreamExcludes(text, excludes = []) {
    let out = String(text ?? '');
    const placeholders = [];
    const rules = Array.isArray(excludes) ? excludes : [];
    for (const rule of rules) {
        if (!rule || typeof rule !== 'object') continue;
        const pattern = String(rule.pattern ?? '');
        if (!pattern) continue;
        let re;
        try { re = new RegExp(pattern, 'g'); } catch { continue; } // 编译失败跳过（归一已剔除，防御）
        const action = rule.action === 'delete' || rule.action === 'replace' ? rule.action : 'hide';
        if (action === 'delete') {
            out = out.replace(re, () => '');
        } else if (action === 'replace') {
            out = out.replace(re, () => (typeof rule.replace === 'string' ? rule.replace : ''));
        } else {
            // hide：掩蔽（占位符全局唯一计数），引擎看不到段内内容
            let counter = placeholders.length;
            out = out.replace(re, (seg) => {
                const ph = `\u0001RP_STREAM_${counter}\u0001`;
                placeholders.push({ ph, seg });
                counter++;
                return ph;
            });
        }
    }
    return { text: out, placeholders };
}

/** 还原 hide 占位符（在引擎输出文本上逐条 split/join）。 */
export function restoreStreamPlaceholders(text, placeholders = []) {
    let out = String(text ?? '');
    for (const { ph, seg } of placeholders) {
        out = out.split(ph).join(seg);
    }
    return out;
}

/**
 * 对段文本逐条应用排除规则（纯函数，node 可测；保留 applyFn 注入语义供测试/纯逻辑复用）。
 * hide 在无 applyFn 时 = 掩蔽后原样还原（对输出无影响）；renderSegment 内使用
 * maskStreamExcludes + 引擎执行 + restoreStreamPlaceholders 的正确三段式。
 *
 * @param {string} text 段文本
 * @param {Array<{pattern:string, action:'hide'|'delete'|'replace', replace?:string|null}>} excludes
 *   排除规则（settings.normalizeStreamExcludes 归一值）
 * @param {object} [opts]
 * @param {Function} [opts.applyFn] 注入的引擎执行函数（默认 = 原样返回，纯测试用）
 * @returns {string} 处理后的段文本
 */
export function applyStreamExcludes(text, excludes = [], { applyFn } = {}) {
    const { text: maskedText, placeholders } = maskStreamExcludes(text, excludes);
    const processed = applyFn ? applyFn(maskedText) : maskedText;
    return restoreStreamPlaceholders(processed, placeholders);
}

/**
 * 流式定格段与正式渲染文本拼合（纯函数，node 可测；S1 方向 A）。
 * 正式链路引擎输出（rph_display）中 content 标签由清洗规则藏走后**拼回原位**（engine.js:955），
 * 因此输出文本里段区间由字面 startTag/endTag 界定 —— 用流式定格段的 engineText 替换该区间，
 * 使「正文段区间用流式结果，其余用正式结果」，消除两条链路锚定上下文差异导致的跳变。
 * 从后往前替换避免索引漂移；区间已一致则跳过（幂等）。
 *
 * @param {string} text 正式链路引擎输出文本（含标签整串，未围栏化/未 HTML 化）
 * @param {Array<{ occurrence?: number, startTag: string, endTag: string, engineText: string }>} segments
 *   流式定格段（getFinalizedSegments 输出形态）
 * @returns {{ text: string, spliced: boolean }}
 */
/**
 * 🔴-3 修复：给每个段附「同标签序号」（tagOrdinal，0 起）。
 * occurrence 是检测器的**全局**段序号（跨不同标签规则依次 0/1/2…，见 segment-detector.js
 * occurrenceCounter），而定位第 N 个 startTag 需要的是「该 startTag 内的第几个」。故按
 * occurrence 升序、对每个 startTag 分别计数，得到 tagOrdinal：同标签多段（如两个 <content>）
 * 分别得到 0/1，异标签（think→content）各自得到 0——两者都能正确定位。
 */
function withTagOrdinals(list) {
    const counter = new Map();
    return [...list]
        .sort((a, b) => (a.occurrence ?? 0) - (b.occurrence ?? 0))
        .map((seg) => {
            const tag = seg.startTag;
            const ord = counter.get(tag) ?? 0;
            counter.set(tag, ord + 1);
            return { ...seg, tagOrdinal: ord };
        });
}

export function spliceSegmentRegions(text, segments = []) {
    let out = String(text ?? '');
    let spliced = false;
    const list = (Array.isArray(segments) ? segments : [])
        .filter((s) => s && s.startTag && s.endTag && typeof s.engineText === 'string');
    if (list.length === 0) return { text: out, spliced };
    // 先算同标签序号，再按 occurrence 降序从后往前替换（索引稳定）
    const sorted = withTagOrdinals(list).sort((a, b) => (b.occurrence ?? 0) - (a.occurrence ?? 0));
    for (const seg of sorted) {
        // 🔴-3 修复：按「同标签序号」定位第 N 个 startTag（同标签多段时不能再只找第一个）
        const s = nthIndexOfTagIn(out, seg.startTag, seg.tagOrdinal, 0);
        if (s === -1) continue; // 标签被改写/剥离 → 放弃该段拼合（回退正式渲染）
        const e = indexOfTagIn(out, seg.endTag, s + seg.startTag.length);
        if (e === -1) continue;
        const end = e + seg.endTag.length;
        if (out.slice(s, end) === seg.engineText) continue; // 已一致
        out = out.slice(0, s) + seg.engineText + out.slice(end);
        spliced = true;
    }
    return { text: out, spliced };
}

/**
 * 流式定格段与正式渲染文本的「跳过」合并（问题 3 方案 A，用户拍板）：
 * 正式链路引擎输出中 content 段区间（startTag..endTag **含标签**）**整体删除** ——
 * content 段成品由兄弟容器（.rph-stream-segment）呈现，`.mes_text` 只渲染思维链+尾部，
 * 不二次渲染正文段、不写进 `.mes_text`。从后往前删除避免索引漂移；无匹配跳过。
 *
 * @param {string} text 正式链路引擎输出文本（含标签整串，未围栏化/未 HTML 化）
 * @param {Array<{ occurrence?: number, startTag: string, endTag: string, engineText?: string }>} segments
 *   流式定格段（getFinalizedSegments 输出形态；engineText 在本函数中不需要）
 * @returns {{ text: string, skipped: boolean }}
 */
export function removeSegmentRegions(text, segments = []) {
    let out = String(text ?? '');
    let skipped = false;
    const list = (Array.isArray(segments) ? segments : [])
        .filter((s) => s && s.startTag && s.endTag);
    if (list.length === 0) return { text: out, skipped };
    // 先算同标签序号，再按 occurrence 降序从后往前删除（索引稳定）
    const sorted = withTagOrdinals(list).sort((a, b) => (b.occurrence ?? 0) - (a.occurrence ?? 0));
    for (const seg of sorted) {
        // 🔴-3 修复：按「同标签序号」定位第 N 个 startTag（同标签多段时不能再只找第一个）
        const s = nthIndexOfTagIn(out, seg.startTag, seg.tagOrdinal, 0);
        if (s === -1) continue; // 标签被改写/剥离 → 放弃该段跳过（回退正式渲染）
        const e = indexOfTagIn(out, seg.endTag, s + seg.startTag.length);
        if (e === -1) continue;
        const end = e + seg.endTag.length;
        out = out.slice(0, s) + out.slice(end);
        skipped = true;
    }
    return { text: out, skipped };
}

/** 找 text 中 from 起的第一个匹配（原始或 HTML 转义变体）。返回索引或 -1。 */
function indexOfTagIn(text, tag, from = 0) {
    if (!tag) return -1;
    const esc = tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const i1 = text.indexOf(tag, from);
    const i2 = esc !== tag ? text.indexOf(esc, from) : -1;
    if (i1 === -1) return i2;
    if (i2 === -1) return i1;
    return Math.min(i1, i2);
}

/**
 * 找 text 中 from 起的第 n 次（0 起）匹配（原始或 HTML 转义变体）。返回索引或 -1。
 * 🔴-3 修复：同标签多段（如两个 <content>）按 occurrence 定位第 N 个标签——
 * 原实现只从 0 找第一个，导致从后往前替换时后段先替换掉前段区间、且 spliced 恒 true 非幂等。
 * 与 indexOfTagIn 一致处理原始/转义变体，并按其实际匹配长度前进（防转义变体内部误匹配）。
 */
function nthIndexOfTagIn(text, tag, n = 0, from = 0) {
    if (!tag) return -1;
    const esc = tag.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const count = Math.max(0, Number(n) || 0);
    let pos = Math.max(0, Number(from) || 0);
    for (let i = 0; i <= count; i++) {
        const i1 = text.indexOf(tag, pos);
        const i2 = esc !== tag ? text.indexOf(esc, pos) : -1;
        let idx = -1;
        let matchedLen = tag.length;
        if (i1 === -1) idx = i2;
        else if (i2 === -1) idx = i1;
        else if (i1 < i2) idx = i1;
        else { idx = i2; matchedLen = esc.length; }
        if (idx === -1) return -1;
        if (i === count) return idx;
        pos = idx + matchedLen;
    }
    return -1;
}

/**
 * 空白归一匹配（问题 2 修复：流式原文隐藏的正文定位）。
 * 把 haystack / needle 的连续空白（含换行、多空格）视为单个空格后，找 needle 在
 * haystack 中的首次匹配，返回**真实索引**（映射回原始文本位置）。
 * 背景：ST 每帧 markdown 渲染后，正文在 `.mes_text` 的 textContent 里块级元素间换行
 * 消失、前导/连续空白被折叠 —— 直接 indexOf(段原文开头片段) 会失配（诊断问题 2 根因）。
 * @param {string} haystack 被搜文本（如 .mes_text textContent）
 * @param {string} needle 目标片段（如正文开头若干字符）
 * @returns {number} 命中返回 haystack 中匹配起点真实索引；未命中 -1
 */
export function normalizedIndexOf(haystack, needle) {
    const n = String(needle ?? '').replace(/\s+/g, ' ').trim();
    if (!n) return -1;
    const src = String(haystack ?? '');
    let norm = '';
    const map = []; // norm 每字符 → src 真实索引
    let pendingSpace = false;
    let pendingSpaceReal = -1;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (/\s/.test(ch)) {
            if (!pendingSpace && norm.length > 0) {
                pendingSpace = true;
                pendingSpaceReal = i;
            }
            continue;
        }
        if (pendingSpace) {
            norm += ' ';
            map.push(pendingSpaceReal);
            pendingSpace = false;
        }
        norm += ch;
        map.push(i);
    }
    const idx = norm.indexOf(n);
    return idx === -1 ? -1 : map[idx];
}

/** 从 from 起的第 n 次（1 起）空白归一匹配；返回真实索引或 -1（occurrence 定位用）。 */
export function nthNormalizedIndexOf(haystack, needle, n = 1, from = 0) {
    const src = String(haystack ?? '');
    const count = Math.max(1, Number(n) || 1);
    let pos = Math.max(0, Number(from) || 0);
    const needleLen = String(needle ?? '').replace(/\s+/g, ' ').trim().length;
    for (let i = 0; i < count; i++) {
        const rel = normalizedIndexOf(src.slice(pos), needle);
        if (rel === -1) return -1;
        pos += rel;
        if (i < count - 1) pos += Math.max(1, needleLen);
    }
    return pos;
}

/**
 * 段级渲染入口（浏览器侧；依赖 runtime / renderDisplayHtml）。
 * 与正式链路同源：runtime.engineRun（runtime.js:149-169 注入全部 options）+ 
 * fenceForMode（html-fence.js:291-293）+ renderDisplayHtml（render.js:33-48）。
 *
 * S1（方向 A）：段文本传**含标签整串**（`<content>正文</content>`，与正式链路同一输入形态，
 * content 标签由引擎清洗规则自然藏走/拼回）—— 两条链路引擎输入同形，输出才可能同态。
 * 排除规则在剥离标签**之前**应用（标签型 pattern 可命中）；hide 用「掩蔽 → 引擎跑掩蔽
 * 文本 → 输出还原占位符」三段式（引擎看不到段内内容，输出原样保留）。
 *
 * @param {object} args
 * @param {string} args.text           段文本（含标签整串，对齐整条消息输入形态）
 * @param {number} args.messageId      消息 id（深度/角色/渲染参数来源）
 * @param {Array} [args.excludes]      排除规则（缺省 []）
 * @param {object} [args.runtime]      运行时注入（缺省用默认 runtime —— 浏览器环境）
 * @param {object} [args.render]       renderDisplayHtml 注入（测试可注入 fake）
 * @param {Function} [args.fence]      fenceForMode 注入（测试可注入 fake）
 * @returns {Promise<{ html: string, via: string, raw: string, engineText: string }|null>}
 *   失败（无 runtime / 引擎异常）→ null（调用方降级为不接管该段）
 *   engineText = 引擎输出文本（hide 占位符已还原；未围栏化/未 HTML 化）—— 供正式链路
 *   拼合（S1）复用，保证「流式中途 = 完整回复后」同态。
 */
export async function renderSegment({ text, messageId = -1, excludes = [], runtime: rt = null, render = null, fence = null } = {}) {
    const segmentText = String(text ?? '');
    if (!segmentText) return null;
    const runtimeObj = rt; // 缺省由调用方（P2 接线）注入；此处不 import runtime 保持可测

    // 1. 排除规则预处理（hide/delete/replace；hide 掩蔽并记录占位符，引擎跑掩蔽文本）
    const { text: preprocessed, placeholders } = maskStreamExcludes(segmentText, excludes);

    // 2. 引擎段级调用（复用 runtime.engineRun；无 runtime → 直接返回原文占位，调用方决定）
    if (!runtimeObj || typeof runtimeObj.engineRun !== 'function') {
        const noEngineText = restoreStreamPlaceholders(preprocessed, placeholders);
        return { html: noEngineText, via: 'no-engine', raw: segmentText, engineText: noEngineText };
    }
    let mode = 'st';
    try {
        mode = typeof runtimeObj.getMode === 'function' ? await runtimeObj.getMode() : 'st';
    } catch {
        mode = 'st';
    }
    const scripts = typeof runtimeObj.getScripts === 'function' ? runtimeObj.getScripts(mode) : [];
    let result;
    try {
        result = runtimeObj.engineRun({
            text: preprocessed,
            scripts,
            mode,
            isDisplay: true,
            placement: 2, // AI_OUTPUT（regex_placement）
            depth: typeof runtimeObj.computeDepth === 'function' ? runtimeObj.computeDepth(messageId) : undefined,
            characterOverride: runtimeObj.chat?.[messageId]?.name,
        });
    } catch (e) {
        console.warn('[rp-hub-compat] 流式段级渲染引擎调用失败：', e instanceof Error ? e.message : e);
        return null;
    }
    // hide 占位符在**引擎输出**上还原（引擎看不到段内内容，输出原样保留）
    const engineText = restoreStreamPlaceholders(typeof result?.text === 'string' ? result.text : preprocessed, placeholders);

    // 3. 渲染为 HTML（与 coverMessage 同路径）
    const fenceFn = fence && typeof fence === 'function' ? fence : (t, m) => (m === 'rphub' ? t : t);
    const text2 = fenceFn(engineText, mode);
    const renderFn = render && typeof render === 'function' ? render : null;
    let html = text2;
    let via = 'plain';
    if (renderFn) {
        try {
            const out = renderFn({ text: text2, messageId, msg: runtimeObj.chat?.[messageId] ?? {}, messageFormatting: runtimeObj.messageFormatting });
            if (out && typeof out.html === 'string') { html = out.html; via = out.via || 'plain'; }
        } catch (e) {
            console.warn('[rp-hub-compat] 流式段级渲染 HTML 化失败（回退原文）：', e instanceof Error ? e.message : e);
        }
    }
    return { html, via, raw: segmentText, engineText };
}

/**
 * 内存段渲染表（Map<messageId, Array<{ segmentType, occurrence, html, engineText, raw,
 * startTag?, endTag?, closed? }>>）。
 * 只存内存，不写持久化（msg.extra 由正式链路管理）。
 *
 * 键控（S3）：同（segmentType, occurrence）覆盖；`closed=true` 写入时移除同 occurrence 的
 * 段内预览条目（'in'）—— 保证每条消息每个出现序号至多一个条目（闭合后表内即定格结果，
 * observer 兜底重建不会再用旧预览）。
 */
export function createSegmentRenderTable() {
    const table = new Map();
    return {
        /**
         * 追加/覆盖某消息的一段渲染结果。
         * extra 透传：{ occurrence, startTag, endTag, engineText, closed }。
         * occurrence = 段出现序号（S3：多段依次 0/1/2…，供段容器/隐藏/拼合键控）。
         * closed=true 时移除同 occurrence 的 'in' 预览条目（定格取代预览）。
         */
        set(messageId, segmentType, html, raw, extra = {}) {
            if (!table.has(messageId)) table.set(messageId, []);
            const list = table.get(messageId);
            const occurrence = extra.occurrence ?? 0;
            if (extra.closed === true) {
                for (let i = list.length - 1; i >= 0; i--) {
                    if (list[i].segmentType === 'in' && (list[i].occurrence ?? 0) === occurrence) {
                        list.splice(i, 1);
                    }
                }
            }
            const existing = list.findIndex((e) => e.segmentType === segmentType && (e.occurrence ?? 0) === occurrence);
            const entry = { segmentType, html, raw, ...extra };
            if (existing !== -1) list[existing] = entry; // 同（段类型 + 出现序号）覆盖（节流持续渲染 → 定格）
            else list.push(entry);
        },
        /** 读取某消息全部段渲染结果。 */
        get(messageId) {
            return table.get(messageId) ?? [];
        },
        /** 删除某消息的全部段渲染结果（MESSAGE_DELETED / 结束清理）。 */
        delete(messageId) {
            table.delete(messageId);
        },
        /** 清空全部（GENERATION_STOPPED / abort 兜底）。 */
        clear() {
            table.clear();
        },
        /** 内部 Map（测试/诊断用）。 */
        raw: table,
    };
}
