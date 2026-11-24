import { useFillRun } from "@/stores/fillRun";

/**
 * 整架补全的状态：进度、计数、失败明细。
 *
 * 弹窗和常驻胶囊共用这一份，不让两处各画一套进度 —— 关掉弹窗后，右下角
 * 胶囊显示的是同一组数字。完成后的书架刷新不在这里：胶囊可能被折叠，
 * 而刷新必须只发生一次，所以由常驻的 `FillRunPill` 负责。
 */
export function FillRunStatus() {
  const run = useFillRun();
  const finished = !run.running;
  const paused = run.stopped?.startsWith("平台限流") ?? false;
  const percent = run.total > 0 ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between text-[13px]">
          <span className="text-text-1">
            {!finished && run.cancelled
              ? "正在停止…"
              : finished
                ? paused
                  ? "已暂停"
                  : run.stopped
                    ? "已停止"
                    : "补全完成"
                : run.cooldownMs > 0
                  ? "限流退避中"
                  : "正在查询并写入…"}
          </span>
          <span className="text-text-3 tabular-nums">
            {run.done} / {run.total}
          </span>
        </div>
        {/* Decorative: the count above it is the accessible version, and a
            div with a `progressbar` role is exactly what `prefer-tag-over-role`
            exists to replace. */}
        <div aria-hidden className="bg-surface-2 mt-2 h-1.5 overflow-hidden rounded-full">
          <div
            className="bg-accent h-full rounded-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <p className="text-text-2 text-[13px]">
        已补全 {run.written} 本{run.renamed > 0 && ` · 改名 ${run.renamed} 本`} · 跳过 {run.skipped}{" "}
        本{run.failed > 0 && ` · 失败 ${run.failed} 本`}
        {run.deferred > 0 && ` · 待重试 ${run.deferred} 本`}
        {finished && run.pending.length > 0 && ` · 待补全 ${run.pending.length} 本`}
      </p>
      {!finished && run.cooldownMs > 0 && (
        <p className="text-text-3 text-xs leading-relaxed">
          正在等待 {Math.ceil(run.cooldownMs / 1000)} 秒后继续（{run.deferred} 本待重试）。
        </p>
      )}
      {/* A count with no names is the complaint this answers. Native details:
          the list can be long, and folded it never pushes 关闭 off the dialog. */}
      {run.failures.length > 0 && (
        <details>
          <summary className="text-text-3 hover:text-text-2 cursor-pointer text-xs transition-colors select-none">
            失败明细（{run.failures.length} 本）
          </summary>
          <ul className="border-hairline divide-hairline mt-2 max-h-40 divide-y overflow-y-auto rounded-md border px-2.5">
            {run.failures.map((failure) => (
              <li key={failure.bookId} className="py-1.5">
                <span className="text-text-2 block text-[12px] break-words">
                  {failure.bookTitle}
                </span>
                <span className="text-text-3 block text-[11px] leading-relaxed break-all">
                  {failure.skipped}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {run.stopped && (
        <p className="text-text-3 max-h-24 overflow-y-auto text-xs leading-relaxed break-all">
          {run.stopped}
        </p>
      )}
      {finished && !run.stopped && run.written > 0 && (
        <p className="text-text-3 text-xs leading-relaxed">更新已保存到书架。</p>
      )}
    </div>
  );
}
