//! Feedback Center client: compose → automatic redaction → **preview** → explicit consent → upload.
//!
//! Nothing leaves the machine until the user has seen the exact payload ([`Feedback::prepare`]) and confirmed it
//! ([`Feedback::submit`] with the preview's SHA-256; any difference is refused). The backend contract is
//! `docs/feedback/API.md`; the backend itself is `services/feedback` (Cloudflare Worker + D1, local-first).

pub mod client;
pub mod image;
pub mod redact;
mod store;

use crate::hub::Core;
use anyhow::{anyhow, bail, Result};
use base64::Engine;
use client::{ApiError, Client, Session};
use redact::Redactor;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const CATEGORIES: &[&str] = &["bug", "feature", "performance", "compatibility", "general"];
/// CYW itself can be reported on, besides every catalog product.
pub const SELF_PRODUCT: &str = "CreateYourWorld";
const PREVIEW_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Environment {
    pub product_version: Option<String>,
    pub cyw_version: String,
    pub os: String,
    pub os_version: Option<String>,
    pub arch: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachment {
    pub filename: String,
    /// File contents, base64 (from a file picker or a pasted screenshot).
    pub data_base64: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub product: String,
    pub category: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub include_environment: bool,
    #[serde(default)]
    pub include_diagnostics: bool,
    #[serde(default)]
    pub attachments: Vec<DraftAttachment>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentPreview {
    pub filename: String,
    pub content_type: String,
    pub size: usize,
    pub sha256: String,
    /// Image metadata blocks (EXIF/GPS, XMP, text chunks, comments) removed.
    pub metadata_removed: u32,
    pub redactions: BTreeMap<String, u32>,
    /// Redacted text, exactly as it will be uploaded (logs).
    pub text: Option<String>,
    /// `data:` URL of the cleaned image, exactly as it will be uploaded (screenshots).
    pub data_url: Option<String>,
}

/// What the user reviews before anything is uploaded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub sha256: String,
    pub endpoint: String,
    /// The exact JSON body of `POST /v1/feedback`.
    pub payload: Value,
    pub redactions: BTreeMap<String, u32>,
    pub attachments: Vec<AttachmentPreview>,
    pub warnings: Vec<String>,
}

struct Prepared {
    preview: Preview,
    files: Vec<(String, String, Vec<u8>)>,
    created: SystemTime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub configured: bool,
    pub base: Option<String>,
    pub user: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    pub feedback: Value,
    pub server_redactions: u64,
    pub attachments: Vec<Value>,
    pub attachment_errors: Vec<String>,
}

pub struct Feedback {
    client: Option<Client>,
    config_error: Option<String>,
    session_file: PathBuf,
    session: Mutex<Option<Session>>,
    device_code: Mutex<Option<String>>,
    prepared: Mutex<HashMap<String, Prepared>>,
    redactor: Redactor,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// Strip control characters (except newline/tab) and trim.
fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect::<String>().replace("\r\n", "\n").trim().to_string()
}

fn merge(into: &mut BTreeMap<String, u32>, from: &BTreeMap<String, u32>) {
    for (k, v) in from {
        *into.entry(k.clone()).or_default() += v;
    }
}

impl Feedback {
    pub fn new(data_dir: &std::path::Path, base: Option<String>, resolver: pikara_secure::doh::DohResolver) -> Self {
        Self::with_redactor(data_dir, base, resolver, Redactor::local())
    }

    pub fn with_redactor(data_dir: &std::path::Path, base: Option<String>, resolver: pikara_secure::doh::DohResolver, redactor: Redactor) -> Self {
        let (client, config_error) = match base.as_deref().map(|b| Client::new(b, resolver)) {
            None => (None, None),
            Some(Ok(c)) => (Some(c), None),
            Some(Err(e)) => (None, Some(format!("{e:#}"))),
        };
        let session_file = data_dir.join("feedback").join("session.bin");
        let session = store::load(&session_file).filter(|s: &Session| client.as_ref().is_some_and(|c| c.base() == s.base) && s.expires_at > now());
        Self { client, config_error, session_file, session: Mutex::new(session), device_code: Mutex::new(None), prepared: Mutex::new(HashMap::new()), redactor }
    }

    fn client(&self) -> Result<&Client> {
        self.client.as_ref().ok_or_else(|| anyhow!(self.config_error.clone().unwrap_or_else(|| "反饋服務尚未部署（尚未設定後端網址）".into())))
    }

    fn token(&self) -> Option<String> {
        self.session.lock().unwrap().as_ref().map(|s| s.token.clone())
    }

    pub fn status(&self) -> Status {
        Status {
            configured: self.client.is_some(),
            base: self.client.as_ref().map(|c| c.base()),
            user: self.session.lock().unwrap().as_ref().map(|s| s.user.clone()),
            error: self.config_error.clone(),
        }
    }

    // ------------------------------------------------------------------ sign-in ----

    /// Start GitHub sign-in (device flow, proxied by the backend: the client never holds an OAuth secret).
    pub async fn device_start(&self) -> Result<DeviceStart> {
        let (_, v) = self.client()?.json(Method::POST, "/v1/auth/device", &[], Some(&json!({})), None).await?;
        let uri = v["verification_uri"].as_str().unwrap_or_default().to_string();
        // only ever open GitHub's own device page
        if !uri.starts_with("https://github.com/login/device") {
            bail!("反饋服務回傳了非 GitHub 的登入網址");
        }
        let code = v["device_code"].as_str().ok_or_else(|| anyhow!("缺少 device_code"))?.to_string();
        *self.device_code.lock().unwrap() = Some(code);
        Ok(DeviceStart {
            user_code: v["user_code"].as_str().unwrap_or_default().to_string(),
            verification_uri: uri,
            interval: v["interval"].as_u64().unwrap_or(5).max(1),
            expires_in: v["expires_in"].as_u64().unwrap_or(900),
        })
    }

    /// Poll once. `Ok(None)` = still waiting for the user.
    pub async fn device_poll(&self) -> Result<Option<Value>> {
        let code = self.device_code.lock().unwrap().clone().ok_or_else(|| anyhow!("請先開始登入"))?;
        let (status, v) = self.client()?.json(Method::POST, "/v1/auth/token", &[], Some(&json!({ "device_code": code })), None).await?;
        if status == 202 || v["pending"].as_bool() == Some(true) {
            return Ok(None);
        }
        *self.device_code.lock().unwrap() = None;
        self.store_session(&v)
    }

    /// Local development only (backend `ENVIRONMENT=development`): sign in without GitHub.
    pub async fn dev_sign_in(&self, login: &str, role: &str) -> Result<Value> {
        let (_, v) = self.client()?.json(Method::POST, "/v1/auth/dev", &[], Some(&json!({ "login": login, "role": role })), None).await?;
        self.store_session(&v)?.ok_or_else(|| anyhow!("登入失敗"))
    }

    fn store_session(&self, v: &Value) -> Result<Option<Value>> {
        let token = v["session"].as_str().ok_or_else(|| anyhow!("反饋服務沒有回傳工作階段"))?.to_string();
        let s = Session { base: self.client()?.base(), token, expires_at: v["expires_at"].as_i64().unwrap_or(now() + 86400), user: v["user"].clone() };
        store::save(&self.session_file, &s)?;
        let user = s.user.clone();
        *self.session.lock().unwrap() = Some(s);
        Ok(Some(user))
    }

    pub async fn sign_out(&self) -> Result<()> {
        if let (Some(t), Ok(c)) = (self.token(), self.client()) {
            let _ = c.json(Method::POST, "/v1/auth/logout", &[], Some(&json!({})), Some(&t)).await;
        }
        *self.session.lock().unwrap() = None;
        store::clear(&self.session_file);
        Ok(())
    }

    // ------------------------------------------------------------- compose ----

    /// Redact, strip metadata and build the exact upload. Nothing is sent.
    pub fn prepare(&self, draft: &Draft, products: &[String], env: Environment, diagnostics: Option<String>) -> Result<Preview> {
        if !products.iter().any(|p| p == &draft.product) {
            bail!("未知的軟體：{}", draft.product);
        }
        if !CATEGORIES.contains(&draft.category.as_str()) {
            bail!("未知的類別：{}", draft.category);
        }
        let mut redactions = BTreeMap::new();
        let title = self.redactor.redact(&clean(&draft.title));
        let body = self.redactor.redact(&clean(&draft.body));
        merge(&mut redactions, &title.counts);
        merge(&mut redactions, &body.counts);
        let tl = title.text.chars().count();
        let bl = body.text.chars().count();
        if !(5..=120).contains(&tl) {
            bail!("標題需為 5–120 個字（目前 {tl}）");
        }
        if !(10..=8000).contains(&bl) {
            bail!("內容需為 10–8000 個字（目前 {bl}）");
        }

        let mut inputs: Vec<(String, Vec<u8>)> = Vec::new();
        for a in &draft.attachments {
            let bytes = base64::engine::general_purpose::STANDARD.decode(a.data_base64.trim()).map_err(|_| anyhow!("{} 的資料無效", a.filename))?;
            inputs.push((a.filename.clone(), bytes));
        }
        if let Some(d) = diagnostics {
            inputs.push(("cyw-diagnostics.log".into(), d.into_bytes()));
        }
        if inputs.len() > image::MAX_ATTACHMENTS {
            bail!("最多 {} 個附件", image::MAX_ATTACHMENTS);
        }

        let mut attachments = Vec::new();
        let mut files = Vec::new();
        let mut warnings = Vec::new();
        let mut total = 0usize;
        for (name, bytes) in inputs {
            let kind = image::sniff(&bytes).ok_or_else(|| anyhow!("{name}：只支援 PNG、JPEG、WebP 圖片與 UTF-8 文字日誌"))?;
            let (data, removed, counts, text) = if kind.is_image() {
                let (clean, removed) = image::strip_metadata(kind, &bytes).map_err(|e| anyhow!("{name}：{e}"))?;
                (clean, removed, BTreeMap::new(), None)
            } else {
                let r = self.redactor.redact(std::str::from_utf8(&bytes).unwrap_or_default());
                (r.text.clone().into_bytes(), 0, r.counts, Some(r.text))
            };
            image::check_size(kind, data.len()).map_err(|e| anyhow!("{name}：{e}"))?;
            total += data.len();
            if kind.is_image() {
                warnings.push(format!("{name}：圖片中的文字無法自動遮蔽，請確認截圖沒有顯示密碼、Token 或個人資料。"));
            }
            let sha = sha_hex(&data);
            attachments.push(AttachmentPreview {
                filename: name.clone(),
                content_type: kind.mime().into(),
                size: data.len(),
                sha256: sha,
                metadata_removed: removed,
                redactions: counts,
                text,
                data_url: kind.is_image().then(|| format!("data:{};base64,{}", kind.mime(), base64::engine::general_purpose::STANDARD.encode(&data))),
            });
            files.push((name, kind.mime().to_string(), data));
        }
        if total > image::MAX_TOTAL {
            bail!("附件總大小超過 {} MiB", image::MAX_TOTAL / 1024 / 1024);
        }

        let environment = draft.include_environment.then_some(env);
        let mut payload = json!({
            "product": draft.product,
            "category": draft.category,
            "title": title.text,
            "body": body.text,
            "environment": environment,
            "website": "",
        });
        // the hash covers the payload and every attachment byte
        let mut h = Sha256::new();
        h.update(serde_json::to_vec(&payload)?);
        for a in &attachments {
            h.update(format!("\n{}|{}|{}", a.filename, a.content_type, a.sha256));
        }
        let sha256 = hex::encode(h.finalize());
        payload["consent"] = json!({ "content": true, "environment": draft.include_environment, "preview_sha256": sha256 });

        let id = format!("p{}", &sha_hex(format!("{sha256}{:?}", SystemTime::now()).as_bytes())[..16]);
        let preview = Preview {
            id: id.clone(),
            sha256,
            endpoint: self.client.as_ref().map(|c| format!("{}/v1/feedback", c.base())).unwrap_or_else(|| "（尚未設定反饋服務）".into()),
            payload,
            redactions,
            attachments,
            warnings,
        };
        let mut p = self.prepared.lock().unwrap();
        p.retain(|_, v| v.created.elapsed().unwrap_or_default() < PREVIEW_TTL);
        p.insert(id, Prepared { preview: preview.clone(), files, created: SystemTime::now() });
        Ok(preview)
    }

    /// Upload exactly what was previewed. `confirmed_sha256` must equal the preview's hash.
    pub async fn submit(&self, preview_id: &str, confirmed_sha256: &str) -> Result<SubmitResult> {
        let token = self.token().ok_or_else(|| anyhow!("請先以 GitHub 登入"))?;
        let prepared = {
            let mut p = self.prepared.lock().unwrap();
            let Some(entry) = p.get(preview_id) else { bail!("預覽已過期，請重新預覽") };
            if entry.preview.sha256 != confirmed_sha256 {
                bail!("確認的內容與預覽不符，未上傳任何資料");
            }
            if entry.created.elapsed().unwrap_or_default() >= PREVIEW_TTL {
                p.remove(preview_id);
                bail!("預覽已過期，請重新預覽");
            }
            p.remove(preview_id).unwrap()
        };
        let c = self.client()?;
        let (_, v) = c.json(Method::POST, "/v1/feedback", &[], Some(&prepared.preview.payload), Some(&token)).await?;
        let id = v["feedback"]["id"].as_str().ok_or_else(|| anyhow!("反饋服務回應缺少 id"))?.to_string();
        let mut attachments = Vec::new();
        let mut attachment_errors = Vec::new();
        for (name, mime, data) in prepared.files {
            match c.upload(&format!("/v1/feedback/{id}/attachments"), &mime, &name, data, &token).await {
                Ok((_, a)) => attachments.push(a["attachment"].clone()),
                Err(e) => attachment_errors.push(format!("{name}：{e:#}")),
            }
        }
        Ok(SubmitResult { feedback: v["feedback"].clone(), server_redactions: v["server_redactions"].as_u64().unwrap_or(0), attachments, attachment_errors })
    }

    /// Discard a preview the user cancelled.
    pub fn discard(&self, preview_id: &str) {
        self.prepared.lock().unwrap().remove(preview_id);
    }

    // ------------------------------------------------------------------ API ----

    /// Generic call for reading and for actions that carry no personal data (votes, comments, status…).
    /// Creating feedback, uploading attachments and auth have their own consent-gated paths and are refused here.
    pub async fn api(&self, method: &str, path: &str, query: &BTreeMap<String, String>, body: Option<Value>) -> Result<Value> {
        let m = match method {
            "GET" => Method::GET,
            "POST" => Method::POST,
            "PATCH" => Method::PATCH,
            "PUT" => Method::PUT,
            "DELETE" => Method::DELETE,
            _ => bail!("不允許的方法：{method}"),
        };
        client::check_path(path)?;
        let p = path.trim_end_matches('/');
        let forbidden = p.starts_with("/v1/auth/") || (m == Method::POST && (p == "/v1/feedback" || p.ends_with("/attachments")));
        if forbidden {
            bail!("此操作必須經過預覽與確認流程");
        }
        let q: Vec<(String, String)> = query.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let body = body.map(|mut b| {
            // free text the user types later (comments, notes) is redacted too
            for k in ["body", "note", "summary", "reason"] {
                if let Some(s) = b.get(k).and_then(Value::as_str) {
                    b[k] = Value::String(self.redactor.redact(&clean(s)).text);
                }
            }
            b
        });
        match self.client()?.json(m, p, &q, body.as_ref(), self.token().as_deref()).await {
            Ok((_, v)) => Ok(v),
            Err(e) => {
                if e.downcast_ref::<ApiError>().is_some_and(|a| a.status == 401) && self.token().is_some() {
                    // session expired or revoked on the server
                    *self.session.lock().unwrap() = None;
                    store::clear(&self.session_file);
                }
                Err(e)
            }
        }
    }

    pub async fn attachment(&self, id: &str) -> Result<(String, Vec<u8>)> {
        let t = self.token().ok_or_else(|| anyhow!("請先登入"))?;
        self.client()?.download(&format!("/v1/attachments/{id}"), &t, image::MAX_IMAGE + 1024).await
    }

    pub fn signed_in(&self) -> bool {
        self.token().is_some()
    }
}

// ------------------------------------------------------------- environment ----

/// Products that can be reported on: every catalog product plus CYW itself.
pub fn products(core: &Core) -> Vec<String> {
    let mut v = vec![SELF_PRODUCT.to_string()];
    v.extend(core.catalog.iter().map(|p| p.id.clone()));
    v
}

/// Software version (installed version of the product, or CYW's own), OS and CPU architecture.
pub fn environment(core: &Core, product: &str) -> Environment {
    let product_version = if product == SELF_PRODUCT { Some(crate::VERSION.to_string()) } else { core.installed_app(product).map(|a| a.current.clone()) };
    Environment {
        product_version,
        cyw_version: crate::VERSION.to_string(),
        os: core.platform.os.clone(),
        os_version: sysinfo::System::long_os_version(),
        arch: core.platform.arch.clone(),
    }
}

/// Recent CYW problems as a text log (offered as an optional attachment; redacted like everything else).
pub fn diagnostics(core: &Core) -> String {
    let mut s = String::new();
    s.push_str(&format!("Create Your World {}\n", crate::VERSION));
    s.push_str(&format!("platform: {} {} (build {}{})\n", core.platform.os, core.platform.arch, core.platform.build_arch, if core.platform.rosetta { ", Rosetta" } else { "" }));
    if let Some(v) = sysinfo::System::long_os_version() {
        s.push_str(&format!("os: {v}\n"));
    }
    s.push_str("\n[installed]\n");
    for a in core.installed.lock().unwrap().apps.values() {
        s.push_str(&format!("{} {}\n", a.product_id, a.current));
    }
    s.push_str("\n[recent download / install errors]\n");
    let mut jobs = core.jobs.list();
    jobs.sort_by_key(|j| std::cmp::Reverse(j.created_at));
    let mut any = false;
    for j in jobs.iter().filter(|j| j.error.is_some()).take(20) {
        any = true;
        s.push_str(&format!("{} {} {:?}: {}\n", j.product_name, j.tag, j.state, j.error.as_deref().unwrap_or_default()));
    }
    if !any {
        s.push_str("(none)\n");
    }
    let su = core.selfupdate.status();
    if let Some(e) = su.error {
        s.push_str(&format!("\n[self-update]\n{e}\n"));
    }
    let problems = core.cli_problems.lock().unwrap();
    if !problems.is_empty() {
        s.push_str("\n[PATH]\n");
        for (k, v) in problems.iter() {
            s.push_str(&format!("{k}: {v}\n"));
        }
    }
    s
}

#[cfg(test)]
mod tests;
