//! Native window chrome appearance.
//!
//! Zed forces DarkAqua so traffic-light glyphs (especially the green zoom
//! button) match a dark UI even when the OS is in light mode.
//!
//! Timing is tight on macOS:
//! - Do **not** call `NSApplication.sharedApplication` before GPUI starts.
//!   That freezes the AppKit singleton as the stock class; GPUI's
//!   `GPUIApplication` subclass then panics on `set_ivar("platform")`.
//! - Do set DarkAqua **before** the first `NSWindow` exists. AppKit snapshots
//!   traffic-light artwork at window creation; later appearance changes do
//!   not restyle existing buttons.
//!
//! `apply_dark()` therefore talks to `GPUIApplication` (registered in a
//! `#[ctor]` before `main`) and is also invoked from gpuix `init_macos`
//! after the App exists and before `open_window`.

#[cfg(target_os = "macos")]
mod macos {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {
        static NSAppearanceNameDarkAqua: id;
    }

    pub fn apply_dark() {
        unsafe {
            // GPUIApplication is registered by gpui_macos's ctor. Using that
            // class (not NSApplication) keeps the singleton on GPUI's subclass.
            let app_class = class!(GPUIApplication);
            let app: id = msg_send![app_class, sharedApplication];
            if app == nil {
                return;
            }
            let appearance: id = msg_send![
                class!(NSAppearance),
                appearanceNamed: NSAppearanceNameDarkAqua
            ];
            if appearance != nil {
                let _: () = msg_send![app, setAppearance: appearance];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod macos {
    pub fn apply_dark() {}
}

pub fn apply_dark() {
    macos::apply_dark();
}
