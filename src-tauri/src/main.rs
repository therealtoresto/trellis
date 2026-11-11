fn main() {
    // WebKitGTK's DMA-BUF renderer leaves the window white on some GPUs and drivers (seen with AMD graphics on
    // Ubuntu 24.04); the older path draws everywhere. It has to be set before WebKit starts. Set the variable to 0
    // to try the DMA-BUF renderer anyway.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    trellis_lib::run()
}
