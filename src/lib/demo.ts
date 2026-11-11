import type {
  Annotation,
  BookSummary,
  ChapterContent,
  ChapterMeta,
  DayTotal,
  Facet,
  Fill,
  LibraryFacets,
  LibraryStats,
  Proposal,
  ReadingStats,
} from "@/types/ipc";

/**
 * Sample content for `pnpm dev` in a browser.
 *
 * The desktop app is the only thing that ships, and `isDesktopRuntime` is false
 * in a browser — so every reader hook normally short-circuits to an empty
 * result and the UI shows its honest "nothing here yet" state. That is right
 * for a user, but it makes the reading surface impossible to look at without
 * building the app, let alone to check a change against.
 *
 * With `?demo=1` those hooks answer from here instead. Two properties matter:
 *
 * - **It cannot reach the shipped app.** Every call site is guarded by
 *   `!isDesktopRuntime`, so in Tauri this module is unreachable.
 * - **It is off by default.** Without the parameter the browser build behaves
 *   exactly as it did before.
 */

export function demoEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("demo") === "1";
}

/** A cover drawn as an SVG data URL, so the fixture needs no assets. */
function cover(index: number, from: string, to: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="300" height="400" fill="url(#g)"/>
    <circle cx="${70 + index * 30}" cy="${110 + index * 20}" r="${60 + index * 8}" fill="rgba(255,255,255,0.14)"/>
    <text x="30" y="350" fill="rgba(255,255,255,0.92)" font-size="54" font-family="sans-serif">${index + 1}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const PALETTES: [string, string][] = [
  ["#4c6ef5", "#f06595"],
  ["#37b24d", "#1c7ed6"],
  ["#9c36b5", "#0c8599"],
];

const TITLES = ["我们为什么会生病", "金色梦乡", "长日将尽"];
const AUTHORS = [["伦道夫·尼斯", "乔治·威廉斯"], ["伊坂幸太郎"], ["石黑一雄"]];

/**
 * How many tiles the sample shelf shows.
 *
 * Three read the layout fine, but a real library is a few hundred books and the
 * shelf's per-card entrance is charged per card — so a three-tile shelf cannot
 * show what returning from the reader costs. `?demo=1&books=84` sizes it for a
 * measurement; without the parameter the fixture is exactly what it always was.
 */
function shelfSize(): number {
  if (typeof window === "undefined") return TITLES.length;
  const asked = Number(new URLSearchParams(window.location.search).get("books"));
  return Number.isFinite(asked) && asked > TITLES.length ? Math.min(asked, 500) : TITLES.length;
}

/**
 * `?demo=1&epub=1` also puts a real EPUB on the sample shelf.
 *
 * The three samples above are plain text, which means the browser build never
 * loads foliate — and foliate is where a Kindle-style book's page number comes
 * from (a section's bytes, not anything the host can measure). Every page-number
 * defect a reader reported landed in exactly that gap: the suite could pass
 * while a real EPUB printed "1 / 1 页" on every page.
 *
 * Opt-in rather than always on: the tile would otherwise change the shelf every
 * other spec counts and clicks through. Built by
 * `scripts/generate-demo-epub.py`, served from `public/demo/`.
 */
function epubEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("epub") === "1";
}

/** The fixture EPUB's book id, so the foliate fixture table can answer for it. */
const EPUB_ID = "demo-epub";

const COUNT = shelfSize();

/** 2023-11-14, fixed rather than `Date.now()` so the fixture is the same shelf
 *  every run. */
const DEMO_ADDED = 1_700_000_000;

const shelf: BookSummary[] = Array.from({ length: COUNT }, (_, index) => ({
  id: `demo-${index + 1}`,
  // Beyond the three samples the shelf repeats them, numbered, so a locator that
  // names a book still names exactly one tile.
  title:
    index < TITLES.length
      ? TITLES[index]!
      : `${TITLES[index % TITLES.length]!} ${Math.floor(index / TITLES.length) + 1}`,
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  // Plain text on purpose. The reader treats this as the prose path — no
  // foliate to load, no pdf.js page to render — so the demo renders straight
  // off `demoChapter` without anything else to mock.
  format: "txt",
  fileSize: 4_100_000 + index * 800_000,
  coverUrl: cover(
    index,
    PALETTES[index % PALETTES.length]![0],
    PALETTES[index % PALETTES.length]![1],
  ),
  // A real date, not 0: the sheet prints 添加于, and 1970/01/01 on a demo shelf
  // reads as a bug in the app rather than as a fixture.
  addedAt: DEMO_ADDED - index * 86_400,
  updatedAt: DEMO_ADDED - index * 86_400,
  // Two of the three samples carry a `lastReadAt` so the shelf's "continue
  // reading" card has something to point at on `?demo=1`. demo-2 is the
  // more recent of the two — so it, not the first book with progress, is
  // what the card surfaces. `null` for the rest (the duplicates beyond the
  // first three) keeps the card pointing at a single book.
  lastReadAt: index === 0 ? 100 : index === 1 ? 200 : null,
  progress: index === 0 ? 0.18 : index === 1 ? 0.62 : 0,
  location: null,
  favorite: index === 0,
  // Every field a row can carry, including the ones the shelf never shows: a
  // fixture that omits them is a fixture that cannot catch 「undefined 让整页
  // 崩掉」, which is exactly what a row written before a column existed looks
  // like.
  isbn: null,
  publishedYear: null,
  rating: null,
  ratingCount: null,
  ratingSource: null,
  doubanUrl: null,
  authors: AUTHORS[index % AUTHORS.length]!,
  tags: index === 1 ? ["小说", "悬疑"] : [],
})) as unknown as BookSummary[];

const epubBook: BookSummary = {
  id: EPUB_ID,
  title: "页码样书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "epub",
  fileSize: 19_546,
  coverUrl: cover(3, PALETTES[0]![0], PALETTES[1]![1]),
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: 0,
  location: null,
  favorite: false,
  authors: ["样书"],
  tags: [],
} as unknown as BookSummary;

/**
 * `?demo=1&pdf=1` also puts a real PDF on the sample shelf.
 *
 * Same argument as the EPUB above, and the same gap it closed. A PDF page is
 * rasterised into a canvas, gets its own text layer, and turns through an
 * offscreen double buffer — none of which a plain-text sample exercises. Two
 * defects found by reading alone landed here in one evening: a page turn that
 * flashed white because the canvas was unmounted, and a sidebar spring that
 * re-rasterised every page on screen once per frame.
 *
 * The fixture is deliberately not uniform: five ordinary text pages against a
 * sixth that is a dense vector grid, so an assertion about the prefetch has
 * something to measure. Built by `scripts/generate-demo-pdf.py`, served from
 * `public/demo/`.
 */
function pdfEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("pdf") === "1";
}

/** The fixture PDF's book id, so `demoPdfBytes` knows what it can answer. */
const PDF_ID = "demo-pdf";

const pdfBook: BookSummary = {
  id: PDF_ID,
  title: "PDF 样书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "pdf",
  fileSize: 56_016,
  coverUrl: cover(4, PALETTES[1]![0], PALETTES[2]![1]),
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: 0,
  location: null,
  favorite: false,
  authors: ["样书"],
  tags: [],
} as unknown as BookSummary;

/**
 * `?demo=1&kindle=1` also puts a real AZW3 on the sample shelf.
 *
 * Same argument as the EPUB above, and the one gap the EPUB could not close.
 * An EPUB and a Kindle container share foliate, but not a parser: an AZW3 is a
 * Palm database, and before this fixture nothing in a browser had ever opened
 * one. The Rust side was covered — `library::import` reads a Kindle file's
 * metadata and chapters through `document::mobi` — but every step past the
 * importer rested on reading: foliate reassembling the book's own XHTML, the
 * paginator numbering the book's bytes, and the reader picking foliate at all
 * from the format it was handed. `isFoliateFormat` deciding *which* renderer an
 * `azw3` gets is a unit test; whether that renderer can open the file is this.
 *
 * The format is the point, so it is `azw3` and not `mobi`: the shelf prints
 * what it is given, and a `mobi` entry would exercise the same parser while
 * leaving the label — the thing the reader actually reported — untested.
 * Built by `scripts/generate-demo-kindle.py`, served from `public/demo/`.
 */
function kindleEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("kindle") === "1";
}

/** The fixture AZW3's book id, so the foliate fixture table can answer for it. */
const KINDLE_ID = "demo-kindle";

const kindleBook: BookSummary = {
  id: KINDLE_ID,
  title: "Kindle 样书",
  subtitle: null,
  description: null,
  language: "zh",
  publisher: null,
  format: "azw3",
  fileSize: 2_916,
  coverUrl: cover(5, PALETTES[2]![0], PALETTES[0]![1]),
  addedAt: 0,
  updatedAt: 0,
  lastReadAt: null,
  progress: 0,
  location: null,
  favorite: false,
  authors: ["样书"],
  tags: [],
} as unknown as BookSummary;

/**
 * The fixture PDF's bytes, for the reader's pdf.js path.
 *
 * `loadDoc` in `lib/pdf.ts` calls this before it gives up on a browser, so the
 * whole PDF surface — raster, text layer, prefetch — is reachable under
 * `?demo=1&pdf=1`. `null` for every other book, which is what keeps a browser
 * showing its honest "PDF 阅读只能在桌面端使用" instead of an empty page.
 */
export async function demoPdfBytes(bookId: string): Promise<ArrayBuffer | null> {
  if (bookId !== PDF_ID) return null;
  const response = await fetch("/demo/pdf-pages.pdf");
  if (!response.ok) throw new Error(`样书 PDF 取不到：HTTP ${response.status}`);
  return response.arrayBuffer();
}

export const demoBooks: BookSummary[] = [
  ...shelf,
  ...(epubEnabled() ? [epubBook] : []),
  ...(pdfEnabled() ? [pdfBook] : []),
  ...(kindleEnabled() ? [kindleBook] : []),
];

/**
 * Where each foliate fixture's bytes live, keyed by the id the shelf hands out.
 *
 * One table rather than a function per format, because the formats do not
 * differ on this path: `makeBook` sniffs the container by content — a zip
 * header, a PDF header, then `BOOKMOBI` at byte 60 — so an EPUB and an AZW3
 * differ only in which file gets fetched. A third fixture is a row.
 */
const FOLIATE_FIXTURES: Record<string, { path: string; label: string }> = {
  [EPUB_ID]: { path: "/demo/page-numbers.epub", label: "样书 EPUB" },
  [KINDLE_ID]: { path: "/demo/kindle-pages.azw3", label: "样书 AZW3" },
};

/**
 * The fixture bytes for a foliate book, for the reader's foliate path.
 *
 * In the app the book comes over IPC (or streams over the 方册
 * protocol); a browser has no backend to read a file from, so the fixture
 * serves one from `public/` instead. `null` for every other book — the caller
 * falls through to the real load path, which in a browser is what it always
 * was.
 */
export async function demoBookBytes(bookId: string): Promise<ArrayBuffer | null> {
  const fixture = FOLIATE_FIXTURES[bookId];
  if (!fixture) return null;
  const response = await fetch(fixture.path);
  if (!response.ok) throw new Error(`${fixture.label} 取不到：HTTP ${response.status}`);
  return response.arrayBuffer();
}

export const demoLibraryStats: LibraryStats = {
  total: demoBooks.length,
  favorites: 1,
  reading: 2,
  finished: 0,
  // The fixture has no bin: nothing in it was ever deleted.
  trashed: 0,
};

/**
 * Counts for the 筛选 panel in `?demo=1`.
 *
 * Tallying the fixture instead of calling into the browser backend: the sample
 * shelf is a fixed array, and a demo that reaches for IndexedDB would show an
 * empty panel the first time someone opens the page.
 */
/** Which slice of its reading history a sample book is in — the thresholds
 *  `ReadingStatus` uses, so the demo panel counts what the real one would. */
function demoStatusOf(book: BookSummary): "unread" | "reading" | "finished" {
  const progress = book.progress ?? 0;
  if (progress >= 0.999) return "finished";
  return progress > 0 ? "reading" : "unread";
}

export const demoFacets: LibraryFacets = (() => {
  const tally = (pick: (book: BookSummary) => string | null | undefined): Facet[] => {
    const counts = new Map<string, number>();
    for (const book of demoBooks) {
      const value = pick(book)?.trim();
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts]
      .map(([value, count]) => ({ value, count }))
      .toSorted((a, b) => b.count - a.count || a.value.localeCompare(b.value, "zh"));
  };

  return {
    formats: tally((book) => book.format),
    languages: tally((book) => book.language),
    publishers: tally((book) => book.publisher),
    status: (["unread", "reading", "finished"] as const).map((value) => ({
      value,
      count: demoBooks.filter((book) => demoStatusOf(book) === value).length,
    })),
    covers: [
      { value: "has", count: demoBooks.filter((book) => book.coverUrl).length },
      { value: "none", count: demoBooks.filter((book) => !book.coverUrl).length },
    ],
  };
})();

/**
 * Reading time for `?demo=1`: a half year with a life in it — busier weekends,
 * stretches of momentum followed by quieter ones, no perfectly even grid.
 * Top books borrow the shelf's own titles so the ranking can link into the
 * reader just like it does on the desktop side.
 */
export const demoReadingStats: ReadingStats = (() => {
  const days: DayTotal[] = [];
  const today = new Date();
  for (let back = 181; back >= 0; back--) {
    const date = new Date(today);
    date.setDate(date.getDate() - back);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const weekend = date.getDay() === 0 || date.getDay() === 6;
    const wave = Math.sin(back / 9) > 0.35 ? 1.7 : 1;
    const jitter = 0.5 + ((back * 7919) % 97) / 97;
    days.push({ day: key, seconds: Math.round((weekend ? 2300 : 800) * wave * jitter) });
  }
  const topSeconds = [8400, 5100, 3200, 1800];
  return {
    todaySeconds: days.at(-1)?.seconds ?? 0,
    weekSeconds: days.slice(-7).reduce((sum, day) => sum + day.seconds, 0),
    totalSeconds: 152_000,
    streak: 6,
    bestStreak: 14,
    daysRead: 151,
    days,
    topBooks: demoBooks.slice(0, topSeconds.length).map((book, index) => ({
      bookId: book.id,
      title: book.title,
      seconds: topSeconds[index] ?? 1200,
    })),
  };
})();

/**
 * Sample highlights, so the notes surface has something to aggregate.
 *
 * The notes page is *made of* other books' highlights; with an empty store it
 * could only ever render its empty state, and a browser dev session could not
 * tell a working aggregation from a broken one. Two books carry samples on
 * purpose — one with a note written and one without — because "全部 / 有笔记"
 * is the filter the page exists to offer, and a single book could not show it
 * doing anything.
 *
 * Unlike `demoBooks` this is mutable: a note edited on the page has to survive
 * the round trip through the query cache, or the surface reads as broken. The
 * fixtures are handed out as copies so a caller cannot edit them in place.
 */
const demoAnnotations: Annotation[] = [
  {
    id: "demo-a1",
    bookId: "demo-1",
    chapterIdx: 0,
    startChar: 0,
    endChar: 47,
    text: "身体是一台被反复修补过的机器。演化并不设计，它只保留此刻还能留下的东西。",
    cfi: null,
    color: "#ffd12e",
    style: "highlight",
    note: "全书的主线：把「设计」换成「修补」，很多奇怪的症状就说得通了。",
    createdAt: 1_700_000_100_000,
  },
  {
    id: "demo-a2",
    bookId: "demo-1",
    chapterIdx: 1,
    startChar: 120,
    endChar: 162,
    text: "咳嗽、发烧、呕吐，这些让人难受的反应大多是防御本身，而不是疾病。",
    cfi: null,
    color: "#f76f6f",
    style: "highlight",
    note: null,
    createdAt: 1_700_000_200_000,
  },
  {
    id: "demo-a3",
    bookId: "demo-1",
    chapterIdx: 2,
    startChar: 240,
    endChar: 291,
    text: "为什么自然选择没有把衰老剔除掉？因为选择在繁殖之后就放手了。",
    cfi: null,
    color: "#56aee2",
    style: "underline",
    note: "和《自私的基因》里那段对读。",
    createdAt: 1_700_000_300_000,
  },
  {
    id: "demo-a4",
    bookId: "demo-2",
    chapterIdx: 0,
    startChar: 60,
    endChar: 104,
    text: "医学擅长处理近因——哪一种细菌、哪一条通路；演化医学追问远因。",
    cfi: null,
    color: "#7cd92c",
    style: "highlight",
    note: null,
    createdAt: 1_700_000_400_000,
  },
  {
    id: "demo-a5",
    bookId: "demo-2",
    chapterIdx: 3,
    startChar: 0,
    endChar: 28,
    text: "理解这一点并不会立刻治好什么病，但它会改变提问的方式。",
    cfi: null,
    color: "#b08fe8",
    style: "squiggly",
    note: "提问方式决定找得到什么答案——这句可以拿去当书签。",
    createdAt: 1_700_000_500_000,
  },
];

/** One book's highlights, in reading order.
 *
 *  Handed out by reference, which is safe because nothing ever writes to an
 *  entry in place — every edit below replaces the element. */
export function demoAnnotationList(bookId: string): Annotation[] {
  return demoAnnotations.filter((entry) => entry.bookId === bookId);
}

/** Writes (or clears) a note on a sample highlight; `null` when it is gone. */
export function demoAnnotationNote(id: string, note: string | null): Annotation | null {
  const at = demoAnnotations.findIndex((entry) => entry.id === id);
  if (at < 0) return null;
  const updated = { ...demoAnnotations[at]!, note };
  demoAnnotations[at] = updated;
  return updated;
}

/** Drops a sample highlight. */
export function demoAnnotationDelete(id: string): void {
  const at = demoAnnotations.findIndex((entry) => entry.id === id);
  if (at >= 0) demoAnnotations.splice(at, 1);
}

const CHAPTER_TITLES = [
  "第一章 疾病的谜题",
  "第二章 防御与修复",
  "第三章 演化的遗留",
  "第四章 现代环境",
];

/** Enough body to scroll, paginate and select against. */
const PARAGRAPHS = [
  "身体是一台被反复修补过的机器。演化并不设计，它只保留此刻还能留下的东西，所以每一处精妙旁边都躺着一处将就。",
  "咳嗽、发烧、呕吐，这些让人难受的反应大多是防御本身，而不是疾病。压掉它们往往是在帮倒忙。",
  "为什么自然选择没有把衰老剔除掉？因为选择在繁殖之后就放手了，晚年是一段没有选择压力的时光，于是损伤在那里慢慢堆积。",
  "我们的基因来自一个食物稀缺、寄生虫遍地的世界，如今坐在一个热量过剩、几乎无菌的世界里，错位本身就是病。",
  "医学擅长处理近因——哪一种细菌、哪一条通路；演化医学追问远因——为什么这套设计会被留下。两把钥匙开两把锁。",
  "理解这一点并不会立刻治好什么病，但它会改变提问的方式，而提问的方式决定了找得到什么答案。",
];

/** `paragraphs`, repeated `times` over — the sample body of one chapter. */
const repeat = (times: number): string[] => Array.from({ length: times }, () => PARAGRAPHS).flat();

/**
 * The body of each chapter.
 *
 * The first three are ten times the shared pool, long enough to paginate into
 * several pages. The last is a single paragraph, deliberately: the whole-book
 * page indicator reads a book's length off the units it has measured, and a
 * shelf whose chapters are all one length makes every estimator look right —
 * including the one that extrapolated the book from whichever chapter happened
 * to be on screen, which reported 493 pages and then 2202 for the same EPUB.
 * One long chapter against one very short one is what tells those two apart,
 * and a very short chapter is where the real thing goes wrong too: the last
 * page of a chapter is never full.
 *
 * It keeps the paragraph `demo-a5` quotes, so the notes page still finds the
 * line it points at on a real page of the book.
 */
const CHAPTER_BODIES: string[][] = [repeat(10), repeat(10), repeat(10), [PARAGRAPHS[5]!]];

export const demoToc: ChapterMeta[] = CHAPTER_TITLES.map((title, idx) => ({
  idx,
  title,
  chars: (CHAPTER_BODIES[idx] ?? []).join("").length,
}));

export function demoChapter(idx: number): ChapterContent | null {
  const title = CHAPTER_TITLES[idx];
  const paragraphs = CHAPTER_BODIES[idx];
  if (title === undefined || paragraphs === undefined) return null;
  return { idx, title, paragraphs };
}

/**
 * Proposals for the batch-fill sheet on `?demo=1`.
 *
 * The sheet is otherwise unreachable without a desktop runtime and a network,
 * which is exactly how a dialog that ran off both edges of the window shipped
 * twice. A canned answer makes it openable in a browser, so a layout regression
 * is something a test can see.
 *
 * Every third book is a miss (the sheet has to render 「没找到」 too), and the
 * first one carries a full-length blurb — the value that broke the layout.
 */
export function demoProposals(ids: string[]): Proposal[] {
  return ids.map((id, index) => {
    const title = shelf.find((item) => item.id === id)?.title ?? "样书";
    if (index % 3 === 2) {
      return {
        bookId: id,
        bookTitle: title,
        fills: [],
        skipped: "没有找到相近的书",
        matchScore: 0,
        rating: null,
        ratingCount: null,
        ratingSource: null,
        doubanUrl: null,
        coverUrl: null,
        existing: [],
      };
    }
    const fills: Fill[] = [
      { field: "publisher", from: null, to: "演示出版社" },
      { field: "language", from: null, to: "zh" },
    ];
    if (index % 3 === 0) {
      fills.push({
        field: "description",
        from: null,
        to: "这是一段演示用的简介，长度接近真实目录返回的那种营销文案。".repeat(60),
      });
    }
    return {
      bookId: id,
      bookTitle: title,
      fills,
      skipped: null,
      matchScore: 0.92,
      // The demo shows the rating line and the Douban link, so the fixture
      // carries them the way a real answer does — with 人类简史's actual Douban
      // numbers, so the label and the page agree.
      rating: 9.1,
      ratingCount: 217634,
      ratingSource: "douban",
      doubanUrl: "https://book.douban.com/subject/25985021/",
      // One row in three carries a picture, so the 「封面」 chip and its detail
      // row are something a browser test can see.
      coverUrl:
        index % 3 === 0 ? "https://img3.doubanio.com/view/subject/l/public/s35198069.jpg" : null,
      // What the book already has. Half the rows in a real batch look like
      // this — an EPUB carries an ISBN and a year, and nothing else.
      existing: index % 2 === 0 ? ["isbn", "publishedYear"] : [],
    };
  });
}
