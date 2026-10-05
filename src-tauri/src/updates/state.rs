use super::{
    health::{Event, Report},
    manifest::Release,
};
use semver::Version;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
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
    pub active: Bundle,
    pub previous: Option<Bundle>,
    pub staged: Option<Staged>,
    pub watermark: Version,
    pub boot_pending: bool,
    pub failures: u32,
    pub healthy_starts: u32,
    pub revoked: Vec<Version>,
    pub snapshot: Option<Version>,
    pub restore: Option<Version>,
    pub reports_enabled: bool,
    pub reports: Vec<Report>,
    pub first_use_pending: bool,
    pub notify_update: bool,
}
impl State {
    pub fn new(embedded: Bundle) -> Self {
        Self {
            install_id: uuid::Uuid::new_v4().to_string(),
            watermark: embedded.version.clone(),
            active: embedded,
            previous: None,
            staged: None,
            boot_pending: false,
            failures: 0,
            healthy_starts: 0,
            revoked: vec![],
            snapshot: None,
            restore: None,
            reports_enabled: true,
            reports: vec![],
            first_use_pending: false,
            notify_update: false,
        }
    }
    pub fn boot(&mut self, embedded: &Bundle) -> Vec<Event> {
        let mut events = vec![];
        if self.boot_pending {
            self.failures = self.failures.saturating_add(1);
            events.push(Event::FailedStart);
        }
        let rollback = self.failures >= 2 || self.revoked.contains(&self.active.version);
        if rollback && self.active.version != embedded.version {
            self.active = self
                .previous
                .take()
                .filter(|b| !self.revoked.contains(&b.version))
                .unwrap_or_else(|| embedded.clone());
            self.restore = self.snapshot.take();
            self.staged = None;
            self.failures = 0;
            self.healthy_starts = 0;
            self.first_use_pending = false;
            self.notify_update = false;
            events.push(Event::RolledBack);
        } else if self.restore.is_none()
            && let Some(staged) = self.staged.clone()
        {
            if self.revoked.contains(&staged.release.version) {
                self.staged = None;
            } else if staged.release.data_format <= self.active.data_format || staged.snapshot_ready
            {
                if staged.release.data_format > self.active.data_format {
                    self.snapshot = Some(self.active.version.clone());
                }
                if self.healthy_starts > 0 {
                    self.previous = Some(self.active.clone());
                }
                self.active = Bundle {
                    version: staged.release.version,
                    data_format: staged.release.data_format,
                };
                self.watermark = self.watermark.clone().max(self.active.version.clone());
                self.staged = None;
                self.failures = 0;
                self.healthy_starts = 0;
                self.first_use_pending = true;
                self.notify_update = true;
            }
        }
        self.boot_pending = true;
        events.push(Event::Started);
        events
    }
    pub fn ready(&mut self, embedded: &Bundle) -> bool {
        let updated = self.notify_update && self.active.version != embedded.version;
        self.notify_update = false;
        self.boot_pending = false;
        self.failures = 0;
        self.healthy_starts = self.healthy_starts.saturating_add(1);
        if self.healthy_starts >= 3 {
            self.snapshot = None;
        }
        updated
    }
}
