//! Create Your World core, shared by the GUI (`create-your-world`) and the CLI (`cyw`).
//! Everything that downloads, verifies, installs, updates or changes the user's machine lives here, once.

pub mod archive;
pub mod catalog;
pub mod cli_path;
pub mod downloads;
pub mod feedback;
pub mod github;
pub mod host;
pub mod hub;
pub mod ids;
pub mod install;
pub mod launch;
pub mod lock;
pub mod paths;
pub mod platform;
pub mod plugins;
pub mod procs;
pub mod runtime;
pub mod selfupdate;
pub mod settings;
pub mod util;
pub mod verify;

/// Create Your World version (the GUI and the CLI ship together and share it).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
