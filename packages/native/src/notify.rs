//! Desktop toast notifications (T2.5 decision: hand-rolled WinRT toast).
//!
//! Why not a library: both candidate layers borrow the PowerShell AUMID on
//! Windows — notify-rust 4.x defaults to `Toast::POWERSHELL_APP_ID` (toasts
//! then show "Windows PowerShell" as their source) and node-notifier 10.x
//! spawns the 2017 SnoreToast binary (same borrowed identity). Neither
//! registers a Start-Menu shortcut, which is what a toast with our OWN
//! AppUserModelID requires. The registration path below follows the (draft,
//! unmerged) zed#58354 pattern and the Microsoft desktop-toast guide:
//! https://learn.microsoft.com/en-us/windows/win32/shell/enable-desktop-toast-with-appusermodelid
//!
//! 1. `SetCurrentProcessExplicitAppUserModelID(AUMID)` — claim the identity.
//! 2. Create a Start-Menu `.lnk` carrying `PKEY_AppUserModelID` (rewritten
//!    every process start while `current_exe()` may have moved; idempotent).
//! 3. `ToastNotificationManager::CreateToastNotifier(AUMID)` + hand-built
//!    XML (silent audio unless `sound`).
//!
//! Everything runs on a detached thread: COM/WinRT apartment state stays out
//! of the JS/napi calling thread, and notifications are a non-critical path —
//! failures are logged to stderr, never surfaced as JS errors.
//!
//! Known limitation (first release): activating the toast launches the
//! shortcut target (the host process — `bun.exe` in dev). Bringing the
//! existing window forward is not wired up; the bell red dot + "activate
//! clears it" path is the in-app affordance.

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, IPersistFile,
    };
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        FOLDERID_Programs, IShellLinkW, KNOWN_FOLDER_FLAG, SHGetKnownFolderPath,
        SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{HSTRING, Interface};

    /// Stable identity of j-agent for the Windows notification platform.
    const AUMID: &str = "dev.jagent.Terminal";
    const SHORTCUT_NAME: &str = "j-agent.lnk";

    /// `PKEY_AppUserModelID` — the property key a shortcut must carry for its
    /// target to be allowed to raise toasts. Hand-written (stable well-known
    /// GUID) rather than depending on a windows-crate constant name.
    const PKEY_APP_USER_MODEL_ID: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

    pub fn show(title: &str, body: &str, sound: bool) {
        // Detached thread: own COM apartment per call, nothing to join on.
        let title = title.to_string();
        let body = body.to_string();
        std::thread::spawn(move || {
            if let Err(e) = run(&title, &body, sound) {
                eprintln!("[notify] desktop toast failed: {e:#}");
            }
        });
    }

    fn run(title: &str, body: &str, sound: bool) -> windows::core::Result<()> {
        // SAFETY: this thread is freshly spawned by us; nobody else has
        // initialized (or will observe) its apartment state. We deliberately
        // never call CoUninitialize — the thread dies right after, and
        // balancing it would tear down state for any still-live WinRT object.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok()?;

        ensure_registered()?;

        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body, sound)))?;

        let toast = ToastNotification::CreateToastNotification(&xml)?;
        let notifier: ToastNotifier =
            ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))?;
        notifier.Show(&toast)
    }

    /// Claim the AUMID for this process and (re)write the Start-Menu shortcut.
    /// Runs at most once per process — a successful pass is cached in-place.
    fn ensure_registered() -> windows::core::Result<()> {
        use std::sync::OnceLock;
        static REGISTERED: OnceLock<()> = OnceLock::new();
        if REGISTERED.get().is_some() {
            return Ok(());
        }
        let result = register();
        if result.is_ok() {
            let _ = REGISTERED.set(());
        }
        result
    }

    fn register() -> windows::core::Result<()> {
        // SAFETY: declares our own AUMID for the current process; no pointers.
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID)) }?;

        let shortcut = shortcut_path()?;
        if let Some(parent) = shortcut.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!(
                    "[notify] cannot create shortcut dir {}: {e}",
                    parent.display()
                );
            }
        }

        // SAFETY: COM object creation on this (initialized) apartment; all
        // interface pointers are released at scope end via COM refcounting.
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            // Target: the host process (bun.exe/node.exe in dev, j-agent.exe
            // once packaged). Pointing the shortcut at it is what makes the
            // AUMID resolvable by the toast platform.
            let exe = std::env::current_exe().map_err(|e| {
                eprintln!("[notify] current_exe failed: {e}");
                windows::core::Error::from_win32()
            })?;
            link.SetPath(&HSTRING::from(exe.as_os_str()))?;
            link.SetDescription(&HSTRING::from("j-agent terminal"))?;

            let store: IPropertyStore = link.cast()?;
            let aumid = PROPVARIANT::from(AUMID);
            store.SetValue(&PKEY_APP_USER_MODEL_ID, &aumid)?;
            store.Commit()?;

            let persist: IPersistFile = link.cast()?;
            // Overwrite on every first-call per process: `current_exe` may
            // have moved (dev ↔ packaged), and a stale target breaks nothing
            // else to rewrite.
            persist.Save(&HSTRING::from(shortcut.as_os_str()), true)?;
        }
        Ok(())
    }

    fn shortcut_path() -> windows::core::Result<PathBuf> {
        // SAFETY: KNOWNFOLDER path out-param is freed below via CoTaskMemFree.
        let path = unsafe { SHGetKnownFolderPath(&FOLDERID_Programs, KNOWN_FOLDER_FLAG(0), None)? };
        // SAFETY: PWSTR comes straight from SHGetKnownFolderPath (valid,
        // NUL-terminated, owned by us until CoTaskMemFree below).
        let s = unsafe { path.to_string() }?;
        // SAFETY: freeing the PWSTR returned by SHGetKnownFolderPath exactly
        // once, on the allocator the shell allocated it from.
        unsafe { CoTaskMemFree(Some(path.0 as _)) };
        Ok(PathBuf::from(s).join(SHORTCUT_NAME))
    }

    /// Toast XML (ToastGeneric). `sound == false` must be EXPLICIT: the
    /// platform default is to play a notification sound when no `<audio>`
    /// node is present. User text is entity-escaped (title may come from OSC
    /// strings, i.e. arbitrary PTY output).
    fn toast_xml(title: &str, body: &str, sound: bool) -> String {
        let audio = if sound {
            r#"<audio src="ms-winsoundevent:Notification.Default"/>"#
        } else {
            r#"<audio silent="true"/>"#
        };
        format!(
            concat!(
                r#"<toast scenario="default">"#,
                r#"<visual><binding template="ToastGeneric">"#,
                r#"<text>{}</text><text>{}</text>"#,
                r#"</binding></visual>{}"#,
                r#"</toast>"#,
            ),
            xml_escape(title),
            xml_escape(body),
            audio,
        )
    }

    fn xml_escape(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for c in s.chars() {
            match c {
                '&' => out.push_str("&amp;"),
                '<' => out.push_str("&lt;"),
                '>' => out.push_str("&gt;"),
                '"' => out.push_str("&quot;"),
                '\'' => out.push_str("&apos;"),
                _ => out.push(c),
            }
        }
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn toast_xml_escapes_markup() {
            let xml = toast_xml("a<b>&'\"", "x&y", false);
            assert!(xml.contains("&lt;") && xml.contains("&amp;"));
            assert!(!xml.contains("a<b>"));
            assert!(xml.contains("silent=\"true\""));
        }

        #[test]
        fn toast_xml_sound_uses_default_event() {
            let xml = toast_xml("t", "b", true);
            assert!(xml.contains("ms-winsoundevent:Notification.Default"));
            assert!(!xml.contains("silent"));
        }
    }
}

#[cfg(windows)]
pub use imp::show;

#[cfg(not(windows))]
/// Non-Windows: accepted and dropped (notification platform is Windows-only
/// for now; wire the platform backend here when it lands).
pub fn show(_title: &str, _body: &str, _sound: bool) {}
