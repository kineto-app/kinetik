use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::State;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};
use url::Url;

pub struct Pending {
    id: String,
    redirect: String,
    listener: TcpListener,
}
#[derive(Default)]
pub struct AuthState(Mutex<AuthSlot>);
#[derive(Default)]
struct AuthSlot {
    pending: Option<Pending>,
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    id: String,
    redirect_uri: String,
}

#[tauri::command]
pub async fn auth_prepare(path: String, state: State<'_, AuthState>) -> Result<Prepared, String> {
    if !["/auth/callback", "/charms/callback"].contains(&path.as_str()) {
        return Err("Unsupported callback path".into());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not open the local sign-in listener")?;
    let port = listener
        .local_addr()
        .map_err(|_| "Sign-in listener unavailable")?
        .port();
    let redirect = format!("http://127.0.0.1:{port}{path}");
    let id = uuid::Uuid::new_v4().to_string();
    let mut slot = state.0.lock().map_err(|_| "Sign-in state unavailable")?;
    if let Some(cancel) = slot.cancel.take() {
        let _ = cancel.send(());
    }
    slot.pending = Some(Pending {
        id: id.clone(),
        redirect: redirect.clone(),
        listener,
    });
    Ok(Prepared {
        id,
        redirect_uri: redirect,
    })
}

fn callback_url(request: &str, redirect: &str, expected_state: &str) -> Option<String> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "GET" {
        return None;
    }
    let path = parts.next()?;
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    let base = Url::parse(redirect).ok()?;
    let url = base.join(path).ok()?;
    if url.origin() != base.origin() || url.path() != base.path() || url.fragment().is_some() {
        return None;
    }
    let states: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "state")
        .collect();
    if states.len() != 1 || states[0].1 != expected_state {
        return None;
    }
    let expected_host = format!("127.0.0.1:{}", base.port()?);
    let host = request.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("host").then(|| value.trim())
    })?;
    if host != expected_host {
        return None;
    }
    Some(url.to_string())
}

#[tauri::command]
pub async fn auth_wait(
    id: String,
    expected_state: String,
    state: State<'_, AuthState>,
) -> Result<String, String> {
    if expected_state.len() < 16 || expected_state.len() > 256 {
        return Err("Invalid sign-in state".into());
    }
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    let pending = {
        let mut slot = state.0.lock().map_err(|_| "Sign-in state unavailable")?;
        if slot.pending.as_ref().is_none_or(|pending| pending.id != id) {
            return Err("This sign-in attempt is no longer active".into());
        }
        slot.cancel = Some(cancel);
        slot.pending.take().unwrap()
    };
    tokio::select! {
      _ = cancelled => Err("Sign-in cancelled.".into()),
      result = tokio::time::timeout(Duration::from_secs(600), async {
        loop {
            let (mut stream, peer) = pending.listener.accept().await.map_err(|_| "Sign-in listener stopped")?;
            if !peer.ip().is_loopback() { continue; }
            let mut bytes = Vec::new();
            let read = tokio::time::timeout(Duration::from_secs(3), async {
                let mut chunk = [0; 1024];
                while bytes.len() < 16384 {
                    let n = stream.read(&mut chunk).await?;
                    if n == 0 { break; }
                    bytes.extend_from_slice(&chunk[..n]);
                    if bytes.windows(4).any(|p| p == b"\r\n\r\n") { break; }
                }
                Ok::<_, std::io::Error>(())
            }).await;
            if !matches!(read, Ok(Ok(()))) { continue; }
            let callback = std::str::from_utf8(&bytes).ok()
                .and_then(|request| callback_url(request, &pending.redirect, &expected_state));
            let response = if callback.is_some() {
                "HTTP/1.1 303 See Other\r\nLocation: kinetik://auth/complete\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                "HTTP/1.1 400 Bad Request\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            let _ = stream.write_all(response.as_bytes()).await;
            let _ = stream.shutdown().await;
            if let Some(callback) = callback { return Ok(callback); }
        }
    }) => result.map_err(|_| "Sign-in timed out. Try again.")?,
    }
}

// iOS presents authentication without moving the app into the background.
// The provider still redirects to the validated HTTP loopback listener. Its
// token-free 303 then dismisses the system authentication sheet.
#[tauri::command]
pub async fn auth_open(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid sign-in URL")?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Sign-in requires an HTTPS URL".into());
    }
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_native::NativeExt;
        tauri::async_runtime::spawn_blocking(move || {
            app.native()
                .call(
                    "authOpen",
                    tauri_plugin_native::NativeRequest {
                        url: Some(url),
                        key: None,
                        value: None,
                        active: None,
                    },
                )
                .map(|_| ())
                .map_err(|_| "Sign-in was cancelled or could not open.".to_string())
        })
        .await
        .map_err(|_| "Sign-in browser stopped".to_string())?
    }
    #[cfg(not(target_os = "ios"))]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "Could not open the sign-in browser".to_string())
    }
}

#[tauri::command]
pub async fn auth_cancel(app: tauri::AppHandle, state: State<'_, AuthState>) -> Result<(), String> {
    {
        let mut slot = state.0.lock().map_err(|_| "Sign-in state unavailable")?;
        slot.pending = None;
        if let Some(cancel) = slot.cancel.take() {
            let _ = cancel.send(());
        }
    }
    #[cfg(target_os = "ios")]
    {
        use tauri_plugin_native::NativeExt;
        tauri::async_runtime::spawn_blocking(move || {
            app.native().call(
                "authCancel",
                tauri_plugin_native::NativeRequest {
                    url: None,
                    key: None,
                    value: None,
                    active: None,
                },
            )
        })
        .await
        .map_err(|_| "Could not close sign-in".to_string())?
        .map_err(|_| "Could not close sign-in".to_string())?;
    }
    #[cfg(not(target_os = "ios"))]
    let _ = app;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callback_is_bound_to_listener_path_host_and_unique_state() {
        let base = "http://127.0.0.1:43111/auth/callback";
        let state = "random-state-for-this-attempt";
        let valid = format!(
            "GET /auth/callback?code=one-use&state={state} HTTP/1.1\r\nHost: 127.0.0.1:43111\r\n\r\n"
        );
        assert!(callback_url(&valid, base, state).is_some());
        for request in [
            valid.replace(state, "wrong"),
            valid.replace("/auth/callback", "/wrong"),
            valid.replace("Host: 127.0.0.1", "Host: attacker.example"),
            valid.replace("&state=", "&state=duplicate&state="),
            valid.replace("GET ", "POST "),
        ] {
            assert!(callback_url(&request, base, state).is_none());
        }
    }
}
