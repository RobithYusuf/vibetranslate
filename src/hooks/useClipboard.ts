import { useCallback } from 'react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';

export function useClipboard() {
  const read = useCallback(async (): Promise<string> => {
    try {
      const text = await readText();
      return text || '';
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      return '';
    }
  }, []);

  const write = useCallback(async (text: string): Promise<boolean> => {
    try {
      await writeText(text);
      return true;
    } catch (error) {
      console.error('Failed to write clipboard:', error);
      return false;
    }
  }, []);

  return { read, write };
}
