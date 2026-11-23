import { useEffect, useSyncExternalStore } from "react";

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
