import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { desktopQuery, ipc } from "@/lib/ipc";
import type { KindleConfig } from "@/lib/bindings";

/** Browser dev mode has no SMTP relay; the settings form still needs a shape. */
const OFFLINE_CONFIG: KindleConfig = {
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
    queryFn: desktopQuery(OFFLINE_CONFIG, () => ipc.kindleGetConfig()),
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
