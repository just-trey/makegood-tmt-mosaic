declare global {
  interface Window {
    umami?: { track: (event: string, data?: Record<string, unknown>) => void };
  }
}

export type EventProps = Record<string, string | number | boolean>;

export function track(event: string, props?: EventProps): void {
  window.umami?.track(event, props);
}
