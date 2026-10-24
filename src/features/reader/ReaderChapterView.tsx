import { lazy, Suspense, type CSSProperties, type RefObject } from "react";

import { ChapterImage } from "@/features/reader/ChapterImage";
import type {
  FoliateHandle,
  FoliateLocation,
  FoliateSelection,
  FoliateTocEntry,
} from "@/features/reader/FoliateBookView";
import type { TextRange } from "@/features/reader/selection";
import type { FoliateStyle } from "@/features/reader/foliateStyle";
import type { LayoutMode, PageTransition } from "@/features/reader/theme";
import type { TtsWashStyle } from "@/features/reader/ttsWash";
import { cn } from "@/lib/cn";
import type { Annotation, AnnotationStyle, BookFormat, BookImage } from "@/types/ipc";

/** pdf.js is ~1 MB; it only ever ships inside its own lazy chunk, loaded the
    first time a PDF book is opened. */
const PdfPageView = lazy(() =>
  import("@/features/reader/PdfPageView").then((module) => ({ default: module.PdfPageView })),
);
const PdfScrollView = lazy(() =>
  import("@/features/reader/PdfScrollView").then((module) => ({ default: module.PdfScrollView })),
);
/** The original-layout renderer; fetched for the two container formats it
 *  serves — Kindle (KF6/7/8) and EPUB (reflowable and fixed-layout). */
const FoliateBookView = lazy(() => import("@/features/reader/FoliateBookView"));

/** A run of text the reader paints: a highlight, a search match, the voice. */
export interface Segment {
  key: string;
  text: string;
  highlighted: boolean;
  annotationId?: string;
  tts?: boolean;
  color: string | null;
  style: string | null;
}

/** A rendered paragraph: prose, an in-book image, or an in-book link. */
export interface RenderedParagraph {
  idx: number;
  key: string;
  imagePath: string | null;
  link: { idx: number; text: string } | null;
  segments: Segment[];
}

/**
 * How the chapter in front of the reader is drawn.
 *
 * Five ways, and they are not variants of one another: a PDF is a bitmap
 * pdf.js renders, a foliate book keeps its own XHTML and CSS, a part-title
 * plate is a full-bleed picture, and prose is text in columns. They share
 * nothing but the chapter index — so the switch lives here and the page keeps
 * only the scroll container around it.
 */
export function ReaderChapterView({
  bookId,
  isPdf,
  useFoliate,
  paged,
  doublePage,
  chapterIdx,
  total,
  transitionClass,
  margin,
  blockMargin,
  images,
  onOpenImage,
  /** The foliate view, driven imperatively. Top-level rather than inside
      `foliate` so the ref is never read through a wrapper during render. */
  foliateRef,
  pdf,
  foliate,
  plate,
  prose,
}: {
  bookId: string;
  isPdf: boolean;
  useFoliate: boolean;
  paged: boolean;
  /** Two pages side by side; PDF only. */
  doublePage: boolean;
  chapterIdx: number;
  total: number;
  transitionClass: string;
  margin: number;
  blockMargin: number;
  /** Every image in the book, so a tapped picture opens in the right place. */
  images: BookImage[];
  onOpenImage: (index: number) => void;
  foliateRef: RefObject<FoliateHandle | null>;
  pdf: {
    gap: number | undefined;
    zoom: number;
    animated: boolean;
    night: { fg: string; bg: string } | null;
    invertImages: boolean;
    annotationsByPage: Map<number, Annotation[]>;
    /** The read-aloud wash for the page the voice is on. */
    wash: { text: string; from: number; to: number } | null;
    onSelection: (range: TextRange, rect: DOMRect, pageNumber: number, bottom: number) => void;
    onAnnotationClick: (annotation: Annotation, x: number, y: number, pageNumber: number) => void;
    onLayout: (slotHeight: number) => void;
  };
  foliate: {
    format: BookFormat;
    startCfi: string | null;
    startFraction: number | null;
    layout: LayoutMode;
    transition: PageTransition;
    style: FoliateStyle;
    annotations: Annotation[] | undefined;
    /** The read-aloud wash, as the overlayer needs it: which painter, and the
     *  ink to hand it. Equal to the prose path's by construction. */
    ttsWash: { style: TtsWashStyle; color: string | null };
    onSelect: (selection: FoliateSelection | null) => void;
    onAnnotationClick: (cfi: string, x: number, y: number) => void;
    onAnchor: (id: string, cfi: string) => void;
    onImageOpen: (path: string) => void;
    onLocationChange: (relocate: FoliateLocation) => void;
    onTocLoaded: (toc: FoliateTocEntry[]) => void;
    /** A pointer went down on the book's own text (inside foliate's iframe,
     *  where this document cannot hear it). 对照阅读 uses it to hand the
     *  window's controls to the pane that was clicked. */
    onActivate?: () => void;
    /** The pointer moved inside a section — same iframe problem, and what
     *  restarts the page number's stillness clock on a foliate book. */
    onPointerInBook?: (event: PointerEvent) => void;
  };
  plate: {
    /** Set when the chapter is a part-title page; otherwise `null`. */
    image: { imagePath: string; title: string } | null;
  };
  prose: {
    pending: boolean;
    paragraphs: RenderedParagraph[];
    gap: number | undefined;
    indent: boolean;
    invertImages: boolean;
    darkSurface: boolean;
    style: CSSProperties;
    annotations: Annotation[] | undefined;
    onGoTo: (idx: number) => void;
    onEditAnnotation: (annotation: Annotation, x: number, y: number) => void;
    ink: (color: string | null, style: AnnotationStyle | null) => CSSProperties;
    /** The read-aloud wash: shape and ink the reader chose (`ttsWash.ts`). */
    ttsWash: CSSProperties;
  };
}) {
  if (isPdf) {
    // One page per chapter, drawn by pdf.js: fixed layout, real fonts
    // and illustrations. Deliberately outside the multicol prose
    // article: a page-sized canvas inside a column layout always
    // spills one column, which reads as a blank page after every page.
    //
    // No `key={chapterIdx}` here, on purpose. A key unmounts the canvas on
    // every turn, and the reader then watches an empty box plus "正在渲染页面…"
    // while pdf.js rasterises the next page. Left mounted, the page already on
    // screen holds until the new bitmap is blitted in one frame (see
    // PdfPageView). The cost is the page-turn transition: any entrance
    // animation would fade in the *previous* page's bitmap, so a paged PDF
    // turns without one.
    //
    // Each page view warms the one a turn will ask for, so that turn is a blit
    // rather than a 50–150 ms raster. The step is the spread, not one page:
    // in double-page mode a turn advances both views at once.
    // `ponytail:` forward only — a turn is what the reader feels, and a
    // spread's worth of rasters is the memory that buys it. Caching history
    // too would double that for a rarer gesture. See `MAX_RASTERS`.
    const step = doublePage ? 2 : 1;
    const prefetchAfter = (page: number) => (page + step <= total ? page + step : null);
    return paged ? (
      <div
        className="mx-auto flex h-full w-full items-stretch justify-center"
        style={{ paddingInline: margin, paddingBlock: blockMargin, gap: pdf.gap }}
      >
        <div className="h-full min-w-0 flex-1">
          <Suspense fallback={<p className="text-sm opacity-60">正在准备 PDF 渲染…</p>}>
            <PdfPageView
              bookId={bookId}
              pageNumber={chapterIdx + 1}
              prefetchPage={prefetchAfter(chapterIdx + 1)}
              fit="box"
              zoom={pdf.zoom}
              animated={pdf.animated}
              nightFg={pdf.night?.fg ?? null}
              nightBg={pdf.night?.bg ?? null}
              invertImages={pdf.invertImages}
              annotations={pdf.annotationsByPage.get(chapterIdx)}
              ttsWash={pdf.wash}
              onSelection={(range, rect, bottom) =>
                pdf.onSelection(range, rect, chapterIdx + 1, bottom)
              }
              onAnnotationClick={(annotation, x, y) =>
                pdf.onAnnotationClick(annotation, x, y, chapterIdx + 1)
              }
            />
          </Suspense>
        </div>
        {doublePage && chapterIdx + 1 < total && (
          <div className="h-full min-w-0 flex-1">
            <Suspense fallback={null}>
              <PdfPageView
                bookId={bookId}
                pageNumber={chapterIdx + 2}
                prefetchPage={prefetchAfter(chapterIdx + 2)}
                fit="box"
                zoom={pdf.zoom}
                animated={pdf.animated}
                nightFg={pdf.night?.fg ?? null}
                nightBg={pdf.night?.bg ?? null}
                invertImages={pdf.invertImages}
                annotations={pdf.annotationsByPage.get(chapterIdx + 1)}
                onSelection={(range, rect, bottom) =>
                  pdf.onSelection(range, rect, chapterIdx + 2, bottom)
                }
                onAnnotationClick={(annotation, x, y) =>
                  pdf.onAnnotationClick(annotation, x, y, chapterIdx + 2)
                }
              />
            </Suspense>
          </div>
        )}
      </div>
    ) : (
      <Suspense fallback={<p className="text-sm opacity-60">正在准备 PDF 渲染…</p>}>
        <PdfScrollView
          bookId={bookId}
          numPages={total}
          margin={margin}
          blockMargin={blockMargin}
          zoom={pdf.zoom}
          animated={pdf.animated}
          nightFg={pdf.night?.fg ?? null}
          nightBg={pdf.night?.bg ?? null}
          invertImages={pdf.invertImages}
          annotationsByPage={pdf.annotationsByPage}
          ttsPage={chapterIdx}
          ttsWash={pdf.wash}
          onSelection={pdf.onSelection}
          onAnnotationClick={pdf.onAnnotationClick}
          onLayout={pdf.onLayout}
        />
      </Suspense>
    );
  }

  if (useFoliate) {
    return (
      <Suspense fallback={<p className="text-text-3 p-6 text-sm">正在打开原书排版…</p>}>
        <FoliateBookView
          ref={foliateRef}
          bookId={bookId}
          format={foliate.format}
          startCfi={foliate.startCfi}
          startFraction={foliate.startFraction}
          layout={foliate.layout}
          transition={foliate.transition}
          marginX={margin}
          marginY={blockMargin}
          style={foliate.style}
          annotations={foliate.annotations}
          ttsWash={foliate.ttsWash}
          onSelect={foliate.onSelect}
          onAnnotationClick={foliate.onAnnotationClick}
          onAnchor={foliate.onAnchor}
          onImageOpen={foliate.onImageOpen}
          onLocationChange={foliate.onLocationChange}
          onTocLoaded={foliate.onTocLoaded}
          onActivate={foliate.onActivate}
          onPointerInBook={foliate.onPointerInBook}
        />
      </Suspense>
    );
  }

  if (paged && plate.image) {
    // Part-title page: full-bleed wallpaper with the heading in a
    // centred plate, the way the book's own stylesheet paints it.
    // Outside the multicol article — a page-sized image inside a
    // column layout spills columns and reads as blank pages.
    return (
      <div
        key={chapterIdx}
        className={cn("mx-auto h-full w-full", transitionClass)}
        style={{ paddingInline: margin, paddingBlock: blockMargin }}
      >
        <div className="border-hairline relative h-full w-full overflow-hidden rounded-2xl">
          <ChapterImage
            bookId={bookId}
            path={plate.image.imagePath}
            plate
            onOpen={() => {
              const imageNo = images.findIndex((image) => image.chapterIdx === chapterIdx);
              if (imageNo >= 0) onOpenImage(imageNo);
            }}
          />
          {plate.image.title !== "" && (
            // The book paints its part titles straight onto the art
            // (ink on paper, no box); a light halo keeps the glyphs
            // readable where the watercolour runs pale.
            <div className="absolute inset-0 flex items-center justify-center">
              <p
                className="text-center text-lg font-medium tracking-[0.3em] whitespace-pre-line"
                style={{ color: "#5a4632", textShadow: "0 1px 10px rgba(255,255,255,0.65)" }}
              >
                {plate.image.title}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <article
      key={chapterIdx}
      className={cn(
        "prose-reader mx-auto",
        !paged && "max-w-3xl",
        paged && "paged-prose",
        prose.darkSurface && prose.invertImages && "invert-book-images",
        transitionClass,
      )}
      style={prose.style}
    >
      {prose.pending ? (
        <p className="text-sm opacity-60">正在加载章节…</p>
      ) : (
        prose.paragraphs.map(({ idx, key, imagePath, link, segments }) =>
          link !== null ? (
            <p key={key} data-para-idx={idx} className="my-6">
              <button
                type="button"
                onClick={() => prose.onGoTo(link.idx)}
                className="focus-visible:focus-ring cursor-pointer underline decoration-dotted underline-offset-4 transition-opacity hover:opacity-70"
                style={{ color: "var(--accent)" }}
              >
                {link.text}
              </button>
            </p>
          ) : imagePath !== null ? (
            <p key={key} data-para-idx={idx} className="image-para my-6 text-center">
              <ChapterImage
                bookId={bookId}
                path={imagePath}
                onOpen={() => {
                  const imageNo = images.findIndex(
                    (image) => image.chapterIdx === chapterIdx && image.path === imagePath,
                  );
                  if (imageNo >= 0) onOpenImage(imageNo);
                }}
              />
            </p>
          ) : (
            <p
              key={key}
              data-para-idx={idx}
              className="text-justify text-pretty"
              style={{
                marginBottom: `${prose.gap}em`,
                textIndent: prose.indent ? "2em" : undefined,
                // Column layouts measure against real heights; dropping
                // off-screen content corrupts the page boundaries.
                ...(paged ? {} : { contentVisibility: "auto", containIntrinsicSize: "auto 3em" }),
              }}
            >
              {segments.map((segment) =>
                segment.tts ? (
                  // The reading voice's own run. Same ink as a saved
                  // mark — one wash, both reading paths — and the same ink on
                  // every format, whichever shape the reader picked. The
                  // attribute is what tells this mark from a highlight's: they
                  // share the tag and the class, and a test that has to find
                  // where the voice is cannot go by either.
                  <mark
                    key={segment.key}
                    data-tts-wash
                    className="text-inherit"
                    style={prose.ttsWash}
                  >
                    {segment.text}
                  </mark>
                ) : segment.highlighted ? (
                  segment.annotationId ? (
                    // An annotation-backed run opens the same toolbar
                    // a fresh selection gets, in edit mode. The
                    // wrapper is an anchor, not a `<button>`: buttons
                    // render as inline-block even with
                    // `display: inline`, and one atomic box breaks
                    // the paragraph's justified line breaking. A
                    // native anchor is focusable and Enter-clickable
                    // for free; the inner `<mark>` keeps the
                    // highlight semantics. The ink comes from the
                    // annotation's own colour and style.
                    <a
                      key={segment.key}
                      href={`#note-${segment.annotationId}`}
                      className="cursor-pointer"
                      onClick={(event) => {
                        event.preventDefault();
                        const annotation = prose.annotations?.find(
                          (a) => a.id === segment.annotationId,
                        );
                        if (!annotation) return;
                        prose.onEditAnnotation(annotation, event.clientX, event.clientY);
                      }}
                    >
                      <mark
                        className="text-inherit"
                        style={prose.ink(segment.color, segment.style as AnnotationStyle | null)}
                      >
                        {segment.text}
                      </mark>
                    </a>
                  ) : (
                    <mark key={segment.key} className="bg-accent-soft rounded-[2px] text-inherit">
                      {segment.text}
                    </mark>
                  )
                ) : (
                  segment.text
                ),
              )}
            </p>
          ),
        )
      )}
    </article>
  );
}
