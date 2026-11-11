//! The close, minimize and zoom buttons, centered on the toolbar. AppKit puts them back at its default spot
//! when the title, size, focus or full screen state changes, so the window places them again after each.

/// Left edge of the close button and the height of its center, in points from the window's top-left corner.
pub struct Spec {
    pub x: f64,
    pub center_y: f64,
    /// The welcome window keeps only the close button, like TablePlus.
    pub only_close: bool,
}

pub fn spec(label: &str) -> Spec {
    if label == "welcome" {
        // Lines up with the search row of the connection list, 32 points down.
        Spec { x: 22.0, center_y: 32.0, only_close: true }
    } else {
        // The workspace toolbar is 46 points tall and sits 10 points below the top: its middle is 33 points down.
        Spec { x: 28.0, center_y: 33.0, only_close: false }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::NSPoint;
    use std::ffi::c_void;

    unsafe fn window<'a>(ptr: *mut c_void) -> Option<&'a NSWindow> {
        (ptr as *const NSWindow).as_ref()
    }

    pub fn place(ptr: *mut c_void, x: f64, center_y: f64, only_close: bool) {
        unsafe {
            let Some(w) = window(ptr) else { return };
            if w.styleMask().contains(NSWindowStyleMask::FullScreen) {
                return;
            }
            let buttons: Vec<_> = [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
                .into_iter()
                .filter_map(|b| w.standardWindowButton(b))
                .collect();
            let Some(close) = buttons.first() else { return };
            let Some(bar) = close.superview() else { return };
            let Some(container) = bar.superview() else { return };
            let size = close.frame().size;
            // The title bar hangs from the top edge; it grows to hold the buttons, or clicks below it would miss them.
            let win_h = w.frame().size.height;
            let height = (center_y + size.height / 2.0 + 6.0).ceil();
            let mut c = container.frame();
            c.origin.y = win_h - height;
            c.size.height = height;
            container.setFrame(c);
            let mut b = bar.frame();
            b.origin.y = 0.0;
            b.size.height = height;
            bar.setFrame(b);
            let spacing = 20.0;
            for (i, button) in buttons.iter().enumerate() {
                button.setHidden(only_close && i > 0);
                // Window coordinates count from the bottom-left; the bar converts them to its own.
                let center = NSPoint::new(x + size.width / 2.0 + i as f64 * spacing, win_h - center_y);
                let p = bar.convertPoint_fromView(center, None::<&NSView>);
                button.setFrameOrigin(NSPoint::new(p.x - size.width / 2.0, p.y - size.height / 2.0));
            }
        }
    }

    /// Where each button's center really is, in points from the window's top-left corner.
    pub fn measure(ptr: *mut c_void) -> Vec<(f64, f64)> {
        unsafe {
            let Some(w) = window(ptr) else { return vec![] };
            let win_h = w.frame().size.height;
            [NSWindowButton::CloseButton, NSWindowButton::MiniaturizeButton, NSWindowButton::ZoomButton]
                .into_iter()
                .filter_map(|b| w.standardWindowButton(b))
                .filter(|b| !b.isHidden())
                .map(|b| {
                    let r = b.convertRect_toView(b.bounds(), None::<&NSView>);
                    (r.origin.x + r.size.width / 2.0, win_h - (r.origin.y + r.size.height / 2.0))
                })
                .collect()
        }
    }
}

/// Places the buttons now and again over the first second: AppKit lays a new window out after it is built
/// and may move the buttons back without telling the window.
pub fn place_settled(w: &tauri::WebviewWindow) {
    place(w);
    let w = w.clone();
    std::thread::spawn(move || {
        for ms in [60, 200, 500, 1000] {
            std::thread::sleep(std::time::Duration::from_millis(ms));
            place(&w);
        }
    });
}

/// Places the buttons on the main thread.
pub fn place(w: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        let Ok(ptr) = w.ns_window() else { return };
        let ptr = ptr as usize;
        let s = spec(w.label());
        let _ = w.run_on_main_thread(move || mac::place(ptr as *mut std::ffi::c_void, s.x, s.center_y, s.only_close));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = w;
}

pub fn measure(w: &tauri::WebviewWindow) -> Vec<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        let Ok(ptr) = w.ns_window() else { return vec![] };
        let ptr = ptr as usize;
        let (tx, rx) = std::sync::mpsc::channel();
        if w.run_on_main_thread(move || { let _ = tx.send(mac::measure(ptr as *mut std::ffi::c_void)); }).is_err() {
            return vec![];
        }
        rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or_default()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = w;
        vec![]
    }
}
