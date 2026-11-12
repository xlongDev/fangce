//! Custom protocol that serves book resources (covers) to the webview.
//!
//! Cover images live in the per-user data directory, outside the asset bundle,
//! so `<img src>` cannot point at them directly. A registered scheme keeps the
//! files private: nothing else on the machine can address them, and the
//! webview never learns a filesystem path.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Builder;
use tauri::http::{
    HeaderValue, Request, Response, StatusCode,
    header::{
        ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE,
        CONTENT_TYPE,
    },
};

use crate::db::Library;
use crate::document::{BookFormat, image_mime};
use crate::library::{cover_file, fonts, repository};

/// Scheme registered with Tauri. Also the host prefix on Windows and Android,
/// where custom protocols are served as `http://<scheme>.localhost`.
pub const SCHEME: &str = "fangce";

/// Path prefix under which cover images are addressed.
const COVER_PREFIX: &str = "/cover/";

/// Path prefix under which source files are addressed. The webview streams
/// these with HTTP Range requests so opening a book no longer transfers the
/// whole file over IPC (see `Registry::book`).
const BOOK_PREFIX: &str = "/book/";

/// Path prefix under which imported font files are addressed. Fonts are an
/// order of magnitude larger than covers, so they are cached hard (see
/// `Registry::font`).
const FONT_PREFIX: &str = "/font/";

/// Path prefix under which generated character portraits are addressed.
///
/// `<book id>/<slug>` — two segments, because a portrait belongs to one book and
/// two books may both have a 林昭.
const PORTRAIT_PREFIX: &str = "/portrait/";

/// How long a font response may be reused. The URL carries a UUID minted at
/// import, so this content can never change under it.
const FONT_CACHE: &str = "public, max-age=31536000, immutable";

/// How long a cover response may be reused.
///
/// Immutable because the URL is versioned: `cover_url` appends the row's
/// `updated_at`, and `set_cover` bumps it, so replacing a picture produces a
/// URL the browser has never fetched. Without the version this header would
/// freeze a stale cover on the shelf for a year.
const COVER_CACHE: &str = "public, max-age=31536000, immutable";

/// Slot the protocol handler reads from.
///
/// Tauri runs the setup hook on the event loop's `Ready` event, which is after
/// the webview has been created, so the browser can ask for a cover before the
/// database exists. Until setup publishes the library, requests answer 503 and
/// the browser retries on the next render.
///
/// The fonts directory rides along because it is the one thing here that cannot
/// be read off the database: covers and book files carry their absolute paths
/// in a row, while a font is recorded by name inside that directory — which is
/// what keeps the font list portable and the renderer ignorant of paths.
#[derive(Clone, Default)]
pub struct Registry(Arc<Mutex<Option<Ready>>>);

/// The library plus the directory the protocol resolves on its own.
#[derive(Clone)]
struct Ready {
    library: Library,
    fonts_dir: PathBuf,
    portraits_dir: PathBuf,
}

impl Registry {
    /// Publishes the opened library. Called once, from setup.
    pub fn set(&self, library: Library, fonts_dir: PathBuf, portraits_dir: PathBuf) {
        if let Ok(mut slot) = self.0.lock() {
            *slot = Some(Ready { library, fonts_dir, portraits_dir });
        }
    }

    fn ready(&self) -> Option<Ready> {
        self.0.lock().ok().and_then(|slot| slot.clone())
    }
}

/// Attaches the scheme to the builder.
///
/// Tauri 2 only accepts protocol handlers while the app is being assembled, so
/// the handler is installed from the builder chain rather than from the setup
/// hook, where the database would already be available.
pub fn install(builder: Builder<tauri::Wry>, registry: Registry) -> Builder<tauri::Wry> {
    builder
        .register_uri_scheme_protocol(SCHEME, move |_context, request| serve(&registry, &request))
}

/// Answers one protocol request. Every failure maps to a status code; the
/// handler never propagates an error out of the webview runtime.
fn serve(registry: &Registry, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri().to_string();
    let path = request.uri().path();
    if let Some(id) = cover_id(path) {
        return registry.cover(id, &uri);
    }
    if let Some(id) = book_id(path) {
        return registry.book(id, request);
    }
    if let Some(id) = font_id(path) {
        return registry.font(id, &uri);
    }
    if let Some((book, name)) = portrait_parts(path) {
        return registry.portrait(book, name, &uri);
    }
    tracing::warn!(uri = %uri, "资源协议收到无法识别的路径");
    empty(StatusCode::NOT_FOUND)
}

impl Registry {
    fn cover(&self, id: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
        let Some(Ready { library, .. }) = self.ready() else {
            tracing::debug!(uri = %uri, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };

        let path = match cover_file(&library, id) {
            Ok(path) => path,
            Err(err) => {
                tracing::warn!(uri = %uri, error = %err, "查询封面失败");
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };
        let Some(path) = path else {
            return empty(StatusCode::NOT_FOUND);
        };

        match std::fs::read(&path) {
            Ok(bytes) => {
                let mut response = Response::new(Cow::Owned(bytes));
                response
                    .headers_mut()
                    .insert(CONTENT_TYPE, HeaderValue::from_static(mime_of(&path)));
                response.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static(COVER_CACHE));
                response
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "读取封面失败");
                empty(StatusCode::NOT_FOUND)
            }
        }
    }

    /// Serves one generated portrait.
    ///
    /// No cache header: the file is rewritten in place when the reader asks for
    /// another take, and the URL has to stay the same for the panel to find it
    /// again — so the browser is told to ask every time.
    fn portrait(&self, book: &str, name: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
        let Some(Ready { portraits_dir, .. }) = self.ready() else {
            tracing::debug!(uri = %uri, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };

        let path = crate::ai::image::portrait_path(&portraits_dir, book, name);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let mut response = Response::new(Cow::Owned(bytes));
                let headers = response.headers_mut();
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("image/png"));
                headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
                response
            }
            Err(err) => {
                tracing::debug!(path = %path.display(), error = %err, "读取立绘失败");
                empty(StatusCode::NOT_FOUND)
            }
        }
    }

    /// Serves one imported font.
    ///
    /// Two of these headers carry weight rather than decoration. A font is
    /// fetched cross-origin — the app document and every book section have an
    /// origin of their own — and `@font-face` obeys CORS, so without the
    /// allow-origin header the face is refused and the reading surface quietly
    /// falls back to another font. And the cache lasts a year: the URL holds a
    /// UUID minted at import time, so it is immutable by construction, while
    /// refetching a 20 MB CJK face once per section would be visible as stutter.
    fn font(&self, id: &str, uri: &str) -> Response<Cow<'static, [u8]>> {
        let Some(Ready { library, fonts_dir, .. }) = self.ready() else {
            tracing::debug!(uri = %uri, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };

        let path = match fonts::path(&library, &fonts_dir, id) {
            Ok(path) => path,
            Err(err) => {
                tracing::warn!(uri = %uri, error = %err, "查询字体失败");
                return empty(StatusCode::INTERNAL_SERVER_ERROR);
            }
        };
        let Some(path) = path else {
            return empty(StatusCode::NOT_FOUND);
        };

        match std::fs::read(&path) {
            Ok(bytes) => {
                let mut response = Response::new(Cow::Owned(bytes));
                let headers = response.headers_mut();
                headers.insert(CONTENT_TYPE, HeaderValue::from_static(font_mime(&path)));
                headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
                headers.insert(CACHE_CONTROL, HeaderValue::from_static(FONT_CACHE));
                response
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "读取字体失败");
                empty(StatusCode::NOT_FOUND)
            }
        }
    }

    /// Streams a book's source file, honouring `Range` so the reader downloads
    /// only the bytes it needs (the OPF, a section, the central directory) and
    /// the open time stops scaling with the file size. A `fetch` from the
    /// webview is cross-origin, so `Access-Control-Allow-Origin` is set.
    fn book(&self, id: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
        let Some(Ready { library, .. }) = self.ready() else {
            tracing::debug!(id, "书库尚未就绪，拒绝资源请求");
            return empty(StatusCode::SERVICE_UNAVAILABLE);
        };
        let (file_path, format) = match library.with(|conn| repository::source(conn, id)) {
            Ok(value) => value,
            Err(err) => {
                tracing::warn!(id, error = %err, "查询书籍源文件失败");
                return empty(StatusCode::NOT_FOUND);
            }
        };
        let path = Path::new(&file_path);
        let Ok(total) = std::fs::metadata(path).map(|meta| meta.len()) else {
            return empty(StatusCode::NOT_FOUND);
        };

        let range =
            request.headers().get(tauri::http::header::RANGE).and_then(|value| value.to_str().ok());
        let (status, body, content_range, content_length) = match read_range(path, total, range) {
            Ok(result) => {
                let RangeResult { bytes, content_range } = result;
                let length = bytes.len();
                (StatusCode::PARTIAL_CONTENT, Cow::Owned(bytes), Some(content_range), length)
            }
            Err(_) => match std::fs::read(path) {
                Ok(bytes) => {
                    let length = bytes.len();
                    (StatusCode::OK, Cow::Owned(bytes), None, length)
                }
                Err(err) => {
                    tracing::warn!(path = %path.display(), error = %err, "读取源文件失败");
                    return empty(StatusCode::NOT_FOUND);
                }
            },
        };

        let mut response = Response::new(body);
        *response.status_mut() = status;
        let headers = response.headers_mut();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static(book_mime(format)));
        headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&content_length.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
        if let Some(range_value) = content_range
            && let Ok(value) = HeaderValue::from_str(&range_value)
        {
            headers.insert(CONTENT_RANGE, value);
        }
        // The webview fetches the protocol from its own origin; allow it.
        headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        response
    }
}

/// The id after `prefix`, or `None` when the path is not a resource we own.
///
/// Ids are v4 UUIDs, so anything outside hex and dashes is rejected outright:
/// an id is never used to build a path on its own, but refusing early keeps a
/// malformed or hostile URL from reaching a query at all.
fn resource_id<'a>(path: &'a str, prefix: &str) -> Option<&'a str> {
    let id = path.strip_prefix(prefix)?;
    valid_id(id).then_some(id)
}

/// Whether a path segment could be one of our ids.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

/// Cover id from a request path.
fn cover_id(path: &str) -> Option<&str> {
    resource_id(path, COVER_PREFIX)
}

/// Book id from a request path.
fn book_id(path: &str) -> Option<&str> {
    resource_id(path, BOOK_PREFIX)
}

/// Book id and character name from a portrait request path.
///
/// The book segment is held to the same rule as a cover id; the name is not,
/// because it is Chinese, and `image::portrait_path` sanitises it before it ever
/// reaches the filesystem.
fn portrait_parts(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix(PORTRAIT_PREFIX)?;
    let (book, name) = rest.split_once('/')?;
    let name = name.strip_suffix(".png").unwrap_or(name);
    if book.is_empty() || name.is_empty() || name.len() > 200 {
        return None;
    }
    valid_id(book).then_some((book, name))
}

/// Imported font id from a request path.
fn font_id(path: &str) -> Option<&str> {
    resource_id(path, FONT_PREFIX)
}

/// Content type announced for a served font, from the extension the import
/// kept. Getting this wrong is a silent failure: a face announced as the wrong
/// flavour is one the webview may drop without a word of explanation.
fn font_mime(path: &Path) -> &'static str {
    let extension = path.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase);
    match extension.as_deref() {
        Some("otf") => "font/otf",
        Some("ttc") => "font/collection",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "font/ttf",
    }
}

/// Content type announced for a served source file.
fn book_mime(format: BookFormat) -> &'static str {
    match format {
        BookFormat::Epub => "application/epub+zip",
        BookFormat::Mobi | BookFormat::Azw | BookFormat::Azw3 | BookFormat::Prc => {
            "application/x-mobipocket-ebook"
        }
        BookFormat::Cbz => "application/vnd.comicbook+zip",
        BookFormat::Fb2 => "application/x-fictionbook+xml",
        _ => "application/octet-stream",
    }
}

/// A single satisfiable byte range and the `Content-Range` it implies.
struct RangeResult {
    bytes: Vec<u8>,
    content_range: String,
}

/// Reads one `Range` window from `path`. `None` (no header or unparseable)
/// means the caller should serve the whole file.
fn read_range(path: &Path, total: u64, range: Option<&str>) -> Result<RangeResult, std::io::Error> {
    let Some((start, end)) = parse_range(range, total) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsatisfiable range"));
    };
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let length = (end - start + 1) as usize;
    let mut buffer = vec![0u8; length];
    file.read_exact(&mut buffer)?;
    Ok(RangeResult { bytes: buffer, content_range: format!("bytes {start}-{end}/{total}") })
}

/// Parses an HTTP `Range` header into an inclusive `[start, end]` window that
/// sits inside `[0, total - 1]`. Supports `start-end`, `start-` and `-suffix`.
fn parse_range(header: Option<&str>, total: u64) -> Option<(u64, u64)> {
    let header = header?.trim();
    let ranges = header.strip_prefix("bytes=")?.trim();
    let segment = ranges.split(',').next()?.trim();
    let (start_text, end_text) = segment.split_once('-')?;
    let (start, end) = if end_text.is_empty() {
        let start = start_text.parse::<u64>().ok()?;
        (start, total.saturating_sub(1))
    } else if start_text.is_empty() {
        let suffix = end_text.parse::<u64>().ok()?;
        if suffix == 0 {
            return None;
        }
        (total.saturating_sub(suffix), total.saturating_sub(1))
    } else {
        (start_text.parse::<u64>().ok()?, end_text.parse::<u64>().ok()?)
    };
    let end = end.min(total.saturating_sub(1));
    if start > end {
        return None;
    }
    Some((start, end))
}

fn mime_of(path: &Path) -> &'static str {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(image_mime)
        .unwrap_or("application/octet-stream")
}

fn empty(status: StatusCode) -> Response<Cow<'static, [u8]>> {
    let mut response = Response::new(Cow::Borrowed(&[] as &[u8]));
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_paths_accept_uuids() {
        assert_eq!(
            cover_id("/cover/6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"),
            Some("6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")
        );
        assert_eq!(cover_id("/cover/abc"), Some("abc"));
    }

    #[test]
    fn anything_that_is_not_a_cover_is_rejected() {
        assert_eq!(cover_id("/book/abc"), None);
        assert_eq!(cover_id("/cover/"), None);
        assert_eq!(cover_id("/cover/../../etc/passwd"), None);
        assert_eq!(cover_id("/cover/with space"), None);
        assert_eq!(cover_id("/cover"), None);
        // Longer than any id we issue.
        assert_eq!(cover_id(&format!("/cover/{}", "a".repeat(65))), None);
    }

    #[test]
    fn book_paths_accept_uuids_and_reject_garbage() {
        assert_eq!(
            book_id("/book/6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"),
            Some("6f1d2c3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")
        );
        assert_eq!(book_id("/book/"), None);
        assert_eq!(book_id("/book/with space"), None);
        assert_eq!(book_id("/book/../../etc/passwd"), None);
        assert_eq!(book_id("/cover/abc"), None);
    }

    #[test]
    fn range_parser_covers_the_common_forms() {
        // Closed window.
        assert_eq!(parse_range(Some("bytes=100-199"), 1000), Some((100, 199)));
        // Open-ended start: read to the end.
        assert_eq!(parse_range(Some("bytes=900-"), 1000), Some((900, 999)));
        // Suffix form.
        assert_eq!(parse_range(Some("bytes=-50"), 1000), Some((950, 999)));
        // End clamped to the file size.
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), Some((900, 999)));
        // No header, or malformed, or inverted window: nothing to satisfy.
        assert_eq!(parse_range(None, 1000), None);
        assert_eq!(parse_range(Some("items=0-10"), 1000), None);
        assert_eq!(parse_range(Some("bytes=200-100"), 1000), None);
        assert_eq!(parse_range(Some("bytes=-0"), 1000), None);
    }

    #[test]
    fn unregistered_requests_answer_service_unavailable() {
        let registry = Registry::default();
        let response = registry.cover("6f1d2c3e", "fangce://localhost/cover/6f1d2c3e");
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn mime_falls_back_to_octet_stream() {
        assert_eq!(mime_of(Path::new("a.png")), "image/png");
        assert_eq!(mime_of(Path::new("a")), "application/octet-stream");
    }
}
