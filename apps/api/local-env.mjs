import { loadEnvFile } from 'node:process';
import { URL } from 'node:url';

export function loadLocalEnv(path = new URL('.env', import.meta.url)) {
  try {
    loadEnvFile(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
