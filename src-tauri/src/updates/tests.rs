use super::*;
use manifest::{Archive, Manifest, Release};
use semver::Version;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

fn version(v: &str) -> Version {
    Version::parse(v).unwrap()
}
fn embedded() -> Bundle {
    Bundle {
        source: Source::Embedded,
        version: version("1.0.0"),
        data_format: 1,
    }
}
fn release(v: &str) -> Release {
    Release {
        version: version(v),
        min_shell_version: version("1.0.0"),
        data_format: 1,
        urgent: false,
        rollout: 100,
        archive: Archive {
            url: "https://example.com/bundle.tar.gz".into(),
            size: 1,
            sha256: "0".repeat(64),
        },
    }
}
fn manifest() -> Manifest {
    Manifest {
        schema: 1,
        channel: "test".into(),
        created_at: Utc::now() - chrono::Duration::minutes(1),
        expires_at: Utc::now() + chrono::Duration::hours(1),
        releases: vec![release("1.1.0"), release("1.2.0")],
        revoked: vec![],
    }
}
struct Keys {
    pairs: Vec<minisign::KeyPair>,
}
impl Keys {
    fn new() -> Self {
        Self {
            pairs: (0..3)
                .map(|_| minisign::KeyPair::generate_unencrypted_keypair().unwrap())
                .collect(),
        }
    }
    fn config(&self) -> config::Config {
        config::Config {
            manifest_url: "https://example.com/manifest.json".into(),
            channel: "test".into(),
            public_keys: self.pairs[..2]
                .iter()
                .map(|pair| pair.pk.to_base64())
                .collect(),
            health_url: None,
        }
    }
    fn sign(&self, bytes: &[u8], key: usize) -> String {
        minisign::sign(
            None,
            &self.pairs[key].sk,
            std::io::Cursor::new(bytes),
            Some("update test"),
            None,
        )
        .unwrap()
        .into_string()
    }
}
#[test]
fn signatures_channel_expiry_and_validation() {
    let keys = Keys::new();
    let config = keys.config();
    config.validate().unwrap();
    let bytes = serde_json::to_vec(&manifest()).unwrap();
    for key in [0, 1] {
        assert!(manifest::verify(&bytes, &keys.sign(&bytes, key), &config, Utc::now()).is_ok());
    }
    assert!(manifest::verify(&bytes, &keys.sign(&bytes, 2), &config, Utc::now()).is_err());
    let signature = keys.sign(&bytes, 0);
    assert!(manifest::verify(b"{}", &signature, &config, Utc::now()).is_err());
    assert!(manifest::verify(&bytes, "bad signature", &config, Utc::now()).is_err());
    for mutate in [0, 1, 2, 3, 4, 5] {
        let mut m = manifest();
        match mutate {
            0 => m.channel = "other".into(),
            1 => m.expires_at = Utc::now() - chrono::Duration::seconds(1),
            2 => m.releases[0].archive.url = "http://example.com/update".into(),
            3 => m.releases[0].rollout = 101,
            4 => m.releases[0].archive.sha256 = "bad".into(),
            _ => m.releases.push(m.releases[0].clone()),
        }
        let bytes = serde_json::to_vec(&m).unwrap();
        assert!(manifest::verify(&bytes, &keys.sign(&bytes, 0), &config, Utc::now()).is_err());
    }
    for url in [
        "http://example.com",
        "file:///tmp/bundle",
        "https://user@example.com",
        "https://example.com/#fragment",
    ] {
        assert!(config::https(url).is_err());
    }
}
#[test]
fn eligibility_watermark_shell_revocation_and_rollout() {
    let mut m = manifest();
    let v = version("1.0.0");
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        manifest::eligible(&m, &v, &v, &v, &id).unwrap().version,
        version("1.2.0")
    );
    assert!(manifest::eligible(&m, &v, &version("1.2.0"), &v, &id).is_none());
    m.releases[1].min_shell_version = version("2.0.0");
    assert_eq!(
        manifest::eligible(&m, &v, &v, &v, &id).unwrap().version,
        version("1.1.0")
    );
    m.revoked.push(version("1.1.0"));
    assert!(manifest::eligible(&m, &v, &v, &v, &id).is_none());
    m.revoked.clear();
    let bucket = manifest::bucket(&id, &m.releases[0].version);
    assert_eq!(bucket, manifest::bucket(&id, &m.releases[0].version));
    m.releases[0].rollout = bucket;
    assert!(manifest::eligible(&m, &v, &v, &v, &id).is_none());
    m.releases[0].rollout = bucket + 1;
    assert!(manifest::eligible(&m, &v, &v, &v, &id).is_some());
    // A fixed vector verifies modulo over the complete digest, not just its first bytes.
    let digest = Sha256::digest(format!("{id}1.1.0"));
    let expected = digest
        .iter()
        .fold(0u32, |n, b| (256 * n + u32::from(*b)) % 100);
    assert_eq!(u32::from(bucket), expected);
}
fn stage(s: &mut State, format: u32) {
    let mut r = release("1.1.0");
    r.data_format = format;
    s.staged = Some(Staged {
        release: r,
        at: 0,
        snapshot_ready: false,
    });
}
#[test]
fn two_failed_starts_rollback_without_lowering_watermark() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 1);
    s.boot(&e);
    assert_eq!(s.active.version, version("1.1.0"));
    s.boot(&e);
    assert_eq!(s.active.version, version("1.1.0"));
    let events = s.boot(&e);
    assert!(events.contains(&Event::RolledBack));
    assert_eq!(s.active.version, e.version);
    assert_eq!(s.watermark, version("1.1.0"));
}
#[test]
fn healthy_starts_reset_failures_and_revocation_rolls_back() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 1);
    s.boot(&e);
    s.boot(&e);
    assert!(s.ready(&e));
    s.boot(&e);
    assert_eq!(s.failures, 0);
    assert!(!s.ready(&e));
    s.revoked.push(version("1.1.0"));
    s.boot(&e);
    assert_eq!(s.active.version, e.version);
}
#[test]
fn snapshots_gate_activation_restore_and_expire_after_three_healthy_starts() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 2);
    s.boot(&e);
    assert_eq!(s.active.version, e.version);
    s.ready(&e);
    s.staged.as_mut().unwrap().snapshot_ready = true;
    s.boot(&e);
    assert_eq!(s.active.data_format, 2);
    let mut failing = s.clone();
    failing.boot(&e);
    failing.boot(&e);
    assert_eq!(failing.restore, Some(e.version.clone()));
    assert!(failing.snapshot.is_none());
    for count in 1..=3 {
        s.ready(&e);
        assert_eq!(s.snapshot.is_some(), count < 3);
        if count < 3 {
            s.boot(&e);
        }
    }
}
#[test]
fn revoked_previous_falls_back_to_embedded_and_revoked_staged_never_runs() {
    let e = embedded();
    let mut s = State::new(e.clone());
    stage(&mut s, 1);
    s.revoked.push(version("1.1.0"));
    s.boot(&e);
    assert_eq!(s.active.version, e.version);
    assert!(s.staged.is_none());
    s.active.version = version("1.2.0");
    s.previous = Some(Bundle {
        source: Source::Downloaded,
        version: version("1.1.0"),
        data_format: 1,
    });
    s.failures = 2;
    s.boot(&e);
    assert_eq!(s.active.version, e.version);
}
fn archive(link: bool) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);
    let mut header = tar::Header::new_ustar();
    header.set_mode(0o644);
    if link {
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_link_name("../escape").unwrap();
        header.set_size(0);
    } else {
        header.set_size(5);
    }
    header.set_cksum();
    tar.append_data(
        &mut header,
        "index.html",
        if link { &b""[..] } else { &b"hello"[..] },
    )
    .unwrap();
    tar.into_inner().unwrap().finish().unwrap()
}
fn archive_info(bytes: &[u8]) -> Archive {
    Archive {
        url: "https://example.com/bundle.tar.gz".into(),
        sha256: format!("{:x}", Sha256::digest(bytes)),
        size: bytes.len() as u64,
    }
}
#[test]
fn verifies_hash_size_and_extracts_atomically_without_links() {
    let root = tempfile::tempdir().unwrap();
    let destination = root.path().join("1.1.0");
    let bytes = archive(false);
    let mut info = archive_info(&bytes);
    info.size += 1;
    assert!(download::unpack(&bytes, &info, &destination).is_err());
    assert!(!destination.exists());
    info = archive_info(&bytes);
    info.sha256 = "0".repeat(64);
    assert!(download::unpack(&bytes, &info, &destination).is_err());
    let link = archive(true);
    assert!(download::unpack(&link, &archive_info(&link), &destination).is_err());
    assert!(!destination.exists());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    download::unpack(&bytes, &archive_info(&bytes), &destination).unwrap();
    assert_eq!(
        std::fs::read(destination.join("index.html")).unwrap(),
        b"hello"
    );
    assert!(download::unpack(&bytes, &archive_info(&bytes), &destination).is_err());
}
#[test]
fn health_requires_configuration_and_consent_and_retries_with_backoff() {
    let keys = Keys::new();
    let mut config = keys.config();
    let mut s = State::new(embedded());
    health::enqueue(&mut s, &config, "1.0.0", "1.1.0", Event::Started);
    assert!(s.reports.is_empty());
    config.health_url = Some("https://example.com/health".into());
    s.reports_enabled = false;
    health::enqueue(&mut s, &config, "1.0.0", "1.1.0", Event::Started);
    assert!(s.reports.is_empty());
    s.reports_enabled = true;
    health::enqueue(&mut s, &config, "1.0.0", "1.1.0", Event::Started);
    health::retry(&mut s.reports[0]);
    let first = s.reports[0].next_at;
    health::retry(&mut s.reports[0]);
    assert!(s.reports[0].next_at > first);
    let payload = serde_json::to_value(&s.reports[0].payload).unwrap();
    assert_eq!(payload.as_object().unwrap().len(), 7);
}
#[test]
fn signed_loopback_feed_download_stage_and_cold_boot() {
    let keys = Keys::new();
    let bytes = archive(false);
    let mut m = manifest();
    m.releases.truncate(1);
    m.releases[0].archive = archive_info(&bytes);
    let manifest_bytes = serde_json::to_vec(&m).unwrap();
    let signature = keys.sign(&manifest_bytes, 0);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        for body in [manifest_bytes, signature.into_bytes(), bytes] {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).unwrap();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(&body).unwrap();
        }
    });
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        // HTTP is injected only in this test client; production clients enforce HTTPS.
        let client = reqwest::Client::builder().build().unwrap();
        let base = format!("http://{address}");
        let bytes = download::fetch(&client, &format!("{base}/manifest.json"), 1024 * 1024)
            .await
            .unwrap();
        let signature = download::fetch(&client, &format!("{base}/manifest.json.minisig"), 8192)
            .await
            .unwrap();
        let m = manifest::verify(
            &bytes,
            std::str::from_utf8(&signature).unwrap(),
            &keys.config(),
            Utc::now(),
        )
        .unwrap();
        let mut s = State::new(embedded());
        s.ready(&embedded());
        let release = manifest::eligible(
            &m,
            &s.active.version,
            &s.watermark,
            &embedded().version,
            &s.install_id,
        )
        .unwrap();
        let bytes = download::fetch(
            &client,
            &format!("{base}/bundle.tar.gz"),
            release.archive.size,
        )
        .await
        .unwrap();
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join(release.version.to_string());
        download::unpack(&bytes, &release.archive, &destination).unwrap();
        s.staged = Some(Staged {
            release: release.clone(),
            at: Utc::now().timestamp(),
            snapshot_ready: false,
        });
        let path = root.path().join("state.json");
        download::atomic_write(&path, &serde_json::to_vec(&s).unwrap()).unwrap();
        assert_eq!(s.active.version, embedded().version);
        let mut rebooted: State = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        rebooted.boot(&embedded());
        assert_eq!(rebooted.active.version, release.version);
        assert!(rebooted.ready(&embedded()));
    });
    server.join().unwrap();
}

#[test]
fn build_metadata_does_not_bypass_the_watermark() {
    let mut m = manifest();
    m.releases = vec![release("1.1.0+new")];
    assert!(
        manifest::eligible(
            &m,
            &version("1.0.0"),
            &version("1.1.0+old"),
            &version("1.0.0"),
            "install"
        )
        .is_none()
    );
}
#[test]
fn readiness_persists_and_cleanup_keeps_only_live_versions() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 1);
    s.boot(&e);
    let mut engine = Engine {
        root: root.path().to_path_buf(),
        config: keys.config(),
        state: s,
        embedded: e,
        ready: false,
        blocked: None,
    };
    for v in ["1.0.0", "1.1.0", "0.9.0"] {
        std::fs::create_dir_all(root.path().join("versions").join(v)).unwrap();
    }
    std::fs::create_dir_all(root.path().join("snapshots")).unwrap();
    std::fs::write(root.path().join("snapshots/unused.json"), "{}").unwrap();
    let mut next = engine.state.clone();
    next.ready(&engine.embedded);
    engine.save(next).unwrap();
    engine.cleanup();
    assert!(root.path().join("versions/1.0.0").exists());
    assert!(root.path().join("versions/1.1.0").exists());
    assert!(!root.path().join("versions/0.9.0").exists());
    assert!(!root.path().join("snapshots/unused.json").exists());
    let persisted: State =
        serde_json::from_slice(&std::fs::read(root.path().join("state.json")).unwrap()).unwrap();
    assert!(!persisted.boot_pending);
    assert_eq!(persisted.healthy_starts, 1);
}
#[test]
fn restart_hint_waits_three_days_unless_urgent_and_requires_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let e = embedded();
    let mut engine = Engine {
        root: root.path().to_path_buf(),
        config: keys.config(),
        state: State::new(e.clone()),
        embedded: e,
        ready: false,
        blocked: None,
    };
    stage(&mut engine.state, 1);
    engine.state.staged.as_mut().unwrap().at = Utc::now().timestamp();
    assert!(!engine.status().restart);
    engine.state.staged.as_mut().unwrap().release.urgent = true;
    assert!(engine.status().restart);
    engine.state.staged.as_mut().unwrap().release.urgent = false;
    engine.state.staged.as_mut().unwrap().at -= 3 * 86400 + 1;
    assert!(engine.status().restart);
    engine.state.staged.as_mut().unwrap().release.data_format = 2;
    assert!(!engine.status().restart);
    engine.state.staged.as_mut().unwrap().snapshot_ready = true;
    assert!(engine.status().restart);
}

#[test]
fn rejects_traversal_duplicate_files_and_truncated_gzip_without_publishing() {
    let root = tempfile::tempdir().unwrap();
    for scenario in 0..3 {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut tar = tar::Builder::new(encoder);
        let mut header = tar::Header::new_ustar();
        header.set_size(5);
        header.set_mode(0o644);
        header.set_path("index.html").unwrap();
        header.set_cksum();
        tar.append(&header, &b"hello"[..]).unwrap();
        if scenario == 0 {
            header.as_mut_bytes()[..100].fill(0);
            header.as_mut_bytes()[..9].copy_from_slice(b"../escape");
            header.set_cksum();
            tar.append(&header, &b"hello"[..]).unwrap();
        } else if scenario == 1 {
            tar.append(&header, &b"hello"[..]).unwrap();
        }
        let mut bytes = tar.into_inner().unwrap().finish().unwrap();
        if scenario == 2 {
            bytes.truncate(bytes.len() - 6);
        }
        let destination = root.path().join(format!("case-{scenario}"));
        assert!(download::unpack(&bytes, &archive_info(&bytes), &destination).is_err());
        assert!(!destination.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}
#[test]
fn a_prepared_snapshot_is_not_restored_before_its_release_activates() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 1);
    s.boot(&e);
    s.ready(&e);
    let mut r = release("1.2.0");
    r.data_format = 2;
    s.staged = Some(Staged {
        release: r,
        at: 0,
        snapshot_ready: true,
    });
    s.revoked.push(version("1.1.0"));
    s.boot(&e);
    assert_eq!(s.active.version, e.version);
    assert!(s.restore.is_none());
}

#[test]
fn rollback_never_runs_a_different_data_format_without_a_matching_snapshot() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.ready(&e);
    stage(&mut s, 2);
    s.staged.as_mut().unwrap().snapshot_ready = true;
    s.boot(&e);
    for _ in 0..3 {
        s.ready(&e);
        s.boot(&e);
    }
    assert!(s.snapshot.is_none());
    s.revoked.push(s.active.version.clone());
    s.boot(&e);
    assert_eq!(
        s.active.data_format, 2,
        "preserve live-format metadata when rollback data is gone"
    );
    assert!(s.restore.is_none());

    // A format-2 snapshot cannot make format-1 embedded code safe.
    let mut s = State::new(e.clone());
    s.active = Bundle {
        source: Source::Downloaded,
        version: version("1.1.0"),
        data_format: 2,
    };
    s.ready(&e);
    let mut r = release("1.2.0");
    r.data_format = 3;
    s.staged = Some(Staged {
        release: r,
        at: 0,
        snapshot_ready: true,
    });
    s.boot(&e);
    s.revoked = vec![version("1.1.0"), version("1.2.0")];
    s.boot(&e);
    assert_eq!(s.active.data_format, 3);
    assert!(s.restore.is_none());
}

#[test]
fn signed_manifest_replay_cannot_erase_a_persisted_revocation() {
    let keys = Keys::new();
    let config = keys.config();
    let older = manifest();
    let mut newer = manifest();
    newer.created_at = older.created_at + chrono::Duration::seconds(1);
    newer.revoked = vec![version("1.1.0")];
    let verified = |m: &Manifest| {
        let bytes = serde_json::to_vec(m).unwrap();
        manifest::verify(&bytes, &keys.sign(&bytes, 0), &config, Utc::now()).unwrap()
    };
    let mut s = State::new(embedded());
    s.accept_manifest(&verified(&newer)).unwrap();
    let bytes = serde_json::to_vec(&s).unwrap();
    let mut restarted: State = serde_json::from_slice(&bytes).unwrap();
    assert!(restarted.accept_manifest(&verified(&older)).is_err());
    // Even a newer feed cannot reuse a revoked version.
    newer.created_at += chrono::Duration::seconds(1);
    newer.revoked.clear();
    restarted.accept_manifest(&verified(&newer)).unwrap();
    assert!(restarted.revoked.contains(&version("1.1.0")));
}

#[test]
fn workspace_owner_probe() {
    let Some(root) = std::env::var_os("KINETIK_TEST_OWNER_ROOT") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    if let Ok(_ownership) = ownership::acquire(&root) {
        // Models an older process's stale in-memory state.
        download::atomic_write(
            &root.join("state.json"),
            &serde_json::to_vec(&State::new(embedded())).unwrap(),
        )
        .unwrap();
    }
}
#[test]
fn second_process_cannot_overwrite_watermark_or_consent() {
    let root = tempfile::tempdir().unwrap();
    let _ownership = ownership::acquire(root.path()).unwrap();
    let mut s = State::new(embedded());
    s.watermark = version("2.0.0");
    s.reports_enabled = false;
    download::atomic_write(
        &root.path().join("state.json"),
        &serde_json::to_vec(&s).unwrap(),
    )
    .unwrap();
    let child = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "updates::tests::workspace_owner_probe"])
        .env("KINETIK_TEST_OWNER_ROOT", root.path())
        .output()
        .unwrap();
    assert!(child.status.success());
    let kept: State =
        serde_json::from_slice(&std::fs::read(root.path().join("state.json")).unwrap()).unwrap();
    assert_eq!(kept.watermark, version("2.0.0"));
    assert!(!kept.reports_enabled);
}

#[test]
fn corrupt_primary_recovers_committed_consent_watermark_and_format_without_resetting() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let e = embedded();
    let mut engine = Engine {
        root: root.path().to_path_buf(),
        config: keys.config(),
        state: State::new(e.clone()),
        embedded: e.clone(),
        ready: false,
        blocked: None,
    };
    let mut next = engine.state.clone();
    next.watermark = version("2.0.0");
    next.reports_enabled = false;
    next.active.data_format = 2;
    engine.save(next).unwrap();
    std::fs::write(root.path().join("state.json"), b"broken state").unwrap();
    let recovered =
        persistence::load(root.path(), &e).expect("corrupt primary must have a recovery path");
    assert!(recovered.recovered);
    assert!(!recovered.state.reports_enabled);
    assert_eq!(recovered.state.watermark, version("2.0.0"));
    assert_eq!(recovered.state.active.data_format, 2);
    assert!(std::fs::read_dir(root.path()).unwrap().flatten().any(|f| {
        f.file_name()
            .to_string_lossy()
            .starts_with("state.corrupt-")
    }));
}

#[test]
fn interrupted_directory_commit_keeps_snapshot_and_recovers_a_committed_generation() {
    for failed_name in ["state.backup.json", "state.json"] {
        let root = tempfile::tempdir().unwrap();
        let keys = Keys::new();
        let e = embedded();
        let mut s = State::new(e.clone());
        s.active = Bundle {
            source: Source::Downloaded,
            version: version("1.1.0"),
            data_format: 2,
        };
        s.snapshot = Some(e.version.clone());
        s.healthy_starts = 2;
        let mut engine = Engine {
            root: root.path().to_path_buf(),
            config: keys.config(),
            state: s,
            embedded: e.clone(),
            ready: false,
            blocked: None,
        };
        engine.save(engine.state.clone()).unwrap();
        let old = std::fs::read(root.path().join(failed_name)).unwrap();
        let snapshot = root.path().join("snapshots/1.0.0.json");
        download::atomic_write(&snapshot, b"snapshot").unwrap();
        durability::fail_next_parent_sync(failed_name);
        let mut next = engine.state.clone();
        next.ready(&e);
        assert!(
            engine.save(next).is_err(),
            "commit must wait for directory durability"
        );
        engine.cleanup();
        assert!(
            snapshot.exists(),
            "failed commit must never prune recovery data"
        );
        // Model the unflushed rename being lost at power failure.
        std::fs::write(root.path().join(failed_name), old).unwrap();
        let recovered = persistence::load(root.path(), &e).unwrap();
        if let Some(version) = recovered.state.snapshot {
            assert!(
                root.path()
                    .join("snapshots")
                    .join(format!("{version}.json"))
                    .exists()
            );
        }
    }
}

#[test]
fn startup_recovers_without_opening_newer_data_and_state_write_failure_keeps_recovery() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let e = embedded();
    let mut s = State::new(e.clone());
    s.active = Bundle {
        source: Source::Downloaded,
        version: version("2.0.0"),
        data_format: 2,
    };
    s.watermark = s.active.version.clone();
    s.reports_enabled = false;
    download::atomic_write(
        &root.path().join("versions/2.0.0/index.html"),
        b"newer code",
    )
    .unwrap();
    persistence::commit(root.path(), &s).unwrap();
    std::fs::write(root.path().join("state.json"), b"broken").unwrap();
    let recovery = start(keys.config(), root.path().to_path_buf(), e.clone());
    assert!(recovery.assets.is_none());
    assert!(recovery.recovery.is_some());
    let recovered = recovery.engine.unwrap();
    assert_eq!(recovered.state.active.data_format, 2);
    assert!(!recovered.state.reports_enabled);
    let reopened = start(keys.config(), root.path().to_path_buf(), e.clone());
    assert!(reopened.recovery.is_none());
    assert_eq!(reopened.assets.unwrap(), root.path().join("versions/2.0.0"));
    durability::fail_next_parent_sync("state.json");
    let failed = start(keys.config(), root.path().to_path_buf(), e.clone());
    assert!(failed.assets.is_none());
    assert!(failed.recovery.is_some());
    assert!(root.path().join("versions/2.0.0/index.html").is_file());
    let saved = persistence::load(root.path(), &e).unwrap().state;
    assert_eq!(saved.watermark, version("2.0.0"));
    assert!(!saved.reports_enabled);
    for name in ["state.json", "state.backup.json"] {
        std::fs::write(root.path().join(name), b"broken").unwrap();
    }
    let lost = start(keys.config(), root.path().to_path_buf(), e);
    assert!(lost.recovery.is_some());
    assert!(lost.engine.is_none());
    assert!(lost.assets.is_none());
}

#[test]
fn pending_restore_survives_repeated_failed_starts() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.active = Bundle {
        source: Source::Downloaded,
        version: version("1.1.0"),
        data_format: 1,
    };
    s.restore = Some(version("1.1.0"));
    s.restore_backup = Some("recovery-test".into());
    for _ in 0..4 {
        s.boot(&e);
    }
    assert_eq!(s.active.version, version("1.1.0"));
    assert_eq!(s.restore, Some(version("1.1.0")));
    assert_eq!(s.restore_backup.as_deref(), Some("recovery-test"));
}

#[test]
fn first_use_error_is_not_overwritten_by_later_success() {
    let mut s = State::new(embedded());
    s.first_use_pending = true;
    assert_eq!(s.first_use(false), Some(Event::FirstUseError));
    let mut restarted: State = serde_json::from_slice(&serde_json::to_vec(&s).unwrap()).unwrap();
    assert_eq!(restarted.first_use(true), None);
}

async fn health_receiver(
    statuses: Vec<u16>,
) -> (String, Arc<std::sync::Mutex<Vec<serde_json::Value>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/health", listener.local_addr().unwrap());
    let received = Arc::new(std::sync::Mutex::new(Vec::new()));
    let requests = received.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let body = loop {
                let mut chunk = [0; 4096];
                let count = stream.read(&mut chunk).await.unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&chunk[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&bytes[..end]);
                    let size: usize = headers
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse().unwrap())
                        })
                        .unwrap();
                    if bytes.len() >= end + 4 + size {
                        break bytes[end + 4..end + 4 + size].to_vec();
                    }
                }
            };
            let status = {
                let mut requests = requests.lock().unwrap();
                let status = statuses.get(requests.len()).copied().unwrap_or(200);
                requests.push(serde_json::from_slice(&body).unwrap());
                status
            };
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 {status} Result\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
    });
    (url, received)
}
fn reporting_updates(root: &std::path::Path, url: String) -> Updates {
    let keys = Keys::new();
    let mut config = keys.config();
    config.health_url = Some(url);
    let mut state = State::new(embedded());
    for n in 1..=6 {
        health::enqueue(
            &mut state,
            &config,
            "1.0.0",
            &format!("1.0.{n}"),
            Event::Started,
        );
    }
    let mut engine = Engine {
        config,
        root: root.to_path_buf(),
        state,
        embedded: embedded(),
        ready: true,
        blocked: None,
    };
    engine.save(engine.state.clone()).unwrap();
    Updates {
        engine: Mutex::new(Some(engine)),
        _ownership: None,
        startup_recovery: None,
        checking: Mutex::new(()),
        reporting: Mutex::new(()),
    }
}
#[test]
fn one_flush_delivers_all_due_health_reports_in_queue_order() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let (url, received) = health_receiver(vec![]).await;
            let updates = reporting_updates(root.path(), url);
            commands::flush(&updates, &reqwest::Client::new())
                .await
                .unwrap();
            let payloads = received.lock().unwrap();
            assert_eq!(payloads.len(), 6, "one flush must drain the backlog");
            assert_eq!(
                payloads
                    .iter()
                    .map(|p| p["bundleVersion"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["1.0.1", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"]
            );
            assert!(
                persistence::load(root.path(), &embedded())
                    .unwrap()
                    .state
                    .reports
                    .is_empty()
            );
        });
}

#[test]
fn health_flush_stops_at_failure_and_preserves_order_through_backoff_and_restart() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let root = tempfile::tempdir().unwrap();
            let (url, received) = health_receiver(vec![200, 503]).await;
            let updates = reporting_updates(root.path(), url);
            let client = reqwest::Client::new();
            commands::flush(&updates, &client).await.unwrap();
            assert_eq!(
                received.lock().unwrap().len(),
                2,
                "stop on the first failed response"
            );
            let saved = persistence::load(root.path(), &embedded()).unwrap().state;
            assert_eq!(saved.reports.len(), 5);
            assert_eq!(saved.reports[0].attempts, 1);
            assert!(saved.reports[0].next_at > Utc::now().timestamp());
            assert!(saved.reports[1..].iter().all(|r| r.attempts == 0));
            updates.engine.lock().await.as_mut().unwrap().state = saved;
            commands::flush(&updates, &client).await.unwrap();
            assert_eq!(
                received.lock().unwrap().len(),
                2,
                "backoff must not allow later events to overtake the failure"
            );
            {
                let mut guard = updates.engine.lock().await;
                let engine = guard.as_mut().unwrap();
                let mut next = engine.state.clone();
                next.reports[0].next_at = 0;
                engine.save(next).unwrap();
            }
            commands::flush(&updates, &client).await.unwrap();
            assert_eq!(
                received
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|p| p["bundleVersion"].as_str().unwrap().to_owned())
                    .collect::<Vec<_>>(),
                vec![
                    "1.0.1", "1.0.2", "1.0.2", "1.0.3", "1.0.4", "1.0.5", "1.0.6"
                ]
            );
            assert!(
                persistence::load(root.path(), &embedded())
                    .unwrap()
                    .state
                    .reports
                    .is_empty()
            );
        });
}

#[test]
fn rollback_reports_abandoned_and_running_versions_after_failures_or_revocation() {
    for revoked in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let keys = Keys::new();
        let e = embedded();
        let mut config = keys.config();
        config.health_url = Some("https://example.com/health".into());
        let mut s = State::new(e.clone());
        s.active = Bundle {
            source: Source::Downloaded,
            version: version("1.2.0"),
            data_format: 1,
        };
        s.previous = Some(Bundle {
            source: Source::Downloaded,
            version: version("1.1.0"),
            data_format: 1,
        });
        s.watermark = s.active.version.clone();
        for v in ["1.1.0", "1.2.0"] {
            download::atomic_write(
                &root.path().join("versions").join(v).join("index.html"),
                b"code",
            )
            .unwrap();
        }
        if revoked {
            s.revoked = vec![version("1.2.0"), version("1.1.0")];
        }
        persistence::commit(root.path(), &s).unwrap();
        // Failure rollback is reached through three actual cold starts without acknowledgement.
        for _ in 0..if revoked { 1 } else { 3 } {
            assert!(
                start(config.clone(), root.path().to_path_buf(), e.clone())
                    .recovery
                    .is_none()
            );
        }
        let saved = persistence::load(root.path(), &e).unwrap().state;
        let rollback = saved
            .reports
            .iter()
            .find(|r| r.payload.event == Event::RolledBack)
            .unwrap();
        let payload = serde_json::to_value(&rollback.payload).unwrap();
        assert_eq!(
            payload["bundleVersion"], "1.2.0",
            "identify the abandoned code"
        );
        assert_eq!(
            payload["runningBundleVersion"],
            if revoked { "1.0.0" } else { "1.1.0" }
        );
        assert!(
            saved
                .reports
                .iter()
                .filter(|r| r.payload.event != Event::RolledBack)
                .all(|r| serde_json::to_value(&r.payload)
                    .unwrap()
                    .get("runningBundleVersion")
                    .is_none())
        );
        let mut legacy = payload;
        legacy
            .as_object_mut()
            .unwrap()
            .remove("runningBundleVersion");
        assert!(
            serde_json::from_value::<health::Payload>(legacy).is_ok(),
            "existing queues remain readable"
        );
    }
}

#[test]
fn native_upgrade_with_matching_version_keeps_the_downloaded_data_format() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let shell = Bundle {
        source: Source::Embedded,
        version: version("2.0.0"),
        data_format: 1,
    };
    let mut state = State::new(embedded());
    state.active = Bundle {
        source: Source::Downloaded,
        version: version("2.0.0"),
        data_format: 2,
    };
    state.watermark = state.active.version.clone();
    let downloaded = root.path().join("versions/2.0.0");
    download::atomic_write(&downloaded.join("index.html"), b"format 2 code").unwrap();
    persistence::commit(root.path(), &state).unwrap();
    let launched = start(keys.config(), root.path().to_path_buf(), shell.clone());
    assert_eq!(launched.assets, Some(downloaded.clone()));
    assert!(launched.recovery.is_none());
    // Missing format-2 assets must not be satisfied by the format-1 native shell.
    std::fs::remove_dir_all(downloaded).unwrap();
    let missing = start(keys.config(), root.path().to_path_buf(), shell);
    assert!(missing.assets.is_none());
    assert!(missing.recovery.is_some());
}

#[test]
fn disabled_updates_repair_compatible_backup_once_without_resetting_metadata() {
    let root = tempfile::tempdir().unwrap();
    let e = embedded();
    let _ownership = ownership::acquire(root.path()).unwrap();
    let mut s = State::new(e.clone());
    s.watermark = version("3.0.0");
    s.reports_enabled = false;
    persistence::commit(root.path(), &s).unwrap();
    std::fs::write(root.path().join("state.json"), b"corrupt").unwrap();
    let first = configured_start(None, root.path().to_path_buf(), e.clone());
    assert!(first.recovery.is_some());
    assert!(first.assets.is_none());
    assert!(first.engine.is_none());
    let repaired = persistence::load(root.path(), &e).unwrap();
    assert!(
        !repaired.recovered,
        "the first disabled launch must repair the primary"
    );
    assert_eq!(repaired.state.watermark, version("3.0.0"));
    assert!(!repaired.state.reports_enabled);
    let second = configured_start(None, root.path().to_path_buf(), e);
    assert!(second.recovery.is_none());
    assert!(second.assets.is_none());
    assert!(second.engine.is_none());
}

#[test]
fn unsafe_fallback_enters_embedded_recovery_without_executing_the_abandoned_bundle() {
    for revoked in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let keys = Keys::new();
        let e = embedded();
        let mut s = State::new(e.clone());
        s.active = Bundle {
            source: Source::Downloaded,
            version: version("2.0.0"),
            data_format: 2,
        };
        s.previous = Some(e.clone());
        s.watermark = s.active.version.clone();
        s.healthy_starts = 3;
        if revoked {
            s.revoked.push(s.active.version.clone());
        } else {
            s.failures = 2;
        }
        download::atomic_write(
            &root.path().join("versions/2.0.0/index.html"),
            b"must not execute",
        )
        .unwrap();
        persistence::commit(root.path(), &s).unwrap();
        for _ in 0..2 {
            let boot = start(keys.config(), root.path().to_path_buf(), e.clone());
            assert!(
                boot.assets.is_none(),
                "failed or revoked code must not run again"
            );
            assert!(boot.recovery.is_some());
            let engine = boot.engine.expect("recovery keeps the updater available");
            assert_eq!(
                engine.state.active.data_format, 2,
                "preserve live-data metadata"
            );
            assert!(engine.status().enabled);
        }
    }
}

#[test]
fn recovery_stages_the_newest_compatible_signed_replacement_and_opens_it_on_restart() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let e = embedded();
    let mut state = State::new(e.clone());
    state.active = Bundle {
        source: Source::Downloaded,
        version: version("2.0.0"),
        data_format: 2,
    };
    state.watermark = state.active.version.clone();
    state.revoked.push(state.active.version.clone());
    // A previously staged format upgrade cannot trap recovery behind an unusable release.
    let mut unusable = release("2.8.0");
    unusable.data_format = 3;
    state.staged = Some(Staged {
        release: unusable,
        at: 0,
        snapshot_ready: true,
    });
    state.generation = 1;
    download::atomic_write(&root.path().join("versions/2.8.0/index.html"), b"format 3").unwrap();
    download::atomic_write(&root.path().join("snapshots/2.0.0.json"), b"saved format 2").unwrap();
    persistence::commit(root.path(), &state).unwrap();
    let boot = start(keys.config(), root.path().to_path_buf(), e.clone());
    assert!(boot.assets.is_none());
    let mut engine = boot.engine.unwrap();
    let bytes = archive(false);
    let mut feed = manifest();
    feed.releases.clear();
    for (version, format) in [
        ("2.1.0", 2),
        ("2.2.0", 2),
        ("2.3.0", 1),
        ("2.4.0", 3),
        ("2.5.0", 2),
    ] {
        let mut r = release(version);
        r.data_format = format;
        r.archive = archive_info(&bytes);
        feed.releases.push(r);
    }
    feed.revoked.push(version("2.5.0"));
    let signed = serde_json::to_vec(&feed).unwrap();
    let verified =
        manifest::verify(&signed, &keys.sign(&signed, 1), &keys.config(), Utc::now()).unwrap();
    let replacement = engine
        .candidate(verified)
        .unwrap()
        .expect("recovery must allow a replacement");
    assert_eq!(replacement.version, version("2.2.0"));
    download::unpack(
        &bytes,
        &replacement.archive,
        &root.path().join("versions/2.2.0"),
    )
    .unwrap();
    let mut next = engine.state.clone();
    next.staged = Some(Staged {
        release: replacement,
        at: Utc::now().timestamp(),
        snapshot_ready: false,
    });
    engine.save(next).unwrap();
    assert!(
        engine.status().restart,
        "recovery offers restart immediately"
    );
    let resumed = start(keys.config(), root.path().to_path_buf(), e);
    assert!(resumed.recovery.is_none());
    assert_eq!(resumed.assets, Some(root.path().join("versions/2.2.0")));
    let state = resumed.engine.unwrap().state;
    assert!(!state.recovery);
    assert!(state.restore.is_none());
    assert!(state.snapshot.is_none());
    assert_eq!(state.active.data_format, 2);
}

#[test]
fn legacy_bundle_provenance_and_snapshot_format_do_not_alias_a_new_native_shell() {
    let root = tempfile::tempdir().unwrap();
    let shell = embedded();
    let mut s = State::new(shell.clone());
    s.active.data_format = 2;
    let mut legacy = serde_json::to_value(&s).unwrap();
    legacy["active"].as_object_mut().unwrap().remove("source");
    download::atomic_write(
        &root.path().join("state.json"),
        &serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let unknown = persistence::load(root.path(), &shell).unwrap().state;
    assert_eq!(unknown.active.source, Source::Unknown);
    download::atomic_write(&root.path().join("versions/1.0.0/index.html"), b"format 2").unwrap();
    let identified = persistence::load(root.path(), &shell).unwrap().state;
    assert_eq!(identified.active.source, Source::Downloaded);
    assert_eq!(identified.active.data_format, 2);
    let mut s = identified;
    s.active.version = version("2.0.0");
    s.active.data_format = 3;
    s.snapshot = Some(shell.version.clone());
    s.snapshot_bundle = Some(Bundle {
        source: Source::Embedded,
        version: shell.version.clone(),
        data_format: 2,
    });
    s.revoked.push(s.active.version.clone());
    s.boot(&shell);
    assert!(
        s.recovery,
        "a matching snapshot version does not make format-1 code compatible"
    );
    assert!(s.restore.is_none());
}

#[test]
fn active_revocation_allows_same_format_replacement_before_the_next_cold_start() {
    let root = tempfile::tempdir().unwrap();
    let keys = Keys::new();
    let mut s = State::new(embedded());
    s.active = Bundle {
        source: Source::Downloaded,
        version: version("2.0.0"),
        data_format: 2,
    };
    s.watermark = s.active.version.clone();
    let mut engine = Engine {
        config: keys.config(),
        root: root.path().to_path_buf(),
        state: s,
        embedded: embedded(),
        ready: true,
        blocked: None,
    };
    let mut feed = manifest();
    feed.revoked.push(version("2.0.0"));
    let mut newer = release("2.1.0");
    newer.data_format = 2;
    feed.releases = vec![newer];
    assert_eq!(
        engine.candidate(feed).unwrap().unwrap().version,
        version("2.1.0")
    );
    assert!(
        !engine.state.recovery,
        "the running process switches to recovery only on cold start"
    );
}

#[test]
fn replacement_preserves_the_healthy_fallback_and_its_snapshot() {
    let e = embedded();
    let mut s = State::new(e.clone());
    s.active = Bundle {
        source: Source::Downloaded,
        version: version("2.0.0"),
        data_format: 2,
    };
    s.previous = Some(e.clone());
    s.snapshot = Some(e.version.clone());
    s.snapshot_bundle = Some(e.clone());
    s.failures = 2;
    s.healthy_starts = 3;
    let mut r = release("2.1.0");
    r.data_format = 2;
    s.staged = Some(Staged {
        release: r.clone(),
        at: 0,
        snapshot_ready: false,
    });
    let mut feed = manifest();
    feed.revoked.push(r.version.clone());
    s.accept_manifest(&feed).unwrap();
    assert_eq!(
        s.snapshot,
        Some(e.version.clone()),
        "revoking a replacement must not discard the active rollback snapshot"
    );
    r.version = version("2.2.0");
    s.staged = Some(Staged {
        release: r,
        at: 0,
        snapshot_ready: false,
    });
    s.boot(&e);
    assert_eq!(s.active.version, version("2.2.0"));
    assert_eq!(
        s.previous,
        Some(e),
        "failed code must not replace the last healthy fallback"
    );
}
