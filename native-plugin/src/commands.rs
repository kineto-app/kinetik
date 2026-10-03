use crate::{NativeExt, Result, models::*};
use tauri::{AppHandle, Runtime, command};
#[command]
pub(crate) async fn secure_get<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeRequest,
) -> Result<NativeResponse> {
    app.native().call("secureGet", payload)
}
#[command]
pub(crate) async fn secure_put<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeRequest,
) -> Result<NativeResponse> {
    app.native().call("securePut", payload)
}
#[command]
pub(crate) async fn background<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeRequest,
) -> Result<NativeResponse> {
    app.native().call("background", payload)
}

#[command]
pub(crate) async fn file_info<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeRequest,
) -> Result<NativeResponse> {
    app.native().call("fileInfo", payload)
}

#[command]
pub(crate) async fn notify<R: Runtime>(
    app: AppHandle<R>,
    payload: NativeRequest,
) -> Result<NativeResponse> {
    app.native().call("notify", payload)
}

#[command]
pub(crate) async fn register_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: tauri::ipc::Channel<serde_json::Value>,
) -> Result<()> {
    if event != "background-stop" {
        return Err(std::io::Error::other("Unknown event").into());
    }
    #[cfg(mobile)]
    app.native().listener(
        "registerListener",
        serde_json::json!({ "event": event, "handler": handler }),
    )?;
    #[cfg(desktop)]
    let _ = (app, handler);
    Ok(())
}
#[command]
pub(crate) async fn remove_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    channel_id: u32,
) -> Result<()> {
    #[cfg(mobile)]
    app.native().listener(
        "removeListener",
        serde_json::json!({ "event": event, "channelId": channel_id }),
    )?;
    #[cfg(desktop)]
    let _ = (app, event, channel_id);
    Ok(())
}
