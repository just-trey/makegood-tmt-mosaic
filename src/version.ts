export function getAppVersion(version: string | undefined): string {
  return version && version !== '' ? version : 'dev';
}
