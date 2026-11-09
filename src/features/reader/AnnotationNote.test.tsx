import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AnnotationNote, NoteCell, NoteEditor } from "./AnnotationNote";

/**
 * The cell as the app wires it: the caller owns the one boolean, the field owns
 * the draft. Driving the whole cell rather than each half in isolation is the
 * point — the split is what lets a row's own 编辑 button open the field, and a
 * test that rendered the halves separately would not see that path at all.
 */
function Harness({
  note,
  disabled,
  onSave,
}: {
  note: string | null;
  disabled?: boolean;
  onSave: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <NoteCell
      note={note}
      disabled={disabled}
      editing={editing}
      onEditingChange={setEditing}
      onSave={onSave}
    />
  );
}

/** Renders the cell for `note` and hands back its save spy. */
function setup(note: string | null = null) {
  const onSave = vi.fn();
  render(<Harness note={note} onSave={onSave} />);
  return onSave;
}

const field = () => screen.getByRole("textbox", { name: "标注笔记" });
const add = () => screen.getByRole("button", { name: /添加笔记/ });

describe("AnnotationNote", () => {
  it("reveals the add affordance on hover but never hides a saved note", () => {
    const onEdit = vi.fn();
    const { unmount } = render(<AnnotationNote note={null} onEdit={onEdit} revealOnHover />);
    expect(add()).toHaveClass("note-row-actions");
    unmount();

    // A note somebody wrote is content: the hover reveal must not reach it.
    render(<AnnotationNote note="第三章埋了伏笔" onEdit={onEdit} revealOnHover />);
    expect(screen.getByRole("button", { name: "第三章埋了伏笔" })).not.toHaveClass(
      "note-row-actions",
    );
  });

  it("shows a saved note and offers no add affordance", () => {
    setup("第三章埋了伏笔");
    expect(screen.getByRole("button", { name: "第三章埋了伏笔" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /添加笔记/ })).not.toBeInTheDocument();
  });

  it("opens a focused field from the add affordance", async () => {
    const user = userEvent.setup();
    setup();
    await user.click(add());
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("");
  });

  it("saves a trimmed draft when the field loses focus", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(add());
    await user.type(field(), "  伏笔在这里  ");
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("伏笔在这里");
  });

  it("saves on ⌘/Ctrl + Enter without waiting for a blur", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(add());
    await user.type(field(), "记一笔");
    await user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onSave).toHaveBeenCalledWith("记一笔");
  });

  it("closes without saving when the draft is unchanged", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "原笔记" })).toBeInTheDocument();
  });

  it("rewinds on Escape instead of saving", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.type(field(), "改到一半");
    await user.keyboard("{Escape}");
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "原笔记" })).toBeInTheDocument();
  });

  it("clears the note when the field is emptied", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.clear(field());
    await user.click(document.body);
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("starts writing at the end of a note that is already there", async () => {
    // Focus alone leaves the caret at index 0, which types *backwards*
    // through the saved note — the whole reason opening one to add a line
    // felt broken.
    const user = userEvent.setup();
    setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.keyboard("！");
    expect(field()).toHaveValue("原笔记！");
  });

  it("saves from the strip's own 保存 button", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(add());
    await user.type(field(), "记一笔");
    await user.click(screen.getByRole("button", { name: "保存笔记" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith("记一笔");
  });

  it("empties the field with 清空 and only saves the note on 保存", async () => {
    const user = userEvent.setup();
    const onSave = setup("原笔记");
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    await user.click(screen.getByRole("button", { name: "清空输入" }));
    expect(field()).toHaveValue("");
    expect(onSave).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "保存笔记" }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it("treats a whitespace-only draft on a bare highlight as no change", async () => {
    const user = userEvent.setup();
    const onSave = setup();
    await user.click(add());
    await user.type(field(), "   ");
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("AnnotationNote's halves", () => {
  it("asks to be opened rather than opening itself", async () => {
    // The display half holds no state: that is what lets a row's own button be
    // a second way in, and a test that only drove the whole cell would not
    // notice if this one started opening the field on its own.
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<AnnotationNote note={null} onEdit={onEdit} />);
    await user.click(add());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("textbox", { name: "标注笔记" })).not.toBeInTheDocument();
  });

  it("does not offer to be opened while an edit is already in flight", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<AnnotationNote note="原笔记" disabled onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: "原笔记" }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("starts the field from the saved note, once, at mount", () => {
    const { rerender } = render(<NoteEditor value="原笔记" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(field()).toHaveValue("原笔记");

    // A later change to the prop does not reach into the field: the draft is
    // the reader's once it is open. This is the whole reason the parent mounts
    // the editor instead of pushing state into one that is already there.
    rerender(<NoteEditor value="别的笔记" onSave={vi.fn()} onCancel={vi.fn()} />);
    expect(field()).toHaveValue("原笔记");
  });

  it("closes through onCancel when the reader is already done", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<NoteEditor value="原笔记" onSave={onSave} onCancel={onCancel} />);
    await user.click(document.body);
    expect(onSave).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
