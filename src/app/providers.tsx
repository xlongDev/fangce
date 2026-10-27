import type { ReactNode } from "react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { useState } from "react";

import { useTheme } from "@/hooks/useTheme";
import { createLogger, describeError } from "@/lib/log";
import { showToast } from "@/stores/toasts";

const log = createLogger("mutation");

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: 1 },
        },
        // The one place a failed write gets named. Most mutations carry no
        // `onError` of their own, so without this a note, bookmark or reading
        // position that fails to save fails silently. A mutation that already
        // shows the reason next to the control it came from opts out with
        // `meta: { silent: true }`.
        mutationCache: new MutationCache({
          onError: (error, _variables, _context, mutation) => {
            if (mutation.meta?.silent) return;
            const { message } = describeError(error);
            log.error("写入失败", { message });
            showToast("error", message);
          },
        }),
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <MotionConfig reducedMotion="user">
        <ThemeSync />
        {children}
      </MotionConfig>
    </QueryClientProvider>
  );
}

function ThemeSync() {
  useTheme();
  return null;
}
