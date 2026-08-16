// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * engine/html-fence.js —— HTML 围栏化（显示通道渲染层动作）。
 *
 * 背景（界面按钮点不动诊断.md 方案 A / 模板全量验证报告.md）：
 *   卡面界面 HTML 不带 ``` 围栏时，ST messageFormatting 会把它当普通内容渲染 →
 *   DOMPurify 剥掉 <script>/onclick/addEventListener、class 加 custom- 前缀、p 残留
 *   + flex 居中被破坏 → 界面只留外观、按钮没有任何点击逻辑（点不动）。
 *   把【完整 HTML 文档】包上 ```html 围栏后：ST markdown 转成 <pre><code
 *   class="language-html"> → 酒馆助手 isFrontend（代码块文本含 `html>`/`<head`/`<body`）
 *   命中 → 包 div.TH-render → iframe 原样渲染 → 卡自带脚本可执行 → 作者样式生效。
 *
 * 对齐原版（RP-Hub runtime-services.js renderMarkdown 第一分支）：
 *   原版是「任意位置检测 + 提取完整文档段单独 iframe 化，前后文本正常 markdown」——
 *   不是开头判定 + 整段处理。已查证（runtime-services.js:277-299）：
 *     const htmlMatch = trimmed.match(/(<!doctype html>|<html\b[^>]*>)/i);
 *     if (htmlMatch && !trimmed.includes('```')) {
 *       startIndex = htmlMatch.index;                 // 只取第一个 match
 *       closeIndex = trimmed.toLowerCase().lastIndexOf('</html>');
 *       hasCloseTag = closeIndex > startIndex;
 *       endIndex = hasCloseTag ? closeIndex + '</html>'.length : trimmed.length;
 *       htmlContent = trimmed.substring(startIndex, endIndex);
 *       preText / postText → markdown 正常渲染；htmlContent → iframe
 *     }
 *   第 2 分支：纯 div/table/section 等开头且无 ```（无完整文档）→ 不 iframe，内联渲染。
 *
 *   关键差异（本版上一实现的 bug，用户实测）：与妹生活 rph_display = [div 正文美化
 *   片段] + [<!DOCTYPE html>…状态面板完整文档] 两个正则产物拼接。上一版「div 开头 →
 *   补骨架围栏」把整个拼接文本包进 <body>，造成 <body> 内嵌 <!DOCTYPE html> 非法
 *   嵌套 → 酒馆助手 iframe 渲染失败 → 只剩 TH-render 壳 + 转义代码块（无 iframe）。
 *   本版对齐原版：任意位置检测完整文档 → 只把文档段围栏化，div 正文保留在前文本
 *   走 ST markdown（对齐原版内联行为）；纯 div/table 片段（无完整文档）不围栏。
 *
 * 设计约束：
 *   - 纯函数、零依赖、node 可单测。
 *   - 只在显示通道输出端（display.js coverMessage 内 fenceForMode）调用，不写回
 *     rph_display 缓存 —— 缓存保持引擎原始输出，围栏化是渲染层动作，重算一致性
 *     （recomputeDecision 与缓存逐字节比较）不受围栏影响。
 *   - 不进正则池 / 不动保护替换（protect.js 只保护已存在的代码块，与本文无关）。
 *   - 短路精确化（方案 c）：`includes('```')` 不再一键短路 —— 先配对检测是否存在
 *     「完整文档代码块」（内容含 <!doctype/<html 且命中 TH isFrontend），有则只给
 *     其开围栏前补空行（修复 showdown 吞 fenced code 起始 → TH iframe 化），
 *     无则原样短路（幂等保留）。div 配平 / srcdoc 转义不在该分支做（见
 *     normalizeFencedDocBlankLines 注释）。
 */

import { injectTriggerBridge } from './trigger-bridge.js';

/**
 * 完整 HTML 文档开头标记（任意位置检测，对齐原版 renderMarkdown 第一分支）：
 * `<!doctype html>` 或 `<html ...>`。注意 <html\b> 排除 <htmlx> 这类畸形标记。
 */
const FULL_HTML_MATCH_RE = /(<!doctype html>|<html\b[^>]*>)/i;

/**
 * HTML 界面片段开头特征：以 <style / <script / <iframe 开头（CSS/JS/iframe 容器）。
 * 对齐方案A 渲染器的 isFrontend 兜底判定：这类片段是「美化界面」而非普通 markdown，
 * ST DOMPurify（script.js:1904 ADD_TAGS 仅 custom-style）会剥 iframe/script/onclick
 * → 需补骨架围栏进 iframe 才能存活。
 * - iframe：不死斩 CBB 世界观动画 = 正则产物 `<iframe srcdoc="...">` 开头（潜意识同步
 *   报告，findRegex <<cyberpunk_immortal_blade_opening>>）→ 不围栏则被 ST 剥（实测消失）
 * - 普通 markdown 正文不会以 <style/<script/<iframe 开头（含 < 会被转义），不误伤。
 */
const FRAGMENT_STYLE_SCRIPT_RE = /^\s*<(?:style|script|iframe)\b/i;

/**
 * 文本是否以 <style>/<script>/<iframe 开头的「前端片段」（会被 fenceFullHtml 补骨架围栏）。
 * 供 pure.js isEngineRenderedDom 复用（A1 修复：前端片段判定与围栏化分支对齐，避免两处正则漂移）。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isFragmentFrontend(text) {
    return FRAGMENT_STYLE_SCRIPT_RE.test(String(text ?? ''));
}

/**
 * 片段界面开头特征（对齐原版 renderMarkdown 三类 iframe 判据，runtime-services.js:237/252）：
 * 以块级容器标签 div/span/table/img/section/article/aside/header/footer/nav/main 开头。
 * ⚠️ 不含 <!doctype/<html/<head/<body（完整文档，由 FULL_HTML_MATCH_RE 处理）也不含
 * <style/<script/<iframe（由 FRAGMENT_STYLE_SCRIPT_RE 无条件围栏）——本判据只补
 * 「带交互/样式标记的块级片段界面」（ZZZ 状态栏 div / 阅读器 article 等）。
 */
const FRAGMENT_INTERFACE_START_RE = /^\s*<(div|span|table|img|section|article|aside|header|footer|nav|main)\b/i;

/**
 * 片段界面「交互/样式标记」：含 class / onclick / <script / data-slash / addEventListener / <style。
 * 守卫：避免误围栏「纯 style div」——与妹生活正文美化容器只有 style 属性、无 class/交互，
 * ST DOMPurify 保留 style 属性、内联渲染即可，无需 iframe 化（保持正文可选中复制）。
 */
const FRAGMENT_INTERFACE_MARKER_RE = /(class\s*=|onclick\s*=|<\s*script\b|data-slash\s*=|addEventListener|<\s*style\b)/i;

/**
 * 文本是否为「片段界面」（以 UI 标签开头 且 含交互/样式标记）→ 应围栏 iframe 化。
 * 对齐原版：原版靠宽松 cleanConfig 内联渲染（class/onclick/script 都保留），本渲染器无法改
 * ST DOMPurify → 只能 iframe 化来保住这些标记。纯 style div 不含这些标记 → 保持内联。
 * @param {unknown} text
 * @returns {boolean}
 */
export function isFragmentInterface(text) {
    const s = String(text ?? '');
    return FRAGMENT_INTERFACE_START_RE.test(s) && FRAGMENT_INTERFACE_MARKER_RE.test(s);
}

/** 骨架围栏（补 <!DOCTYPE html> 让酒馆助手 isFrontend 命中 html>）：片段界面无 <html>/<head>/<body>，
 * 裸围栏后 isFrontend 扫不到 → 必须补 doctype 骨架。 */
function 骨架围栏(html) {
    return `\n\n\`\`\`html\n<!DOCTYPE html>\n${escapeSrcdocEntities(injectTriggerBridge(html))}\n\`\`\`\n\n`;
}

/**
 * 酒馆助手 isFrontend 命中标记（对齐 is_frontend.ts：html> / <head> / <body）。
 * - <head> 带闭合尖括号（宽松的 <head 会误命中 <header>）
 * - <body 不带闭合尖括号（TH 原版如此）
 * 用于短路精确化：判定围栏代码块是否为「可 iframe 化的前端界面」。
 */
const FRONTEND_MARKER_RE = /(html>|<head>|<body)/;

/** 内容是否命中酒馆助手 isFrontend 标记（html> / <head> / <body）。 */
function hasFrontendMarker(content) {
    return FRONTEND_MARKER_RE.test(content);
}

/** 代码块文本是否为「完整 HTML 文档」（含 <!doctype/<html 标记且命中 isFrontend）。 */
function isFullDocBlockText(block) {
    return FULL_HTML_MATCH_RE.test(block) && hasFrontendMarker(block);
}

/**
 * 围栏代码块是否为「完整 HTML 文档」。
 * @param {string} text 全文
 * @param {number} open ``` 开围栏索引
 * @param {number} close ``` 闭围栏索引
 */
function isFullDocFencedBlock(text, open, close) {
    return isFullDocBlockText(text.slice(open + 3, close));
}

/**
 * 在开围栏前补一个空行（fenced code 识别要求：围栏前必须有空白行，
 * 否则 ``` 被当普通文本渲染，<pre> 不生成 → TH isFrontend 扫不到）。
 * 幂等：p 在文本开头、p 前已是空行分隔（\n\n 或空行 + \n）→ 零改动。
 *
 * @param {string} text 当前文本
 * @param {number} p ``` 开围栏索引
 * @returns {string} 可能插入 '\n\n' 后的文本
 */
function ensureBlankLineBefore(text, p) {
    if (p <= 0) return text;
    const lastNl = text.lastIndexOf('\n', p - 1);
    if (lastNl !== -1) {
        const prefix = text.slice(lastNl, p);
        if (prefix === '\n' || /^\n\s*$/.test(prefix)) {
            // 围栏位于行首（或行首带缩进）：检查上一行是否为空行
            const prevLastNl = text.lastIndexOf('\n', lastNl - 1);
            if (prevLastNl === -1) {
                if (/^\s*$/.test(text.slice(0, lastNl))) return text; // 第一行为空 → 已空行
            } else if (/^\s*$/.test(text.slice(prevLastNl, lastNl))) {
                return text; // 上一行为空 → 已空行
            }
            // 行尾换行后插入一个 '\n' 形成空行（围栏行保持行首）
            return text.slice(0, lastNl + 1) + '\n' + text.slice(lastNl + 1);
        }
    }
    // 围栏紧跟非换行内容：直接插 '\n\n'
    return text.slice(0, p) + '\n\n' + text.slice(p);
}

/**
 * 短路精确化（方案 c，围栏短路精确化-可行性与影响.md）：含 ``` 围栏文本的处理。
 *
 * 背景：旧实现 `text.includes('```')` 一键短路 → 新形态「HTML 容器 div（未闭合）+
 * 内部完整文档代码块」整段不围栏 → showdown 把 fenced code 起始吞进未闭合 div 的
 * HTML 块 → <pre> 不生成 → 酒馆助手 isFrontend 扫不到 → 渲染炸。
 * 实测根因（76KB 真实数据 node showdown 模拟）：容器 div 与 ``` 之间无空行。
 *
 * 本函数：
 *   1. 按 ``` 配对扫描（偶数索引开围栏、奇数索引闭围栏；奇数个时最后一个视为
 *      无闭开围栏），检查是否存在「完整文档代码块」；
 *   2. 无 → 原样短路（幂等保护完全保留：普通 markdown / js / css / 反引号文本）；
 *   3. 有 → 只给完整文档代码块的开围栏前补空行（已空行跳过，二次调用幂等），
 *      不改任何内容。
 *   div 配平 / srcdoc 转义不在本分支做（新形态 div 数量平衡；escapeSrcdocEntities
 *   非幂等，保短路幂等优先）。
 *
 * @param {string} text 含 ``` 的文本
 * @returns {string} 规整后文本（无完整文档代码块时原样）
 */
function normalizeFencedDocBlankLines(text) {
    const positions = [];
    let idx = 0;
    while ((idx = text.indexOf('```', idx)) !== -1) {
        positions.push(idx);
        idx += 3;
    }
    const pairs = Math.floor(positions.length / 2);
    // 检测是否存在完整文档代码块
    let hasFullDoc = false;
    for (let i = 0; i < pairs; i++) {
        if (isFullDocFencedBlock(text, positions[i * 2], positions[i * 2 + 1])) {
            hasFullDoc = true;
            break;
        }
    }
    if (!hasFullDoc && positions.length % 2 === 1) {
        const last = positions[positions.length - 1];
        if (isFullDocBlockText(text.slice(last + 3))) hasFullDoc = true;
    }
    if (!hasFullDoc) return text;
    // 只给完整文档块的开围栏前补空行（从后往前插入，避免索引偏移）
    let out = text;
    for (let i = pairs - 1; i >= 0; i--) {
        if (isFullDocFencedBlock(text, positions[i * 2], positions[i * 2 + 1])) {
            out = ensureBlankLineBefore(out, positions[i * 2]);
        }
    }
    if (positions.length % 2 === 1) {
        const last = positions[positions.length - 1];
        if (isFullDocBlockText(text.slice(last + 3))) {
            out = ensureBlankLineBefore(out, last);
        }
    }
    return out;
}

/**
 * 围栏化 HTML（对齐原版 renderMarkdown 第一分支的提取语义）：
 *   text 中【任意位置】匹配到完整 HTML 文档标记（<!doctype html> 或 <html…>）
 *   且不含 ``` 围栏时：
 *     - 提取完整文档段（从 match 起始到 </html> 闭合；无闭合取到末尾）；
 *     - 文档段单独包 ```html 围栏（酒馆助手 isFrontend → iframe 化）；
 *     - 前后文本（preText/postText）保持原样（走 ST markdown 渲染，对齐原版内联）。
 *   纯片段（div/table 等开头但无完整文档）→ 不围栏（对齐原版第 2 分支内联渲染）。
 *   幂等：非 HTML / 空串 / 非字符串 → 原样；含 ``` 但无完整文档代码块 → 原样。
 *
 * @param {unknown} text 待检测文本
 * @returns {unknown|string}
 *   - 非字符串 / 空串 → 原样返回
 *   - 已含 ``` 围栏（任意位置）：无完整文档代码块 → 原样（幂等短路，不重复包、
 *     不产生嵌套围栏）；有完整文档代码块 → 仅给其开围栏前补空行（修复 showdown
 *     吞 fenced code 起始，代码块内容不改，二次调用幂等）
 *   - 无完整文档标记 → 原样返回（纯片段内联，不围栏）
 *   - 完整文档段 → 前文本 + '```html\n' + 文档段 + '\n```' + 后文本
 */
/**
 * div 配平修复（与妹生活类卡，用户实测「状态栏被包进正文」）。
 *
 * 根因：卡美化正则的拼接产物 = div 正文片段（未闭合）+ 完整文档 + 游离 </div> ——
 * 正则把闭合标签挤到了文档段后面。围栏化把文档段单独包 ```html 围栏后，未闭合的
 * <div> 会把 <pre><code>（状态面板围栏）也吞进正文容器 → 状态栏显示在正文美化容器
 * 内部（被渐变背景/圆角包住）。原版 RP-Hub 无此问题：其 renderMarkdown 对 preText
 * 走 DOMPurify.sanitize（自动补全未闭合标签），div 先被修复闭合、文档段才独立渲染。
 *
 * 本函数对齐该语义：preText 缺 N 个 </div> 时在围栏前补 N 个；postText 前导剥离
 * 等量游离 </div>（那些闭合本属于 preText，被挤到文档段后面）。
 * 启发式（div 计数基于 <div\b / </div> 字面匹配）：仅影响「缺失闭合」的拼接场景，
 * 配平 / 纯文本 / 无文档的 pre 零改动。
 *
 * @param {string} preText 文档段前文本
 * @param {string} postText 文档段后文本
 * @returns {{ preText: string, postText: string }}
 */
function balanceDivBeforeFence(preText, postText) {
    // H2 修复：剔除 HTML 注释与自闭合 <div/> 后再计数，避免注释/脚本字符串/散文本内的 <div 误判配平
    // （与第三部 模板渲染.ts 配平div闭合 同步镜像，改动需两侧一致）。
    const clean = String(preText)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<div\b[^>]*\/>/gi, '');
    const opens = (clean.match(/<div\b/gi) || []).length;
    const closes = (clean.match(/<\/div>/gi) || []).length;
    const missing = opens - closes;
    if (missing <= 0) return { preText, postText };
    let fixedPost = postText;
    for (let i = 0; i < missing; i++) {
        const m = fixedPost.match(/^\s*<\/div>\s*/);
        if (!m) break;
        fixedPost = fixedPost.slice(m[0].length);
    }
    return { preText: preText + '</div>'.repeat(missing), postText: fixedPost };
}

/**
 * srcdoc 双重实体转义（绝区零状态栏空渲染修复，独立审查报告 §5 方向 A）。
 *
 * 根因链（绝区零状态栏-独立审查.md §4）：围栏化把卡文档变 code 块文本 → ST showdown
 * 转义（&lt; → &amp;lt;）→ ST「&amp; 还原」（script.js:1889-1891）把 code 块内双重转义
 * 打平 → DOMPurify → 酒馆助手 code.text() 解码成裸字符 → createSrcContent 塞进外层
 * srcdoc → 浏览器解析属性时裸引号截断嵌套 srcdoc → 空文档 8px 塌陷（状态栏不渲染）。
 * 原版不经 ST 管线（文本直通 srcdoc）天然免疫；本函数在围栏化前把文档内 iframe 的
 * srcdoc 属性值实体再翻倍一层（& → &amp;），使 ST 层层打平后恰好恢复为浏览器所需的
 * 单重实体形式 —— 以「代码块源码里 srcdoc 显示为 &amp;lt;（双重实体）」的可读性损失
 * 换取嵌套 srcdoc 卡界面正常渲染（用户已确认接受）。
 *
 * 仅匹配双引号包裹的 srcdoc 属性（真实卡如此）；单引号/无引号变体不处理（已知局限）。
 *
 * @param {string} html 文档段文本
 * @returns {string} srcdoc 属性值实体翻倍后的文本
 */
function escapeSrcdocEntities(html) {
    return String(html).replace(/(<iframe\b[^>]*\bsrcdoc=")([^"]*)(")/gi, (match, pre, value, post) => (
        pre + value.replace(/&/g, '&amp;') + post
    ));
}

/**
 * H4 修复：混合形态兜底 —— 文本已含 ``` 围栏时，旧短路分支只补空行，会漏掉
 * 「围栏区间之外的裸完整文档」。
 * 背景（与妹生活 #4）：预设（阶段①）产出**已围栏**的思维链/选项完整文档，卡内嵌 ui
 * 脚本（阶段②）产出**未围栏**的状态面板完整文档 —— 三者并存时，旧短路把状态面板漏出
 * 围栏机制 → ST DOMPurify 清洗 → title 变文本、class 加 custom-、居中丢失。
 * 本函数：按 ``` 配对找出围栏区间，对区间之外的「裸完整文档」（<!doctype html>/<html>
 * 到 </html>）逐个补 ```html 围栏（含 srcdoc 转义 + div 配平，对齐无 ``` 分支语义）。
 * 幂等：已围栏的完整文档在 ``` 区间内不被再围栏；二次调用无裸文档 → 零改动。
 * @param {string} text
 * @returns {string}
 */
function fenceUnfencedFullDocs(text) {
    const str = String(text);
    // 1. ``` 配对区间（偶数开、奇数闭；奇数个时末尾视为无闭开围栏，不参与区间配对）
    const positions = [];
    let idx = 0;
    while ((idx = str.indexOf('```', idx)) !== -1) { positions.push(idx); idx += 3; }
    // 2. 围栏区间之外的 gap（未围栏区）：逐个 ``` 交替「开/闭」切分
    //    - 偶数个 ```（成对）→ 首尾 + 每对闭合之间的文本是 gap；
    //    - 奇数个 ```（末尾是未闭合开围栏）→ 末尾开围栏之后的内容视为「围栏内」，不算 gap
    //      （否则会把「单开围栏尾部完整文档」误围栏，破坏 normalizeFencedDocBlankLines 语义）。
    const gaps = [];
    let gapStart = 0;
    let isOpen = true;
    for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        if (isOpen) {
            if (p > gapStart) gaps.push({ start: gapStart, end: p });
        } else {
            gapStart = p + 3;
        }
        isOpen = !isOpen;
    }
    if (positions.length % 2 === 0 && gapStart < str.length) {
        gaps.push({ start: gapStart, end: str.length });
    }
    // 3. 每个 gap 内找「片段界面」（整段骨架围栏）或「裸完整文档」，收集待围栏区间
    const 待围栏 = [];
    for (const gap of gaps) {
        const gapText = str.slice(gap.start, gap.end);
        // 3a. 片段界面（<style/<script/<iframe 开头，或 div/span/... 开头且含 class/onclick/script
        //     标记）→ 整段骨架围栏（补 <!DOCTYPE html> 让酒馆助手 isFrontend 命中，否则 div 片段
        //     iframe 化失败）。对齐原版：原版靠宽松 cleanConfig 内联，本渲染器只能 iframe 化。
        if (FRAGMENT_STYLE_SCRIPT_RE.test(gapText) || isFragmentInterface(gapText)) {
            待围栏.push({ start: gap.start, end: gap.end, type: 'fragment' });
            continue;
        }
        // 3b. 裸完整文档 → 逐个围栏（从后往前处理，避免 index 偏移）
        let seg = gapText;
        let offset = 0;
        while (seg.length > 0) {
            const m = seg.match(FULL_HTML_MATCH_RE);
            if (!m) break;
            const relStart = m.index ?? 0;
            const relClose = seg.toLowerCase().indexOf('</html>', relStart);
            if (relClose === -1) break;
            const relEnd = relClose + '</html>'.length;
            待围栏.push({ start: gap.start + offset + relStart, end: gap.start + offset + relEnd, type: 'doc' });
            offset += relEnd;
            seg = seg.slice(relEnd);
        }
    }
    if (待围栏.length === 0) return str;
    // 4. 从后往前围栏（避免 index 偏移）
    待围栏.sort((a, b) => b.start - a.start);
    let out = str;
    for (const seg of 待围栏) {
        const raw = out.substring(seg.start, seg.end);
        // 片段界面 → 骨架围栏（补 <!DOCTYPE html>）；完整文档 → 裸 ```html 围栏（文档自带 doctype）
        const 围栏段 = seg.type === 'fragment' ? 骨架围栏(raw) : ('\n\n```html\n' + escapeSrcdocEntities(injectTriggerBridge(raw)) + '\n```\n\n');
        let preText = out.substring(0, seg.start);
        let postText = out.substring(seg.end);
        // 空包裹 div 兜底：full doc 紧跟在「开 div 且无文本（仅自闭合 div/空白）」之后 →
        // 该 div 是「正文美化容器」误包 full doc 的空壳（外层 div + 内层左竖条自闭合 div）。
        // 移除空骨架（而非补 </div>），否则围栏化后会留下空正文美化容器。
        const 空div = preText.match(/(<div\b[^>]*>(?:<div\b[^>]*><\/div>|\s)*)$/);
        if (空div) {
            preText = preText.slice(0, 空div.index);
            postText = postText.replace(/^\s*<\/div>/, '');
        } else {
            ({ preText, postText } = balanceDivBeforeFence(preText, postText));
        }
        out = preText + 围栏段 + postText;
    }
    return out;
}

export function fenceFullHtml(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (text.includes('```')) {
        // 短路精确化（方案 c）+ H4：先围栏「围栏外的裸完整文档」，再给所有完整文档围栏补空行
        return normalizeFencedDocBlankLines(fenceUnfencedFullDocs(text));
    }
    const htmlMatch = text.match(FULL_HTML_MATCH_RE);
    if (!htmlMatch) {
        // 无完整文档：界面片段 → 补 <!DOCTYPE html> 骨架围栏（让酒馆助手 isFrontend 命中 →
        // iframe 化 → class/onclick/script 存活；ST 清洗剥 script/改名 class 的问题解决）。
        //   - <style/<script/<iframe 开头：无条件围栏（CSS/JS/iframe 容器，原有判据）；
        //   - div/article/span/table/img 开头且含 class/onclick/script 等标记：片段界面围栏（原版判据）。
        // 纯 style div（正文美化容器）不含标记 → 保持内联（正文可选中复制）。
        if (FRAGMENT_STYLE_SCRIPT_RE.test(text) || isFragmentInterface(text)) {
            return 骨架围栏(text);
        }
        return text;
    }
    const startIndex = htmlMatch.index;
    const closeTag = '</html>';
    const closeIndex = text.toLowerCase().lastIndexOf(closeTag);
    const hasCloseTag = closeIndex !== -1 && closeIndex > startIndex;
    const endIndex = hasCloseTag ? closeIndex + closeTag.length : text.length;
    // srcdoc 双重实体转义（嵌套 iframe 状态栏修复，方向 A）：ST 管线层层打平后
    // 恰好恢复为浏览器所需的单重实体，嵌套 srcdoc 不被裸引号截断。
    const htmlContent = escapeSrcdocEntities(injectTriggerBridge(text.substring(startIndex, endIndex)));
    let preText = text.substring(0, startIndex);
    let postText = hasCloseTag ? text.substring(endIndex) : '';
    // div 配平：pre 缺闭合 → 围栏前补；post 游离闭合 → 剥离（状态栏不被正文 div 吞）
    ({ preText, postText } = balanceDivBeforeFence(preText, postText));
    // 围栏前后必须补空行：marked 的 fenced code block 要求前后有空白行才识别为 <pre><code>，
    // 否则 ``` 被当普通文本渲染（<p>```html</p>）→ 酒馆助手 isFrontend 扫不到 → 无 iframe。
    return preText + '\n\n```html\n' + htmlContent + '\n```\n\n' + postText;
}

/**
 * 模式门控围栏化：仅 rphub 模式启用（与 rphub 语义同步；st 模式原样透传，行为不变）。
 * 由显示通道输出端（display.js coverMessage）调用，mode 取自 runtime.getMode()。
 * 幂等：已带围栏 / 非 HTML 开头 → 原样（委托 fenceFullHtml 语义）。
 *
 * @param {string} text 显示文本
 * @param {string} [mode] 语义模式 'rphub' | 'st' | 'unknown'…
 * @returns {string} mode === 'rphub' 时围栏化后的文本；否则原样
 */
export function fenceForMode(text, mode) {
    return mode === 'rphub' ? fenceFullHtml(text) : text;
}
