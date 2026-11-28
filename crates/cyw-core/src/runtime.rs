//! Hardware / compute-backend detection for the shared Runtime Manager.
//! (Installing shared runtimes themselves is P2; this module only reports what the machine has.)

use crate::util::hidden_command;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub vendor: String,
    pub name: String,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backend {
    /// "cuda" | "amd" | "metal" | "cpu"
    pub id: &'static str,
    pub name: String,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareReport {
    pub os: String,
    pub arch: String,
    pub logical_cores: usize,
    pub cpu_features: Vec<String>,
    pub gpus: Vec<Gpu>,
    pub backends: Vec<Backend>,
    pub recommended: &'static str,
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = hidden_command(program).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).to_string())
}

fn vendor_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("quadro") || n.contains("rtx") {
        "NVIDIA"
    } else if n.contains("amd") || n.contains("radeon") {
        "AMD"
    } else if n.contains("intel") {
        "Intel"
    } else if n.contains("apple") {
        "Apple"
    } else {
        "Other"
    }
}

fn cpu_features() -> Vec<String> {
    #[allow(unused_mut)]
    let mut f: Vec<String> = vec![];
    #[cfg(target_arch = "x86_64")]
    {
        if std::arch::is_x86_feature_detected!("avx2") { f.push("AVX2".into()) }
        if std::arch::is_x86_feature_detected!("fma") { f.push("FMA".into()) }
        if std::arch::is_x86_feature_detected!("avx512f") { f.push("AVX-512".into()) }
    }
    #[cfg(target_arch = "aarch64")]
    {
        f.push("NEON".into());
    }
    f
}

fn list_gpus() -> Vec<Gpu> {
    let mut gpus = vec![];
    #[cfg(windows)]
    if let Some(out) = run(
        "powershell",
        &["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion }"],
    ) {
        for line in out.lines().map(str::trim).filter(|l| !l.is_empty()) {
            let (name, driver) = line.split_once('|').unwrap_or((line, ""));
            gpus.push(Gpu { vendor: vendor_of(name).into(), name: name.trim().into(), driver: (!driver.is_empty()).then(|| driver.trim().into()) });
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(out) = run("system_profiler", &["SPDisplaysDataType", "-json"]) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out) {
            for item in v["SPDisplaysDataType"].as_array().into_iter().flatten() {
                if let Some(name) = item["sppci_model"].as_str() {
                    gpus.push(Gpu { vendor: vendor_of(name).into(), name: name.into(), driver: None });
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let Ok(rd) = std::fs::read_dir("/sys/class/drm") {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("card") || name.contains('-') {
                continue;
            }
            let vendor_id = std::fs::read_to_string(e.path().join("device/vendor")).unwrap_or_default();
            let vendor = match vendor_id.trim() {
                "0x10de" => "NVIDIA",
                "0x1002" => "AMD",
                "0x8086" => "Intel",
                _ => "Other",
            };
            gpus.push(Gpu { vendor: vendor.into(), name: format!("{vendor} GPU ({name})"), driver: None });
        }
    }
    gpus
}

pub fn detect() -> HardwareReport {
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let mut gpus = list_gpus();
    let mut backends = vec![];

    // NVIDIA CUDA: the driver ships nvidia-smi on Windows and Linux.
    let nvsmi = if os == "macos" { None } else { run("nvidia-smi", &["--query-gpu=name,driver_version", "--format=csv,noheader"]) };
    match &nvsmi {
        Some(out) => {
            let first = out.lines().next().unwrap_or("").to_string();
            let (name, driver) = first.split_once(',').map(|(a, b)| (a.trim().to_string(), b.trim().to_string())).unwrap_or((first.clone(), String::new()));
            if !gpus.iter().any(|g| g.vendor == "NVIDIA") {
                gpus.push(Gpu { vendor: "NVIDIA".into(), name: name.clone(), driver: Some(driver.clone()) });
            }
            backends.push(Backend { id: "cuda", name: "NVIDIA CUDA".into(), available: true, detail: format!("{name}，驅動程式 {driver}") });
        }
        None => backends.push(Backend {
            id: "cuda",
            name: "NVIDIA CUDA".into(),
            available: false,
            detail: if os == "macos" { "macOS 不支援 CUDA".into() } else { "未偵測到 NVIDIA 驅動程式 (nvidia-smi)".into() },
        }),
    }

    // AMD: ROCm on Linux; on Windows AMD GPUs are usable through Vulkan / DirectML builds.
    let amd = gpus.iter().find(|g| g.vendor == "AMD").cloned();
    let rocm = os == "linux" && std::path::Path::new("/opt/rocm").exists();
    backends.push(Backend {
        id: "amd",
        name: if os == "linux" { "AMD ROCm".into() } else { "AMD (Vulkan / DirectML)".into() },
        available: if os == "linux" { rocm } else { amd.is_some() && os == "windows" },
        detail: match (&amd, os.as_str()) {
            (Some(g), "linux") if rocm => format!("{}，已安裝 ROCm", g.name),
            (Some(g), "linux") => format!("{}，但未安裝 ROCm", g.name),
            (Some(g), "windows") => g.name.clone(),
            (Some(_), _) => "macOS 上的 AMD GPU 透過 Metal 使用".into(),
            (None, _) => "未偵測到 AMD GPU".into(),
        },
    });

    // Apple Metal: every Mac supported by macOS 11+ has a Metal-capable GPU.
    backends.push(Backend {
        id: "metal",
        name: "Apple Metal".into(),
        available: os == "macos",
        detail: if os == "macos" {
            if arch == "aarch64" { "Apple Silicon（統一記憶體）".into() } else { "Intel Mac 的 Metal GPU".into() }
        } else {
            "僅適用於 macOS".into()
        },
    });

    let feats = cpu_features();
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    backends.push(Backend {
        id: "cpu",
        name: "CPU".into(),
        available: true,
        detail: format!("{cores} 個邏輯核心{}", if feats.is_empty() { String::new() } else { format!("，{}", feats.join(" / ")) }),
    });

    let recommended = ["cuda", "metal", "amd"]
        .into_iter()
        .find(|id| backends.iter().any(|b| b.id == *id && b.available))
        .unwrap_or("cpu");

    HardwareReport { os, arch, logical_cores: cores, cpu_features: feats, gpus, backends, recommended }
}
