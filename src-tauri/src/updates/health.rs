use super::{config::Config, state::State};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Event {
    Started,
    FailedStart,
    RolledBack,
    FirstUseOk,
    FirstUseError,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payload {
    pub install_id: String,
    pub platform: String,
    pub shell_version: String,
    pub bundle_version: String,
    pub channel: String,
    pub event: Event,
    pub at: DateTime<Utc>,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct Report {
    pub id: String,
    pub payload: Payload,
    pub attempts: u32,
    pub next_at: i64,
}
pub fn enqueue(state: &mut State, config: &Config, shell: &str, bundle: &str, event: Event) {
    if config.health_url.is_none() || !state.reports_enabled {
        return;
    }
    if state.reports.len() >= 100 {
        state.reports.remove(0);
    }
    state.reports.push(Report {
        id: uuid::Uuid::new_v4().to_string(),
        payload: Payload {
            install_id: state.install_id.clone(),
            platform: std::env::consts::OS.into(),
            shell_version: shell.into(),
            bundle_version: bundle.into(),
            channel: config.channel.clone(),
            event,
            at: Utc::now(),
        },
        attempts: 0,
        next_at: 0,
    });
}
pub fn retry(report: &mut Report) {
    report.attempts = report.attempts.saturating_add(1);
    report.next_at =
        Utc::now().timestamp() + (30i64 * 2i64.pow(report.attempts.min(10))).min(21600);
}
