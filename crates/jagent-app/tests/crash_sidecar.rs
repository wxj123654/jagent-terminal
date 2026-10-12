use std::{fs, process::Command, thread, time::Duration};

#[test]
fn panic_is_written_by_the_child_sidecar_before_the_app_exits() {
    let dir = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_j-agent"))
        .arg("--panic-smoke")
        .env("JAGENT_CRASH_DIR", dir.path())
        .output()
        .expect("run panic smoke child");
    assert!(!output.status.success(), "panic smoke must exit abnormally");

    let mut report = None;
    for _ in 0..40 {
        report = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
            .map(|entry| fs::read_to_string(entry.path()).unwrap());
        if report.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let report = report.expect("sidecar should persist panic metadata");
    let value: serde_json::Value = serde_json::from_str(&report).unwrap();
    assert_eq!(value["kind"], "panic");
    assert_eq!(value["message"], "integration panic smoke marker");
    assert!(
        value["location"]
            .as_str()
            .is_some_and(|s| s.contains("main.rs"))
    );
}
