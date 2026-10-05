use std::{
    borrow::Cow,
    path::{Component, PathBuf},
    sync::{Arc, OnceLock},
};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

pub type Source = Arc<OnceLock<Option<PathBuf>>>;
pub struct BundleAssets<R: Runtime> {
    pub embedded: Box<dyn Assets<R>>,
    pub source: Source,
}
impl<R: Runtime> Assets<R> for BundleAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.embedded.setup(app);
    }
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(Some(root)) = self.source.get() {
            let key = key.as_ref().trim_start_matches('/');
            if key.is_empty()
                || key.contains(['\\', ':'])
                || std::path::Path::new(key)
                    .components()
                    .any(|c| !matches!(c, Component::Normal(_)))
            {
                return None;
            }
            // Never mix downloaded code with files from another embedded release.
            return std::fs::read(root.join(key)).ok().map(Cow::Owned);
        }
        self.embedded.get(key)
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }
    fn csp_hashes(&self, key: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        if matches!(self.source.get(), Some(Some(_))) {
            Box::new(std::iter::empty())
        } else {
            self.embedded.csp_hashes(key)
        }
    }
}
pub struct Empty;
impl<R: Runtime> Assets<R> for Empty {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
