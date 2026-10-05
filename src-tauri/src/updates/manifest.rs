use super::config::{Config, https};
use chrono::{DateTime, Utc};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_ARCHIVE: u64 = 64 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Archive {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: Version,
    pub min_shell_version: Version,
    pub data_format: u32,
    pub urgent: bool,
    pub rollout: u8,
    pub archive: Archive,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub channel: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub releases: Vec<Release>,
    pub revoked: Vec<Version>,
}
pub fn verify(
    bytes: &[u8],
    signature: &str,
    config: &Config,
    now: DateTime<Utc>,
) -> Result<Manifest, String> {
    let signature =
        minisign_verify::Signature::decode(signature).map_err(|_| "Invalid signature")?;
    if !config.public_keys.iter().any(|key| {
        minisign_verify::PublicKey::from_base64(key)
            .is_ok_and(|key| key.verify(bytes, &signature, false).is_ok())
    }) {
        return Err("Untrusted manifest".into());
    }
    let manifest: Manifest = serde_json::from_slice(bytes).map_err(|_| "Malformed manifest")?;
    if manifest.schema != 1
        || manifest.channel != config.channel
        || manifest.expires_at <= now
        || manifest.created_at > now
        || manifest.created_at >= manifest.expires_at
    {
        return Err("Invalid manifest schema, channel or validity period".into());
    }
    let mut versions = std::collections::HashSet::new();
    for release in &manifest.releases {
        https(&release.archive.url)?;
        if release.rollout > 100
            || release.archive.size == 0
            || release.archive.size > MAX_ARCHIVE
            || release.archive.sha256.len() != 64
            || !release
                .archive
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || !versions.insert(&release.version)
        {
            return Err("Malformed release".into());
        }
    }
    Ok(manifest)
}
pub fn bucket(install_id: &str, version: &Version) -> u8 {
    Sha256::digest(format!("{install_id}{version}").as_bytes())
        .iter()
        .fold(0u32, |n, b| (n * 256 + u32::from(*b)) % 100) as u8
}
pub fn eligible<'a>(
    manifest: &'a Manifest,
    installed: &Version,
    watermark: &Version,
    shell: &Version,
    install_id: &str,
) -> Option<&'a Release> {
    manifest
        .releases
        .iter()
        .filter(|r| {
            r.version.cmp_precedence(installed).is_gt()
                && r.version.cmp_precedence(watermark).is_gt()
                && !r.min_shell_version.cmp_precedence(shell).is_gt()
                && !manifest.revoked.contains(&r.version)
                && bucket(install_id, &r.version) < r.rollout
        })
        .max_by(|a, b| a.version.cmp_precedence(&b.version))
}
