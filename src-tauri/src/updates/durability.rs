use super::Result;
use std::path::Path;
#[cfg(test)]
thread_local! { static FAIL: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) }; }
#[cfg(test)]
pub fn fail_next_parent_sync(name: &str) {
    FAIL.with(|f| *f.borrow_mut() = Some(name.into()));
}
pub fn sync_parent(path: &Path) -> Result<()> {
    #[cfg(test)]
    if FAIL.with(|f| {
        let mut next = f.borrow_mut();
        if next.as_deref() == path.file_name().and_then(|n| n.to_str()) {
            next.take();
            true
        } else {
            false
        }
    }) {
        return Err("Injected parent sync failure".into());
    }
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("No parent directory")?)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn create_dir_all(path: &Path) -> Result<()> {
    if path.is_dir() {
        return Ok(());
    }
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        create_dir_all(parent)?;
    }
    std::fs::create_dir(path).map_err(|e| e.to_string())?;
    sync_parent(path)
}
pub fn sync_tree(path: &Path) -> Result<()> {
    for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            sync_tree(&entry.path())?;
        }
    }
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn rename(from: &Path, to: &Path) -> Result<()> {
    #[cfg(not(windows))]
    std::fs::rename(from, to).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // Windows has no directory fsync; request a write-through metadata move instead.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    sync_parent(to)?;
    if from.parent() != to.parent() {
        sync_parent(from)?;
    }
    Ok(())
}
