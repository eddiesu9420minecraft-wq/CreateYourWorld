// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `--pikara-version` and the self-update helper run before (and instead of) the GUI.
    if let Some(code) = cyw_lib::cli_entry() {
        std::process::exit(code);
    }
    cyw_lib::run()
}
