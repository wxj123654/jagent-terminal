fn main() {
    println!("cargo:rerun-if-changed=assets/icons/app.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let icon = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons/app.ico");
        if !icon.is_file() {
            panic!("Windows icon asset missing: {}", icon.display());
        }
        let mut resource = winresource::WindowsResource::new();
        resource.set_icon(icon.to_str().expect("icon path is UTF-8"));
        resource.set("ProductName", "j-agent");
        resource.set("FileDescription", "j-agent desktop application");
        resource.set("InternalName", "j-agent");
        resource.set("OriginalFilename", "j-agent.exe");
        resource.set("ProductVersion", env!("CARGO_PKG_VERSION"));
        resource.set("FileVersion", env!("CARGO_PKG_VERSION"));
        resource
            .compile()
            .expect("compile Windows icon and version resources");
    }
}
