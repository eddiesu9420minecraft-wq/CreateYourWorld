//! What the core needs from the program hosting it (the Tauri GUI or the `cyw` CLI): a way to report
//! progress events and to spawn background tasks. The core never touches a window or a WebView.

use serde::Serialize;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

pub type BoxFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

pub trait Host: Send + Sync {
    /// A state change the UI may want to show (`downloads://job`, `selfupdate://status`, `apps://changed`).
    fn emit_json(&self, topic: &str, payload: serde_json::Value);
    /// Run a background task on the host's async runtime.
    fn spawn(&self, task: BoxFuture);
}

pub type App = Arc<dyn Host>;

/// `app.emit("topic", &value)` for any serializable value.
pub trait HostExt {
    fn emit<T: Serialize>(&self, topic: &str, payload: T);
}

impl<H: Host + ?Sized> HostExt for H {
    fn emit<T: Serialize>(&self, topic: &str, payload: T) {
        self.emit_json(topic, serde_json::to_value(payload).unwrap_or(serde_json::Value::Null));
    }
}

/// A host that ignores events and spawns on the current tokio runtime (tests, simple tools).
pub struct Silent;

impl Host for Silent {
    fn emit_json(&self, _: &str, _: serde_json::Value) {}
    fn spawn(&self, task: BoxFuture) {
        tokio::spawn(task);
    }
}
