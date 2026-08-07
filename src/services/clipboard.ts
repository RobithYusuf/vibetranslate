import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

export async function getClipboardText(): Promise<string> {
  try {
    const text = await readText();
    return text || '';
  } catch (error) {
    console.error('Failed to read clipboard:', error);
    return '';
  }
}

export async function setClipboardText(text: string): Promise<void> {
  await writeText(text);
}
