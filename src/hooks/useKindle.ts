import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc } from "@/lib/ipc";
import type { KindleConfig } from "@/lib/bindings";

/** Browser dev mode has no SMTP relay; the settings form still needs a shape.
 *  Also the fallback when a config sealed by another build cannot be opened. */
export const EMPTY_KINDLE_CONFIG: KindleConfig = {
  smtpHost: "",
  smtpPort: 465,
  username: "",
  password: "",
  kindleEmail: "",
};

/** Persisted send-to-Kindle config. It only changes on the settings page. */
export function useKindleConfig() {
  return useQuery<KindleConfig>({
    queryKey: ["kindle", "config"],
    queryFn: desktopQuery(EMPTY_KINDLE_CONFIG, () => ipc.kindleGetConfig()),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Saves the form; the query then shows the stored, normalized values. */
export function useSaveKindleConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: KindleConfig) => ipc.kindleSetConfig(config),
    meta: { silent: true },
    onSuccess: (saved) => {
      queryClient.setQueryData(["kindle", "config"], saved);
      // The banner checks every sealed row, not just this one. Re-check after
      // replacing a credential so it clears when the last old seal is gone.
      void queryClient.invalidateQueries({ queryKey: ["system", "secrets"] });
    },
  });
}

/** Pushes one EPUB. Errors are shown by the shared mutation toast. */
export function useSendToKindle() {
  return useMutation({
    mutationFn: (id: string) => ipc.bookSendToKindle(id),
    meta: { silent: false },
  });
}
