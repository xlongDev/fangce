//! Typed, serializable error surface shared by every command.
//!
//! Commands return `AppResult<T>`; Tauri serializes the error into the IPC
//! rejection payload, so the message must be safe and useful to show a user.

use serde::{Serialize, Serializer};
use std::time::Duration;

/// Every failure that can cross the IPC boundary.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("not found: {0}")]
    NotFound(String),

    /// The book's own file is gone — deleted, or left behind by a restore that
    /// did not finish. Distinct from every other IO failure because the two ask
    /// the reader for different things: a broken file can only be re-imported,
    /// a missing one may also be recoverable from a backup.
    #[error("书籍源文件缺失：{0}。可从备份恢复，或重新导入这本书。")]
    SourceMissing(String),

    #[error("unsupported format: {0}")]
    UnsupportedFormat(String),

    #[error("parse error: {0}")]
    Parse(String),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error("serialization error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("archive error: {0}")]
    Zip(#[from] zip::result::ZipError),

    /// A credential could not be sealed or opened. Its own variant because it
    /// is the one failure the reader can act on by re-entering the credential,
    /// and because the settings page keys its warning off it: "凭据" in the
    /// message is what tells them which field to retype.
    #[error("凭据不可用：{0}")]
    Secrets(String),

    /// A catalogue asked us to wait rather than refusing the book. Distinct
    /// from every other error because the right answer is to defer this book
    /// and try it in a later batch, not to tell the reader it does not exist.
    #[error("{provider} 返回 {status}，请稍后再试")]
    Throttled { provider: String, status: u16, retry_after: Duration },

    #[error("{0}")]
    Message(String),
}

impl AppError {
    /// Lock poisoning and other unrecoverable process-state failures.
    pub fn poisoned(what: &str) -> Self {
        AppError::Message(format!("内部状态损坏：{what} 的锁已被污染"))
    }

    /// Re-labels a failure from a path the caller already has: "the file is
    /// gone" reads differently to a reader than "the file is broken", and only
    /// the first one can be answered by a backup. Anything else passes through
    /// untouched — a parse failure on a file that is still there is not this.
    ///
    /// The name rather than the whole path: the payload is shown to the reader,
    /// and the data directory leading up to it is not theirs to act on.
    pub fn missing_source(path: &std::path::Path, err: AppError) -> AppError {
        match &err {
            AppError::Io(io) if io.kind() == std::io::ErrorKind::NotFound => {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.to_string_lossy().into_owned());
                AppError::SourceMissing(name)
            }
            _ => err,
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Specta sees the same shape `Serialize` emits: a plain string message.
///
/// Deriving `Type` would describe a tagged enum, which is not what crosses the
/// IPC boundary — Tauri turns an `Err` into a rejection carrying this string.
impl specta::Type for AppError {
    fn definition(types: &mut specta::Types) -> specta::datatype::DataType {
        <String as specta::Type>::definition(types)
    }
}

/// Result alias used by all command handlers.
pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_are_tagged() {
        let err =
            AppError::from(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked"));
        assert!(matches!(err, AppError::Io(_)));
        assert!(err.to_string().starts_with("io error:"));
    }

    #[test]
    fn serializes_as_plain_message() {
        let json = serde_json::to_string(&AppError::NotFound("book".into()))
            .expect("serialization must not fail");
        assert_eq!(json, "\"not found: book\"");
    }

    #[test]
    fn a_missing_file_is_reported_as_missing_rather_than_broken() {
        use std::path::Path;

        let gone = std::io::Error::new(std::io::ErrorKind::NotFound, "no such file");
        let err = AppError::missing_source(Path::new("/data/books/ab/abcdef.book"), gone.into());
        assert!(matches!(err, AppError::SourceMissing(ref name) if name == "abcdef.book"));
    }

    #[test]
    fn missing_source_leaves_every_other_failure_alone() {
        use std::path::Path;

        let denied = AppError::missing_source(
            Path::new("/data/books/x"),
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "locked").into(),
        );
        assert!(matches!(denied, AppError::Io(_)));

        let broken =
            AppError::missing_source(Path::new("/data/books/x"), AppError::Parse("bad opf".into()));
        assert!(matches!(broken, AppError::Parse(_)));
    }

    #[test]
    fn every_variant_renders_a_showable_sentence() {
        for err in [
            AppError::UnsupportedFormat("pdf".into()),
            AppError::Parse("bad opf".into()),
            AppError::InvalidArgument("empty id".into()),
            AppError::SourceMissing("abcdef.book".into()),
            AppError::Secrets("钥匙串不可用".into()),
            AppError::poisoned("library"),
        ] {
            assert!(!err.to_string().is_empty(), "{err:?} rendered nothing");
        }
    }
}
