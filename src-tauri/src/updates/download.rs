use super::{durability, manifest::Archive};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path},
};

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|e| e.to_string())
}
pub async fn fetch(client: &reqwest::Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() || response.content_length().is_some_and(|n| n > limit) {
        return Err("Invalid update response".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("Update exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub fn unpack(bytes: &[u8], archive: &Archive, destination: &Path) -> Result<(), String> {
    if bytes.len() as u64 != archive.size
        || format!("{:x}", Sha256::digest(bytes)) != archive.sha256.to_lowercase()
    {
        return Err("Archive size or SHA-256 mismatch".into());
    }
    let parent = destination.parent().ok_or("Missing version directory")?;
    durability::create_dir_all(parent)?;
    let temp = tempfile::tempdir_in(parent).map_err(|e| e.to_string())?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(bytes));
    let mut total = 0u64;
    let mut count = 0usize;
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path.as_os_str().is_empty()
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || path.to_string_lossy().contains(['\\', ':'])
        {
            return Err("Unsafe archive path".into());
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err("Archive contains a link or special file".into());
        }
        total = total.checked_add(entry.size()).ok_or("Archive too large")?;
        count += 1;
        if total > 256 * 1024 * 1024 || count > 10000 {
            return Err("Archive exceeds extraction limits".into());
        }
        let output = temp.path().join(path);
        if kind.is_dir() {
            fs::create_dir_all(output).map_err(|e| e.to_string())?;
        } else {
            fs::create_dir_all(output.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(output)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;
            file.flush()
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
        }
    }
    // Consume the gzip trailer so CRC/truncation failures cannot become staged releases.
    let mut decoder = tar.into_inner();
    let mut tail = Vec::new();
    decoder
        .by_ref()
        .take(1024 * 1024)
        .read_to_end(&mut tail)
        .map_err(|e| e.to_string())?;
    if tail.len() >= 1024 * 1024
        || tail.iter().any(|b| *b != 0)
        || !temp.path().join("index.html").is_file()
    {
        return Err("Invalid bundle contents".into());
    }
    durability::sync_tree(temp.path())?;
    durability::rename(temp.path(), destination)?;
    Ok(())
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    durability::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    let temp_path = file.into_temp_path();
    durability::rename(&temp_path, path)?;
    Ok(())
}
