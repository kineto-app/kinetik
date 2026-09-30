use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Native<R>> {
    #[cfg(target_os = "android")]
    let handle = api.register_android_plugin("app.kinetik.nativebridge", "NativePlugin")?;
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_native)?;
    Ok(Native(handle))
}

/// Access to the native APIs.
pub struct Native<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Native<R> {
    pub fn listener(&self, method: &str, payload: serde_json::Value) -> crate::Result<()> {
        self.0
            .run_mobile_plugin::<()>(method, payload)
            .map_err(Into::into)
    }

    pub fn call(&self, method: &str, payload: NativeRequest) -> crate::Result<NativeResponse> {
        self.0
            .run_mobile_plugin(method, payload)
            .map_err(Into::into)
    }
}
