use crate::models::*;
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::{io, sync::Mutex};
use tauri::{AppHandle, Manager, Runtime, plugin::PluginApi};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Native<R>> {
    Ok(Native {
        app: app.clone(),
        lock: Mutex::new(()),
    })
}
pub struct Native<R: Runtime> {
    app: AppHandle<R>,
    lock: Mutex<()>,
}
fn error(message: &str) -> io::Error {
    io::Error::other(message)
}

// Keep only a small encryption key in the OS credential store. Windows credential
// entries cannot hold a full OAuth token response, which can exceed its size limit.
impl<R: Runtime> Native<R> {
    pub fn call(&self, method: &str, payload: NativeRequest) -> crate::Result<NativeResponse> {
        // Desktop shows no system notification yet; the open window already shows the result.
        if method == "background" || method == "notify" {
            return Ok(NativeResponse::default());
        }
        let _guard = self
            .lock
            .lock()
            .map_err(|_| error("Credential store unavailable"))?;
        let name = payload.key.ok_or_else(|| error("Missing credential key"))?;
        if name.is_empty() || name.len() > 256 {
            return Err(error("Invalid credential key").into());
        }
        let directory = self
            .app
            .path()
            .app_data_dir()
            .map_err(|_| error("App storage unavailable"))?
            .join("credentials-v1");
        let path = directory.join(format!("{:x}", Sha256::digest(name.as_bytes())));
        if method == "secureGet" && !path.exists() {
            return Ok(NativeResponse::default());
        }
        let entry = keyring::Entry::new(&self.app.config().identifier, "credential-encryption-v1")
            .map_err(|_| error("Credential store unavailable"))?;
        let key = match entry.get_password() {
            Ok(key) => STANDARD
                .decode(key)
                .map_err(|_| error("Invalid credential encryption key"))?,
            Err(keyring::Error::NoEntry) if method == "securePut" => {
                let key = Aes256Gcm::generate_key(OsRng);
                entry
                    .set_password(&STANDARD.encode(key))
                    .map_err(|_| error("Could not save encryption key"))?;
                key.to_vec()
            }
            _ => return Err(error("Could not read credential encryption key").into()),
        };
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| error("Invalid credential encryption key"))?;
        let value = match method {
            "secureGet" => {
                let bytes = std::fs::read(&path)?;
                Some(open(&cipher, &name, &bytes)?)
            }
            "securePut" => {
                let value = payload
                    .value
                    .ok_or_else(|| error("Missing credential value"))?;
                if value.len() > 262144 {
                    return Err(error("Credential value too large").into());
                }
                let bytes = seal(&cipher, &name, &value)?;
                std::fs::create_dir_all(&directory)?;
                let temporary = path.with_extension("tmp");
                use std::io::Write;
                let mut options = std::fs::OpenOptions::new();
                options.create(true).truncate(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut file = options.open(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&temporary, &path)?;
                None
            }
            _ => return Err(error("Unknown native command").into()),
        };
        Ok(NativeResponse { value })
    }
}
fn seal(cipher: &Aes256Gcm, name: &str, value: &str) -> io::Result<Vec<u8>> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: value.as_bytes(),
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| error("Could not encrypt credential"))?;
    Ok([nonce.as_slice(), encrypted.as_slice()].concat())
}
fn open(cipher: &Aes256Gcm, name: &str, bytes: &[u8]) -> io::Result<String> {
    if bytes.len() < 28 || bytes.len() > 262172 {
        return Err(error("Invalid credential data"));
    }
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| error("Could not decrypt credential"))?;
    String::from_utf8(plaintext).map_err(|_| error("Invalid credential data"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn large_credentials_roundtrip_and_reject_tampering() {
        let cipher = Aes256Gcm::new(&Aes256Gcm::generate_key(OsRng));
        let value = "token".repeat(4000);
        let mut bytes = seal(&cipher, "session", &value).unwrap();
        assert_eq!(open(&cipher, "session", &bytes).unwrap(), value);
        assert!(open(&cipher, "different-session", &bytes).is_err());
        bytes[20] ^= 1;
        assert!(open(&cipher, "session", &bytes).is_err());
        assert!(open(&cipher, "session", &[0; 12]).is_err());
    }
}
