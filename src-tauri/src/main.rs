// Hides the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--mcp` is the whole CLI: the app is a windowed program, and the one
    // thing it also has to be is a tool server an agent can spawn. Parsed by
    // hand rather than through an argument crate — one flag does not earn a
    // dependency, and this keeps the flag from ever being swallowed by Tauri's
    // own argv handling.
    if std::env::args().nth(1).as_deref() == Some("--mcp") {
        std::process::exit(fangce_lib::run_mcp());
    }
    if let Err(err) = fangce_lib::run() {
        eprintln!("方册 启动失败：{err}");
        std::process::exit(1);
    }
}
