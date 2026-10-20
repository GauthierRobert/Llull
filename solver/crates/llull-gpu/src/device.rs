//! Adapter / device selection shared by every llull GPU path. One rule everywhere: prefer a high-performance hardware
//! adapter, accept a software one (lavapipe, WARP) when it is all there is, and otherwise return why not, so the caller
//! runs its CPU twin and logs the reason (RS1 §2 rule 6). `LLULL_GPU=off` disables the GPU for a run.

/// An opened GPU: device + queue and a printable adapter description (`name (backend, device type)`).
pub struct Gpu {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter: String,
    /// True for a CPU-emulated adapter (lavapipe, WARP): fine for tests, not for speed.
    pub software: bool,
}

/// Why the GPU is not used when `LLULL_GPU=off` (or `0` / `false`) is set.
pub fn disabled_by_environment() -> Option<String> {
    match std::env::var("LLULL_GPU") {
        Ok(value) if matches!(value.as_str(), "off" | "0" | "false") => Some(format!("disabled by LLULL_GPU={value}")),
        _ => None,
    }
}

/// Opens the best adapter with its own limits (large storage buffers for compute), or returns why no GPU can be used.
pub fn acquire(label: &str) -> Result<Gpu, String> {
    acquire_with(label, wgpu::Features::empty())
}

/// [`acquire`] that also requires `features` (e.g. `SHADER_F64`); an adapter without them is a reason, not a panic.
pub fn acquire_with(label: &str, features: wgpu::Features) -> Result<Gpu, String> {
    if let Some(reason) = disabled_by_environment() {
        return Err(reason);
    }
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let request = |force_fallback_adapter: bool| {
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            force_fallback_adapter,
            compatible_surface: None,
        }))
    };
    let adapter = match request(false) {
        Ok(adapter) => adapter,
        Err(first) => request(true).map_err(|_| format!("no GPU adapter ({first})"))?,
    };
    let info = adapter.get_info();
    if !adapter.features().contains(features) {
        return Err(format!("the GPU adapter {} lacks {:?}", info.name, features - adapter.features()));
    }
    let descriptor = wgpu::DeviceDescriptor {
        label: Some(label),
        required_features: features,
        required_limits: adapter.limits(),
        ..wgpu::DeviceDescriptor::default()
    };
    let (device, queue) = pollster::block_on(adapter.request_device(&descriptor)).map_err(|error| format!("no GPU device ({error})"))?;
    Ok(Gpu {
        device,
        queue,
        adapter: format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type),
        software: info.device_type == wgpu::DeviceType::Cpu,
    })
}
