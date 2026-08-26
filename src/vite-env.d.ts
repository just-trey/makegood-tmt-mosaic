// Injected by vite.config.ts's `define` from package.json's "version" field,
// so the UI version tag can't drift out of sync with the package version.
declare const __APP_VERSION__: string;

// Formspree form URL, injected by vite.config.ts's `define` from FEEDBACK_ENDPOINT. Empty in a
// fork or an unconfigured build, where the feedback widget then renders nothing.
declare const __FEEDBACK_ENDPOINT__: string;
