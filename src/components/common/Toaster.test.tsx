import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";

import { Toaster } from "@/components/common/Toaster";
import { useToasts } from "@/stores/toasts";

/** The toast's icon colour is the one visible half of a result that started on
 *  a book card. Pin it: the store carrying `emphasis` is useless if the view
 *  ignores it. */
function renderToaster() {
  return render(
    <MemoryRouter>
      <Toaster />
    </MemoryRouter>,
  );
}

const icon = () => screen.getByRole("status").querySelector("svg");

describe("Toaster", () => {
  beforeEach(() => useToasts.setState({ toasts: [] }));

  it("keeps the ordinary success green without an emphasis", () => {
    useToasts.getState().push({ tone: "success", message: "已保存" });
    renderToaster();
    expect(icon()?.getAttribute("class")).toContain("text-success");
  });

  it("borrows the card's accent when the message asks for it", () => {
    useToasts.getState().push({
      tone: "success",
      message: "《书》已提交到 Kindle",
      emphasis: "accent",
    });
    renderToaster();
    expect(icon()?.getAttribute("class")).toContain("text-accent");
  });
});
