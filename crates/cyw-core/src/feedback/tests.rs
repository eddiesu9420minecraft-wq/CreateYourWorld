//! Client API tests against a local mock backend (real HTTP on 127.0.0.1): consent gating, exact-preview upload,
//! redaction before sending, metadata stripping, session scoping. The real backend is tested in `services/feedback`.

use super::*;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
struct Req {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

async fn mock() -> (String, Arc<Mutex<Vec<Req>>>) {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    let log = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let log = log2.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 65536];
                let (head_end, len) = loop {
                    let n = s.read(&mut tmp).await.unwrap();
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        let head = String::from_utf8_lossy(&buf[..i]).to_string();
                        let len = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        break (i + 4, len);
                    }
                };
                while buf.len() < head_end + len {
                    let n = s.read(&mut tmp).await.unwrap();
                    buf.extend_from_slice(&tmp[..n]);
                }
                let head = String::from_utf8_lossy(&buf[..head_end - 4]).to_string();
                let mut lines = head.lines();
                let mut first = lines.next().unwrap().split(' ');
                let method = first.next().unwrap().to_string();
                let path = first.next().unwrap().to_string();
                let headers = lines.filter_map(|l| l.split_once(':').map(|(a, b)| (a.trim().to_string(), b.trim().to_string()))).collect();
                let req = Req { method, path, headers, body: buf[head_end..head_end + len].to_vec() };
                let (status, body) = route(&req);
                log.lock().unwrap().push(req);
                let resp = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes()).await;
            });
        }
    });
    (base, log)
}

fn route(r: &Req) -> (u16, String) {
    let authed = r.header("authorization") == Some("Bearer tok-alice");
    match (r.method.as_str(), r.path.as_str()) {
        ("POST", "/v1/auth/dev") => (200, json!({"session": "tok-alice", "expires_at": 4102444800i64, "user": {"login": "alice", "role": "user"}}).to_string()),
        ("POST", "/v1/auth/logout") => (204, String::new()),
        ("POST", "/v1/feedback") if authed => (201, json!({"feedback": {"id": "fb1", "number": 1}, "server_redactions": 0}).to_string()),
        ("POST", "/v1/feedback/fb1/attachments") if authed => (201, json!({"attachment": {"id": "a1"}}).to_string()),
        ("POST", "/v1/feedback/fb1/comments") if authed => (201, json!({"comment": {"id": "c1"}}).to_string()),
        ("GET", p) if p.starts_with("/v1/feedback?") => (200, json!({"items": [], "total": 0}).to_string()),
        ("GET", "/v1/me") => (401, json!({"error": {"code": "unauthenticated", "message": "請登入"}}).to_string()),
        _ if !authed => (401, json!({"error": {"code": "unauthenticated", "message": "請登入"}}).to_string()),
        _ => (404, json!({"error": {"code": "not_found", "message": "找不到"}}).to_string()),
    }
}

fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("cyw-fb-{tag}-{}-{:?}", std::process::id(), SystemTime::now()).replace([':', ' '], "_"));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn service(dir: &std::path::Path, base: &str) -> Feedback {
    let r = Redactor::with_identity(&["alice".into()], &["ALICE-PC".into()]);
    Feedback::with_redactor(dir, Some(base.into()), pikara_secure::doh::DohResolver::default(), r)
}

fn env() -> Environment {
    Environment { product_version: Some("v0.3.1".into()), cyw_version: "0.1.3-alpha".into(), os: "windows".into(), os_version: Some("Windows 11 (26200)".into()), arch: "x86_64".into() }
}

fn products() -> Vec<String> {
    vec!["CreateYourWorld".into(), "PikaraScienceStudio".into(), "runX".into()]
}

fn draft() -> Draft {
    let png = base64::engine::general_purpose::STANDARD.encode(image::tests::png_with_text());
    let log = base64::engine::general_purpose::STANDARD.encode("token=ghp_0123456789abcdefghijABCDEFGHIJ012345\nC:\\Users\\alice\\AppData\\x.log\nfrom 192.168.0.5\n");
    Draft {
        product: "PikaraScienceStudio".into(),
        category: "bug".into(),
        title: "Export crashes on ALICE-PC".into(),
        body: "Steps: open C:\\Users\\alice\\proj.pss and export. My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz, mail alice@example.com".into(),
        include_environment: true,
        include_diagnostics: false,
        attachments: vec![DraftAttachment { filename: "C:\\Users\\alice\\shot.png".into(), data_base64: png }, DraftAttachment { filename: "studio.log".into(), data_base64: log }],
    }
}

#[tokio::test]
async fn preview_redacts_and_sends_nothing() {
    let (base, log) = mock().await;
    let dir = tmpdir("preview");
    let f = service(&dir, &base);
    let p = f.prepare(&draft(), &products(), env(), Some("diag from 10.1.2.3".into())).unwrap();
    let body = p.payload["body"].as_str().unwrap();
    assert!(!body.contains("alice") && !body.contains("sk-ant") && !body.contains("example.com"), "{body}");
    assert_eq!(p.payload["title"], "Export crashes on [REDACTED:host]");
    assert_eq!(p.payload["environment"]["arch"], "x86_64");
    assert_eq!(p.payload["consent"]["environment"], true);
    assert_eq!(p.payload["consent"]["preview_sha256"], p.sha256);
    assert_eq!(p.payload["website"], "");
    assert_eq!(p.attachments.len(), 3);
    let png = &p.attachments[0];
    assert_eq!(png.content_type, "image/png");
    assert_eq!(png.metadata_removed, 2);
    assert!(png.data_url.as_deref().unwrap().starts_with("data:image/png;base64,"));
    let logp = &p.attachments[1];
    let text = logp.text.as_deref().unwrap();
    assert!(!text.contains("ghp_") && !text.contains("alice") && !text.contains("192.168"), "{text}");
    assert_eq!(p.attachments[2].text.as_deref(), Some("diag from [REDACTED:ip]"));
    assert!(!p.warnings.is_empty(), "screenshots carry a manual-check warning");
    assert!(p.redactions["token"] >= 1 && p.redactions["email"] == 1);
    assert!(log.lock().unwrap().is_empty(), "preview must not contact the backend");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn environment_only_with_consent() {
    let (base, _) = mock().await;
    let dir = tmpdir("env");
    let f = service(&dir, &base);
    let mut d = draft();
    d.include_environment = false;
    let p = f.prepare(&d, &products(), env(), None).unwrap();
    assert!(p.payload["environment"].is_null());
    assert_eq!(p.payload["consent"]["environment"], false);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn submit_requires_matching_confirmation_and_sign_in() {
    let (base, log) = mock().await;
    let dir = tmpdir("confirm");
    let f = service(&dir, &base);
    let p = f.prepare(&draft(), &products(), env(), None).unwrap();
    assert!(f.submit(&p.id, "0000").await.is_err(), "wrong hash");
    // a mismatching confirmation does not consume the preview, but a missing sign-in fails before any upload
    assert!(f.submit(&p.id, &p.sha256).await.unwrap_err().to_string().contains("登入"));
    assert!(log.lock().unwrap().is_empty(), "nothing may be uploaded without confirmation + sign-in");
    assert!(f.submit("nope", &p.sha256).await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn submit_uploads_exactly_the_preview() {
    let (base, log) = mock().await;
    let dir = tmpdir("submit");
    let f = service(&dir, &base);
    f.dev_sign_in("alice", "user").await.unwrap();
    assert!(f.signed_in());
    let p = f.prepare(&draft(), &products(), env(), None).unwrap();
    let r = f.submit(&p.id, &p.sha256).await.unwrap();
    assert_eq!(r.feedback["id"], "fb1");
    assert_eq!(r.attachments.len(), 2);
    assert!(r.attachment_errors.is_empty());
    let reqs = log.lock().unwrap().clone();
    let create = reqs.iter().find(|r| r.method == "POST" && r.path == "/v1/feedback").unwrap();
    assert_eq!(create.json(), p.payload, "the uploaded JSON is byte-for-byte the previewed payload");
    let uploads: Vec<_> = reqs.iter().filter(|r| r.path.ends_with("/attachments")).collect();
    assert_eq!(uploads.len(), 2);
    assert_eq!(uploads[0].header("content-type"), Some("image/png"));
    assert_eq!(uploads[0].header("x-filename"), Some("shot.png"), "local folder names are not sent");
    assert!(!uploads[0].body.windows(5).any(|w| w == b"alice"), "PNG text chunk removed");
    assert!(!String::from_utf8_lossy(&uploads[1].body).contains("ghp_"));
    for r in &reqs {
        assert!(!String::from_utf8_lossy(&r.body).contains("alice@example.com"));
    }
    // the preview is single-use
    assert!(f.submit(&p.id, &p.sha256).await.is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn generic_api_cannot_bypass_consent() {
    let (base, log) = mock().await;
    let dir = tmpdir("bypass");
    let f = service(&dir, &base);
    f.dev_sign_in("alice", "user").await.unwrap();
    let q = BTreeMap::new();
    for (m, p) in [("POST", "/v1/feedback"), ("POST", "/v1/feedback/"), ("POST", "/v1/feedback/fb1/attachments"), ("POST", "/v1/auth/dev"), ("GET", "/v1/auth/x"), ("TRACE", "/v1/feedback"), ("GET", "/v1/../x"), ("GET", "https://evil.example/v1/feedback")] {
        assert!(f.api(m, p, &q, Some(json!({"title": "x"}))).await.is_err(), "{m} {p}");
    }
    let n = log.lock().unwrap().len();
    assert_eq!(n, 1, "only the sign-in reached the backend");
    // comments are redacted on the way out
    f.api("POST", "/v1/feedback/fb1/comments", &q, Some(json!({"body": "my ip is 8.8.4.4, user alice"}))).await.unwrap();
    let last = log.lock().unwrap().last().unwrap().json();
    assert_eq!(last["body"], "my ip is [REDACTED:ip], user [REDACTED:user]");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn session_is_scoped_to_its_backend_and_cleared_on_401() {
    let (base, _) = mock().await;
    let dir = tmpdir("scope");
    {
        let f = service(&dir, &base);
        f.dev_sign_in("alice", "user").await.unwrap();
    }
    // same data folder, same backend → still signed in
    assert!(service(&dir, &base).signed_in());
    // another backend never receives this session
    let (other, other_log) = mock().await;
    let g = service(&dir, &other);
    assert!(!g.signed_in());
    let _ = g.api("GET", "/v1/feedback", &BTreeMap::new(), None).await;
    assert!(other_log.lock().unwrap().iter().all(|r| r.header("authorization").is_none()));
    // a 401 from the backend drops the stored session
    let f = service(&dir, &base);
    assert!(f.api("GET", "/v1/me", &BTreeMap::new(), None).await.is_err());
    assert!(!f.signed_in());
    assert!(!service(&dir, &base).signed_in());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn validation_rejects_bad_drafts() {
    let (base, _) = mock().await;
    let dir = tmpdir("valid");
    let f = service(&dir, &base);
    let mut d = draft();
    d.product = "EvilApp".into();
    assert!(f.prepare(&d, &products(), env(), None).is_err());
    let mut d = draft();
    d.category = "rce".into();
    assert!(f.prepare(&d, &products(), env(), None).is_err());
    let mut d = draft();
    d.title = "hi".into();
    assert!(f.prepare(&d, &products(), env(), None).is_err());
    let mut d = draft();
    d.attachments = vec![DraftAttachment { filename: "x.png".into(), data_base64: base64::engine::general_purpose::STANDARD.encode(b"MZ\x90\x00binary") }];
    assert!(f.prepare(&d, &products(), env(), None).is_err(), "executables are refused whatever their name");
    let mut d = draft();
    let big = base64::engine::general_purpose::STANDARD.encode(vec![b'a'; image::MAX_LOG + 1]);
    d.attachments = vec![DraftAttachment { filename: "big.log".into(), data_base64: big }];
    assert!(f.prepare(&d, &products(), env(), None).is_err());
    let mut d = draft();
    let one = d.attachments[1].clone();
    d.attachments = vec![one; 6];
    assert!(f.prepare(&d, &products(), env(), None).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn unconfigured_backend_still_previews() {
    let dir = tmpdir("unconf");
    let f = Feedback::with_redactor(&dir, None, pikara_secure::doh::DohResolver::default(), Redactor::generic());
    assert!(!f.status().configured);
    let p = f.prepare(&draft(), &products(), env(), None).unwrap();
    assert!(p.endpoint.contains("尚未設定"));
    let bad = Feedback::with_redactor(&dir, Some("http://10.0.0.5:8787".into()), pikara_secure::doh::DohResolver::default(), Redactor::generic());
    assert!(!bad.status().configured && bad.status().error.is_some());
    let _ = std::fs::remove_dir_all(dir);
}
