//! Character pack: one book's character cards in a single file.
//!
//! Same container as the book pack (`pack.rs`) — a ZIP — because the thing a
//! reader does with it is hand it to another reader, not feed it to a database.
//! The manifest is plain JSON so a pack can be read without this program; the
//! portraits are the exact PNG bytes the resource protocol already serves.

use std::io::{Cursor, Read, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::{AppError, AppResult};

const MANIFEST_ENTRY: &str = "manifest.json";
const MANIFEST_FORMAT: &str = "fangce-characters";
const MANIFEST_VERSION: u32 = 1;
/// Every portrait entry starts with this; the rest of the name is the file slug,
/// which is also how a card finds its picture again after an import.
const PORTRAIT_PREFIX: &str = "portraits/";

/// One card as it travels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackedCharacter {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub mentions: usize,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    characters: Vec<PackedCharacter>,
}

/// A pack, read back: the cards and their pictures, keyed by file slug.
pub struct Unpacked {
    pub characters: Vec<PackedCharacter>,
    pub portraits: Vec<(String, Vec<u8>)>,
}

/// Writes `characters` and their portraits to `dest`.
pub fn export(
    dest: &Path,
    characters: &[PackedCharacter],
    portraits: &[(String, Vec<u8>)],
) -> AppResult<()> {
    std::fs::write(dest, build(characters, portraits)?)?;
    Ok(())
}

/// Reads a pack. The manifest is checked before anything is returned, so a ZIP
/// that merely has the right extension is rejected rather than half-imported.
pub fn unpack(path: &Path) -> AppResult<Unpacked> {
    read(&std::fs::read(path)?)
}

fn build(characters: &[PackedCharacter], portraits: &[(String, Vec<u8>)]) -> AppResult<Vec<u8>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    writer.start_file(MANIFEST_ENTRY, options)?;
    serde_json::to_writer(
        &mut writer,
        &Manifest {
            format: MANIFEST_FORMAT.to_string(),
            version: MANIFEST_VERSION,
            characters: characters.to_vec(),
        },
    )?;

    for (slug, bytes) in portraits {
        writer.start_file(format!("{PORTRAIT_PREFIX}{slug}.png"), options)?;
        writer.write_all(bytes)?;
    }

    Ok(writer.finish()?.into_inner())
}

fn read(archive: &[u8]) -> AppResult<Unpacked> {
    let mut zip = ZipArchive::new(Cursor::new(archive))?;
    // zip 9 decodes entry names lazily, so each one arrives as
    // `Result<Cow<str>, _>`. A name that is not valid UTF-8 cannot be a portrait
    // this module wrote, so it is skipped.
    let names: Vec<String> =
        zip.file_names().filter_map(|name| name.ok()).map(|name| name.to_string()).collect();

    let manifest: Manifest = serde_json::from_reader(
        zip.by_name(MANIFEST_ENTRY).map_err(|_| AppError::Parse("这个文件不是角色卡包".into()))?,
    )?;
    if manifest.format != MANIFEST_FORMAT {
        return Err(AppError::UnsupportedFormat(manifest.format));
    }
    if manifest.version > MANIFEST_VERSION {
        return Err(AppError::InvalidArgument(format!(
            "角色卡包版本 {} 高于当前支持的 {MANIFEST_VERSION}",
            manifest.version
        )));
    }

    let mut portraits = Vec::new();
    for name in names.iter().filter(|name| name.starts_with(PORTRAIT_PREFIX)) {
        let Some(slug) = name[PORTRAIT_PREFIX.len()..].strip_suffix(".png") else {
            continue;
        };
        if slug.is_empty() {
            continue;
        }
        let mut bytes = Vec::new();
        zip.by_name(name)?.read_to_end(&mut bytes)?;
        portraits.push((slug.to_string(), bytes));
    }

    Ok(Unpacked { characters: manifest.characters, portraits })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pack_round_trips() {
        let cards =
            vec![PackedCharacter { name: "林昭".into(), kind: "人物".into(), mentions: 12 }];
        let portraits = vec![("林昭".to_string(), vec![0x89, b'P', b'N', b'G'])];
        let bytes = build(&cards, &portraits).unwrap();
        let read = read(&bytes).unwrap();
        assert_eq!(read.characters, cards);
        assert_eq!(read.portraits, portraits);
    }

    #[test]
    fn a_zip_without_a_manifest_is_refused() {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("portraits/x.png", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"not a card").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert!(read(&bytes).is_err());
    }

    #[test]
    fn an_empty_book_exports_an_empty_pack() {
        let read = read(&build(&[], &[]).unwrap()).unwrap();
        assert!(read.characters.is_empty());
        assert!(read.portraits.is_empty());
    }
}
