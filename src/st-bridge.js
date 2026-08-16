// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 ReikoYuzuka

/**
 * st-bridge.js —— 集中导入 SillyTavern 全局模块，供管道 / 数据层使用。
 *
 * 设计动机：
 *   - 引擎核心（src/engine/*）是纯函数，可 node 直接测试，不依赖 ST。
 *   - 管道 / 数据层需要 ST 全局（script.js / extensions.js / preset-manager.js 等），
 *     全部集中在此一处相对路径导入；其余模块只 import 本桥，避免散落深度相对路径。
 *   - node --test 只测纯函数模块（scripts-core / rp-mode 纯逻辑 / pipeline/pure），
 *     不 import 本桥，因此测试可离线运行。
 *
 * 路径基准：本文件位于 .../public/scripts/extensions/third-party/rp-hub-compat/src/。
 */

// public/script.js（5 级上溯：src → rp-hub-compat → third-party → extensions → scripts → public）
export {
    chat,
    characters,
    this_chid,
    chatElement,
    chat_metadata,
    saveSettingsDebounced,
    saveChatConditional,
    messageFormatting,
    substituteParams,
    substituteParamsExtended,
    reloadCurrentChat,
    getCurrentChatId,
} from '../../../../../script.js';

// public/scripts/（4 级上溯）
export { extension_settings, renderExtensionTemplateAsync, writeExtensionField } from '../../../../extensions.js';
export { event_types, eventSource } from '../../../../events.js';
export { power_user } from '../../../../power-user.js';
export { getPresetManager } from '../../../../preset-manager.js';
export { trimSpaces } from '../../../../utils.js';
