//! IPC command handlers, grouped by domain: `system.*`, `book.*`, `reader.*`,
//! `annotation.*`, `search.*`, `pack.*`, `notes.*`, `ai.*`, `rag.*`, `graph.*`,
//! `source.*`, `sync.*`, `tts.*`, `tag.*`, `clippings.*`, `dictionary.*`,
//! `summary.*`, `backup.*`, `webview.*`, `mini_bar.*`.

pub mod ai;
pub mod annotation;
pub mod backup;
pub mod book;
pub mod bookmark;
pub mod clippings;
pub mod conversation;
pub mod dictionary;
pub mod export;
pub mod font;
pub mod graph;
pub mod lookup;
pub mod mini_bar;
pub mod ocr;
pub mod rag;
pub mod reader;
pub mod search;
pub mod source;
pub mod stats;
pub mod summary;
pub mod sync;
pub mod system;
pub mod tag;
pub mod tts;
pub mod webview;
