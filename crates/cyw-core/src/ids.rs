//! Package identifiers.
//!
//! Every product has exactly one identifier — its full product name (`PikaraScienceStudio`, `runX`,
//! later `RunXStudio`, `RunXIDE`). Matching is case-insensitive and there are no aliases: generic short names
//! such as `studio` would collide across the Pikara family. Identifiers used by earlier CYW versions are listed in
//! `legacyIds` and are used **only** to migrate existing records (installed apps, channels, download history);
//! they are never accepted on the command line.

use crate::catalog::Product;
use crate::install::InstalledDb;
use crate::settings::Settings;

/// Find a product by its identifier, ignoring ASCII case.
pub fn find<'a>(catalog: &'a [Product], name: &str) -> Option<&'a Product> {
    catalog.iter().find(|p| p.id.eq_ignore_ascii_case(name.trim()))
}

/// Identifiers that are close to `name` (for "did you mean" messages).
pub fn suggestions(catalog: &[Product], name: &str) -> Vec<String> {
    let n = name.to_ascii_lowercase();
    catalog
        .iter()
        .filter(|p| {
            let id = p.id.to_ascii_lowercase();
            id.contains(&n) || n.contains(&id) || p.name.to_ascii_lowercase().contains(&n)
        })
        .map(|p| p.id.clone())
        .collect()
}

/// Catalog rule: identifiers (and legacy identifiers) are unique, case-insensitively.
pub fn check_unique(catalog: &[Product]) -> Result<(), String> {
    let mut seen: Vec<(String, &str)> = vec![];
    for p in catalog {
        for id in std::iter::once(&p.id).chain(p.legacy_ids.iter()) {
            let k = id.to_ascii_lowercase();
            // a product may list its own old spelling (e.g. `runx` for `runX`); only other products collide
            if let Some((_, owner)) = seen.iter().find(|(s, o)| *s == k && *o != p.id.as_str()) {
                return Err(format!("identifier `{id}` of {} collides with {owner}", p.id));
            }
            seen.push((k, &p.id));
        }
    }
    Ok(())
}

fn canonical_for_legacy<'a>(catalog: &'a [Product], old: &str) -> Option<&'a Product> {
    catalog.iter().find(|p| p.legacy_ids.iter().any(|l| l.eq_ignore_ascii_case(old)))
}

/// Re-key installed apps recorded under a legacy identifier. Install folders are **not** moved (a running app
/// keeps working and nothing is downloaded again): each version keeps its recorded absolute path.
/// Returns true when something changed.
pub fn migrate_installed(db: &mut InstalledDb, catalog: &[Product]) -> bool {
    let olds: Vec<String> = db.apps.keys().filter(|k| find(catalog, k).map(|p| p.id != **k).unwrap_or(true)).cloned().collect();
    let mut changed = false;
    for old in olds {
        let target = canonical_for_legacy(catalog, &old).or_else(|| find(catalog, &old)).map(|p| p.id.clone());
        let Some(new_id) = target else { continue };
        if let Some(mut app) = db.apps.remove(&old) {
            app.product_id = new_id.clone();
            match db.apps.get_mut(&new_id) {
                // both present (should not happen): keep every version, prefer the canonical record's current
                Some(existing) => {
                    for v in app.versions {
                        if !existing.versions.iter().any(|x| x.tag == v.tag) {
                            existing.versions.push(v);
                        }
                    }
                    existing.on_path |= app.on_path;
                }
                None => {
                    db.apps.insert(new_id, app);
                }
            }
            changed = true;
        }
    }
    changed
}

/// Re-key per-product channel choices.
pub fn migrate_settings(s: &mut Settings, catalog: &[Product]) -> bool {
    let olds: Vec<String> = s.channels.keys().filter(|k| canonical_for_legacy(catalog, k).is_some()).cloned().collect();
    for old in &olds {
        if let (Some(c), Some(p)) = (s.channels.remove(old), canonical_for_legacy(catalog, old)) {
            s.channels.entry(p.id.clone()).or_insert(c);
        }
    }
    !olds.is_empty()
}

/// Canonical identifier for a product id found in an old record (download history), unchanged otherwise.
pub fn canonical_id(catalog: &[Product], id: &str) -> String {
    canonical_for_legacy(catalog, id).or_else(|| find(catalog, id)).map(|p| p.id.clone()).unwrap_or_else(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{InstallKind, InstalledApp, InstalledVersion};

    fn catalog() -> Vec<Product> {
        crate::catalog::load()
    }

    #[test]
    fn real_catalog_has_unique_full_names_and_no_generic_aliases() {
        let c = catalog();
        check_unique(&c).unwrap();
        assert!(find(&c, "PikaraScienceStudio").is_some());
        assert!(find(&c, "pikarasciencestudio").is_some(), "case-insensitive");
        assert!(find(&c, "RUNX").is_some_and(|p| p.id == "runX"));
        for alias in ["studio", "pikarastudio", "pss", "pikara-science-studio", "runx-studio"] {
            assert!(find(&c, alias).is_none(), "`{alias}` must not resolve to a product");
        }
    }

    #[test]
    fn duplicate_identifiers_are_rejected() {
        let mut c = catalog();
        let mut dup = c[0].clone();
        dup.id = c[0].id.to_ascii_uppercase();
        c.push(dup);
        assert!(check_unique(&c).is_err());
    }

    #[test]
    fn legacy_studio_record_is_rekeyed_without_moving_files() {
        let c = catalog();
        let dir = std::path::PathBuf::from(r"C:\data\apps\pikara-science-studio\v0.3.4");
        let mut db = InstalledDb::default();
        db.apps.insert(
            "pikara-science-studio".into(),
            InstalledApp {
                product_id: "pikara-science-studio".into(),
                current: "v0.3.4".into(),
                versions: vec![InstalledVersion {
                    tag: "v0.3.4".into(),
                    dir: dir.clone(),
                    launch: dir.join("PikaraScienceStudio.exe"),
                    kind: InstallKind::Portable,
                    asset_name: "PikaraScienceStudio.exe".into(),
                    size: 1,
                    verification: Default::default(),
                    installed_at: 1,
                }],
                on_path: false,
            },
        );
        assert!(migrate_installed(&mut db, &c));
        let app = db.apps.get("PikaraScienceStudio").expect("re-keyed");
        assert_eq!(app.product_id, "PikaraScienceStudio");
        assert_eq!(app.versions[0].dir, dir, "install folder is not moved");
        assert!(!db.apps.contains_key("pikara-science-studio"));
        assert!(!migrate_installed(&mut db, &c), "idempotent");
    }
}
