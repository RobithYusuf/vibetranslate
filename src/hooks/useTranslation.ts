import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { useAppStore } from '@/stores/appStore';
import { useClipboard } from './useClipboard';
import { useKeyboard } from './useKeyboard';
import { translateText, enhanceText } from '@/services/openai';
import { AI_PROVIDERS, MAX_TRANSLATE_CHARS } from '@/utils/constants';
import { captureForegroundHwnd, getTerminalSelection, simulateTerminalCopy, debugTerminalInfo } from '@/services/keyboard';

// Debug mode - set to false in production to hide sensitive logs
const DEBUG_MODE = import.meta.env.DEV;

// Safe logging - only shows content in dev mode, shows length in production
function logContent(tag: string, label: string, content: string | null | undefined) {
  if (!content) {
    console.log(`[${tag}] ${label}: (empty)`);
  } else if (DEBUG_MODE) {
    console.log(`[${tag}] ${label}: "${content.substring(0, 50)}..." (${content.length} chars)`);
  } else {
    console.log(`[${tag}] ${label}: ${content.length} chars`);
  }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Poll the clipboard until it no longer holds `unchanged` (the macOS sentinel or the
// pre-copy content). A fixed post-copy sleep raced busy apps — under load (streaming +
// OBS, Chrome's PDF viewer) the copy can land well after 300ms, which read as "copy
// produced nothing" even though it succeeded a moment later. Polling returns the instant
// the copy lands and only pays the full timeout when nothing was copied at all.
async function waitClipboardChange(
  read: () => Promise<string>,
  unchanged: string | null,
  timeoutMs: number
): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    let text = '';
    try { text = await read(); } catch { /* transient read failure - keep polling */ }
    if (text && text !== unchanged && text.trim()) return text;
    if (performance.now() >= deadline) return text;
    await sleep(100);
  }
}

// Map a raw failure to an ACTIONABLE notification: a clear title/body for the system
// notification, and a short `hint` shown on the loading overlay (which is always visible and
// needs no OS notification permission — system notifications alone are easily missed/denied).
// For missing Accessibility permission, also open the exact System Settings pane (once per
// session) so the user lands where the fix is.
let accessibilityPaneOpened = false;
async function reportFailure(context: 'Translation' | 'Enhance', msg: string): Promise<string> {
  let title = `${context} Failed`;
  let body = msg.substring(0, 120);
  let hint = 'Failed';
  if (/accessibility permission|not allowed assistive/i.test(msg)) {
    title = 'Permission Required';
    body = 'Enable VibeTranslate in System Settings › Privacy & Security › Accessibility, then try again.';
    hint = 'Accessibility permission needed';
    if (!accessibilityPaneOpened) {
      accessibilityPaneOpened = true;
      try { await invoke('open_accessibility_settings'); } catch { /* */ }
    }
  } else if (/server unavailable|unreachable|failed to fetch|load failed|network error|timed? ?out/i.test(msg)) {
    title = 'Server Unreachable';
    body = "The translation server can't be reached. Check your connection, or set your own API key in Settings.";
    hint = 'Server unreachable';
  } else if (/terminal replace failed|paste failed/i.test(msg)) {
    title = 'Paste Failed';
    hint = 'Paste failed';
  } else if (/copy failed/i.test(msg)) {
    title = 'Copy Failed';
    hint = 'Copy failed';
  }
  await notify(title, body);
  return hint;
}

// No engine configured is a setup problem, not a runtime failure, so it gets its own path.
// It also happens BEFORE the loading overlay is shown, which is why this puts one up itself:
// the old code called setError() into a store no mounted component renders, and release
// builds strip console.error — so pressing the shortcut on a fresh install did nothing at
// all, visibly indistinguishable from a broken app.
async function reportMissingEngine(loadingEnabled: boolean): Promise<void> {
  await notify(
    'No translation engine selected',
    'Open Settings and choose Free (built-in), or add your own API key.',
  );
  if (!loadingEnabled) return;
  try {
    await invoke('show_loading', { x: null, y: null });
    await emit('loading-status', { status: 'error', message: 'No engine — open Settings' });
    await sleep(2200);
    await invoke('hide_loading');
  } catch { /* */ }
}

// Send system notification for errors/warnings
async function notify(title: string, body: string) {
  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }
    if (permissionGranted) {
      // Prepend app name to title for clarity (especially in dev mode)
      sendNotification({ title: `VibeTranslate: ${title}`, body });
    }
  } catch (e) {
    console.warn('[Notify] Failed to send notification:', e);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// Platform detection (cached at module level to avoid repeated checks)
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0;
const PLATFORM = IS_MAC ? 'macOS' : 'Windows';

// Terminal app patterns for detection
const TERMINAL_PATTERNS = ['powershell', 'cmd', 'terminal', 'command prompt', 'conhost'];

/**
 * Detects if the captured app is a terminal application.
 * Used to determine if terminal-specific copy/paste methods should be used.
 */
// macOS terminal apps (by frontmost-process name).
const MAC_TERMINAL_PATTERNS = ['terminal', 'iterm', 'warp', 'alacritty', 'kitty', 'wezterm', 'hyper', 'tabby', 'ghostty', 'orca'];
function isMacTerminalApp(capturedApp: string): boolean {
  const appLower = capturedApp.toLowerCase();
  return MAC_TERMINAL_PATTERNS.some(pattern => appLower.includes(pattern));
}

// Terminal detection for BOTH platforms. In a terminal, plain paste can't replace the selection
// (it just types at the cursor → duplicated text), so replace mode auto-routes to the terminal
// strategy (clear the input line, then paste). The dedicated terminal shortcut stays as a manual
// override for terminals this list doesn't recognize.
function isTerminalApp(capturedApp: string): boolean {
  if (IS_MAC) return isMacTerminalApp(capturedApp);
  const appLower = capturedApp.toLowerCase();
  return TERMINAL_PATTERNS.some(pattern => appLower.includes(pattern));
}

// Terminal paste-injection guard. The text we paste is an LLM translation of arbitrary
// (untrusted, possibly prompt-injected) source, and a terminal without bracketed-paste
// protection executes an embedded newline as a command. For terminal mode only, flatten
// newlines to spaces and strip other control chars. Normal paste keeps full formatting.
function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

/**
 * Detects the type of app for translation behavior.
 * Returns:
 * - 'non_replaceable': Cannot paste (PDF, image viewer, etc.) → force popup
 * - 'browser_editable': Browser with editable pattern (AI chat, docs) → try replace with fallback
 * - 'browser_readonly': Browser viewing article → force popup
 * - 'messaging_app': WhatsApp, Telegram, etc. → try replace with verification fallback
 * - 'replaceable': Normal app that supports replace
 */
type AppType = 'non_replaceable' | 'browser_editable' | 'browser_readonly' | 'messaging_app' | 'replaceable';

function detectAppType(capturedApp: string): { type: AppType; reason: string } {
  const appLower = capturedApp.toLowerCase();
  
  // PDF readers - selection is never replaceable
  const pdfReaders = ['acrobat', 'pdf', 'foxit', 'sumatra', 'evince'];
  if (pdfReaders.some(p => appLower.includes(p))) {
    return {
      type: 'non_replaceable',
      reason: 'PDF reader - text cannot be replaced. Use Popup mode (Ctrl+Alt+P) instead.'
    };
  }
  
  // Image viewers
  const imageViewers = ['photos', 'irfanview', 'xnview', 'picasa', 'lightroom'];
  if (imageViewers.some(v => appLower.includes(v))) {
    return {
      type: 'non_replaceable',
      reason: 'Image viewer - no text to replace. Use Popup mode.'
    };
  }
  
  // Media players
  const mediaPlayers = ['vlc', 'mpv', 'media player', 'spotify', 'youtube'];
  if (mediaPlayers.some(m => appLower.includes(m))) {
    return {
      type: 'non_replaceable',
      reason: 'Media player - no text to replace. Use Popup mode.'
    };
  }
  
  // Messaging apps - try replace first, fallback to popup if it fails
  // Some messaging apps lose selection after copy (chat history), but text input fields work fine
  const messagingApps = ['whatsapp', 'telegram', 'discord', 'slack', 'messenger', 'signal', 'line', 'wechat'];
  if (messagingApps.some(m => appLower.includes(m))) {
    return {
      type: 'messaging_app',
      reason: 'Messaging app - will try replace, fallback to popup if selection lost.'
    };
  }
  
  // Web browsers detection
  const browsers = ['chrome', 'firefox', 'edge', 'brave', 'opera', 'safari', 'vivaldi', 'arc'];
  const isBrowser = browsers.some(b => appLower.includes(b));
  
  if (isBrowser) {
    // Check if browser window title suggests editable content
    const editablePatterns = [
      'compose', 'edit', 'write', 'draft', 'new message', 'reply',
      'docs.google', 'notion', 'mail', 'gmail', 'outlook', 'email',
      // AI chat interfaces - these have editable prompt boxes
      'chatgpt', 'claude', 'gemini', 'bard', 'copilot', 'perplexity',
      'openai', 'anthropic', 'chat.openai', 'poe.com', 'you.com',
      'aistudio', 'ai studio', 'deepseek', 'mistral', 'huggingface',
      // Code editors / IDEs in browser
      'codepen', 'codesandbox', 'stackblitz', 'replit', 'github.dev',
      'vscode', 'codespace'
    ];
    
    if (editablePatterns.some(p => appLower.includes(p))) {
      return {
        type: 'browser_editable',
        reason: 'Browser with editable content - will try replace with fallback to popup.'
      };
    }
    
    return {
      type: 'browser_readonly',
      reason: 'Browser viewing article - text cannot be replaced. Use Popup mode (Ctrl+Alt+P) instead.'
    };
  }
  
  return { type: 'replaceable', reason: '' };
}

export function useTranslation() {
  const { read: readClipboard, write: writeClipboard } = useClipboard();
  const { simulateCopy, simulatePaste } = useKeyboard();

  const {
    apiKeys,
    provider,
    model,
    customBaseURL,
    customModel,
    sourceLang,
    targetLang,
    isTranslating,
    translationStatus,
    currentTranslation,
    error,
    soundEnabled,
    loadingEnabled,
    setTranslating,
    setEnhancing,
    setTranslationStatus,
    setTranslation,
    setError,
    reset,
    setAbortController,
  } = useAppStore();
  
  const apiKey = apiKeys[provider];
  const isServerProvider = AI_PROVIDERS[provider]?.isServer;
  const hasValidKey = !!apiKey || isServerProvider;

  // Test API Key
  const testApiKey = useCallback(async () => {
    console.log('[Test] Testing API key...');
    if (!hasValidKey) {
      console.error('[Test] No API key set!');
      return { success: false, error: 'No API key' };
    }
    try {
      const result = await translateText({
        text: 'Hello',
        sourceLang: 'en',
        targetLang: 'id',
        apiKey: apiKey || '',
        provider,
        model: (provider === 'custom' ? customModel : model) === 'auto' ? undefined : (provider === 'custom' ? customModel : model),
        baseURL: provider === 'custom' ? customBaseURL : undefined,
      });
      console.log(`[Test] API Key OK! (${result.translatedText.length} chars returned)`);
      return { success: true, result: result.translatedText };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Test] API Key failed:', msg);
      return { success: false, error: msg };
    }
  }, [apiKey, provider, model, hasValidKey]);

  // Test Clipboard Read
  const testClipboard = useCallback(async () => {
    console.log('[Test] Reading clipboard...');
    try {
      const text = await readClipboard();
      logContent('Test', 'Clipboard content', text);
      return { success: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Test] Clipboard read failed:', msg);
      return { success: false, error: msg };
    }
  }, [readClipboard]);

  // Test Simulate Copy
  const testSimulateCopy = useCallback(async () => {
    console.log('[Test] Testing simulate copy (AppleScript)...');
    try {
      await simulateCopy();
      console.log('[Test] Simulate copy OK!');
      await sleep(200);
      const text = await readClipboard();
      logContent('Test', 'Copied text', text);
      return { success: true, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Test] Simulate copy failed:', msg);
      return { success: false, error: msg };
    }
  }, [simulateCopy, readClipboard]);

  // Translate from clipboard (no simulate copy)
  const translateFromClipboard = useCallback(async () => {
    console.log('[Translate] Starting from clipboard...');
    
    if (!hasValidKey) {
      console.error('[Translate] No API key!');
      setError('No API key');
      return;
    }

    if (isTranslating) return;

    setTranslating(true);
    setError(null);

    try {
      console.log('[Translate] Reading clipboard...');
      const textToTranslate = await readClipboard();
      logContent('Translate', 'Text', textToTranslate);

      if (!textToTranslate?.trim()) {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        setError(`Clipboard empty. Copy text first with ${isMac ? 'Cmd+C' : 'Ctrl+C'}`);
        reset();
        return;
      }

      console.log('[Translate] Calling API...');
      setTranslationStatus('translating');
      const result = await translateText({
        text: textToTranslate,
        sourceLang,
        targetLang,
        apiKey: apiKey || '',
        provider,
        model: (provider === 'custom' ? customModel : model) === 'auto' ? undefined : (provider === 'custom' ? customModel : model),
        baseURL: provider === 'custom' ? customBaseURL : undefined,
      });
      logContent('Translate', 'Result', result.translatedText);

      setTranslation({
        original: textToTranslate,
        translated: result.translatedText,
        sourceLang: result.detectedLang || sourceLang,
        targetLang,
      });

      await writeClipboard(result.translatedText);
      setTranslationStatus('done');
      console.log('✅ [Translate] SUCCESS! Result copied to clipboard');

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Translate] ERROR:', msg);
      setError(msg);
      reset();
    } finally {
      setTranslating(false);
    }
  }, [apiKey, provider, model, sourceLang, targetLang, isTranslating, hasValidKey, readClipboard, writeClipboard, setTranslating, setTranslationStatus, setTranslation, setError, reset]);

  // Full translate with simulate copy/paste
  // forcePopup: if true, show popup instead of replacing text
  // forceTerminal: if true, use terminal-specific paste (Ctrl+C to clear, then Ctrl+V)
  const translate = useCallback(async (forcePopup = false, forceTerminal = false) => {
    const effectiveMode = forcePopup ? 'popup' : 'replace';
    
    console.log('🚀 [Translate] ====== START ======');
    console.log(`[Translate] Platform: ${PLATFORM} | Mode: ${effectiveMode}`);
    console.log(`[Translate] Provider: ${provider} | ServerOnly: ${isServerProvider}`);
    
    if (!hasValidKey) {
      console.error('❌ [Translate] ERROR: No API key!');
      setError('No API key');
      await reportMissingEngine(loadingEnabled);
      return;
    }

    if (isTranslating) {
      console.warn('[Translate] Already translating, skipping...');
      return;
    }

    // Create abort controller for cancellation
    const abortController = new AbortController();
    setAbortController(abortController);

    setTranslating(true);
    setEnhancing(false); // Mark as translate operation
    setError(null);

    // IMPORTANT: Hide popup first to prevent focus issues
    // If popup is open, it steals focus and Ctrl+C goes to wrong window
    try {
      await invoke('hide_popup');
    } catch (e) {
      // Ignore - popup might not be open
    }

    // Play start sound for feedback (this doesn't steal focus)
    if (soundEnabled) {
      try {
        await invoke('play_sound', { soundType: 'start' });
      } catch (e) {
        console.warn('[Translate] Could not play sound:', e);
      }
    }

    // IMPORTANT: Do NOT show loading before copy!
    // Loading window steals focus and Ctrl+C goes to wrong window
    
    try {
      setTranslationStatus('copying');
      
      let textToTranslate: string | null = null;
      let gotFromConsoleApi = false;
      
      // Check clipboard BEFORE copy
      const clipboardBefore = await readClipboard();
      logContent('Translate', '▶️ Clipboard BEFORE', clipboardBefore);
      
      // Step 0: Capture foreground HWND FIRST (this must happen before anything else!)
      // The background tracker should have the correct HWND, but we refresh it here
      console.log('▶️ [Translate] Step 0: Capture foreground HWND...');
      let capturedApp = '';
      try {
        capturedApp = await captureForegroundHwnd();
        console.log(`✅ [Translate] Captured foreground: "${capturedApp}"`);
      } catch (e) {
        console.warn('[Translate] Could not capture foreground:', e);
      }

      // Show the loading overlay NOW - instant feedback that the shortcut fired. It is
      // non-activating (focused(false) + overlay level), so it can no longer steal the
      // copy's focus - which was the old reason to defer it until after the copy. On slow
      // copies (long selection, busy terminal) the user used to stare at nothing for 1-2s
      // and assume the shortcut was dead.
      if (loadingEnabled) {
        try {
          await invoke('show_loading', { x: null, y: null });
        } catch (e) {
          console.warn('[Translate] Could not show loading:', e);
        }
      }
      
      // Detect app type for smart handling
      const appDetection = capturedApp ? detectAppType(capturedApp) : { type: 'replaceable' as AppType, reason: '' };
      // Check if target app is non-replaceable (PDF viewers, etc.)
      // For browsers, ALWAYS try replace first - verification will catch failures
      const isBrowser = ['chrome', 'firefox', 'brave', 'safari', 'edge', 'opera', 'arc'].some(
        b => capturedApp.toLowerCase().includes(b)
      );
      
      // Terminal detection - ONLY for replace mode, NOT for popup mode
      // Popup mode just needs to copy text, no special terminal handling needed
      const isTerminal_detected = (effectiveMode === 'replace') ? isTerminalApp(capturedApp) : false;
      
      if (effectiveMode === 'replace' && capturedApp && !isTerminal_detected) {
        if (appDetection.type === 'non_replaceable') {
          // Only force popup for truly non-replaceable apps (PDF, image viewers)
          console.warn(`⚠️ [Translate] Non-replaceable app detected: ${capturedApp}`);
          console.warn(`⚠️ [Translate] Reason: ${appDetection.reason}`);
          await notify('Replace Mode Not Supported', appDetection.reason);
          console.log('[Translate] Switching to Popup mode...');
          return translate(true, false); // forcePopup = true
        }
        // For browsers (readonly or editable), try replace with verification fallback
        if (isBrowser) {
          console.log(`[Translate] Browser detected: ${capturedApp} - will try replace with verification fallback`);
        }
      }
      
      // Terminal mode: ONLY if forced via shortcut OR (replace mode AND detected terminal)
      // Never auto-enable terminal mode for popup - just use normal copy
      const isTerminal = forceTerminal || (effectiveMode === 'replace' && isTerminal_detected);
      if (isTerminal) {
        console.log(`[Translate] Terminal mode ENABLED (forced: ${forceTerminal}, detected: ${isTerminal_detected})`);
        // Debug: Show detailed terminal detection info
        try {
          const debugInfo = await debugTerminalInfo();
          console.log('[Translate] DEBUG TERMINAL:\n' + debugInfo);
        } catch (e) {
          console.warn('[Translate] Debug info failed:', e);
        }
      }
      
      // Step 0b: For terminal mode on Windows, try Console API
      // This uses AttachConsole + GetConsoleSelectionInfo to read selection directly
      // MUST be called AFTER capturing HWND so we know which console to attach to
      if (isTerminal && !IS_MAC) {
        console.log('▶️ [Translate] Step 0b: Trying Console API for terminal selection...');
        try {
          const consoleText = await getTerminalSelection();
          if (consoleText && consoleText.trim()) {
            logContent('Translate', '✅ Console API SUCCESS', consoleText);
            textToTranslate = consoleText;
            gotFromConsoleApi = true;
            // Also write to clipboard so paste will work later
            await writeClipboard(consoleText);
          }
        } catch (consoleErr) {
          const msg = consoleErr instanceof Error ? consoleErr.message : String(consoleErr);
          console.warn(`[Translate] Console API failed (will try Ctrl+C): ${msg}`);
        }
      }
      
      // Step 1: If Console API didn't work, fall back to copy
      if (!gotFromConsoleApi) {
        // For terminal mode on Windows: Use WM_COMMAND to trigger Edit > Copy menu
        // This sends a message to console window to copy selection without keyboard input
        if (isTerminal && !IS_MAC) {
          console.log('▶️ [Translate] Step 1: Terminal mode - using WM_COMMAND copy...');
          try {
            await simulateTerminalCopy();
            console.log('✅ [Translate] Terminal WM_COMMAND copy sent OK');
            
            // Wait for clipboard to update
            console.log('[Translate] Waiting 200ms for clipboard...');
            await sleep(200);
            
            // Read clipboard
            console.log('▶️ [Translate] Step 2: Read clipboard...');
            textToTranslate = await readClipboard();
            logContent('Translate', 'Clipboard AFTER', textToTranslate);
            
            // Retry if unchanged
            if (textToTranslate === clipboardBefore) {
              console.warn('⚠️ [Translate] Clipboard unchanged - retrying WM_COMMAND copy...');
              await simulateTerminalCopy();
              await sleep(200);
              textToTranslate = await readClipboard();
              logContent('Translate', 'Retry result', textToTranslate);
            }
          } catch (copyErr) {
            const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            console.warn(`[Translate] Terminal WM_COMMAND failed: ${msg}, using clipboard directly`);
            // Fallback: use existing clipboard content
            textToTranslate = clipboardBefore;
          }
        } else {
          // For normal apps: use Cmd/Ctrl+C (standard copy).
          console.log('▶️ [Translate] Step 1: Simulate copy...');
          // macOS: write a sentinel FIRST so we can tell "copy did nothing" (stale clipboard →
          // would paste OLD content over the selection — silent data loss) apart from "copy
          // succeeded with text that happens to equal the previous clipboard". The sentinel is
          // overwritten iff the copy actually produced text. (Windows keeps its unchanged-retry.)
          const sentinel = IS_MAC ? `__vt_copy_${Date.now()}__` : null;
          if (sentinel) { try { await writeClipboard(sentinel); } catch { /* */ } }
          try {
            await simulateCopy();
            console.log('✅ [Translate] Copy command sent OK');
          } catch (copyErr) {
            const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            console.error('❌ [Translate] Copy FAILED: ' + msg);
            if (sentinel) { try { await writeClipboard(clipboardBefore); } catch { /* */ } }
            throw new Error(`Copy failed: ${msg}`);
          }

          // Step 2: Poll until the copy lands (fixed sleeps raced busy apps)
          const copyWait = IS_MAC ? 1500 : 800;
          console.log(`▶️ [Translate] Step 2: Waiting for clipboard (up to ${copyWait}ms)...`);
          textToTranslate = await waitClipboardChange(readClipboard, IS_MAC ? sentinel : clipboardBefore, copyWait);
          logContent('Translate', 'Clipboard AFTER', textToTranslate);

          // macOS: still the sentinel → copy produced nothing. Retry once, then restore the
          // original clipboard. In a TERMINAL, "copy produced nothing" usually means the terminal
          // already copied the selection on select (copy-on-select) and rejects synthetic Cmd+C —
          // so the pre-copy clipboard IS the user's selection: use it. For non-terminal apps keep
          // the strict guard (never translate/paste stale content over a document selection).
          if (sentinel && textToTranslate === sentinel) {
            console.warn('⚠️ [Translate] Copy produced nothing - retrying once...');
            await sleep(100);
            await simulateCopy();
            textToTranslate = await waitClipboardChange(readClipboard, sentinel, copyWait);
            if (textToTranslate === sentinel) {
              try { await writeClipboard(clipboardBefore); } catch { /* */ }
              if (isMacTerminalApp(capturedApp) && clipboardBefore?.trim()) {
                console.log('[Translate] Copy produced nothing in a terminal - using the pre-copy clipboard (copy-on-select)');
                textToTranslate = clipboardBefore;
              } else {
                console.error('❌ [Translate] Copy still produced nothing - restoring clipboard');
                textToTranslate = ''; // -> "No text selected" handling below
              }
            }
          }

          // Windows: retry if clipboard unchanged
          if (!IS_MAC && textToTranslate === clipboardBefore) {
            console.warn('⚠️ [Translate] Clipboard unchanged - retrying copy once...');
            await sleep(100);
            await simulateCopy();
            textToTranslate = await waitClipboardChange(readClipboard, clipboardBefore, copyWait);
            logContent('Translate', 'Retry result', textToTranslate);

            if (textToTranslate === clipboardBefore && textToTranslate?.trim()) {
              console.log('[Translate] Clipboard still same - proceeding with existing text');
            }
          }
        }
      }


      if (!textToTranslate?.trim()) {
        console.error('❌ [Translate] ERROR: Clipboard is empty! Nothing was copied.');
        // Provide helpful message based on detected app
        let notifyMessage = 'Please select some text before pressing the shortcut.';
        if (capturedApp) {
          const detection = detectAppType(capturedApp);
          if (detection.type === 'non_replaceable' || detection.type === 'browser_readonly') {
            notifyMessage = 'Text selection not detected. This app may not support copy. Try using Popup mode (Ctrl+Alt+P).';
          }
        }
        await notify('No Text Detected', notifyMessage);
        throw new Error('No text selected');
      }

      // Check character limit
      if (textToTranslate.length > MAX_TRANSLATE_CHARS) {
        console.error(`❌ [Translate] ERROR: Text too long! ${textToTranslate.length} > ${MAX_TRANSLATE_CHARS}`);
        await notify('Text Too Long', `Maximum ${MAX_TRANSLATE_CHARS} characters. Your text has ${textToTranslate.length} characters.`);
        throw new Error(`Text too long (${textToTranslate.length}/${MAX_TRANSLATE_CHARS} chars)`);
      }

      // Step 3: Translate
      console.log('▶️ [Translate] Step 3: API call...');
      setTranslationStatus('translating');
      const result = await translateText({
        text: textToTranslate,
        sourceLang,
        targetLang,
        apiKey: apiKey || '',
        provider,
        model: (provider === 'custom' ? customModel : model) === 'auto' ? undefined : (provider === 'custom' ? customModel : model),
        baseURL: provider === 'custom' ? customBaseURL : undefined,
        signal: abortController.signal,
      });
      logContent('Translate', '✅ API Result', result.translatedText);
      
      // Check if source and target language are the same
      const detectedLang = result.detectedLang || sourceLang;
      if (detectedLang === targetLang || 
          (detectedLang === 'auto' && result.translatedText === textToTranslate)) {
        console.warn(`⚠️ [Translate] Same language detected: ${detectedLang} → ${targetLang}`);
        await notify('Already in Target Language', `Text is already in ${targetLang.toUpperCase()}. No translation needed, or change target language in Settings.`);
      }

      setTranslation({
        original: textToTranslate,
        translated: result.translatedText,
        sourceLang: detectedLang,
        targetLang,
      });

      // Step 4: Write to clipboard. For terminal mode, sanitize first so a newline in the
      // (untrusted) translation can't execute as a command when pasted into a shell.
      console.log('▶️ [Translate] Step 4: Write translated text to clipboard...');
      await writeClipboard(isTerminal ? sanitizeForTerminal(result.translatedText) : result.translatedText);
      console.log('✅ [Translate] Clipboard updated with translation');

      if (effectiveMode === 'replace') {
        if (isTerminal) {
          // Terminal: Send Escape to clear line, then Ctrl+V to paste
          console.log('▶️ [Translate] Step 5: Terminal mode - Escape + Ctrl+V...');
          setTranslationStatus('pasting');
          
          // IMPORTANT: Hide loading BEFORE terminal replace!
          // Otherwise Escape key gets captured by loading overlay's cancel handler
          if (loadingEnabled) {
            console.log('[Translate] Hiding loading before terminal replace...');
            try {
              await invoke('hide_loading');
            } catch (e) {
              console.warn('[Translate] Could not hide loading:', e);
            }
          }
          
          await sleep(150);
          try {
            // clearChars: lets the Rust side backspace the original text away even in prompts
            // whose keymap ignores Ctrl+U (Claude Code mid-task, some AI TUIs).
            await invoke('simulate_terminal_replace', { clearChars: textToTranslate.length });
            console.log('✅ [Translate] Terminal replace OK');
          } catch (pasteErr) {
            const msg = pasteErr instanceof Error ? pasteErr.message : String(pasteErr);
            console.error('❌ [Translate] Terminal replace FAILED: ' + msg);
            throw new Error(`Terminal replace failed: ${msg}`);
          }
        } else {
          // Step 5: Simulate paste
          console.log('▶️ [Translate] Step 5: Simulate paste (Ctrl+V)...');
          setTranslationStatus('pasting');
          await sleep(150);
          try {
            await simulatePaste();
            console.log('✅ [Translate] Paste OK');
            
            // FALLBACK CHECK - verify paste worked for apps that may lose selection
            // Verify for: read-only browser pages and messaging apps
            const needsVerification = (isBrowser && appDetection.type === 'browser_readonly') || appDetection.type === 'messaging_app';
            if (needsVerification) {
              console.log('[Translate] Verifying paste (may lose selection)...');
              await sleep(400);
              await simulateCopy();
              await sleep(300);
              const clipboardAfterPaste = await readClipboard();
              
              // Paste failed if we got the ORIGINAL text back (means nothing was replaced)
              const pasteDefinitelyFailed = clipboardAfterPaste === textToTranslate;
              if (pasteDefinitelyFailed) {
                console.log('[Translate] Paste FAILED - got original text, showing popup');
                await writeClipboard(result.translatedText);
                await invoke('show_popup');
                const { emit } = await import('@tauri-apps/api/event');
                const translationData = {
                  original: textToTranslate,
                  translated: result.translatedText,
                  sourceLang: result.detectedLang || sourceLang,
                  targetLang,
                };
                await sleep(300);
                await emit('translation-result', translationData);
                await sleep(200);
                await emit('translation-result', translationData);
                console.log('✅ [Translate] Fallback to popup');
                setTranslationStatus('done');
                setTranslating(false);
                return;
              } else {
                console.log('[Translate] Paste verification OK');
              }
            } else if (isBrowser) {
              console.log('[Translate] Editable browser field - skipping verification');
            }
          } catch (pasteErr) {
            const msg = pasteErr instanceof Error ? pasteErr.message : String(pasteErr);
            console.error('❌ [Translate] Paste FAILED: ' + msg);
            throw new Error(`Paste failed: ${msg}`);
          }
        }
        console.log('✅ [Translate] ====== REPLACE SUCCESS ======');
        setTranslationStatus('done');
        setTimeout(() => reset(), 2000);
      } else {
        // Popup mode: show popup
        console.log('▶️ [Translate] Step 5: Showing popup window...');
        setTranslationStatus('done');
        await invoke('show_popup');
        
        // Wait for popup to load and set up event listeners
        const { emit } = await import('@tauri-apps/api/event');
        const translationData = {
          original: textToTranslate,
          translated: result.translatedText,
          sourceLang: result.detectedLang || sourceLang,
          targetLang,
        };
        
        // Emit with retry (popup needs time to load)
        await sleep(300);
        await emit('translation-result', translationData);
        await sleep(200);
        await emit('translation-result', translationData);
      }
      
      console.log('✅ [Translate] ====== POPUP SUCCESS ======');
      // Play success sound
      if (soundEnabled) {
        try {
          await invoke('play_sound', { soundType: 'success' });
        } catch (e) {
          console.warn('[Translate] Could not play sound:', e);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled = msg.includes('cancelled') || msg.includes('Cancelled') || abortController.signal.aborted;
      
      if (isCancelled) {
        console.log('⚠️ [Translate] ====== CANCELLED BY USER ======');
        setError('Cancelled');
      } else {
        console.error('❌ [Translate] ====== FAILED ======');
        console.error('❌ [Translate] Error: ' + msg);
        setError(msg);
        // Actionable notification + short reason on the loading overlay (linger so it's readable
        // before finally{} hides it — the overlay needs no OS notification permission).
        const hint = await reportFailure('Translation', msg);
        if (loadingEnabled) {
          try {
            await emit('loading-status', { status: 'error', message: hint });
            await sleep(2200);
          } catch { /* */ }
        }
        // Play error sound only for real errors
        if (soundEnabled) {
          try {
            await invoke('play_sound', { soundType: 'error' });
          } catch (e) {
            console.warn('[Translate] Could not play sound:', e);
          }
        }
      }
      reset();
    } finally {
      // Clear abort controller
      setAbortController(null);
      
      // Hide loading indicator if enabled
      if (loadingEnabled) {
        try {
          await invoke('hide_loading');
        } catch (e) {
          console.warn('[Translate] Could not hide loading:', e);
        }
      }
      
      if (effectiveMode !== 'replace') {
        setTranslating(false);
      }
    }
  }, [apiKey, provider, model, sourceLang, targetLang, isTranslating, hasValidKey, isServerProvider, soundEnabled, loadingEnabled, simulateCopy, simulatePaste, readClipboard, writeClipboard, setTranslating, setEnhancing, setTranslationStatus, setTranslation, setError, reset, setAbortController]);

  // Translate with popup - always shows popup regardless of mode setting
  const translatePopup = useCallback(async () => {
    return translate(true);
  }, [translate]);

  // Translate for terminal - same as normal but uses terminal paste
  const translateTerminal = useCallback(async () => {
    return translate(false, true); // forcePopup=false, forceTerminal=true
  }, [translate]);

  const copyResult = useCallback(async () => {
    if (currentTranslation?.translated) {
      await writeClipboard(currentTranslation.translated);
      return true;
    }
    return false;
  }, [currentTranslation, writeClipboard]);

  // Enhance text (improve/rewrite)
  // forcePopup: if true, show popup instead of replacing text
  // forceTerminal: if true, use terminal-specific paste (Ctrl+A to select, then Ctrl+V)
  const enhance = useCallback(async (forcePopup = false, forceTerminal = false) => {
    const effectiveMode = forcePopup ? 'popup' : 'replace';
    
    console.log('🚀 [Enhance] ====== START ======');
    console.log(`[Enhance] Platform: ${PLATFORM} | Mode: ${effectiveMode}`);
    console.log(`[Enhance] Provider: ${provider} | ServerOnly: ${isServerProvider}`);
    
    if (!hasValidKey) {
      console.error('❌ [Enhance] ERROR: No API key!');
      setError('No API key');
      await reportMissingEngine(loadingEnabled);
      return;
    }

    if (isTranslating) {
      console.warn('[Enhance] Already processing, skipping...');
      return;
    }

    // Create abort controller for cancellation
    const abortController = new AbortController();
    setAbortController(abortController);

    setTranslating(true);
    setEnhancing(true); // Mark as enhance operation
    setError(null);

    // IMPORTANT: Hide popup first to prevent focus issues
    // If popup is open, it steals focus and Ctrl+C goes to wrong window
    try {
      await invoke('hide_popup');
    } catch (e) {
      // Ignore - popup might not be open
    }

    // Play start sound for feedback (this doesn't steal focus)
    if (soundEnabled) {
      try {
        await invoke('play_sound', { soundType: 'start' });
      } catch (e) {
        console.warn('[Enhance] Could not play sound:', e);
      }
    }

    // IMPORTANT: Do NOT show loading before copy!
    // Loading window steals focus and Ctrl+C goes to wrong window
    
    try {
      setTranslationStatus('copying');
      
      let textToEnhance: string | null = null;
      let gotFromConsoleApi = false;
      
      // Check clipboard BEFORE copy
      const clipboardBefore = await readClipboard();
      logContent('Enhance', '▶️ Clipboard BEFORE', clipboardBefore);
      
      // Step 0: Capture foreground HWND FIRST (this must happen before anything else!)
      console.log('▶️ [Enhance] Step 0: Capture foreground HWND...');
      let capturedApp = '';
      try {
        capturedApp = await captureForegroundHwnd();
        console.log(`✅ [Enhance] Captured foreground: "${capturedApp}"`);
      } catch (e) {
        console.warn('[Enhance] Could not capture foreground:', e);
      }

      // Show the loading overlay NOW - instant feedback that the shortcut fired. It is
      // non-activating (focused(false) + overlay level), so it can no longer steal the
      // copy's focus - which was the old reason to defer it until after the copy. On slow
      // copies (long selection, busy terminal) the user used to stare at nothing for 1-2s
      // and assume the shortcut was dead.
      if (loadingEnabled) {
        try {
          await invoke('show_loading', { x: null, y: null });
        } catch (e) {
          console.warn('[Enhance] Could not show loading:', e);
        }
      }
      
      // Detect if target is a terminal app - use terminal methods even for replace/popup mode
      const isTerminal_detected = isTerminalApp(capturedApp);
      
      // Detect app type for smart handling
      const appDetection = capturedApp ? detectAppType(capturedApp) : { type: 'replaceable' as AppType, reason: '' };
      // Check if target app is non-replaceable (PDF viewers, etc.)
      // For browsers, ALWAYS try replace first - verification will catch failures
      const isBrowser_enhance = ['chrome', 'firefox', 'brave', 'safari', 'edge', 'opera', 'arc'].some(
        b => capturedApp.toLowerCase().includes(b)
      );
      
      if (effectiveMode === 'replace' && capturedApp && !isTerminal_detected) {
        if (appDetection.type === 'non_replaceable') {
          // Only force popup for truly non-replaceable apps (PDF, image viewers)
          console.warn(`⚠️ [Enhance] Non-replaceable app detected: ${capturedApp}`);
          await notify('Replace Mode Not Supported', appDetection.reason);
          return enhance(true, false); // forcePopup = true
        }
        // For browsers (readonly or editable), try replace with verification fallback
        if (isBrowser_enhance) {
          console.log(`[Enhance] Browser detected: ${capturedApp} - will try replace with verification fallback`);
        }
      }
      
      // Terminal mode: either forced via shortcut OR detected from captured app
      const isTerminal = forceTerminal || isTerminal_detected;
      if (isTerminal) {
        console.log(`[Enhance] Terminal mode ENABLED (forced: ${forceTerminal}, detected: ${isTerminal_detected})`);
      }
      
      // Step 0b: For terminal mode on Windows, try Console API
      if (isTerminal && !IS_MAC) {
        console.log('▶️ [Enhance] Step 0b: Trying Console API for terminal selection...');
        try {
          const consoleText = await getTerminalSelection();
          if (consoleText && consoleText.trim()) {
            logContent('Enhance', '✅ Console API SUCCESS', consoleText);
            textToEnhance = consoleText;
            gotFromConsoleApi = true;
            // Also write to clipboard so paste will work later
            await writeClipboard(consoleText);
          }
        } catch (consoleErr) {
          const msg = consoleErr instanceof Error ? consoleErr.message : String(consoleErr);
          console.warn(`[Enhance] Console API failed (will try Ctrl+C): ${msg}`);
        }
      }
      
      // Step 1: If Console API didn't work, fall back to copy
      if (!gotFromConsoleApi) {
        // For terminal mode on Windows: Use WM_COMMAND to trigger Edit > Copy menu
        if (isTerminal && !IS_MAC) {
          console.log('▶️ [Enhance] Step 1: Terminal mode - using WM_COMMAND copy...');
          try {
            await simulateTerminalCopy();
            console.log('✅ [Enhance] Terminal WM_COMMAND copy sent OK');
            
            // Wait for clipboard to update
            console.log('[Enhance] Waiting 200ms for clipboard...');
            await sleep(200);
            
            // Read clipboard
            console.log('▶️ [Enhance] Step 2: Read clipboard...');
            textToEnhance = await readClipboard();
            logContent('Enhance', 'Clipboard AFTER', textToEnhance);
            
            // Retry if unchanged
            if (textToEnhance === clipboardBefore) {
              console.warn('⚠️ [Enhance] Clipboard unchanged - retrying WM_COMMAND copy...');
              await simulateTerminalCopy();
              await sleep(200);
              textToEnhance = await readClipboard();
              logContent('Enhance', 'Retry result', textToEnhance);
            }
          } catch (copyErr) {
            const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            console.warn(`[Enhance] Terminal WM_COMMAND failed: ${msg}, using clipboard directly`);
            textToEnhance = clipboardBefore;
          }
        } else {
          // For normal apps: use Cmd/Ctrl+C (standard copy).
          console.log('▶️ [Enhance] Step 1: Simulate copy...');
          // macOS sentinel — see the Translate flow for the rationale (prevents enhancing/pasting
          // a stale clipboard over the selection when the copy silently produced nothing).
          const sentinel = IS_MAC ? `__vt_copy_${Date.now()}__` : null;
          if (sentinel) { try { await writeClipboard(sentinel); } catch { /* */ } }
          try {
            await simulateCopy();
            console.log('✅ [Enhance] Copy command sent OK');
          } catch (copyErr) {
            const msg = copyErr instanceof Error ? copyErr.message : String(copyErr);
            console.error('❌ [Enhance] Copy FAILED: ' + msg);
            if (sentinel) { try { await writeClipboard(clipboardBefore); } catch { /* */ } }
            throw new Error(`Copy failed: ${msg}`);
          }

          // Step 2: Poll until the copy lands (fixed sleeps raced busy apps)
          const copyWait = IS_MAC ? 1500 : 800;
          console.log(`▶️ [Enhance] Step 2: Waiting for clipboard (up to ${copyWait}ms)...`);
          textToEnhance = await waitClipboardChange(readClipboard, IS_MAC ? sentinel : clipboardBefore, copyWait);
          logContent('Enhance', 'Clipboard AFTER', textToEnhance);

          // macOS: still the sentinel → copy produced nothing. Retry once, then restore clipboard.
          // Terminals: fall back to the pre-copy clipboard (copy-on-select) — see the Translate flow.
          if (sentinel && textToEnhance === sentinel) {
            console.warn('⚠️ [Enhance] Copy produced nothing - retrying once...');
            await sleep(100);
            await simulateCopy();
            textToEnhance = await waitClipboardChange(readClipboard, sentinel, copyWait);
            if (textToEnhance === sentinel) {
              try { await writeClipboard(clipboardBefore); } catch { /* */ }
              if (isMacTerminalApp(capturedApp) && clipboardBefore?.trim()) {
                console.log('[Enhance] Copy produced nothing in a terminal - using the pre-copy clipboard (copy-on-select)');
                textToEnhance = clipboardBefore;
              } else {
                console.error('❌ [Enhance] Copy still produced nothing - restoring clipboard');
                textToEnhance = ''; // -> "No text selected" handling below
              }
            }
          }

          // Windows: retry if clipboard unchanged
          if (!IS_MAC && textToEnhance === clipboardBefore) {
            console.warn('⚠️ [Enhance] Clipboard unchanged - retrying copy once...');
            await sleep(100);
            await simulateCopy();
            textToEnhance = await waitClipboardChange(readClipboard, clipboardBefore, copyWait);
            logContent('Enhance', 'Retry result', textToEnhance);

            if (textToEnhance === clipboardBefore && textToEnhance?.trim()) {
              console.log('[Enhance] Clipboard still same - proceeding with existing text');
            }
          }
        }
      }


      if (!textToEnhance?.trim()) {
        console.error('❌ [Enhance] ERROR: Clipboard is empty! Nothing was copied.');
        // Provide helpful message based on detected app
        let notifyMessage = 'Please select some text before pressing the shortcut.';
        if (capturedApp) {
          const detection = detectAppType(capturedApp);
          if (detection.type === 'non_replaceable' || detection.type === 'browser_readonly') {
            notifyMessage = 'Text selection not detected. This app may not support copy. Try using Popup mode (Ctrl+Alt+Shift+E).';
          }
        }
        await notify('No Text Detected', notifyMessage);
        throw new Error('No text selected');
      }

      // Check character limit
      if (textToEnhance.length > MAX_TRANSLATE_CHARS) {
        console.error(`❌ [Enhance] ERROR: Text too long! ${textToEnhance.length} > ${MAX_TRANSLATE_CHARS}`);
        await notify('Text Too Long', `Maximum ${MAX_TRANSLATE_CHARS} characters. Your text has ${textToEnhance.length} characters.`);
        throw new Error(`Text too long (${textToEnhance.length}/${MAX_TRANSLATE_CHARS} chars)`);
      }

      // Step 3: Enhance
      console.log('▶️ [Enhance] Step 3: API call...');
      console.log(`[Enhance] Target language: ${targetLang}`);
      setTranslationStatus('translating');
      const result = await enhanceText({
        text: textToEnhance,
        targetLang,
        apiKey: apiKey || '',
        provider,
        model: (provider === 'custom' ? customModel : model) === 'auto' ? undefined : (provider === 'custom' ? customModel : model),
        baseURL: provider === 'custom' ? customBaseURL : undefined,
        signal: abortController.signal,
      });
      logContent('Enhance', '✅ API Result', result.translatedText);
      
      // Check if text was unchanged (nothing to enhance)
      if (result.translatedText.trim() === textToEnhance.trim()) {
        console.warn('⚠️ [Enhance] Text unchanged after enhancement');
        await notify('No Changes', 'Text is already well-written. No enhancement needed.');
      }

      setTranslation({
        original: textToEnhance,
        translated: result.translatedText,
        sourceLang: 'auto',
        targetLang, // was hardcoded 'en' — use the actual target so state matches the popup
      });

      // Step 4: Write to clipboard. Terminal mode → sanitize so an embedded newline can't
      // execute as a command when pasted into a shell.
      console.log('▶️ [Enhance] Step 4: Write enhanced text to clipboard...');
      await writeClipboard(isTerminal ? sanitizeForTerminal(result.translatedText) : result.translatedText);
      console.log('✅ [Enhance] Clipboard updated with enhanced text');

      // Step 5: Popup or Replace
      if (effectiveMode === 'popup') {
        // Popup mode - just show the popup, don't paste
        try {
          await invoke('show_popup');
          const { emit } = await import('@tauri-apps/api/event');
          const enhanceData = {
            original: textToEnhance,
            translated: result.translatedText,
            sourceLang: 'auto',
            targetLang,
          };
          await sleep(300);
          await emit('translation-result', enhanceData);
          await sleep(200);
          await emit('translation-result', enhanceData);
        } catch (popupErr) {
          console.error('❌ [Enhance] Could not show popup:', popupErr);
        }
        console.log('✅ [Enhance] Popup shown');
      } else if (isTerminal) {
        // Terminal: Ctrl+A to select line, then Ctrl+V to paste
        console.log('▶️ [Enhance] Step 5: Terminal mode - Ctrl+A then paste...');
        // IMPORTANT: Hide loading BEFORE terminal replace!
        if (loadingEnabled) {
          try {
            await invoke('hide_loading');
          } catch (e) {
            console.warn('[Enhance] Could not hide loading:', e);
          }
        }
        setTranslationStatus('pasting');
        await sleep(150);
        try {
          await invoke('simulate_terminal_replace', { clearChars: textToEnhance.length });
          console.log('✅ [Enhance] Terminal replace OK');
        } catch (pasteErr) {
          const msg = pasteErr instanceof Error ? pasteErr.message : String(pasteErr);
          console.error('❌ [Enhance] Terminal replace FAILED: ' + msg);
          throw new Error(`Terminal replace failed: ${msg}`);
        }
        console.log('✅ [Enhance] ====== REPLACE SUCCESS ======');
      } else {
        // Replace mode - simulate paste
        console.log('▶️ [Enhance] Step 5: Simulate paste (Ctrl+V)...');
        setTranslationStatus('pasting');
        await sleep(150);
        try {
          await simulatePaste();
          console.log('✅ [Enhance] Paste OK');
          
          // FALLBACK CHECK - verify paste worked for apps that may lose selection
          // Verify for: read-only browser pages and messaging apps
          const needsVerification_enhance = (isBrowser_enhance && appDetection.type === 'browser_readonly') || appDetection.type === 'messaging_app';
          if (needsVerification_enhance) {
            console.log('[Enhance] Verifying paste (may lose selection)...');
            await sleep(400);
            await simulateCopy();
            await sleep(300);
            const clipboardAfterPaste = await readClipboard();
            
            // Paste failed if we got the ORIGINAL text back
            const pasteDefinitelyFailed = clipboardAfterPaste === textToEnhance;
            if (pasteDefinitelyFailed) {
              console.log('[Enhance] Paste FAILED - got original text, showing popup');
              await writeClipboard(result.translatedText);
              await invoke('show_popup');
              const { emit } = await import('@tauri-apps/api/event');
              const enhanceData = {
                original: textToEnhance,
                translated: result.translatedText,
                sourceLang: 'auto',
                targetLang,
              };
              await sleep(300);
              await emit('translation-result', enhanceData);
              await sleep(200);
              await emit('translation-result', enhanceData);
              console.log('✅ [Enhance] Fallback to popup');
              setTranslationStatus('done');
              setTranslating(false);
              return;
            } else {
              console.log('[Enhance] Paste verification OK');
            }
          } else if (isBrowser_enhance) {
            console.log('[Enhance] Editable browser field - skipping verification');
          }
        } catch (pasteErr) {
          const msg = pasteErr instanceof Error ? pasteErr.message : String(pasteErr);
          console.error('❌ [Enhance] Paste FAILED: ' + msg);
          throw new Error(`Paste failed: ${msg}`);
        }
        console.log('✅ [Enhance] ====== REPLACE SUCCESS ======');
      }
      setTranslationStatus('done');
      setTimeout(() => reset(), 2000);
      
      // Play success sound
      if (soundEnabled) {
        try {
          await invoke('play_sound', { soundType: 'success' });
        } catch (e) {
          console.warn('[Enhance] Could not play sound:', e);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isCancelled = msg.includes('cancelled') || msg.includes('Cancelled') || abortController.signal.aborted;
      
      if (isCancelled) {
        console.log('⚠️ [Enhance] ====== CANCELLED BY USER ======');
        setError('Cancelled');
      } else {
        console.error('❌ [Enhance] ====== FAILED ======');
        console.error('❌ [Enhance] Error: ' + msg);
        setError(msg);
        // Actionable notification + short reason on the loading overlay (see the Translate catch).
        const hint = await reportFailure('Enhance', msg);
        if (loadingEnabled) {
          try {
            await emit('loading-status', { status: 'error', message: hint });
            await sleep(2200);
          } catch { /* */ }
        }
        // Play error sound only for real errors
        if (soundEnabled) {
          try {
            await invoke('play_sound', { soundType: 'error' });
          } catch (e) {
            console.warn('[Enhance] Could not play sound:', e);
          }
        }
      }
      reset();
    } finally {
      // Clear abort controller
      setAbortController(null);
      
      // Hide loading indicator if enabled
      if (loadingEnabled) {
        try {
          await invoke('hide_loading');
        } catch (e) {
          console.warn('[Enhance] Could not hide loading:', e);
        }
      }
      
      // Note: setTranslating(false) is handled by reset() after success/error
    }
  }, [apiKey, provider, model, targetLang, isTranslating, hasValidKey, isServerProvider, soundEnabled, loadingEnabled, simulateCopy, simulatePaste, readClipboard, writeClipboard, setTranslating, setEnhancing, setTranslationStatus, setTranslation, setError, reset, setAbortController]);

  // Enhance with popup - shows popup instead of replacing text
  const enhancePopup = useCallback(async () => {
    return enhance(true); // forcePopup=true
  }, [enhance]);

  // Enhance for terminal - same as normal but uses terminal paste
  const enhanceTerminal = useCallback(async () => {
    return enhance(false, true); // forcePopup=false, forceTerminal=true
  }, [enhance]);

  return {
    translate,
    translatePopup,
    translateTerminal,
    enhance,
    enhancePopup,
    enhanceTerminal,
    translateFromClipboard,
    testApiKey,
    testClipboard,
    testSimulateCopy,
    copyResult,
    isTranslating,
    translationStatus,
    currentTranslation,
    error,
  };
}
