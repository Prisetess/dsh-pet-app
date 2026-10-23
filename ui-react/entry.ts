/**
 * 官方设置页入口（A 方案完整形态）
 *
 * 直接把插件自己的 src/client/settings.ts 挂进一个独立窗口：
 *   - 组件工厂 makePetConfigSection({ h, useState, useEffect, useRef, t }) 由插件导出；
 *   - 文案直接用插件自带的 zh 字典（原本由 DSH 的 ctx.locale.bind 提供）；
 *   - petBridge 是插件模块内的同一个单例：current/template 由这里灌，reload 由这里接管。
 *
 * 数据链与 DSH 里完全一致（相对路径 → 同源 → 插件 /dsh-pet-7340/config），
 * 唯一多出来的一步：保存后额外调 /pet-app/rebuild，让本 App 立刻重建宠物窗。
 *
 * 构建：scripts/build-ui-react.mjs（需要 esbuild + react@18 + react-dom@18）。
 */
import { jsx } from 'react/jsx-runtime';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { makePetConfigSection, petBridge, zh } from '../../vendor/plugin/src/client/settings';
import { flattenConfigPets } from '../../vendor/plugin/src/shared/config';

const t = (key: string): string => (zh as Record<string, string>)[key] ?? key;

const Section = makePetConfigSection({
  h: jsx as unknown as (type: unknown, props?: unknown) => unknown,
  useState,
  useEffect,
  useRef,
  t,
});

async function pull(merged?: Record<string, Record<string, unknown>>): Promise<void> {
  const config =
    merged ?? ((await (await fetch('/dsh-pet-7340/config', { cache: 'no-store' })).json()) as Record<string, Record<string, unknown>>);
  petBridge.current = flattenConfigPets(config);
  petBridge.template = petBridge.current.find((pet) => !pet.extra);
}

// 插件设置页保存/同步后会调 petBridge.reload(成品聚合)：这里更新容器数据并让 App 重建宠物窗
petBridge.reload = (merged) => {
  void pull(merged);
  void fetch('/pet-app/rebuild', { method: 'POST' }).catch(() => {});
};

async function main(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('缺少 #root');
  try {
    await pull();
  } catch (error) {
    root.innerHTML = `<p style="color:#ff8a84;font:13px/1.6 sans-serif">加载配置失败：${
      error instanceof Error ? error.message : String(error)
    }</p>`;
    return;
  }
  createRoot(root).render(jsx(Section, { close: () => window.close() }) as never);
}

void main();
