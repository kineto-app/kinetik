use super::{
    Result, download,
    state::{Bundle, Source, State},
};
use std::{fs, path::Path};
pub struct Loaded {
    pub state: State,
    pub recovered: bool,
}
pub fn load(root: &Path, embedded: &Bundle) -> Result<Loaded> {
    let mut copies = Vec::new();
    let mut damaged = false;
    for name in ["state.json", "state.backup.json"] {
        match fs::read(root.join(name)) {
            Ok(bytes) => match serde_json::from_slice::<State>(&bytes) {
                Ok(state) => copies.push((name, state)),
                Err(_) => {
                    damaged = true;
                    // Keep the original until a recovered copy has been durably committed.
                    download::atomic_write(
                        &root.join(format!("state.corrupt-{}.json", uuid::Uuid::new_v4())),
                        &bytes,
                    )?;
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    if copies.is_empty() {
        let artifacts = fs::read_dir(root)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .any(|entry| {
                let name = entry.file_name().to_string_lossy().to_string();
                name.starts_with("state.corrupt-") || name == "versions" || name == "snapshots"
            });
        if damaged || artifacts {
            return Err("No trustworthy update state remains".into());
        }
        return Ok(Loaded {
            state: State::new(embedded.clone()),
            recovered: false,
        });
    }
    copies.sort_by_key(|(_, s)| s.generation);
    let (name, mut state) = copies.pop().unwrap();
    let recovered = damaged
        || (name != "state.json"
            && !copies
                .iter()
                .any(|(n, s)| *n == "state.json" && s.generation == state.generation));
    // Older state did not record provenance. Prefer existing downloaded assets; otherwise
    // embedded identity requires both version and format. Unknown identities stay unavailable.
    for bundle in std::iter::once(&mut state.active).chain(state.previous.iter_mut()) {
        if bundle.source == Source::Unknown {
            if root
                .join("versions")
                .join(bundle.version.to_string())
                .join("index.html")
                .is_file()
            {
                bundle.source = Source::Downloaded;
            } else if bundle.version == embedded.version
                && bundle.data_format == embedded.data_format
            {
                bundle.source = Source::Embedded;
            }
        }
    }
    if state.snapshot_bundle.is_none() {
        state.snapshot_bundle = state
            .previous
            .as_ref()
            .filter(|bundle| state.snapshot.as_ref() == Some(&bundle.version))
            .cloned();
    }
    Ok(Loaded { state, recovered })
}
pub fn commit(root: &Path, state: &State) -> Result<()> {
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    // The backup is the same generation, not yesterday's consent or watermark.
    download::atomic_write(&root.join("state.backup.json"), &bytes)?;
    download::atomic_write(&root.join("state.json"), &bytes)
}
