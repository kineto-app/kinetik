use super::{
    health::{Event, Report},
    manifest::Release,
};
use semver::Version;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Embedded,
    Downloaded,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    #[serde(default)]
    pub source: Source,
    pub version: Version,
    pub data_format: u32,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Staged {
    pub release: Release,
    pub at: i64,
    pub snapshot_ready: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub install_id: String,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub recovery: bool,
    pub active: Bundle,
    pub previous: Option<Bundle>,
    pub staged: Option<Staged>,
    pub watermark: Version,
    pub boot_pending: bool,
    pub failures: u32,
    pub healthy_starts: u32,
    pub revoked: Vec<Version>,
    #[serde(default)]
    pub manifest_dates: std::collections::BTreeMap<String, chrono::DateTime<chrono::Utc>>,
    pub snapshot: Option<Version>,
    #[serde(default)]
    pub snapshot_bundle: Option<Bundle>,
    pub restore: Option<Version>,
    #[serde(default)]
    pub restore_backup: Option<String>,
    pub reports_enabled: bool,
    pub reports: Vec<Report>,
    pub first_use_pending: bool,
    pub notify_update: bool,
}
impl State {
    pub fn new(embedded: Bundle) -> Self {
        Self {
            install_id: uuid::Uuid::new_v4().to_string(),
            generation: 0,
            recovery: false,
            watermark: embedded.version.clone(),
            active: embedded,
            previous: None,
            staged: None,
            boot_pending: false,
            failures: 0,
            healthy_starts: 0,
            revoked: vec![],
            manifest_dates: Default::default(),
            snapshot: None,
            snapshot_bundle: None,
            restore: None,
            restore_backup: None,
            reports_enabled: true,
            reports: vec![],
            first_use_pending: false,
            notify_update: false,
        }
    }
    pub fn accept_manifest(&mut self, manifest: &super::manifest::Manifest) -> Result<(), String> {
        if self
            .manifest_dates
            .get(&manifest.channel)
            .is_some_and(|at| manifest.created_at < *at)
        {
            return Err("Older update manifest rejected".into());
        }
        self.manifest_dates
            .insert(manifest.channel.clone(), manifest.created_at);
        for version in &manifest.revoked {
            if !self.revoked.contains(version) {
                self.revoked.push(version.clone());
            }
        }
        if self
            .staged
            .as_ref()
            .is_some_and(|s| self.revoked.contains(&s.release.version))
        {
            self.staged = None;
        }
        Ok(())
    }
    pub fn resolve_restore(&mut self, embedded: &Bundle, exists: impl Fn(&Bundle) -> bool) {
        if self.restore.is_none() {
            return;
        }
        // active.data_format is the snapshot's target format until restore is acknowledged.
        // Resolve code independently of the snapshot version and the outgoing-data backup.
        let staged = self.staged.as_ref().map(|s| Bundle {
            source: Source::Downloaded,
            version: s.release.version.clone(),
            data_format: s.release.data_format,
        });
        let target = std::iter::once(&self.active)
            .chain(self.previous.iter())
            .chain(std::iter::once(embedded))
            .chain(staged.iter())
            .filter(|b| {
                b.data_format == self.active.data_format
                    && !self.revoked.contains(&b.version)
                    && exists(b)
            })
            .max_by(|a, b| a.version.cmp_precedence(&b.version))
            .cloned();
        self.staged = None;
        self.recovery = target.is_none();
        if let Some(target) = target {
            if target != self.active {
                self.boot_pending = false;
                self.failures = 0;
                self.healthy_starts = 0;
                self.first_use_pending = false;
                self.notify_update = false;
            }
            self.watermark = self.watermark.clone().max(target.version.clone());
            self.active = target;
        }
    }
    pub fn boot(&mut self, embedded: &Bundle) -> Vec<Event> {
        let mut events = vec![];
        if self.boot_pending {
            self.failures = self.failures.saturating_add(1);
            events.push(Event::FailedStart);
        }
        self.boot_pending = false;
        if self.restore.is_some() {
            // Startup resolved compatible code, but the snapshot still must be restored
            // before runtime initialization. Repeated starts keep that same restore intact.
            if self.recovery || self.revoked.contains(&self.active.version) {
                self.recovery = true;
                return events;
            }
            self.boot_pending = true;
            events.push(Event::Started);
            return events;
        }
        let rollback =
            self.recovery || self.failures >= 2 || self.revoked.contains(&self.active.version);
        if rollback
            && self
                .staged
                .as_ref()
                .is_some_and(|s| s.release.data_format != self.active.data_format)
        {
            self.staged = None;
        }
        let replacement = self
            .staged
            .as_ref()
            .filter(|s| {
                s.release.data_format == self.active.data_format
                    && !self.revoked.contains(&s.release.version)
            })
            .cloned();
        if rollback && let Some(staged) = replacement {
            self.activate(staged);
        } else if rollback {
            let fallback = self
                .previous
                .iter()
                .chain(std::iter::once(embedded))
                .find(|bundle| {
                    *bundle != &self.active
                        && !self.revoked.contains(&bundle.version)
                        && (bundle.data_format == self.active.data_format
                            || (self.snapshot.as_ref() == Some(&bundle.version)
                                && self.snapshot_bundle.as_ref() == Some(bundle)))
                })
                .cloned();
            let Some(fallback) = fallback else {
                self.recovery = true;
                return events;
            };
            self.restore = if fallback.data_format == self.active.data_format {
                None
            } else {
                self.snapshot.take()
            };
            self.snapshot_bundle = None;
            if self.restore.is_some() {
                self.restore_backup =
                    Some(format!("kinetik-update-recovery-{}", uuid::Uuid::new_v4()));
            }
            self.active = fallback;
            self.previous = None;
            self.staged = None;
            self.failures = 0;
            self.healthy_starts = 0;
            self.first_use_pending = false;
            self.notify_update = false;
            self.recovery = false;
            events.push(Event::RolledBack);
        } else if let Some(staged) = self.staged.clone() {
            if self.revoked.contains(&staged.release.version)
                || staged.release.data_format < self.active.data_format
            {
                self.staged = None;
            } else if staged.release.data_format == self.active.data_format || staged.snapshot_ready
            {
                self.activate(staged);
            }
        }
        self.boot_pending = true;
        events.push(Event::Started);
        events
    }
    fn activate(&mut self, staged: Staged) {
        if staged.release.data_format > self.active.data_format {
            self.snapshot = Some(self.active.version.clone());
            self.snapshot_bundle = Some(self.active.clone());
        }
        if self.healthy_starts > 0
            && self.failures < 2
            && !self.recovery
            && !self.revoked.contains(&self.active.version)
        {
            self.previous = Some(self.active.clone());
        }
        self.active = Bundle {
            source: Source::Downloaded,
            version: staged.release.version,
            data_format: staged.release.data_format,
        };
        self.watermark = self.watermark.clone().max(self.active.version.clone());
        self.staged = None;
        self.failures = 0;
        self.healthy_starts = 0;
        self.first_use_pending = true;
        self.notify_update = true;
        self.recovery = false;
    }
    pub fn first_use(&mut self, ok: bool) -> Option<Event> {
        if !self.first_use_pending {
            return None;
        }
        self.first_use_pending = false;
        Some(if ok {
            Event::FirstUseOk
        } else {
            Event::FirstUseError
        })
    }
    pub fn ready(&mut self, embedded: &Bundle) -> bool {
        let updated = self.notify_update && self.active != *embedded;
        self.notify_update = false;
        self.boot_pending = false;
        self.failures = 0;
        self.healthy_starts = self.healthy_starts.saturating_add(1);
        if self.healthy_starts >= 3 {
            self.snapshot = None;
            self.snapshot_bundle = None;
        }
        updated
    }
}
