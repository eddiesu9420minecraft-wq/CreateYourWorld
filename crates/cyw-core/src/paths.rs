use serde::Serialize;
use std::path::PathBuf;

/// App identifier (tauri.conf.json `identifier`): the data folder name on every platform.
pub const IDENTIFIER: &str = "com.pikara.cyw";

/// All on-disk locations, resolved from the OS conventions (same as Tauri's path API).
/// Nothing here is hard-coded to a particular platform.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub data: PathBuf,
    pub cache: PathBuf,
    pub downloads: PathBuf,
    pub apps: PathBuf,
    pub runtimes: PathBuf,
}

impl Paths {
    /// The same folders the GUI has always used (Tauri's app-local-data / app-cache dirs for
    /// `com.pikara.cyw`), resolved without Tauri so the CLI shares them.
    pub fn resolve() -> anyhow::Result<Self> {
        // Tests (and only tests) can point CYW at an isolated, empty data folder so they never
        // read or modify the user's real installed apps, settings or downloads.
        if let Some(dir) = std::env::var_os("PIKARA_CYW_DATA_DIR").filter(|d| !d.is_empty()) {
            let data = PathBuf::from(dir);
            return Ok(Self { downloads: data.join("downloads"), apps: data.join("apps"), runtimes: data.join("runtimes"), cache: data.join("cache"), data });
        }
        let data = dirs::data_local_dir().ok_or_else(|| anyhow::anyhow!("no local data directory"))?.join(IDENTIFIER);
        let mut cache = dirs::cache_dir().ok_or_else(|| anyhow::anyhow!("no cache directory"))?.join(IDENTIFIER);
        if cache == data {
            cache = data.join("cache");
        }
        Ok(Self {
            downloads: data.join("downloads"),
            apps: data.join("apps"),
            runtimes: data.join("runtimes"),
            cache,
            data,
        })
    }

    /// A self-contained layout under `root` (unit tests).
    #[cfg(test)]
    pub fn for_test(root: &std::path::Path) -> Self {
        let data = root.to_path_buf();
        Self { downloads: data.join("downloads"), apps: data.join("apps"), runtimes: data.join("runtimes"), cache: data.join("cache"), data }
    }

    pub fn ensure(&self) -> std::io::Result<()> {
        for p in [&self.data, &self.cache, &self.downloads, &self.apps, &self.runtimes] {
            std::fs::create_dir_all(p)?;
        }
        Ok(())
    }

    pub fn settings_file(&self) -> PathBuf { self.data.join("settings.json") }
    pub fn installed_file(&self) -> PathBuf { self.data.join("installed.json") }
    pub fn jobs_file(&self) -> PathBuf { self.data.join("downloads.json") }
}
