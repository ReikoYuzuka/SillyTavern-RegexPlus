/**
 * engine/trigger-bridge.js —— triggerSlash 语义分发桥（供显示通道围栏化注入）。
 *
 * 背景（与第三部 tavern_helper_template 的 生成triggerSlash桥脚本 同步，改动需两侧一致）：
 *   RP-Hub 卡内脚本（正则生成的界面 / 模板界面）里 `window.triggerSlash(text)` 语义 =
 *   「把 text 当用户消息发出 + 触发生成」（RP-Hub app.js:8423-8440），而酒馆助手（TH）
 *   注入 iframe 的 `triggerSlash` 是 ST slash 命令执行器 —— 对不以 / 开头或非注册命令的
 *   纯文本（如魔物娘世界「构筑命运」按钮的 `/构筑命运完毕！以下是我的选择：\n【性别】…`）
 *   会抛 SlashCommandParserError「Unknown command」。
 *
 * 本桥把 iframe 内 `window.triggerSlash` 包装成语义分发器：
 *   - `/` 开头且是已注册 slash 命令 → 转发原版（TH/ST 执行器，/ 命令路径不受破坏）；
 *   - 其余（纯文本 / 以 `/` 开头但非注册命令）→ `sendUserMessage`（发消息+生成，对齐 RP-Hub）。
 * 另挂 ST 主窗口 `window.parent.triggerSlash`（模板脚本直调）与 data-slash 点击委托。
 *
 * 本模块是纯函数 + 纯字符串，node 可单测，不依赖 DOM / ST 全局。
 */

/**
 * 生成 triggerSlash 语义分发桥脚本（JS 函数体，不含 <script> 标签）。
 * 与第三部 模板渲染.ts 的 生成triggerSlash桥脚本 逐字同步，改动时两边必须一致。
 * @returns {string}
 */
export function 生成triggerSlash桥脚本() {
    return `(function () {
  var host = window.parent;

  function isGeneratingNow() {
    var dg = false;
    try {
      dg = !!(host && host.document && host.document.body && host.document.body.dataset &&
        host.document.body.dataset.generating === 'true');
    } catch (e) { dg = false; }
    if (dg) return true;
    if (host && host.__rpGenerating === true) {
      var since = host.__rpGeneratingSince || 0;
      if (Date.now() - since > 300) {
        host.__rpGenerating = false;
      } else {
        return true;
      }
    }
    return false;
  }

  function toastGenerating() {
    try {
      var t = (host && host.toastr) || window.toastr;
      if (t && typeof t.warning === 'function') t.warning('正在生成中，请稍后...');
    } catch (e) {}
  }

  function runGeneration() {
    var p = null;
    try {
      if (host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function') {
        var c = host.SillyTavern.getContext();
        if (c && typeof c.executeSlashCommandsWithOptions === 'function') {
          p = c.executeSlashCommandsWithOptions('/trigger');
        }
      }
    } catch (e) {}
    if (p === null) {
      try {
        if (host && host.TavernHelper && typeof host.TavernHelper.triggerSlash === 'function') {
          p = host.TavernHelper.triggerSlash('/trigger');
        }
      } catch (e) {}
    }
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  function sendUserMessage(text) {
    if (isGeneratingNow()) { toastGenerating(); return false; }
    try {
      var ctx = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      if (!ctx || !ctx.chat || typeof ctx.chat.push !== 'function') return false;
      var msg = {
        name: ctx.name1 || '',
        is_user: true,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: String(text),
        extra: {}
      };
      ctx.chat.push(msg);
      var id = ctx.chat.length - 1;
      if (typeof ctx.saveChat === 'function') { try { ctx.saveChat(); } catch (e) {} }
      var et = ctx.eventTypes || {};
      if (ctx.eventSource) { try { ctx.eventSource.emit(et.MESSAGE_SENT || 'message_sent', id); } catch (e) {} }
      if (typeof ctx.addOneMessage === 'function') { try { ctx.addOneMessage(msg); } catch (e) {} }
      if (ctx.eventSource) { try { ctx.eventSource.emit(et.USER_MESSAGE_RENDERED || 'user_message_rendered', id); } catch (e) {} }
      runGeneration();
      return true;
    } catch (e) { return false; }
  }

  function isRegisteredSlash(s) {
    var m = s.match(/^\\/([^\\s|]+)/);
    if (!m) return false;
    var name = m[1].toLowerCase();
    try {
      var c = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      var table = c && c.SlashCommandParser ? c.SlashCommandParser.commands : null;
      if (!table) return true;
      return Object.prototype.hasOwnProperty.call(table, name);
    } catch (e) { return true; }
  }

  function makeDispatcher(original) {
    return function (text) {
      var s = String(text || '').trim();
      if (!s) return;
      if (s.charAt(0) === '/' && isRegisteredSlash(s)) {
        if (typeof original === 'function') return original(text);
        if (host && host.TavernHelper && typeof host.TavernHelper.triggerSlash === 'function') {
          return host.TavernHelper.triggerSlash(text);
        }
        return sendUserMessage(text);
      }
      return sendUserMessage(text);
    };
  }

  if (!window.__rpTriggerSlashDispatch) {
    window.__rpTriggerSlashDispatch = true;
    window.triggerSlash = makeDispatcher(typeof window.triggerSlash === 'function' ? window.triggerSlash : null);
    try {
      var ctx0 = host && host.SillyTavern && typeof host.SillyTavern.getContext === 'function'
        ? host.SillyTavern.getContext() : null;
      if (ctx0 && ctx0.eventSource && ctx0.eventTypes) {
        var et0 = ctx0.eventTypes;
        var onGS = function () { try { host.__rpGenerating = true; host.__rpGeneratingSince = Date.now(); } catch (e) {} };
        var onGE = function () { try { host.__rpGenerating = false; } catch (e) {} };
        ctx0.eventSource.on(et0.GENERATION_STARTED || 'generation_started', onGS);
        ctx0.eventSource.on(et0.GENERATION_ENDED || 'generation_ended', onGE);
      }
    } catch (e) {}
  }

  try {
    if (host && typeof host.triggerSlash !== 'function') {
      host.triggerSlash = makeDispatcher(null);
    }
  } catch (e) {}

  if (!window.__rpDataSlashDelegate) {
    window.__rpDataSlashDelegate = true;
    window.addEventListener('click', function (event) {
      var t = event.target && event.target.closest && event.target.closest('[data-slash]');
      if (t) {
        event.preventDefault();
        var c = t.getAttribute('data-slash');
        if (c && window.triggerSlash) window.triggerSlash(c);
      }
    });
  }

  // ---- DOMContentLoaded 兜底（与第三部 生成DCL兜底脚本 同步）----
  if (!window.__rpDCLGuard) {
    window.__rpDCLGuard = true;
    window.__rpDCLFired = false;
    document.addEventListener('DOMContentLoaded', function () {
      window.__rpDCLFired = true;
    });
    function rpTryDispatchDCL() {
      try {
        if (!window.__rpDCLFired && document.readyState === 'complete') {
          window.__rpDCLFired = true;
          document.dispatchEvent(new Event('DOMContentLoaded'));
        }
      } catch (e) {}
    }
    var rpDclTries = 0;
    var rpDclTimer = setInterval(function () {
      rpTryDispatchDCL();
      rpDclTries++;
      if (window.__rpDCLFired || rpDclTries > 17) clearInterval(rpDclTimer);
    }, 300);
  }
})();`;
}

/**
 * 把 triggerSlash 语义分发桥注入到完整 HTML 文档内（幂等，仅交互文档注入）。
 * 注入位置与第三部 注入模板兼容层 对齐：<head> 后 → <html> 后 → <!doctype> 后 → 前置。
 * 仅注入桥脚本（不含 reset 样式 —— reset 是模板兼容层职责，正则卡正文由作者样式自管）。
 * ⚠️ 条件注入：仅当 HTML 含 triggerSlash / data-slash 交互标记才注入 —— 纯状态面板等
 * 无交互文档不加 ~2KB 桥（既有围栏化输出逐字节不变，避免无谓膨胀）。
 * @param {string} html 完整 HTML 文档（或片段骨架）
 * @returns {string} 注入桥后的 HTML
 */
export function injectTriggerBridge(html) {
    const 内容 = String(html ?? '');
    if (内容.includes('__rpDataSlashDelegate')) return 内容; // 幂等
    if (!/triggerSlash|data-slash/i.test(内容)) return 内容; // 无交互 → 不注入
    const 桥 = `<script>
${生成triggerSlash桥脚本()}
<\/script>`;
    const 头部匹配 = 内容.match(/<head\b[^>]*>/i);
    if (头部匹配) {
        const 索引 = 头部匹配.index + 头部匹配[0].length;
        return 内容.slice(0, 索引) + 桥 + 内容.slice(索引);
    }
    const html标签 = 内容.match(/<html([^>]*)>/i);
    if (html标签) {
        const 索引 = html标签.index + html标签[0].length;
        return 内容.slice(0, 索引) + 桥 + 内容.slice(索引);
    }
    const 文档声明 = 内容.match(/(\s*<!doctype html>\s*)/i);
    if (文档声明) {
        const 索引 = 文档声明.index + 文档声明[0].length;
        return 内容.slice(0, 索引) + 桥 + 内容.slice(索引);
    }
    return 桥 + 内容;
}
