// Browser file helpers for save export/import, extracted from the old port's
// "Dune Sega Web/web/browser-features.mjs" (downloadSave / pickSaveFile only).
// No game memory or simulation is touched; only the minimum DOM the browser
// needs for a download and a file picker.
//
// Both helpers accept dependency injection so they are testable without a DOM.
// `downloadSave` keeps the iOS share-sheet path (Files app) and falls back to an
// anchor download when Web Share with files is unavailable.

export function isAppleMobile(nav = globalThis.navigator) {
  return /iPhone|iPad|iPod/.test(nav?.userAgent || '') || (nav?.platform === 'MacIntel' && nav?.maxTouchPoints > 1);
}

export async function downloadSave({ text, filename }, { nav = globalThis.navigator, doc = globalThis.document, url = globalThis.URL } = {}) {
  const blob = new Blob([text], { type: 'application/json' });
  if (isAppleMobile(nav) && typeof File !== 'undefined') {
    const file = new File([blob], filename, { type: 'application/json' });
    if (nav?.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Dune save' });
        return true;
      } catch (e) {
        if (e.name === 'AbortError') return false;
        // A disabled/failed share sheet falls back to a regular download.
      }
    }
  }
  const href = url.createObjectURL(blob), a = doc.createElement('a');
  a.href = href;
  a.download = filename;
  a.style.display = 'none';
  doc.body.append(a);
  a.click();
  a.remove();
  // unref() exists only in Node (tests); browsers return a number here.
  setTimeout(() => url.revokeObjectURL(href), 60000)?.unref?.();
  return true;
}

// Open immediately from a user click, before any await or screen transition.
export function pickSaveFile(onFile, { doc = globalThis.document } = {}) {
  const input = doc.createElement('input');
  input.type = 'file';
  input.accept = '.json,.dune-save,application/json';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onFile(file);
  }, { once: true });
  input.addEventListener('cancel', () => input.remove(), { once: true });
  doc.body.append(input);
  input.click();
  return input;
}
