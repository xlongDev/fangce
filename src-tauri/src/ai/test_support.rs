//! What the AI tests share: a scripted provider, and a library with a book.
//!
//! The agent loop, the tools and the image clients all need the same two things
//! and none of them can be checked without them. A real model costs a key and a
//! network; a mock that speaks the protocol costs a thread.

#![cfg(test)]

use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use rusqlite::params;

/// One SSE frame, as a provider would write it.
pub fn sse(frames: &[&str]) -> String {
    let mut out = String::new();
    for frame in frames {
        out.push_str("data: ");
        out.push_str(frame);
        out.push_str("\n\n");
    }
    out.push_str("data: [DONE]\n\n");
    out
}

/// A streamed answer with no tool calls: one text chunk, then a stop.
pub fn answer(text: &str) -> String {
    sse(&[
        &format!(r#"{{"choices":[{{"delta":{{"content":"{text}"}}}}]}}"#),
        r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
    ])
}

/// A scripted OpenAI-compatible endpoint: one canned reply per request, and
/// every request body kept for the assertions.
pub struct MockChat {
    pub base_url: String,
    pub seen: Arc<Mutex<Vec<String>>>,
}

impl MockChat {
    /// How many requests arrived.
    pub fn count(&self) -> usize {
        self.seen.lock().map(|list| list.len()).unwrap_or(0)
    }

    /// The body of request `index`, headers and all.
    pub fn request(&self, index: usize) -> String {
        self.seen.lock().map(|list| list[index].clone()).unwrap_or_default()
    }
}

/// Serves `replies` in order, one per connection, then stops listening.
pub fn mock_chat(replies: Vec<String>) -> MockChat {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let captured = seen.clone();

    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else { return };
            // Read the whole request first: replying before the client has
            // finished sending leaves it with a broken pipe.
            let request = read_request(&mut stream);
            if let Ok(mut slot) = captured.lock() {
                slot.push(request);
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                reply.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(reply.as_bytes());
        }
    });

    MockChat { base_url: format!("http://127.0.0.1:{port}"), seen }
}

/// Reads one whole request, headers and body.
fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut raw = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        raw.extend_from_slice(&buffer[..read]);
        let text = String::from_utf8_lossy(&raw).to_string();
        let Some(split) = text.find("\r\n\r\n") else { continue };
        let length = text[..split]
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                if !name.eq_ignore_ascii_case("content-length") {
                    return None;
                }
                value.trim().parse::<usize>().ok()
            })
            .unwrap_or(0);
        if raw.len() >= split + 4 + length {
            break;
        }
    }
    String::from_utf8_lossy(&raw).to_string()
}

/// A client that ignores the ambient proxy settings, for talking to the mock.
pub fn direct_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().expect("client")
}

/// A library with one book, and whatever the test puts in it.
pub struct Harness {
    dir: std::path::PathBuf,
    pub library: crate::db::Library,
}

impl Harness {
    pub fn new(tag: &str) -> Self {
        let dir = crate::document::fixture::temp_dir(tag);
        let layout = crate::db::Layout::create(dir.clone()).expect("layout");
        let library = crate::db::Library::open(&layout.data_dir).expect("open");
        library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO books (id, title, sort_title, format, content_hash, \
                     file_path, file_size, added_at, updated_at) \
                     VALUES ('b', 'T', 't', 'epub', 'h', 'p', 1, 1, 1)",
                    [],
                )?;
                Ok(())
            })
            .expect("seed book");
        Self { dir, library }
    }

    pub fn add_chapter(&self, idx: i64, title: &str, content: &str) {
        self.library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO chapters (book_id, idx, title, content, chars) \
                     VALUES ('b', ?1, ?2, ?3, ?4)",
                    params![idx, title, content, content.chars().count() as i64],
                )?;
                Ok(())
            })
            .expect("seed chapter");
    }

    pub fn add_entity(&self, name: &str, kind: &str, mentions: i64) {
        self.library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO entities (book_id, name, kind, mentions) VALUES ('b', ?1, ?2, ?3)",
                    params![name, kind, mentions],
                )?;
                Ok(())
            })
            .expect("seed entity");
    }

    pub fn add_relation(
        &self,
        subject: &str,
        relation: &str,
        object: &str,
        evidence: &str,
        at: i64,
    ) {
        self.library
            .with(|conn| {
                conn.execute(
                    "INSERT INTO entity_relations \
                     (book_id, subject, relation, object, evidence, chapter_idx) \
                     VALUES ('b', ?1, ?2, ?3, ?4, ?5)",
                    params![subject, relation, object, evidence, at],
                )?;
                Ok(())
            })
            .expect("seed relation");
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.dir).ok();
    }
}
