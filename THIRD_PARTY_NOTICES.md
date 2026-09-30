# Third-party notices

## Runtime dependencies

- just-bash, Vercel Labs: Apache-2.0. Provides the browser shell and in-memory filesystem semantics. See its license in the installed package and https://github.com/vercel-labs/just-bash.
- Ajv: MIT. Provides tool input-schema validation. See its license in the installed package and https://github.com/ajv-validator/ajv.

The locked dependency tree includes additional packages and their respective notices. The production worker is bundled from those sources. `dist/THIRD_PARTY_LICENSES.txt` accompanies distributed builds with runtime dependency licenses and esbuild's extracted legal comments.

## Kinetik visual language

`src/ui/tokens.css` is adapted from Kineto's `cloud/charms-widget/src/styles.css`. `src/ui/icons.ts` reuses the file, folder, action, and skill icon paths from `cloud/charms-widget/src/ui/icons.ts`, with matching strokes for additional controls. `public/icon.svg` uses the mascot from `cloud/charms-widget/src/components/BrandMark.tsx`, at commit `abfb798cbfacd5d74b7985faf1a736298bce181e`. Reused at the owner's direction for this Kinetik project. Copyright Kineto; retained under this project's license. The license does not grant rights to use Kineto or Kinetik trademarks to imply endorsement.
