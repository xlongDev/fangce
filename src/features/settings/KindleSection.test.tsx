import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { KindleSection } from "./KindleSection";
import type { KindleConfig } from "@/lib/bindings";

/** The config is a query, but what this file pins is the rendering decision:
 *  a sealed config the current build cannot open must still leave a form the
 *  reader can fill in — and a jump target for the settings rail. */
const { BLANK } = vi.hoisted(() => ({
  BLANK: {
    smtpHost: "",
    smtpPort: 465,
    username: "",
    password: "",
    kindleEmail: "",
  },
}));

let config: KindleConfig | undefined;
let failed = false;

vi.mock("@/hooks/useKindle", () => ({
  EMPTY_KINDLE_CONFIG: BLANK,
  useKindleConfig: () => ({
    data: config,
    isError: failed,
    error: failed ? new Error("凭据不是本程序写入的格式") : null,
    dataUpdatedAt: 0,
  }),
  useSaveKindleConfig: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/ipc", () => ({ isDesktopRuntime: true }));
vi.mock("@/hooks/useSystemInfo", () => ({
  useSecretsStatus: () => ({ data: { available: true, detail: null } }),
}));

beforeEach(() => {
  config = { ...BLANK };
  failed = false;
});

const group = () => document.querySelector('[data-section="kindle"]');

describe("KindleSection", () => {
  it("renders the form once a config has loaded", () => {
    render(<KindleSection />);
    expect(group()).not.toBeNull();
    expect(screen.getByLabelText("Kindle 邮箱")).toBeInTheDocument();
  });

  it("keeps a blank form when the stored config cannot be decrypted", () => {
    // Debug seals with a fixed key, release with the keychain's. Without this
    // fallback the section vanished entirely and the rail's jump went nowhere.
    config = undefined;
    failed = true;
    render(<KindleSection />);
    expect(group()).not.toBeNull();
    expect(screen.getByLabelText("授权码")).toBeInTheDocument();
    expect(screen.getByText(/读取已保存配置失败/)).toBeInTheDocument();
  });

  it("says nothing until the query has answered", () => {
    config = undefined;
    render(<KindleSection />);
    expect(group()).toBeNull();
  });
});
