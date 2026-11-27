use crate::github::Channel;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// How updates are handled (for CYW itself and for installed apps separately).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    /// Check, download, verify and install automatically (apps: once they are closed;
    /// CYW: applied when CYW exits).
    Auto,
    /// Check automatically and notify; installing needs a click.
    #[default]
    Notify,
    /// No automatic checks.
    Manual,
}

/// UI animation preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum UiMotion {
    /// Follow the OS "reduce motion" setting.
    #[default]
    System,
    On,
    Off,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Concurrent downloads in the queue (1..=4).
    pub max_concurrent_downloads: u8,
    /// How many previous versions to keep per app for rollback (0..=3).
    pub keep_previous_versions: u8,
    pub launch_after_install: bool,
    pub default_channel: Channel,
    /// Per-product channel override.
    pub channels: BTreeMap<String, Channel>,
    pub self_update_mode: UpdateMode,
    pub apps_update_mode: UpdateMode,
    pub ui_motion: UiMotion,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_concurrent_downloads: 2,
            keep_previous_versions: 1,
            launch_after_install: false,
            default_channel: Channel::Stable,
            channels: BTreeMap::new(),
            self_update_mode: UpdateMode::Notify,
            apps_update_mode: UpdateMode::Notify,
            ui_motion: UiMotion::System,
        }
    }
}

impl Settings {
    pub fn channel_for(&self, product_id: &str) -> Channel {
        self.channels.get(product_id).copied().unwrap_or(self.default_channel)
    }

    pub fn clamp(mut self) -> Self {
        self.max_concurrent_downloads = self.max_concurrent_downloads.clamp(1, 4);
        self.keep_previous_versions = self.keep_previous_versions.min(3);
        self
    }
}
