mod assets;
mod commands;
mod config;
pub use commands::*;
mod download;
mod durability;
mod health;
mod manifest;
mod ownership;
mod persistence;
mod state;
#[cfg(test)]
mod tests;

use chrono::Utc;
use health::Event;
use serde::Serialize;
use state::{Bundle, Source, Staged, State};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};
use tauri::{Manager, Runtime};
use tokio::sync::Mutex;

type Result<T> = std::result::Result<T, String>;
pub struct Updates {
    engine: Mutex<Option<Engine>>,
    _ownership: Option<std::fs::File>,
    startup_recovery: Option<String>,
    checking: Mutex<()>,
    reporting: Mutex<()>,
}
struct Engine {
    config: config::Config,
    root: PathBuf,
    state: State,
    embedded: Bundle,
    ready: bool,
    blocked: Option<String>,
}
impl Engine {
    fn candidate(&mut self, mut manifest: manifest::Manifest) -> Result<Option<manifest::Release>> {
        let mut next = self.state.clone();
        next.accept_manifest(&manifest)?;
        let replacement = next.restore.is_some()
            || next.recovery
            || next.failures >= 2
            || next.revoked.contains(&next.active.version);
        if replacement
            && next
                .staged
                .as_ref()
                .is_some_and(|s| s.release.data_format != next.active.data_format)
        {
            next.staged = None;
        }
        self.save(next)?;
        let s = &self.state;
        manifest.revoked = s.revoked.clone();
        if s.staged.is_some()
            || (!replacement
                && (s.snapshot.is_some() || (s.active != self.embedded && s.healthy_starts < 3)))
        {
            return Ok(None);
        }
        manifest.releases.retain(|r| {
            if replacement {
                r.data_format == s.active.data_format
            } else {
                r.data_format >= s.active.data_format
            }
        });
        Ok(manifest::eligible(
            &manifest,
            &s.active.version,
            &s.watermark,
            &self.embedded.version,
            &s.install_id,
        )
        .cloned())
    }

    fn ensure_writable(&self) -> Result<()> {
        self.blocked.clone().map_or(Ok(()), Err)
    }
    fn save(&mut self, mut next: State) -> Result<()> {
        self.ensure_writable()?;
        let result = self
            .state
            .generation
            .checked_add(1)
            .ok_or_else(|| "Update state generation exhausted".to_string())
            .and_then(|generation| {
                next.generation = generation;
                persistence::commit(&self.root, &next)
            });
        self.state = next;
        if result.is_err() {
            self.blocked = Some("Update state could not be saved. Your workspace has been kept. Close Kinetik, check available storage, then reopen it.".into());
        }
        result
    }
    fn status(&self) -> Status {
        let staged = self.state.staged.as_ref();
        Status {
            enabled: self.blocked.is_none(),
            recovery: self.blocked.clone().or_else(|| {
                self.state.recovery.then(|| "Kinetik needs a compatible update before opening your workspace. Your data has been kept.".into())
            }),
            health_configured: self.config.health_url.is_some(),
            reports_enabled: self.state.reports_enabled,
            staged: staged.map(|s| s.release.version.to_string()),
            snapshot_needed: staged.is_some_and(|s| {
                s.release.data_format > self.state.active.data_format && !s.snapshot_ready
            }),
            restart: staged.is_some_and(|s| {
                let compatible = s.release.data_format == self.state.active.data_format;
                let prepared_upgrade = self.state.restore.is_none() && !self.state.recovery
                    && s.release.data_format > self.state.active.data_format && s.snapshot_ready;
                (compatible || prepared_upgrade)
                    && (self.state.recovery || s.release.urgent || Utc::now().timestamp() - s.at > 3 * 86400)
            }),
        }
    }
    fn cleanup(&self) {
        if self.blocked.is_some() || self.state.recovery {
            return;
        }
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
    recovery: Option<String>,
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
    let mut ownership = None;
    let startup = (|| -> Result<Startup> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("updates");
        ownership = Some(ownership::acquire(&root)?);
        let config: Option<config::Config> = serde_json::from_str(include_str!(concat!(
            env!("OUT_DIR"),
            "/updates-config.json"
        )))
        .map_err(|e| e.to_string())?;
        let embedded = Bundle {
            source: Source::Embedded,
            version: app.package_info().version.clone(),
            data_format: 1,
        };
        Ok(configured_start(config, root, embedded))
    })()
    .unwrap_or_else(|_| Startup::recovery());
    let _ = source.set(startup.assets);
    app.manage(Updates {
        engine: Mutex::new(startup.engine),
        _ownership: ownership,
        startup_recovery: startup.recovery,
        checking: Mutex::new(()),
        reporting: Mutex::new(()),
    });
    Ok(())
}
struct Startup {
    engine: Option<Engine>,
    recovery: Option<String>,
    assets: Option<PathBuf>,
}
impl Startup {
    fn recovery() -> Self {
        Self { engine: None, assets: None, recovery: Some("Kinetik could not safely open its update state. Your workspace has been kept. Close other copies of Kinetik and check available storage. If reopening does not help, recover the saved update state or install a compatible native app.".into()) }
    }
}
fn configured_start(config: Option<config::Config>, root: PathBuf, embedded: Bundle) -> Startup {
    (|| -> Result<Startup> {
        if let Some(config) = config {
            config.validate()?;
            Ok(start(config, root, embedded))
        } else {
            // Disabling updates must not let embedded code migrate an unknown newer workspace.
            let loaded = persistence::load(&root, &embedded)?;
            if loaded.recovered {
                let mut repaired = loaded.state;
                repaired.generation = repaired.generation.checked_add(1).ok_or("Update state generation exhausted")?;
                persistence::commit(&root, &repaired)?;
                return Ok(Startup { engine: None, assets: None, recovery: Some("Kinetik recovered its saved update state. Close and reopen Kinetik to continue.".into()) });
            }
            if loaded.state.active.data_format != embedded.data_format
                || loaded.state.restore.is_some()
                || loaded.state.revoked.contains(&embedded.version)
            {
                return Err("Workspace requires its compatible native app".into());
            }
            Ok(Startup {
                engine: None,
                recovery: None,
                assets: None,
            })
        }
    })().unwrap_or_else(|_| Startup::recovery())
}
fn start(config: config::Config, root: PathBuf, embedded: Bundle) -> Startup {
    let Ok(loaded) = persistence::load(&root, &embedded) else {
        return Startup::recovery();
    };
    let mut engine = Engine {
        config,
        root,
        state: loaded.state,
        embedded,
        ready: false,
        blocked: None,
    };
    if loaded.recovered {
        // Repair metadata only. Embedded recovery UI must not open or migrate the workspace.
        let _ = engine.save(engine.state.clone());
        let recovery = engine.blocked.clone().unwrap_or_else(|| "Kinetik recovered its saved update state. Your workspace has not been opened. Close and reopen Kinetik to continue with compatible code.".into());
        return Startup {
            engine: Some(engine),
            assets: None,
            recovery: Some(recovery),
        };
    }
    let mut next = engine.state.clone();
    if next
        .active
        .version
        .cmp_precedence(&engine.embedded.version)
        .is_lt()
        && next.active.data_format == engine.embedded.data_format
        && next.restore.is_none()
        && !next.revoked.contains(&engine.embedded.version)
    {
        next.recovery = false;
        next.active = engine.embedded.clone();
        next.previous = None;
        next.staged = None;
        next.boot_pending = false;
        next.failures = 0;
        next.healthy_starts = 0;
        next.watermark = next.watermark.max(engine.embedded.version.clone());
    }
    let exists = |b: &Bundle| {
        b == &engine.embedded
            || (b.source == Source::Downloaded
                && engine
                    .root
                    .join("versions")
                    .join(b.version.to_string())
                    .join("index.html")
                    .is_file())
    };
    if !exists(&next.active) {
        next.failures = 2;
    }
    if next.previous.as_ref().is_some_and(|b| !exists(b)) {
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
    }
    if let Some(staged) = next.staged.as_mut() {
        if next.generation == 0
            || (staged.release.data_format > next.active.data_format
                && !engine
                    .root
                    .join("snapshots")
                    .join(format!("{}.json", next.active.version))
                    .is_file())
        {
            staged.snapshot_ready = false;
        }
    }
    // Missing snapshots are never a reason to select incompatible code.
    if next.snapshot.as_ref().is_some_and(|v| {
        !engine
            .root
            .join("snapshots")
            .join(format!("{v}.json"))
            .is_file()
    }) {
        next.snapshot = None;
    }
    next.resolve_restore(&engine.embedded, &exists);
    let old_version = next.active.version.to_string();
    for event in next.boot(&engine.embedded) {
        let version = if matches!(event, Event::FailedStart | Event::RolledBack) {
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
    if !next.recovery && !exists(&next.active) {
        next.recovery = true;
        next.boot_pending = false;
    }
    if engine.save(next).is_err() {
        return Startup {
            recovery: engine.blocked.clone(),
            engine: Some(engine),
            assets: None,
        };
    }
    if engine.state.recovery {
        return Startup {
            recovery: engine.status().recovery,
            engine: Some(engine),
            assets: None,
        };
    }
    let assets = (engine.state.active.source == Source::Downloaded).then(|| {
        engine
            .root
            .join("versions")
            .join(engine.state.active.version.to_string())
    });
    engine.cleanup();
    Startup {
        engine: Some(engine),
        recovery: None,
        assets,
    }
}
