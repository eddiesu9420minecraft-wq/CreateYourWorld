//! Attachment checks: content type by magic bytes, size limits, and removal of image metadata
//! (EXIF/GPS, XMP, text chunks, comments) — screenshots are uploaded without anything but pixels.

use anyhow::{bail, Result};

pub const MAX_IMAGE: usize = 4 * 1024 * 1024;
pub const MAX_LOG: usize = 1024 * 1024;
pub const MAX_ATTACHMENTS: usize = 5;
pub const MAX_TOTAL: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Png,
    Jpeg,
    Webp,
    Text,
}

impl Kind {
    pub fn mime(self) -> &'static str {
        match self {
            Kind::Png => "image/png",
            Kind::Jpeg => "image/jpeg",
            Kind::Webp => "image/webp",
            Kind::Text => "text/plain",
        }
    }
    pub fn is_image(self) -> bool {
        self != Kind::Text
    }
}

/// Detect the type from the bytes (never from the file name). Text = valid UTF-8 without NULs.
pub fn sniff(b: &[u8]) -> Option<Kind> {
    if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Kind::Png)
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Kind::Jpeg)
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(Kind::Webp)
    } else if std::str::from_utf8(b).is_ok() && !b.contains(&0) {
        Some(Kind::Text)
    } else {
        None
    }
}

/// Remove metadata. Returns the cleaned bytes and how many metadata blocks were removed.
pub fn strip_metadata(kind: Kind, b: &[u8]) -> Result<(Vec<u8>, u32)> {
    match kind {
        Kind::Png => strip_png(b),
        Kind::Jpeg => strip_jpeg(b),
        Kind::Webp => strip_webp(b),
        Kind::Text => Ok((b.to_vec(), 0)),
    }
}

fn strip_png(b: &[u8]) -> Result<(Vec<u8>, u32)> {
    let mut out = b[..8].to_vec();
    let mut i = 8;
    let mut removed = 0;
    let mut saw_end = false;
    while i + 8 <= b.len() {
        let len = u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        let ty = &b[i + 4..i + 8];
        let end = i.checked_add(12).and_then(|v| v.checked_add(len)).filter(|&e| e <= b.len());
        let Some(end) = end else { bail!("PNG 檔案損毀（區塊長度超出檔案）") };
        if matches!(ty, b"tEXt" | b"iTXt" | b"zTXt" | b"eXIf" | b"tIME") {
            removed += 1;
        } else {
            out.extend_from_slice(&b[i..end]);
        }
        i = end;
        if ty == b"IEND" {
            saw_end = true;
            break;
        }
    }
    if !saw_end {
        bail!("PNG 檔案不完整");
    }
    Ok((out, removed))
}

fn strip_jpeg(b: &[u8]) -> Result<(Vec<u8>, u32)> {
    let mut out = vec![0xFF, 0xD8];
    let mut i = 2;
    let mut removed = 0;
    loop {
        if i + 4 > b.len() || b[i] != 0xFF {
            bail!("JPEG 檔案損毀");
        }
        let marker = b[i + 1];
        if marker == 0xFF {
            i += 1; // fill byte
            continue;
        }
        if marker == 0xD9 {
            out.extend_from_slice(&b[i..i + 2]);
            return Ok((out, removed));
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            bail!("JPEG 檔案損毀（區段長度）");
        }
        let seg_end = i + 2 + len;
        // APP1..APP15 (EXIF, XMP, ICC, vendor data) and COM are dropped; APP0 (JFIF) is kept.
        if (0xE1..=0xEF).contains(&marker) || marker == 0xFE {
            removed += 1;
        } else {
            out.extend_from_slice(&b[i..seg_end]);
        }
        i = seg_end;
        if marker == 0xDA {
            // start of scan: entropy-coded data follows until EOI; copy the rest unchanged
            out.extend_from_slice(&b[i..]);
            return Ok((out, removed));
        }
    }
}

fn strip_webp(b: &[u8]) -> Result<(Vec<u8>, u32)> {
    let mut body = Vec::with_capacity(b.len());
    let mut i = 12;
    let mut removed = 0;
    let mut vp8x_at: Option<usize> = None;
    while i + 8 <= b.len() {
        let ty = &b[i..i + 4];
        let len = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let padded = len + (len & 1);
        let Some(end) = (i + 8).checked_add(padded).filter(|&e| e <= b.len()) else { bail!("WebP 檔案損毀") };
        if ty == b"EXIF" || ty == b"XMP " {
            removed += 1;
        } else {
            if ty == b"VP8X" {
                vp8x_at = Some(body.len());
            }
            body.extend_from_slice(&b[i..end]);
        }
        i = end;
    }
    if let Some(at) = vp8x_at {
        // clear the EXIF (0x08) and XMP (0x04) flags
        if body.len() > at + 8 {
            body[at + 8] &= !0x0C;
        }
    }
    let mut out = b"RIFF".to_vec();
    out.extend_from_slice(&((body.len() + 4) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&body);
    Ok((out, removed))
}

/// Size limit per type.
pub fn check_size(kind: Kind, len: usize) -> Result<()> {
    let max = if kind.is_image() { MAX_IMAGE } else { MAX_LOG };
    if len > max {
        bail!("附件過大（{} KiB，上限 {} KiB）", len / 1024, max / 1024);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn chunk(ty: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut c = (data.len() as u32).to_be_bytes().to_vec();
        c.extend_from_slice(ty);
        c.extend_from_slice(data);
        c.extend_from_slice(&[0, 0, 0, 0]); // CRC (not checked here)
        c
    }

    pub fn png_with_text() -> Vec<u8> {
        let mut p = b"\x89PNG\r\n\x1a\n".to_vec();
        p.extend(chunk(b"IHDR", &[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
        p.extend(chunk(b"tEXt", b"Author\0alice"));
        p.extend(chunk(b"eXIf", b"MM\0*GPS"));
        p.extend(chunk(b"IDAT", &[1, 2, 3]));
        p.extend(chunk(b"IEND", &[]));
        p
    }

    #[test]
    fn png_metadata_removed() {
        let p = png_with_text();
        assert_eq!(sniff(&p), Some(Kind::Png));
        let (out, n) = strip_metadata(Kind::Png, &p).unwrap();
        assert_eq!(n, 2);
        assert!(!out.windows(4).any(|w| w == b"tEXt" || w == b"eXIf"));
        assert!(out.windows(4).any(|w| w == b"IDAT"));
        assert!(!out.windows(5).any(|w| w == b"alice"));
        // already clean → unchanged
        assert_eq!(strip_metadata(Kind::Png, &out).unwrap(), (out.clone(), 0));
    }

    #[test]
    fn png_truncated_rejected() {
        let mut p = png_with_text();
        p.truncate(40);
        assert!(strip_metadata(Kind::Png, &p).is_err());
        let mut huge = b"\x89PNG\r\n\x1a\n".to_vec();
        huge.extend_from_slice(&u32::MAX.to_be_bytes());
        huge.extend_from_slice(b"IDAT");
        assert!(strip_metadata(Kind::Png, &huge).is_err());
    }

    pub fn jpeg_with_exif() -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        j.extend([0xFF, 0xE0, 0, 6, b'J', b'F', b'I', b'F']); // APP0
        j.extend([0xFF, 0xE1, 0, 10, b'E', b'x', b'i', b'f', 0, 0, b'G', b'P']); // APP1 EXIF
        j.extend([0xFF, 0xFE, 0, 7, b'a', b'l', b'i', b'c', b'e']); // COM
        j.extend([0xFF, 0xDB, 0, 4, 1, 2]); // DQT
        j.extend([0xFF, 0xDA, 0, 4, 9, 9, 0x11, 0x22, 0x33]); // SOS + data
        j.extend([0xFF, 0xD9]);
        j
    }

    #[test]
    fn jpeg_metadata_removed() {
        let j = jpeg_with_exif();
        assert_eq!(sniff(&j), Some(Kind::Jpeg));
        let (out, n) = strip_metadata(Kind::Jpeg, &j).unwrap();
        assert_eq!(n, 2);
        assert!(!out.windows(4).any(|w| w == b"Exif"));
        assert!(!out.windows(5).any(|w| w == b"alice"));
        assert!(out.windows(4).any(|w| w == b"JFIF"));
        assert!(out.ends_with(&[0x11, 0x22, 0x33, 0xFF, 0xD9]));
        assert!(strip_metadata(Kind::Jpeg, &j[..9]).is_err());
    }

    #[test]
    fn webp_metadata_removed() {
        let mut body = Vec::new();
        body.extend(b"VP8X");
        body.extend(10u32.to_le_bytes());
        body.extend([0x0C, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        body.extend(b"VP8L");
        body.extend(3u32.to_le_bytes());
        body.extend([1, 2, 3, 0]); // padded
        body.extend(b"EXIF");
        body.extend(4u32.to_le_bytes());
        body.extend(b"GPS!");
        body.extend(b"XMP ");
        body.extend(5u32.to_le_bytes());
        body.extend(b"alice\0");
        let mut w = b"RIFF".to_vec();
        w.extend(((body.len() + 4) as u32).to_le_bytes());
        w.extend(b"WEBP");
        w.extend(&body);
        assert_eq!(sniff(&w), Some(Kind::Webp));
        let (out, n) = strip_metadata(Kind::Webp, &w).unwrap();
        assert_eq!(n, 2);
        assert!(!out.windows(4).any(|x| x == b"EXIF" || x == b"XMP "));
        assert_eq!(u32::from_le_bytes([out[4], out[5], out[6], out[7]]) as usize, out.len() - 8);
        assert_eq!(out[20] & 0x0C, 0, "EXIF/XMP flags cleared");
    }

    #[test]
    fn sniffing_ignores_names_and_rejects_binaries() {
        assert_eq!(sniff(b"MZ\x90\x00\x03"), None); // an .exe renamed to .png
        assert_eq!(sniff(b"plain log line\n"), Some(Kind::Text));
        assert_eq!(sniff(&[0xC3, 0x28]), None); // invalid UTF-8
        assert!(check_size(Kind::Png, MAX_IMAGE).is_ok());
        assert!(check_size(Kind::Png, MAX_IMAGE + 1).is_err());
        assert!(check_size(Kind::Text, MAX_LOG + 1).is_err());
    }
}
