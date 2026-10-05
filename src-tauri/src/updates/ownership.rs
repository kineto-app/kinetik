use std::{
    fs::{File, OpenOptions},
    path::Path,
};
pub fn acquire(root: &Path) -> Result<File, String> {
    super::durability::create_dir_all(root)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("workspace.lock"))
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|_| "Another Kinetik process owns this workspace".to_string())?;
    Ok(file)
}
