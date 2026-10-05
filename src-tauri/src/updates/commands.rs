use super::*;

#[tauri::command]
pub async fn updates_status(updates: tauri::State<'_, Updates>) -> Result<Status> {
    Ok(updates
        .engine
        .lock()
        .await
        .as_ref()
        .map(Engine::status)
        .unwrap_or_default())
}
#[tauri::command]
pub async fn updates_ready(updates: tauri::State<'_, Updates>) -> Result<bool> {
    let mut guard = updates.engine.lock().await;
    let Some(engine) = guard.as_mut() else {
        return Ok(false);
    };
    if engine.ready || engine.state.restore.is_some() {
        return Ok(false);
    }
    let mut next = engine.state.clone();
    let updated = next.ready(&engine.embedded);
    engine.save(next)?;
    engine.ready = true;
    engine.cleanup();
    Ok(updated)
}
#[tauri::command]
pub async fn updates_check(updates: tauri::State<'_, Updates>) -> Result<Status> {
    let Ok(_check) = updates.checking.try_lock() else {
        return updates_status(updates.clone()).await;
    };
    let config = {
        let guard = updates.engine.lock().await;
        let Some(engine) = guard.as_ref() else {
            return Ok(Status::default());
        };
        engine.config.clone()
    };
    let client = download::client()?;
    let bytes = download::fetch(&client, &config.manifest_url, 1024 * 1024).await?;
    let mut signature_url = url::Url::parse(&config.manifest_url).map_err(|e| e.to_string())?;
    signature_url.set_path(&format!("{}.minisig", signature_url.path()));
    let signature = download::fetch(&client, signature_url.as_str(), 8192).await?;
    let manifest = manifest::verify(
        &bytes,
        std::str::from_utf8(&signature).map_err(|e| e.to_string())?,
        &config,
        Utc::now(),
    )?;
    let candidate = {
        let mut guard = updates.engine.lock().await;
        let engine = guard.as_mut().unwrap();
        let mut next = engine.state.clone();
        next.revoked = manifest.revoked.clone();
        if next
            .staged
            .as_ref()
            .is_some_and(|s| next.revoked.contains(&s.release.version))
        {
            next.staged = None;
            next.snapshot = None;
        }
        engine.save(next)?;
        let s = &engine.state;
        if s.staged.is_some()
            || s.snapshot.is_some()
            || s.restore.is_some()
            || s.revoked.contains(&s.active.version)
            || (s.active.version != engine.embedded.version && s.healthy_starts < 3)
        {
            None
        } else {
            manifest::eligible(
                &manifest,
                &s.active.version,
                &s.watermark,
                &engine.embedded.version,
                &s.install_id,
            )
            .map(|r| {
                (
                    r.clone(),
                    engine.root.join("versions").join(r.version.to_string()),
                )
            })
        }
    };
    if let Some((release, destination)) = candidate {
        let bytes = download::fetch(&client, &release.archive.url, release.archive.size).await?;
        let archive = release.archive.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // An interrupted state write may leave a complete, unreferenced directory.
            if destination.exists() {
                std::fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
            }
            download::unpack(&bytes, &archive, &destination)
        })
        .await
        .map_err(|e| e.to_string())??;
        let mut guard = updates.engine.lock().await;
        let engine = guard.as_mut().unwrap();
        let mut next = engine.state.clone();
        next.staged = Some(Staged {
            release,
            at: Utc::now().timestamp(),
            snapshot_ready: false,
        });
        engine.save(next)?;
        engine.cleanup();
    }
    updates_status(updates.clone()).await
}
#[tauri::command]
pub async fn updates_snapshot(
    updates: tauri::State<'_, Updates>,
    version: String,
    text: String,
) -> Result<()> {
    if text.len() > 32 * 1024 * 1024 {
        return Err("Snapshot exceeds size limit".into());
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if value["format"] != "kinetik-workspace" || value["version"] != 1 {
        return Err("Invalid workspace snapshot".into());
    }
    let mut guard = updates.engine.lock().await;
    let engine = guard.as_mut().ok_or("Updates disabled")?;
    let mut next = engine.state.clone();
    let staged = next.staged.as_mut().ok_or("No staged release")?;
    if staged.release.version.to_string() != version
        || staged.release.data_format <= next.active.data_format
    {
        return Err("Snapshot does not match staged release".into());
    }
    download::atomic_write(
        &engine
            .root
            .join("snapshots")
            .join(format!("{}.json", next.active.version)),
        text.as_bytes(),
    )?;
    staged.snapshot_ready = true;
    engine.save(next)
}
#[tauri::command]
pub async fn updates_restore(
    updates: tauri::State<'_, Updates>,
    complete: bool,
) -> Result<Option<String>> {
    let mut guard = updates.engine.lock().await;
    let Some(engine) = guard.as_mut() else {
        return Ok(None);
    };
    let Some(version) = &engine.state.restore else {
        return Ok(None);
    };
    let path = engine
        .root
        .join("snapshots")
        .join(format!("{version}.json"));
    if !complete {
        return std::fs::read_to_string(path)
            .map(Some)
            .map_err(|e| e.to_string());
    }
    let mut next = engine.state.clone();
    next.restore = None;
    engine.save(next)?;
    engine.cleanup();
    Ok(None)
}
#[tauri::command]
pub async fn updates_reports(updates: tauri::State<'_, Updates>, enabled: bool) -> Result<()> {
    let mut guard = updates.engine.lock().await;
    let Some(engine) = guard.as_mut() else {
        return Ok(());
    };
    let mut next = engine.state.clone();
    next.reports_enabled = enabled;
    if !enabled {
        next.reports.clear();
    }
    engine.save(next)
}
#[tauri::command]
pub async fn updates_first_use(updates: tauri::State<'_, Updates>, ok: bool) -> Result<()> {
    let mut guard = updates.engine.lock().await;
    let Some(engine) = guard.as_mut() else {
        return Ok(());
    };
    if !engine.state.first_use_pending {
        return Ok(());
    }
    let mut next = engine.state.clone();
    next.first_use_pending = false;
    let version = next.active.version.to_string();
    health::enqueue(
        &mut next,
        &engine.config,
        &engine.embedded.version.to_string(),
        &version,
        if ok {
            Event::FirstUseOk
        } else {
            Event::FirstUseError
        },
    );
    engine.save(next)
}
#[tauri::command]
pub async fn updates_flush(updates: tauri::State<'_, Updates>) -> Result<()> {
    let Ok(_sending) = updates.reporting.try_lock() else {
        return Ok(());
    };
    let pending = {
        let guard = updates.engine.lock().await;
        let Some(engine) = guard.as_ref() else {
            return Ok(());
        };
        if !engine.state.reports_enabled {
            return Ok(());
        }
        engine.config.health_url.as_ref().and_then(|url| {
            engine
                .state
                .reports
                .iter()
                .find(|r| r.next_at <= Utc::now().timestamp())
                .map(|r| (url.clone(), r.clone()))
        })
    };
    let Some((url, report)) = pending else {
        return Ok(());
    };
    let result = download::client()?
        .post(url)
        .timeout(std::time::Duration::from_secs(5))
        .json(&report.payload)
        .send()
        .await;
    let sent = result.is_ok_and(|r| r.status().is_success());
    let mut guard = updates.engine.lock().await;
    let Some(engine) = guard.as_mut() else {
        return Ok(());
    };
    let mut next = engine.state.clone();
    if let Some(index) = next.reports.iter().position(|r| r.id == report.id) {
        if sent {
            next.reports.remove(index);
        } else {
            health::retry(&mut next.reports[index]);
        }
        engine.save(next)?;
    }
    Ok(())
}
