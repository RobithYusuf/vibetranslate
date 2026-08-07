import { saveActiveApp, getTargetApp, simulateCopy, simulateCopyDirect, simulatePaste, captureAndCopy } from '@/services/keyboard';

export function useKeyboard() {
  return { saveActiveApp, getTargetApp, simulateCopy, simulateCopyDirect, simulatePaste, captureAndCopy };
}
