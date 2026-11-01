import { MindmapView } from "@/features/reader/MindmapView";
import { WordcloudView } from "@/features/reader/WordcloudView";
import type { ToolCallView } from "@/types/ipc";

/**
 * The picture a tool produced, if any.
 *
 * Its own module so the two renderers — a Markdown parser and a layout engine
 * between them — can be loaded only when a conversation actually contains one.
 * `ToolRow` deliberately does not import this: it is the part the unit tests
 * exercise, and pulling markmap into its module graph made a four-assertion test
 * file take three minutes to transform.
 */
export function ToolArtifact({ tool }: { tool: ToolCallView }) {
  if (tool.mindmap) {
    return (
      <div className="border-hairline bg-surface-1/40 mt-1.5 h-[230px] overflow-hidden rounded-lg border">
        <MindmapView markdown={tool.mindmap} compact />
      </div>
    );
  }
  if (tool.wordcloud) {
    return (
      <div className="border-hairline bg-surface-1/40 mt-1.5 overflow-hidden rounded-lg border p-1">
        <WordcloudView words={tool.wordcloud} compact />
      </div>
    );
  }
  return null;
}
