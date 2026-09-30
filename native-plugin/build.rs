const COMMANDS: &[&str] = &[
    "secure_get",
    "secure_put",
    "background",
    "file_info",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
