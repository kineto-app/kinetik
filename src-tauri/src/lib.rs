#[cfg(desktop)]
use tauri::Manager;

mod auth;
mod updates;

/// The operating system, which the app reports to the connections it is configured with.
#[tauri::command]
fn client_platform() -> &'static str {
    std::env::consts::OS
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut context = tauri::generate_context!();
    let updates = updates::install(&mut context);
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(target_os = "android")]
    let builder = builder.invoke_system(include_str!("android-ipc.js"));
    builder
        .manage(auth::AuthState::default())
        .plugin(tauri_plugin_native::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![client_platform, auth::auth_prepare, auth::auth_wait, auth::auth_open, auth::auth_cancel,
            updates::updates_status, updates::updates_ready, updates::updates_check,
            updates::updates_snapshot, updates::updates_restore, updates::updates_reports,
            updates::updates_first_use, updates::updates_flush, updates::updates_workspace_write, updates::updates_recovery_copy])
         .setup(move |app| {
            updates::initialize(app, updates).map_err(std::io::Error::other)?;
            let config = app.config().app.windows.first().expect("main window configuration");
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .on_web_resource_request(|request, response| {
                    if request.uri().path().ends_with("/app-sandbox.html") {
                        response.headers_mut().insert("Content-Security-Policy", tauri::http::HeaderValue::from_static(
                            "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; media-src data: https:; connect-src https: wss:; frame-src about: https:; base-uri https:; object-src 'none'; form-action 'none'; sandbox allow-scripts"
                        ));
                    }
                })
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("Kinetik could not start");
}
