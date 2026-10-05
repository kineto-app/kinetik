mod assets;
mod commands;
mod config;
pub use commands::*;
mod download;
mod health;
mod manifest;
mod state;
#[cfg(test)]
mod tests;

use chrono::Utc;
use health::Event;
use serde::Serialize;
use state::{Bundle, Staged, State};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tauri::{Manager, Runtime};
use tokio::sync::Mutex;

type Result<T> = std::result::Result<T, String>;
pub struct Updates {
    engine: Mutex<Option<Engine>>,
    checking: Mutex<()>,
    reporting: Mutex<()>,
}
struct Engine {
    config: config::Config,
    root: PathBuf,
    state: State,
    embedded: Bundle,
    ready: bool,
}
impl Engine {
    fn save(&mut self, next: State) -> Result<()> {
        download::atomic_write(
            &self.root.join("state.json"),
            &serde_json::to_vec(&next).map_err(|e| e.to_string())?,
        )?;
        self.state = next;
        Ok(())
    }
    fn status(&self) -> Status {
        let staged = self.state.staged.as_ref();
        Status {
            enabled: true,
            health_configured: self.config.health_url.is_some(),
            reports_enabled: self.state.reports_enabled,
            staged: staged.map(|s| s.release.version.to_string()),
            snapshot_needed: staged.is_some_and(|s| {
                s.release.data_format > self.state.active.data_format && !s.snapshot_ready
            }),
            restart: staged.is_some_and(|s| {
                (s.release.data_format <= self.state.active.data_format || s.snapshot_ready)
                    && (s.release.urgent || Utc::now().timestamp() - s.at > 3 * 86400)
            }),
        }
    }
    fn cleanup(&self) {
        let keep: Vec<String> = std::iter::once(self.state.active.version.to_string())
            .chain(self.state.previous.iter().map(|b| b.version.to_string()))
            .chain(
                self.state
                    .staged
                    .iter()
                    .map(|s| s.release.version.to_string()),
            )
            .collect();
        if let Ok(entries) = std::fs::read_dir(self.root.join("versions")) {
            for entry in entries.flatten() {
                if !keep.contains(&entry.file_name().to_string_lossy().to_string()) {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        if let Ok(entries) = std::fs::read_dir(self.root.join("snapshots")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let staged_snapshot = self.state.staged.as_ref().is_some_and(|s| {
                    s.snapshot_ready && name == format!("{}.json", self.state.active.version)
                });
                if !staged_snapshot
                    && !self
                        .state
                        .snapshot
                        .iter()
                        .chain(self.state.restore.iter())
                        .any(|v| name == format!("{v}.json"))
                {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    health_configured: bool,
    reports_enabled: bool,
    staged: Option<String>,
    snapshot_needed: bool,
    restart: bool,
}

pub fn install<R: Runtime>(context: &mut tauri::Context<R>) -> assets::Source {
    let source = Arc::new(OnceLock::new());
    let embedded = context.set_assets(Box::new(assets::Empty));
    context.set_assets(Box::new(assets::BundleAssets {
        embedded,
        source: source.clone(),
    }));
    source
}
pub fn initialize<R: Runtime>(app: &tauri::App<R>, source: assets::Source) -> Result<()> {
    let config: Option<config::Config> = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/updates-config.json"
    )))
    .map_err(|e| e.to_string())?;
    let engine = if let Some(config) = config {
        config.validate()?;
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("updates");
        let embedded = Bundle {
            version: app.package_info().version.clone(),
            data_format: 1,
        };
        let state_path = root.join("state.json");
        let state = match std::fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice::<State>(&bytes).map_err(|e| e.to_string())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => State::new(embedded.clone()),
            Err(e) => return Err(e.to_string()),
        };
        let mut engine = Engine {
            config,
            root,
            state,
            embedded,
            ready: false,
        };
        let mut next = engine.state.clone();
        // A newer native shell supersedes old web bundles while preserving the watermark.
        if next
            .active
            .version
            .cmp_precedence(&engine.embedded.version)
            .is_lt()
        {
            next.active = engine.embedded.clone();
            next.previous = None;
            next.staged = None;
            next.boot_pending = false;
            next.failures = 0;
            next.healthy_starts = 0;
            next.watermark = next.watermark.max(engine.embedded.version.clone());
        }
        if next.active.version != engine.embedded.version
            && !engine
                .root
                .join("versions")
                .join(next.active.version.to_string())
                .join("index.html")
                .is_file()
        {
            next.failures = 2;
        }
        if next.previous.as_ref().is_some_and(|b| {
            b.version != engine.embedded.version
                && !engine
                    .root
                    .join("versions")
                    .join(b.version.to_string())
                    .join("index.html")
                    .is_file()
        }) {
            next.previous = None;
        }
        if next.staged.as_ref().is_some_and(|s| {
            !engine
                .root
                .join("versions")
                .join(s.release.version.to_string())
                .join("index.html")
                .is_file()
        }) {
            next.staged = None;
            next.snapshot = None;
        }
        let old_version = next.active.version.to_string();
        let events = next.boot(&engine.embedded);
        for event in events {
            let version = if event == Event::FailedStart {
                old_version.clone()
            } else {
                next.active.version.to_string()
            };
            health::enqueue(
                &mut next,
                &engine.config,
                &engine.embedded.version.to_string(),
                &version,
                event,
            );
        }
        engine.save(next)?;
        let active = (engine.state.active.version != engine.embedded.version).then(|| {
            engine
                .root
                .join("versions")
                .join(engine.state.active.version.to_string())
        });
        let _ = source.set(active);
        engine.cleanup();
        Some(engine)
    } else {
        let _ = source.set(None);
        None
    };
    app.manage(Updates {
        engine: Mutex::new(engine),
        checking: Mutex::new(()),
        reporting: Mutex::new(()),
    });
    Ok(())
}
