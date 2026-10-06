#[path = "src/updates/config.rs"]
mod config;
fn main() {
    println!("cargo:rerun-if-env-changed=KINETIK_UPDATES_CONFIG");
    println!("cargo:rerun-if-env-changed=TAURI_KINETIK_UPDATES_CONFIG");
    // The Tauri CLI starts iOS builds with a cleared environment that keeps only a few prefixes,
    // TAURI_* among them, so iOS builds read the TAURI_-prefixed name.
    let set = |name: &str| std::env::var(name).ok().filter(|path| !path.is_empty());
    let path = set("KINETIK_UPDATES_CONFIG")
        .or_else(|| set("TAURI_KINETIK_UPDATES_CONFIG"))
        .ok_or(());
    let text = match path {
        Ok(path) => {
            println!("cargo:rerun-if-changed={path}");
            let text = std::fs::read_to_string(path).expect("Read update configuration");
            let config: config::Config =
                serde_json::from_str(&text).expect("Parse update configuration");
            config.validate().expect("Validate update configuration");
            text
        }
        Err(_) => "null".into(),
    };
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::write(output.join("updates-config.json"), text).expect("Embed update configuration");
    tauri_build::build()
}
