//! # Pikara Secure Network
//!
//! Shared by every Pikara app (Create Your World., Pikara Science Studio, …):
//!
//! * [`doh`]: DNS-over-HTTPS resolver (Cloudflare → Google failover, fixed bootstrap IPs,
//!   IPv4 + IPv6, TTL cache). Update and download traffic never touches the system resolver,
//!   and the user's system DNS settings are never modified.
//! * [`net`]: HTTPS-only client with strict certificate validation (built-in Mozilla roots),
//!   no plain-HTTP downgrade, and an allow-list for hosts and redirect targets.
//! * [`manifest`]: signed `update.json` verification with anti-downgrade / anti-replay rules.
//! * [`artifact`]: one-pass streaming SHA-256 + minisign verification of downloaded files.
//! * [`keys`]: trusted public keys compiled into the binary. They are never fetched remotely.
//!
//! Every check fails closed. There is deliberately no "skip verification" switch.

pub mod artifact;
pub mod doh;
pub mod error;
pub mod keys;
pub mod manifest;
pub mod net;

pub use error::SecureError;
