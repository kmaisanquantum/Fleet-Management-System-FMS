/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPTILER_KEY?: string;
  readonly VITE_CARTO_API_KEY?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_MESHSAT_MAP_URL?: string;
  readonly VITE_IDLE_TIMEOUT_MINUTES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
