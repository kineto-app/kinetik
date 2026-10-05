#[path = "src/updates/config.rs"]
mod config;
fn main() {
    println!("cargo:rerun-if-env-changed=KINETIK_UPDATES_CONFIG");
    let text = match std::env::var("KINETIK_UPDATES_CONFIG") {
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
