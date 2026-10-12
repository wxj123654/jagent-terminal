use std::process::Command;

#[test]
fn watchdog_restarts_failing_children_and_stops_at_the_crash_loop_limit() {
    let output = Command::new(env!("CARGO_BIN_EXE_j-agent"))
        .arg("--watchdog-smoke")
        .output()
        .expect("run watchdog smoke process");
    assert!(
        output.status.success(),
        "watchdog smoke should classify the crash loop and exit cleanly: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    let child_exits = stderr.matches("app exited with").count();
    assert_eq!(
        child_exits, 2,
        "watchdog actually restarted two failing child processes: {stderr}"
    );
    assert!(
        stderr.contains("stopping to prevent crash loop"),
        "watchdog cutoff is reported: {stderr}"
    );
}

#[cfg(unix)]
#[test]
fn watchdog_normal_exit_branch_is_reached_through_default_routing_and_runs_one_child() {
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("watchdog-normal-child.started");
    let output = Command::new(env!("CARGO_BIN_EXE_j-agent"))
        .env("JAGENT_WATCHDOG_NORMAL_CHILD_MARKER", &marker)
        .arg("--watchdog-normal-smoke")
        .output()
        .expect("run normal-stop smoke process");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        marker.exists(),
        "default unspecialized child must pass through watchdog and execute once"
    );
    let marker_text = std::fs::read_to_string(marker).unwrap();
    assert_eq!(
        marker_text.lines().count(),
        1,
        "normal exit is not restarted"
    );
    assert!(
        output.stderr.is_empty(),
        "normal child exit should not cause a restart: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
