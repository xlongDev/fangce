import { create } from "zustand";

import { ipc } from "@/lib/ipc";
import { showToast } from "@/stores/toasts";

/** 后端一次 tagSuggest 的上限；分块必须和它一致，块间才不会重复建议同一本。 */
const RUN_LIMIT = 60;

/** 审阅列表的一行。建议生成后、写库前，读者还能改/删/跳过。 */
export interface ReviewRow {
  bookId: string;
  title: string;
  tags: string[];
}

/**
 * 「全部生成后统一审阅」的任务。循环住在 store，所以对话框关掉（转后台）
 * 照跑；跑完或中途停止都不清空 `rows` —— token 已经花了，建议要留着审。
 */
export interface TagReview {
  ids: string[];
  rows: ReviewRow[];
  /** 已拉取的块数。 */
  done: number;
  /** 总块数。 */
  total: number;
  failed: number;
  error: string | null;
  running: boolean;
  cancelled: boolean;
}

/**
 * 批量打标签的后台任务：循环住在 store，对话框关掉也照跑。
 *
 * 两种模式共用这一个 store，同一时刻只允许一种在跑：
 * - `start`（逐批写入）：每批 suggest + apply，进度交给胶囊。与 `fillRun` 同形。
 * - `startReview`（统一审阅）：分块拉建议、全程不写库，出齐/停止后 `rows`
 *   留在 store 里等读者审阅，一次写入仍由对话框发起。
 *
 * 取消只在批次之间生效 —— 一批是一次模型调用，中途掐断 token 白花；
 * 审阅模式连飞行中的结果也收下（钱已经花了），然后才停。
 */
export interface TagRunState {
  running: boolean;
  cancelled: boolean;
  /** 选中要处理的书数；首轮拿到后端实际参与数后会校正。 */
  total: number;
  /** 已经问过的书数（= 选中数 − 剩余）。后端每批重新筛，逐批累加 considered
   *  会把同一本无标签的书算多次，所以用差值。 */
  done: number;
  /** 实际写入了标签的书数。 */
  written: number;
  /** 剩余没轮上的书数。 */
  remaining: number;
  /** 模型没答上来的批次数。 */
  failedBatches: number;
  /** 提前结束的原因，正常跑完为 null。 */
  stopped: string | null;
  /** null = 没有审阅任务；非 null = 建议已生成/已停止，等读者审。 */
  review: TagReview | null;
  /** 胶囊上的「审阅」把对话框打开。放 store，跨组件又不碰 React effect。 */
  reviewSheetOpen: boolean;
  /** 胶囊折叠成小徽章（照 GuideBatchPill）；纯展示态。 */
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  start: (ids: string[]) => void;
  /** `seed` 是从前台在飞那批接住的建议：token 已花，作为第一批攒进审阅，
   *  后续块按 bookId 跳过它们，不重复请求。 */
  startReview: (ids: string[], seed?: ReviewRow[]) => void;
  cancelReview: () => void;
  requestReview: () => void;
  closeReviewSheet: () => void;
  clearReview: () => void;
  dismissReview: () => void;
  cancel: () => void;
  reset: () => void;
}

const idle = {
  running: false,
  cancelled: false,
  total: 0,
  done: 0,
  written: 0,
  remaining: 0,
  failedBatches: 0,
  stopped: null as string | null,
  review: null as TagReview | null,
  reviewSheetOpen: false,
  collapsed: false,
};

/** 审阅循环的代次：新一轮开始时 +1，旧轮在飞的结果回来时发现代次变了就
 *  不再写 store —— 否则「停止后立刻重开一批」会让旧的在飞结果灌进新任务。
 *  与 guideBatch 的 runToken 同构。 */
let reviewToken = 0;

export const useTagRun = create<TagRunState>((set, get) => ({
  ...idle,
  reset: () => {
    reviewToken += 1;
    set(idle);
  },
  setCollapsed: (collapsed) => set({ collapsed }),
  cancel: () => set({ cancelled: true }),
  cancelReview: () => {
    const review = get().review;
    if (!review || !review.running) return;
    // 立即结算 UI：后端那次 tagSuggest（60 本 / 3 次模型调用）无法取消，
    // 但不能让读者对着「正在停止…」干等。running 一置 false，胶囊就切到
    // 「已停止 + N 本待审阅」，飞行块的结果回来后照样并进 rows（token 已花）。
    set({ review: { ...review, cancelled: true, running: false } });
  },
  /** 胶囊上的「审阅 / 回到界面」把对话框打开。放 store，跨组件又不碰 React
   *  effect。生成中也允许 —— 对话框的进度卡片就是那套完整界面。 */
  requestReview: () => {
    const review = get().review;
    if (review) set({ reviewSheetOpen: true });
  },
  closeReviewSheet: () => set({ reviewSheetOpen: false }),
  /** 只撤掉胶囊入口；对话框的成功态由它自己显示，读者点「完成」再关窗。 */
  clearReview: () => set({ review: null }),
  /** 胶囊上的「关闭」：整批丢弃，顺手把可能开着的对话框也关掉。 */
  dismissReview: () => set({ review: null, reviewSheetOpen: false }),
  start: (ids) => {
    if (get().running || get().review?.running) {
      showToast("error", "正在批量打标签，等这轮结束再开始。");
      return;
    }
    if (ids.length === 0) return;
    set({ ...idle, running: true, total: ids.length });
    void loop(ids, set, get);
  },
  startReview: (ids, seed) => {
    if (get().running || get().review?.running) {
      showToast("error", "正在批量打标签，等这轮结束再开始。");
      return;
    }
    if (ids.length === 0) return;
    const token = ++reviewToken;
    set({
      collapsed: false,
      review: {
        ids,
        rows: seed ? [...seed] : [],
        done: seed ? 1 : 0,
        total: Math.ceil(ids.length / RUN_LIMIT),
        failed: 0,
        error: null,
        running: true,
        cancelled: false,
      },
    });
    void reviewLoop(ids, set, get, seed, token);
  },
}));

/** 切成不重叠的块：块间无交集，逐块拉取才不会把同一本书建议两遍。 */
function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function loop(
  ids: string[],
  set: (partial: Partial<TagRunState>) => void,
  get: () => TagRunState,
) {
  let done = 0;
  let written = 0;
  let remaining = ids.length;
  let failedBatches = 0;
  let batches = 0;
  let stopped: string | null = null;

  try {
    for (;;) {
      // 批次之间检查：一批是一次模型调用加一次事务，停要在边界上停。
      // 请求已经在飞就让它写完再停 —— 否则这一批的 token 白花，建议也丢了。
      if (get().cancelled) {
        stopped = "已停止";
        break;
      }
      // 后端每批重新筛没有标签的书，剩余数只减不增。批数超过书数说明它
      // 没在收敛（接口异常 / 标签没写进去），再问下去只是无限烧 token。
      if (batches >= ids.length) {
        stopped = "剩余数量没有减少，已停止以免重复请求";
        break;
      }
      batches += 1;
      // 后端每批重新筛没有标签的书，所以整份 ids 每批都原样传进去。
      // oxlint-disable-next-line no-await-in-loop -- 一批写完再问下一批，否则会重复建议同一本书。
      const run = await ipc.tagSuggest(ids);
      const items = run.suggestions.map((s) => ({ bookId: s.bookId, tags: s.tags }));
      // oxlint-disable-next-line no-await-in-loop -- 写入要按批落盘，批间取消才有意义。
      const batchWritten = await ipc.tagSuggestApply(items);
      written += batchWritten;
      remaining = run.remaining;
      failedBatches += run.failedBatches;
      done = ids.length - remaining;
      set({ done, written, remaining, failedBatches });

      // 这一批一个字都没写：下一批还是同一批书，空转会一直烧 token。停下交还读者。
      if (batchWritten === 0 && remaining > 0) {
        stopped = "这一批没有可写入的标签，已停止，剩下没轮上的书可稍后重试";
        break;
      }
      if (remaining === 0) break;
    }
  } catch (err) {
    stopped = err instanceof Error ? err.message : String(err);
  } finally {
    if (stopped === null && get().cancelled) stopped = "已停止";
    set({ running: false, stopped, done, written, remaining, failedBatches });
  }
}

async function reviewLoop(
  ids: string[],
  set: (partial: Partial<TagRunState>) => void,
  get: () => TagRunState,
  seed: ReviewRow[] | undefined,
  token: number,
) {
  const parts = chunks(ids, RUN_LIMIT);
  const collected = new Map<string, ReviewRow>();
  // 前台在飞那批的 token 已花：先攒进去，后面按 id 跳过它们。
  if (seed) for (const row of seed) collected.set(row.bookId, row);
  let failed = 0;
  let error: string | null = null;
  let done = seed ? 1 : 0;

  const publish = () => {
    // 代次变了 = 有新的一轮开始（或 reset），旧循环的在飞结果不能再写 store。
    if (token !== reviewToken) return;
    const review = get().review;
    if (review) set({ review: { ...review, rows: [...collected.values()], done, failed, error } });
  };
  if (seed) publish();

  for (let i = 0; i < parts.length; i++) {
    // 停止只在块与块之间生效：一块是一次模型调用，飞行中掐断就是白花钱。
    // 代次变了也要退出，否则旧循环会继续为新一轮拉请求。
    if (token !== reviewToken || get().review?.cancelled) break;
    // 这一块里已攒过的书不再请求 —— 它们的 token 已经花在前台那批里了。
    const pending = parts[i]!.filter((id) => !collected.has(id));
    if (pending.length === 0) {
      done = Math.max(done, i + 1);
      continue;
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- 块间要留停止点，且结果要按序攒。
      const data = await ipc.tagSuggest(pending);
      // 飞行中按了停止：这一批的钱已经花了，结果照样收下。循环头下一轮退出。
      failed += data.failedBatches;
      for (const s of data.suggestions) {
        if (!collected.has(s.bookId)) {
          collected.set(s.bookId, { bookId: s.bookId, title: s.title, tags: s.tags });
        }
      }
      done = Math.max(done, i + 1);
      publish();
    } catch (err) {
      // 一块全是已打标签的书会被引擎拒绝；那是正常跳过，不是整轮失败。
      // 其余错误记下来继续下一块，一条建议都没有时再把错误摆到台面上。
      failed += 1;
      error ||= err instanceof Error ? err.message : String(err);
      publish();
    }
  }

  if (token !== reviewToken) return;
  const review = get().review;
  if (review) {
    set({
      review: { ...review, running: false, rows: [...collected.values()], done, failed, error },
    });
  }
}

/** 完成/停止时那句 toast，和 Phase 里其余后台任务一个语气。 */
export function describeTagRun(state: TagRunState): string {
  const head = state.stopped
    ? `批量打标签已停止：已写入 ${state.written} 本`
    : `批量打标签完成：已写入 ${state.written} 本`;
  const extra = state.failedBatches > 0 ? `，${state.failedBatches} 批模型没有回答` : "";
  const left = state.remaining > 0 ? `，剩余 ${state.remaining} 本未处理` : "";
  return `${head}${extra}${left}。`;
}

/** 审阅模式跑完的 toast：建议还没写库，重点是去审，不是写入了几本。 */
export function describeTagReview(review: TagReview): string {
  const head = review.cancelled
    ? `标签建议已停止：收集到 ${review.rows.length} 本`
    : `标签建议已生成：共 ${review.rows.length} 本待审阅`;
  const extra = review.failed > 0 ? `，${review.failed} 批模型没有回答` : "";
  return `${head}${extra}；点右下角「审阅」查看并确认写入。`;
}
