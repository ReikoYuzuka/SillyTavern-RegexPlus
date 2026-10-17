// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * RP-Hub 兼容插件 · 自研正则引擎 —— 扩展入口（第二部：事件管道 + 数据层 + 正则面板）
 *
 * 本文件是 SillyTavern 扩展的入口（manifest.json 的 `hooks.activate` -> `init`）。
 *
 * 结构：
 *   index.js                    本入口：初始化数据层 + 挂载管道事件 + 挂载正则面板
 *   src/engine/*                引擎核心（纯函数，可 node 测试）
 *   src/store/scripts.js        三类脚本存储读写 + 合并（Global→Preset→Scoped）
 *   src/store/rp-mode.js        formatDetail 判定（后端 /v1/cards/by-name 匹配 + 缓存 + 降级）
 *   src/pipeline/*              事件管道：显示/prompt/编辑三通道 + 宏注入 + 渲染衔接
 *   src/panel/*                 正则面板 UI（jQuery 复刻原版，挂 #regex_container）
 *
 * 构建方式：纯 ESM 无构建（ST 以 script.type='module' 注入扩展脚本）。
 *   - 引擎核心与管道纯函数（pure.js / scripts-core.js / rp-mode.js / panel/logic-core.js
 *     /panel/debugger-core.js 纯逻辑）可 `node --test` 离线测试；
 *     ST 全局（st-bridge.js / panel/ui.js）仅在浏览器加载。
 */

import { engine } from './src/engine/engine.js';
import * as pipeline from './src/pipeline/index.js';
import * as panel from './src/panel/ui.js';
import { runtime } from './src/pipeline/runtime.js';
import { mountCompatApi } from './src/pipeline/force-render.js';
import { rphubCompatPromptInterceptor } from './src/pipeline/prompt.js';
import { getFormatDetail, clearModeCache } from './src/store/rp-mode.js';
import { getRegexScripts } from './src/store/scripts.js';
import { characters, this_chid } from './src/st-bridge.js';
import { initStreamService } from './src/stream/stream-service.js';
import { initLegacyStreamHook } from './src/stream/legacy-hook.js';

/**
 * 扩展激活入口（由 ST hooks.activate 调用）。
 */
export async function init() {
    if (typeof engine?.run !== 'function') {
        console.error('[rp-hub-compat] 引擎核心加载失败：engine.run 不存在。');
        return;
    }

    // REG-01：不再自动写入 ST 正则白名单（preset_allowed_regex / character_allowed_regex）。
    //   旧实现在启动/APP_READY/CHAT_CHANGED/PRESET_CHANGED 时无条件把当前预设名与卡 avatar
    //   push 进白名单并落盘——覆盖用户在面板「不允许」的显式选择，且曾把 "{{char}}.png" 之类
    //   模板残留（X-7）写进 character_allowed_regex。白名单写入职责回归用户显式操作：
    //   面板保存 scoped/preset 脚本时的 allowScopedScripts/allowPresetScripts（panel/ui.js）
    //   与 SPreset 自身的注入逻辑。本引擎管道不依赖白名单（getRegexScripts allowedOnly=false）。
    //   若用户未允许某预设/卡，仅 ST 原生显示通道会跳过其内嵌正则（与原版 ST 行为一致）。

    // 注册 generate_interceptor（F3，审查报告 L3/D7）：manifest.json 的 generate_interceptor 字段
    // 指向本全局函数，ST 在 script.js:4505（coreChat 组装后）逐条调用 —— prompt 通道 per-message
    // placement/depth 恢复（原版 script.js:4444-4445 逐字复刻）。
    try {
        if (typeof globalThis.rphubCompatPromptInterceptor !== 'function') {
            globalThis.rphubCompatPromptInterceptor = rphubCompatPromptInterceptor;
        }
    } catch {
        console.warn('[rp-hub-compat] 无法注册 generate_interceptor（prompt 通道将走 GENERATE_AFTER_DATA 兜底整段处理）。');
    }

    // 数据层自检：三类脚本可读、模式可判定（不阻塞）
    try {
        const info = await getFormatDetail({ avatar: characters?.[this_chid]?.avatar, name: characters?.[this_chid]?.name });
        const mode = info.formatDetail;
        const scripts = getRegexScripts({ allowedOnly: true, mode });
        console.debug(`[rp-hub-compat] 当前角色模式：${mode}，合并脚本数：${scripts.length}。`);
    } catch (error) {
        console.warn('[rp-hub-compat] 数据层自检失败（不阻塞管道挂载）：', String(error?.message || error));
    }

    // 挂载管道（显示/prompt/编辑 + 宏注入 + 事件）
    await pipeline.init();

    // 挂载 ST 卡流式即时正则拦截器（还原原版 ST 正则随写随擦流式体验）
    initLegacyStreamHook();

    // 挂载流式实时渲染服务（P2：STREAM_TOKEN_RECEIVED 段状态机 + DOM 回插。
    // 开关 rp_hub_stream_render_enabled 默认关闭 → 零介入；开启后流式期间段级渲染）
    initStreamService();

    // 挂载正则面板（#regex_container，dropdown 三分类 + 预设分组 + 编辑器 + 调试器）
    try {
        await panel.init();
    } catch (error) {
        console.error('[rp-hub-compat] 正则面板初始化失败（不阻塞引擎管道）：', String(error?.message || error));
    }

    // 挂全局入口 window.__rphubCompat__（第三部「强制重新渲染」按钮调用）：
    //   clearModeCache —— 清 formatDetail 内存缓存（30 分钟 TTL，后端标记变化后立即可见）
    //   forceRerenderAll —— 遍历聊天逐条重算 + 围栏化 + 覆盖 DOM（后台执行不卡 UI）
    mountCompatApi();

    console.debug('[rp-hub-compat] 事件管道已启动。宏注入：ST substituteParams/substituteParamsExtended。');
}
