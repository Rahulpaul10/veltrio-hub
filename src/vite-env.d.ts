/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SITE_DOMAIN?: string
  readonly VITE_RPC_URLS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
