#!/usr/bin/env python3
"""Generate a Calibre-compatible library for checking 方册's read-only scan.

You do not need Calibre installed, or an existing library, to use this. The
schema is Calibre's own (user_version 28), vendored as GPL-3.0 by dalibre at
github.com/djyde/dalibre in internal/calibre/metadata_sqlite.sql. 方册 is
AGPL-3.0 and does NOT vendor that file: this script fetches it into
~/.cache/fangce/ at run time, or falls back to an offline DDL with the same
column names. Neither the SQL nor the generated library lives in this repo.

Usage:
    python3 scripts/generate-calibre-sample.py [output-dir]

Then open 方册 → shelf header's folder button → pick output-dir. The EPUBs are
minimal but valid, so "import selected" has real files to try (the import
itself is not verified by this script); other formats are placeholder bytes
that exercise the failure message instead.

The generated library deliberately includes awkward real-world shapes: a
custom column, extra tables the scanner never reads, a multi-author book, an
HTML comment, a book whose directory is missing, and a path that escapes the
library (which must produce a warning, never a crash).
"""

from __future__ import annotations

import io
import os
import sqlite3
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = "https://github.com/djyde/dalibre"
SCHEMA_PATH = "internal/calibre/metadata_sqlite.sql"
CACHE = Path.home() / ".cache" / "fangce" / "calibre-metadata-sqlite.sql"
DEFAULT_OUTPUT = Path.home() / "Downloads" / "fangce-calibre-sample"

# Column names copied from Calibre's schema, not the SQL text: only the tables
# the scanner reads plus the side tables holding optional metadata. Used when
# there is no network and no cached copy.
FALLBACK_DDL = """
CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, sort TEXT,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    pubdate TIMESTAMP DEFAULT CURRENT_TIMESTAMP, series_index REAL DEFAULT 1.0,
    author_sort TEXT, path TEXT DEFAULT '', uuid TEXT, has_cover BOOL DEFAULT 0,
    last_modified TIMESTAMP DEFAULT '2000-01-01 00:00:00+00:00');
CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT);
CREATE TABLE books_authors_link (id INTEGER PRIMARY KEY, book INTEGER, author INTEGER);
CREATE TABLE data (id INTEGER PRIMARY KEY, book INTEGER, format TEXT,
    uncompressed_size INTEGER, name TEXT);
CREATE TABLE identifiers (id INTEGER PRIMARY KEY, book INTEGER, type TEXT, val TEXT);
CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT);
CREATE TABLE books_publishers_link (id INTEGER PRIMARY KEY, book INTEGER, publisher INTEGER);
CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL, link TEXT);
CREATE TABLE books_tags_link (id INTEGER PRIMARY KEY, book INTEGER, tag INTEGER);
CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort TEXT, link TEXT);
CREATE TABLE books_series_link (id INTEGER PRIMARY KEY, book INTEGER, series INTEGER);
CREATE TABLE ratings (id INTEGER PRIMARY KEY, rating INTEGER, link TEXT);
CREATE TABLE books_ratings_link (id INTEGER PRIMARY KEY, book INTEGER, rating INTEGER);
CREATE TABLE languages (id INTEGER PRIMARY KEY, lang_code TEXT NOT NULL, link TEXT);
CREATE TABLE books_languages_link (id INTEGER PRIMARY KEY, book INTEGER,
    lang_code INTEGER, item_order INTEGER DEFAULT 0);
CREATE TABLE comments (id INTEGER PRIMARY KEY, book INTEGER, text TEXT);
CREATE TABLE custom_columns (id INTEGER PRIMARY KEY, label TEXT NOT NULL,
    name TEXT NOT NULL, datatype TEXT NOT NULL, mark_for_delete BOOL DEFAULT 0,
    editable BOOL DEFAULT 1, display TEXT DEFAULT '{}',
    is_multiple BOOL DEFAULT 0, normalized BOOL NOT NULL);
"""

ROWS = """
INSERT INTO books (id, title, path, pubdate) VALUES
  (1, '三体', '刘慈欣/三体 (1)', '2006-05-01 00:00:00+00:00'),
  (2, '活着', '余华/活着 (2)', '1993-01-01 00:00:00+00:00'),
  (3, '红楼梦', '曹雪芹/红楼梦 (3)', '1791-01-01 00:00:00+00:00'),
  (4, '越界示例', '../outside', NULL),
  (5, '目录缺失示例', '无名氏/目录缺失 (5)', NULL);
INSERT INTO authors (id, name) VALUES
  (1, '刘慈欣'), (2, '余华'), (3, '曹雪芹'), (4, '高鹗'), (5, '无名氏');
INSERT INTO books_authors_link (id, book, author) VALUES
  (1, 1, 1), (2, 2, 2), (3, 3, 3), (4, 3, 4), (5, 5, 5);
INSERT INTO data (id, book, format, uncompressed_size, name) VALUES
  (1, 1, 'EPUB', 0, '三体 - 刘慈欣'),
  (2, 1, 'AZW3', 0, '三体 - 刘慈欣'),
  (3, 2, 'EPUB', 0, '活着 - 余华'),
  (4, 3, 'PDF', 0, '红楼梦 - 曹雪芹'),
  (5, 4, 'EPUB', 0, '越界示例');
INSERT INTO identifiers (id, book, type, val) VALUES
  (1, 1, 'isbn', '9787536692930'), (2, 1, 'doi', '10.1000/xyz'),
  (3, 2, 'ISBN', '9787506365437');
INSERT INTO publishers (id, name) VALUES (1, '重庆出版社');
INSERT INTO books_publishers_link (id, book, publisher) VALUES (1, 1, 1);
INSERT INTO tags (id, name) VALUES (1, '科幻'), (2, '中国文学'), (3, '古典');
INSERT INTO books_tags_link (id, book, tag) VALUES (1, 1, 1), (2, 1, 2), (3, 3, 3);
INSERT INTO series (id, name) VALUES (1, '地球往事');
INSERT INTO books_series_link (id, book, series) VALUES (1, 1, 1);
INSERT INTO ratings (id, rating) VALUES (1, 8), (2, 10);
INSERT INTO books_ratings_link (id, book, rating) VALUES (1, 1, 1), (2, 3, 2);
INSERT INTO languages (id, lang_code) VALUES (1, 'zho'), (2, 'eng');
INSERT INTO books_languages_link (id, book, lang_code) VALUES (1, 1, 1), (2, 1, 2), (3, 3, 1);
INSERT INTO comments (id, book, text) VALUES
  (1, 1, '<p>地球往事三部曲 · <b>示例简介</b></p>'),
  (2, 3, '<div>中国古典长篇小说</div>');
INSERT INTO custom_columns (id, label, name, datatype, normalized)
  VALUES (1, '书架', 'shelf', 'text', 0);
INSERT INTO custom_column_1 (id, book, value) VALUES (1, 1, '科幻架');
"""


def official_schema() -> tuple[str, str]:
    """Return (DDL, human-readable provenance). Never vendor the GPL SQL."""
    from_env = os.environ.get("FANGCE_CALIBRE_SCHEMA")
    if from_env and Path(from_env).is_file():
        return Path(from_env).read_text(), f"local file {from_env}"
    if CACHE.is_file():
        return CACHE.read_text(), f"cached copy {CACHE}"

    with tempfile.TemporaryDirectory(prefix="fangce-dalibre-") as tmp:
        clone = Path(tmp) / "dalibre"
        try:
            subprocess.run(
                ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", REPO, str(clone)],
                check=True,
                capture_output=True,
                timeout=90,
            )
            subprocess.run(
                ["git", "-C", str(clone), "sparse-checkout", "set", "internal/calibre"],
                check=True,
                capture_output=True,
                timeout=60,
            )
            sql = (clone / SCHEMA_PATH).read_text()
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            CACHE.write_text(sql)
            return sql, f"fresh clone of {REPO} (cached in {CACHE})"
        except (OSError, subprocess.SubprocessError) as err:
            print(f"Note: could not fetch Calibre's schema ({err}); using offline DDL.")
            return FALLBACK_DDL, "offline DDL with Calibre's column names"


def minimal_epub(title: str, author: str) -> bytes:
    """A real, if tiny, EPUB: enough for 方册's importer to open it."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(
            zipfile.ZipInfo("mimetype"),
            "application/epub+zip",
            compress_type=zipfile.ZIP_STORED,
        )
        zf.writestr(
            "META-INF/container.xml",
            '<?xml version="1.0"?><container version="1.0" '
            'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
            '<rootfiles><rootfile full-path="OEBPS/content.opf" '
            'media-type="application/oebps-package+xml"/></rootfiles></container>',
        )
        zf.writestr(
            "OEBPS/content.opf",
            '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" '
            'version="3.0" unique-identifier="id"><metadata '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            f'<dc:identifier id="id">urn:uuid:sample-{sum(title.encode())}</dc:identifier>'
            f"<dc:title>{title}</dc:title><dc:creator>{author}</dc:creator>"
            "<dc:language>zh</dc:language></metadata>"
            '<manifest><item id="c1" href="c1.xhtml" '
            'media-type="application/xhtml+xml"/></manifest>'
            '<spine><itemref idref="c1"/></spine></package>',
        )
        zf.writestr(
            "OEBPS/c1.xhtml",
            '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">'
            f"<head><title>{title}</title></head><body><h1>{title}</h1>"
            f"<p>方册 Calibre 示例书库：{author}。</p></body></html>",
        )
    return buf.getvalue()


def write_library(root: Path, schema_sql: str) -> tuple[int, int]:
    db = root / "metadata.db"
    conn = sqlite3.connect(db)
    conn.executescript(schema_sql)
    # Calibre registers SQL functions (title_sort, uuid4, ...) in its app, so
    # its triggers cannot run under a bare sqlite3 connection.
    triggers = [
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'trigger'")
    ]
    for name in triggers:
        conn.execute(f'DROP TRIGGER "{name}"')
    conn.execute("PRAGMA user_version = 28")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_column_1 "
        "(id INTEGER PRIMARY KEY, book INTEGER, value TEXT)"
    )
    conn.executescript(ROWS)
    conn.commit()
    tables = conn.execute(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table'"
    ).fetchone()[0]
    conn.close()

    books: dict[str, list[str]] = {
        "刘慈欣/三体 (1)": [
            "三体 - 刘慈欣.epub",
            "三体 - 刘慈欣.azw3",
            "cover.jpg",
            "metadata.opf",
        ],
        "余华/活着 (2)": ["活着 - 余华.epub", "cover.jpg", "metadata.opf"],
        "曹雪芹/红楼梦 (3)": ["红楼梦 - 曹雪芹.pdf", "cover.jpg", "metadata.opf"],
        # Book 4 escapes the library and book 5 has no directory on purpose:
        # both must show up as warnings, not as a failed scan or an empty list.
    }
    for relative, names in books.items():
        folder = root / relative
        folder.mkdir(parents=True, exist_ok=True)
        for name in names:
            path = folder / name
            if name.endswith(".epub"):
                author = relative.split("/")[0]
                path.write_bytes(minimal_epub(name.removesuffix(".epub"), author))
            elif name == "metadata.opf":
                path.write_text(
                    '<?xml version="1.0"?><package '
                    'xmlns="http://www.idpf.org/2007/opf" version="2.0"/>'
                )
            else:
                path.write_bytes(b"fixture")
    return tables, len(triggers)


def main() -> int:
    output = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else DEFAULT_OUTPUT
    if output.exists() and any(output.iterdir()):
        print(f"Refusing to touch a non-empty directory: {output}")
        print("Pass a different path, or move that directory aside first.")
        return 1

    schema_sql, source = official_schema()
    output.mkdir(parents=True, exist_ok=True)
    tables, triggers = write_library(output, schema_sql)
    print(f"Created:  {output}")
    print(f"Schema:   {source}")
    print(f"          user_version 28 · {tables} tables · {triggers} triggers dropped")
    print("Books:    5 (3 importable EPUB/PDF, 1 escaping path, 1 missing directory)")
    print("Next:     方册 → 书架标题栏的文件夹图标 → 选上面这个目录")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
