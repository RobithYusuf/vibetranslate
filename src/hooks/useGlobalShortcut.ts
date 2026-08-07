import { useEffect, useState, useRef } from 'react';
import {
  register,
  unregister,
  isRegistered,
} from '@tauri-apps/plugin-global-shortcut';

interface UseGlobalShortcutOptions {
  shortcut: string;
  onTrigger: () => void;
  enabled?: boolean;
}

// A standalone function key (F1–F24) is a valid global hotkey on its own.
const isFunctionKey = (s: string) => /^F([1-9]|1[0-9]|2[0-4])$/i.test(s.trim());

// Validate shortcut format
function isValidShortcut(shortcut: string): boolean {
  if (!shortcut) return false;
  const invalidChars = /[´`~§±]/;
  if (invalidChars.test(shortcut)) return false;
  const parts = shortcut.split('+');
  // Allow a single function key (e.g. "F5"); otherwise require modifier + key.
  if (parts.length < 2) return isFunctionKey(shortcut);
  return shortcut.length >= 3;
}

// Global registry to track all registered shortcuts across hook instances
const globalRegistry = new Map<string, boolean>();

export function useGlobalShortcut({
  shortcut,
  onTrigger,
  enabled = true,
}: UseGlobalShortcutOptions) {
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  
  // Use ref for callback to avoid re-registration
  const onTriggerRef = useRef(onTrigger);
  const lastShortcutRef = useRef<string | null>(null);
  
  // Update callback ref
  useEffect(() => {
    onTriggerRef.current = onTrigger;
  }, [onTrigger]);

  useEffect(() => {
    // If disabled, unregister the shortcut
    if (!enabled) {
      const doUnregister = async () => {
        if (lastShortcutRef.current && globalRegistry.get(lastShortcutRef.current)) {
          try {
            console.log(`🔴 [Shortcut] Disabling: ${lastShortcutRef.current}`);
            await unregister(lastShortcutRef.current);
            globalRegistry.delete(lastShortcutRef.current);
            console.log(`✅ [Shortcut] Disabled OK: ${lastShortcutRef.current}`);
          } catch (err) {
            console.error(`❌ [Shortcut] Disable failed:`, err);
          }
        }
        setIsActive(false);
      };
      doUnregister();
      return;
    }

    // Skip if invalid shortcut
    if (!isValidShortcut(shortcut)) {
      setIsActive(false);
      return;
    }

    // Skip if already registered with same shortcut
    if (lastShortcutRef.current === shortcut && globalRegistry.get(shortcut)) {
      return;
    }

    const doRegister = async () => {
      try {
        // Unregister old shortcut if changed
        if (lastShortcutRef.current && lastShortcutRef.current !== shortcut) {
          try {
            await unregister(lastShortcutRef.current);
            globalRegistry.delete(lastShortcutRef.current);
          } catch {
            // Ignore
          }
        }

        // Skip if already globally registered
        if (globalRegistry.get(shortcut)) {
          lastShortcutRef.current = shortcut;
          setIsActive(true);
          return;
        }

        // Try to unregister if somehow still registered
        const alreadyReg = await isRegistered(shortcut).catch(() => false);
        if (alreadyReg) {
          await unregister(shortcut).catch(() => {});
        }

        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        console.log(`🔑 [Shortcut] Registering: ${shortcut} on ${isMac ? 'macOS' : 'Windows'}`);
        
        await register(shortcut, (event) => {
          if (event.state === 'Pressed') {
            console.log(`⚡ [Shortcut] Triggered: ${shortcut}`);
            onTriggerRef.current();
          }
        });

        lastShortcutRef.current = shortcut;
        globalRegistry.set(shortcut, true);
        console.log(`✅ [Shortcut] Registered OK: ${shortcut}`);
        setIsActive(true);
        setError(null);
      } catch (err) {
        console.error(`❌ [Shortcut] FAILED: ${shortcut}`, err);
        setError(err as Error);
        setIsActive(false);
      }
    };

    doRegister();
    
    // NO cleanup - let shortcuts persist until explicitly changed
  }, [shortcut, enabled]);

  return { isActive, error };
}
