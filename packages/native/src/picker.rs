//! Native directory picker (Phase W3): "浏览…" for the add-workspace form.
//!
//! gpuix exposes no dialog API (inventory: zero folder-picker / dialog
//! exports in the pinned rev), so this seam lives here next to `notify`.
//!
//! Platform threading:
//! - **macOS**: `NSOpenPanel.runModal` must run on the AppKit main thread.
//!   On macOS gpuix runs GPUI on the JS caller's thread (`tick()` pumps
//!   AppKit there), so we can run the modal loop synchronously from the
//!   napi call. The panel pumps its own modal runloop (interactive); the
//!   GPUI window behind it simply stops repainting — acceptable for a
//!   modal, same as Zed's NSOpenPanel usage.
//! - **Windows**: `IFileDialog` wants an STA thread and its modal `Show`
//!   pumps messages; we mirror `notify.rs` (detached thread + COM
//!   apartment) so the JS/napi thread never blocks.
//!
//! Result is delivered through the caller's callback (`ThreadsafeFunction`,
//! called `NonBlocking` — safe from any thread including the JS thread).

/// Callback contract: `Some(path)` = user picked; `None` = cancelled/failed.
pub type PickCallback = Box<dyn FnOnce(Option<String>) + Send>;

pub fn pick_directory(cb: PickCallback) {
    imp::run(cb);
}

#[cfg(target_os = "macos")]
mod imp {
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    use super::PickCallback;

    pub fn run(cb: PickCallback) {
        cb(open_panel());
    }

    fn open_panel() -> Option<String> {
        unsafe {
            let panel: id = msg_send![class!(NSOpenPanel), openPanel];
            if panel == nil {
                return None;
            }
            let yes: cocoa::base::BOOL = true; // YES
            let no: cocoa::base::BOOL = false; // NO
            let _: () = msg_send![panel, setCanChooseDirectories: yes];
            let _: () = msg_send![panel, setCanChooseFiles: no];
            let _: () = msg_send![panel, setAllowsMultipleSelection: no];
            let _: () = msg_send![panel, setResolvesAliases: yes];
            // NSModalResponseOK == 1
            let response: i64 = msg_send![panel, runModal];
            if response != 1 {
                return None;
            }
            let url: id = msg_send![panel, URL];
            if url == nil {
                return None;
            }
            let s: id = msg_send![url, path];
            if s == nil {
                return None;
            }
            let utf8: *const std::os::raw::c_char = msg_send![s, UTF8String];
            if utf8.is_null() {
                return None;
            }
            Some(std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned())
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
    };
    use windows::Win32::UI::Shell::{
        FileOpenDialog, FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM, FOS_PICKFOLDERS,
        IFileOpenDialog, SIGDN_FILESYSPATH,
    };

    use super::PickCallback;

    pub fn run(cb: PickCallback) {
        // STA + detached thread (notify.rs pattern): apartment state never
        // leaks into the JS/napi calling thread.
        std::thread::spawn(move || cb(open_dialog()));
    }

    fn open_dialog() -> Option<String> {
        unsafe {
            // CoInitializeEx returns a bare HRESULT in windows-rs 0.61;
            // S_FALSE (already initialized) is an ok outcome.
            let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if hr.is_err() {
                eprintln!("pick_directory: CoInitializeEx failed: {hr}");
                return None;
            }
            let dialog: IFileOpenDialog =
                match CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) {
                    Ok(d) => d,
                    Err(e) => {
                        eprintln!("pick_directory: CoCreateInstance failed: {e}");
                        return None;
                    }
                };
            // Keep the stock options; only add folder-picking + filesystem.
            // (GetOptions takes no args and returns the options in 0.61.)
            let opts: FILEOPENDIALOGOPTIONS = dialog.GetOptions().unwrap_or_default();
            let _ = dialog.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
            if dialog.Show(None).is_err() {
                // Includes ERROR_CANCELLED — user closed the dialog.
                return None;
            }
            let item = match dialog.GetResult() {
                Ok(i) => i,
                Err(_) => return None,
            };
            // SIGDN_FILESYNCHRONOUS is absent from windows-rs 0.61 metadata;
            // SIGDN_FILESYSPATH requests the same filesystem path, which every
            // item from an FOS_FORCEFILESYSTEM dialog is guaranteed to have.
            let name = match item.GetDisplayName(SIGDN_FILESYSPATH) {
                Ok(n) => n,
                Err(_) => return None,
            };
            let s = name.to_string().ok()?;
            // Release COM on the way out (we did initialize above).
            let _ = windows::Win32::System::Com::CoUninitialize();
            Some(s)
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::PickCallback;

    pub fn run(cb: PickCallback) {
        // Linux: no native picker wired yet (Server decorations platform);
        // report "unavailable" — the JS side hides the 「浏览…」button or the
        // caller surfaces cancellation.
        cb(None);
    }
}
