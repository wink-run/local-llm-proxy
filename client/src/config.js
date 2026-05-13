export const DEFAULT_SERVER_URL = 'http://81.70.249.144:8000';

export function getServerUrl() {
  return localStorage.getItem('serverUrl') || DEFAULT_SERVER_URL;
}
