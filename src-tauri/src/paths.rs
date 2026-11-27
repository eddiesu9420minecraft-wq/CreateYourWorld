use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// All on-disk locations, resolved from the OS conventions via Tauri's path API.
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
    pub fn resolve(app: &AppHandle) -> anyhow::Result<Self> {
        let data = app.path().app_local_data_dir()?;
        let mut cache = app.path().app_cache_dir()?;
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
