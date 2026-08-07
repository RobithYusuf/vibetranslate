import { load, Store } from '@tauri-apps/plugin-store';
import { Settings } from '@/types';

const STORE_PATH = 'settings.json';

let store: Store | null = null;

async function getStore(): Promise<Store> {
  if (!store) {
    store = await load(STORE_PATH);
  }
  return store;
}

export async function loadSettings(): Promise<Settings | null> {
  try {
    const s = await getStore();
    const settings = await s.get<Settings>('settings');
    return settings || null;
  } catch (error) {
    console.error('Failed to load settings:', error);
    return null;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    const s = await getStore();
    await s.set('settings', settings);
    await s.save();
  } catch (error) {
    console.error('Failed to save settings:', error);
    throw error;
  }
}

export async function clearSettings(): Promise<void> {
  try {
    const s = await getStore();
    await s.clear();
    await s.save();
  } catch (error) {
    console.error('Failed to clear settings:', error);
  }
}
