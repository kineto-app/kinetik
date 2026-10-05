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
