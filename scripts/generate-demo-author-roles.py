#!/usr/bin/env python3
"""Regenerate `public/demo/author-roles.epub`.

Why this exists: the shelf's blank-page defect on the web build. foliate's EPUB
reader keeps a contributor an **object** whenever it carries a role or a
file-as, so a book whose creators carry `opf:role="aut"` hands over a list of
objects; stored as it arrived, `authorLine`'s `name.trim()` took the whole shelf
down (`TypeError: e.trim is not a function`). The desktop never met the shape —
its Rust importer answers plain strings — so only the browser import path could
show it, which is what `e2e/book-import.spec.ts` pins here.

    python3 scripts/generate-demo-author-roles.py public/demo/author-roles.epub

The two creators deliberately carry different attributes: the first only a
role, the second a role and a file-as. Both keep the contributor an object, and
a fixture with one shape would let a fix that only handles that shape pass.
"""
import sys
import zipfile

CONTAINER = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""

NAV = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">
<head><title>目录</title></head>
<body><nav epub:type="toc"><h1>目录</h1><ol><li><a href="ch1.xhtml">第一章 两个人</a></li></ol></nav></body>
</html>
"""

XHTML = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh">
<head><title>第一章 两个人</title></head>
<body><h1>第一章 两个人</h1><p>一本书的两个作者，各自写了一半。</p></body>
</html>
"""

OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:opf="http://www.idpf.org/2007/opf"
         xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0"
         unique-identifier="bookid" xml:lang="zh">
  <metadata>
    <dc:identifier id="bookid">urn:uuid:fangce-author-roles</dc:identifier>
    <dc:title>双作者样书</dc:title>
    <dc:language>zh</dc:language>
    <dc:creator opf:role="aut">张三</dc:creator>
    <dc:creator opf:role="aut" opf:file-as="Li, Si">李四</dc:creator>
    <meta property="dcterms:modified">2026-10-25T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>
"""


def main(out: str) -> None:
    with zipfile.ZipFile(out, "w") as archive:
        # `mimetype` first and uncompressed: a reader checks those exact 20
        # bytes at byte 30 before it will look at anything else.
        archive.writestr(
            zipfile.ZipInfo("mimetype", (2026, 10, 25, 0, 0, 0)),
            "application/epub+zip",
            zipfile.ZIP_STORED,
        )
        archive.writestr("META-INF/container.xml", CONTAINER)
        archive.writestr("OEBPS/content.opf", OPF)
        archive.writestr("OEBPS/nav.xhtml", NAV)
        archive.writestr("OEBPS/ch1.xhtml", XHTML)
    print(f"wrote {out}")


if __name__ == "__main__":
    main(sys.argv[1])
