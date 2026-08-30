import type { AppPhase, SkillLevel } from "../domain/types";

export function queryRequired<T extends Element>(
  root: ParentNode,
  selector: string,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required element not found: ${selector}`);
  }
  return element;
}

export function topbar(step: string): string {
  return `
    <header class="page-topbar">
      <div class="brand-mini" aria-label="英语商业街">
        <span class="brand-mark" aria-hidden="true">EHS</span>
        <span>英语商业街</span>
      </div>
      <span class="step-label">${step}</span>
    </header>
  `;
}

export function viewportWarning(): string {
  return `
    <aside class="viewport-warning" role="alert">
      <div>
        <strong>请放大浏览器窗口</strong>
        <span>首个 MVP 为桌面版本，需要至少 960 × 540 的可用空间。</span>
      </div>
    </aside>
  `;
}

export const phaseLabels: Record<AppPhase, string> = {
  landing: "首页",
  onboarding: "选择辅助模式",
  preview: "今日准备",
  buyer: "向供货商进货",
  restock: "补货",
  store: "接待顾客",
  settlement: "当日结算",
  upgrade: "店铺升级",
  complete: "首日完成",
};

export const levelLabels: Record<SkillLevel, string> = {
  unseen: "未接触",
  exposed: "已接触",
  guided: "提示后完成",
  independent: "独立完成",
  variant: "变式完成",
};
