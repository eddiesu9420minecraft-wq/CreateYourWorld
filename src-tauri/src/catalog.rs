use crate::install::InstallKind;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// One entry of the product list. The list is bundled with the app
/// (`catalog/products.json`); versions and downloads always come from GitHub Releases.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub name: String,
    pub tagline: String,
    pub description: String,
    /// `owner/name`. `None` means the product is still in development and has no repo yet.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub glyph: Option<String>,
    /// Asset rules keyed by `"{os}-{arch}"`, tried in order.
    #[serde(default)]
    pub assets: BTreeMap<String, Vec<AssetRule>>,
    /// Asset name regexes that are never installable (checksums, signatures, extras).
    #[serde(default)]
    pub ignore_assets: Vec<String>,
    /// Minisign / Tauri-updater public key. When set, a matching `.sig` asset is REQUIRED.
    #[serde(default)]
    pub minisign_public_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRule {
    pub pattern: String,
    pub kind: InstallKind,
    /// Relative path (or file name) of the executable to launch, for installers / archives.
    #[serde(default)]
    pub launch: Option<String>,
}

pub fn load() -> Vec<Product> {
    serde_json::from_str(include_str!("../catalog/products.json"))
        .expect("bundled catalog/products.json must be valid")
}

#[cfg(test)]
mod tests {
    #[test]
    fn catalog_parses() {
        let c = super::load();
        assert!(c.iter().any(|p| p.id == "pikara-science-studio"));
        for p in &c {
            for rules in p.assets.values() {
                for r in rules {
                    regex::Regex::new(&r.pattern).unwrap();
                }
            }
        }
    }
}
