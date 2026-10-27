import { AnimatePresence, motion } from "motion/react";
import { CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/cn";
import { useMotion } from "@/lib/motion";
import { useToasts, type ToastTone } from "@/stores/toasts";

const TONE: Record<ToastTone, { icon: typeof X; accent: string }> = {
  error: { icon: WarningCircle, accent: "text-danger" },
  success: { icon: CheckCircle, accent: "text-success" },
};

/**
 * Failure and confirmation messages, bottom-right.
 *
 * Rendered beside the router rather than inside a page: the shell's panes are
 * `backdrop-filter` elements, which become the containing block for `fixed`
 * children and clip them at the pane's edge.
 */
export function Toaster() {
  const toasts = useToasts((state) => state.toasts);
  const dismiss = useToasts((state) => state.dismiss);
  const navigate = useNavigate();
  const m = useMotion();

  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2"
      data-toaster
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const { icon: Icon, accent } = TONE[toast.tone];
          const action = toast.action;
          return (
            <motion.div
              key={toast.id}
              layout={!m.reduce}
              initial={{ opacity: 0, y: m.rise, scale: m.reduce ? 1 : 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: m.reduce ? 0 : 4, scale: m.reduce ? 1 : 0.98 }}
              transition={m.enter}
              role={toast.tone === "error" ? "alert" : "status"}
              aria-live={toast.tone === "error" ? "assertive" : "polite"}
              className="glass-liquid pointer-events-auto flex items-start gap-2.5 rounded-lg p-3"
            >
              <Icon size={18} className={cn("mt-px shrink-0", accent)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-text-1 text-[13px] leading-relaxed break-words">
                  {toast.message}
                </p>
                {/* The fix is one click from the complaint. A reader told their
                    key was rejected should not have to remember that keys live
                    under 设置 › AI 助手. */}
                {action && (
                  <button
                    type="button"
                    onClick={() => {
                      navigate(action.to);
                      dismiss(toast.id);
                    }}
                    className="text-accent hover:text-accent/80 focus-visible:focus-ring mt-1.5 rounded-md text-[12px] font-medium transition-colors duration-150"
                  >
                    {action.label}
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                aria-label="关闭提示"
                className="text-text-3 hover:text-text-1 focus-visible:focus-ring -mt-0.5 -mr-0.5 shrink-0 rounded-md p-1 transition-colors duration-150"
              >
                <X size={14} aria-hidden />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
