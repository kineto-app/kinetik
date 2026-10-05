use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub manifest_url: String,
    pub channel: String,
    pub public_keys: Vec<String>,
    pub health_url: Option<String>,
}
pub fn https(value: &str) -> Result<(), String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid update URL")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Updates require HTTPS URLs without credentials or fragments".into());
    }
    Ok(())
}
impl Config {
    pub fn validate(&self) -> Result<(), String> {
        https(&self.manifest_url)?;
        if let Some(url) = &self.health_url {
            https(url)?;
        }
        if self.channel.is_empty()
            || self.channel.len() > 100
            || self.public_keys.len() != 2
            || self.public_keys[0] == self.public_keys[1]
        {
            return Err("Updates require a channel and two distinct trusted keys".into());
        }
        for key in &self.public_keys {
            minisign_verify::PublicKey::from_base64(key)
                .map_err(|_| "Invalid update public key")?;
        }
        Ok(())
    }
}
