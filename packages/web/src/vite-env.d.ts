/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' in the simulator build. Set by the build script, not by a user. */
  readonly VITE_SIMULATOR?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
