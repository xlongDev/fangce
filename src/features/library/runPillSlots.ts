import { useMemo, useEffect, useState, useSyncExternalStore } from "react";
import type { MotionProps } from "motion/react";

import { DURATION, EASE_OUT, useMotion } from "@/lib/motion";

/**
 * The three batch-run pills share one stack just above the shelf's batch bar.
 *
 * Fixed per-pill offsets left a lone pill floating far above the bar, while an
 * empty slot above it wasted the space. Slots are assigned to the pills that
 * are actually on screen, so one run sits lowest and two never overlap.
 */
const ORDER = ["guide", "fill", "tag"] as const;
export type RunPillId = (typeof ORDER)[number];

const mounted = new Set<RunPillId>();
const listeners = new Set<() => void>();
let snapshot = "";

function publish() {
  snapshot = ORDER.filter((id) => mounted.has(id)).join(",");
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

/**
 * 88px clears the batch bar (`bottom-6` + ~50px) with ~14px of air. A pill is
 * ~50px, up to ~66px when the guide adds its news line, hence 68px per slot.
 */
export function runPillBottom(slot: number): number {
  return 88 + slot * 68;
}

export function useRunPillSlot(id: RunPillId, visible: boolean): number {
  useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    if (!visible) return;
    mounted.add(id);
    publish();
    return () => {
      mounted.delete(id);
      publish();
    };
  }, [id, visible]);
  const index = ORDER.filter((present) => mounted.has(present)).indexOf(id);
  return visible ? Math.max(0, index) : 0;
}

/**
 * 折叠徽章的「探头」：默认只留图标，指针或键盘聚焦才把计数横向弹出。
 *
 * 三条通知条共用这一套，避免 hover、focus 与点击的语义各自漂移。状态留在
 * 组件本地，不进 store —— 它只是这一瞬间的呈现，不属于跑批进度。
 */
export function useRunPillPeek(collapsed: boolean) {
  const [peek, setPeek] = useState(false);
  return {
    /** 折叠且没探头时，计数列收成 0 宽。 */
    countHidden: collapsed && !peek,
    /** 摊到徽章上；展开态拿到也无害，因为 `countHidden` 已经忽略 peek。 */
    peekHandlers: {
      onMouseEnter: () => setPeek(true),
      onMouseLeave: () => setPeek(false),
      onFocus: () => setPeek(true),
      onBlur: () => setPeek(false),
    },
    /** 点「折叠」时调用：指针还在徽章上，别闪一下空徽章。 */
    keepPeek: () => setPeek(true),
  };
}

/**
 * 三条通知条共用的动画定义。
 *
 * 🔴 之前每条各自复制一份 `ease/transition/fold/surface`，改一处就会漏掉
 * 另外两处 —— 用户看到的「动画不一致」就是这么来的。曲线、时长、过渡属性
 * 和入场弹簧都集中在这里，三条只能一起变。
 */
export function useRunPillMotion() {
  const m = useMotion();
  return useMemo(() => {
    const ease = `cubic-bezier(${EASE_OUT.join(", ")})`;
    const transition = (properties: string[]) =>
      m.reduce
        ? "none"
        : properties.map((property) => `${property} ${DURATION.base}s ${ease}`).join(", ");
    return {
      /** 横向收放与 hover 探头：列宽、行高、负边距、透明度。 */
      fold: transition(["grid-template-columns", "grid-template-rows", "margin-left", "opacity"]),
      /** 胶囊外壳：内边距、间距、圆角跟着一起变，不会出现长度在动而高度跳变。 */
      surface: transition(["padding", "gap", "border-radius"]),
      /** 浮层出现/退场：直接摊到 motion.div 上。 */
      entrance: {
        initial: { opacity: 0, y: m.reduce ? 0 : 12 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: m.reduce ? 0 : 12 },
        transition: m.panel,
      } satisfies MotionProps,
    };
  }, [m]);
}
