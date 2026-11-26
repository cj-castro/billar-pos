// Recomputes WCAG contrast for every text pair in tokens.json. Usage: node check-contrast.mjs  (exit 1 if a pair < 4.5:1)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const t = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'tokens.json'), 'utf8')).colors;
const L = (h) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const cr = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const P = [
  ['textPrimary', 'bg'], ['textPrimary', 'surface'], ['textPrimary', 'surfaceRaised'], ['textSecondary', 'surface'], ['textSecondary', 'surfaceRaised'],
  ['textMuted', 'bg'], ['textMuted', 'surface'], ['textMuted', 'surfaceRaised'], ['textOnAccent', 'primary'], ['textOnAccent', 'primaryPressed'],
  ['primaryText', 'surface'], ['primaryText', 'surfaceRaised'], ['textOnDanger', 'danger'], ['dangerText', 'surface'], ['dangerText', 'dangerTint'],
  ['success', 'surface'], ['warning', 'surface'], ['info', 'surface'], ['tableFreeFg', 'tableFreeBg'], ['tableOccupiedFg', 'tableOccupiedBg'],
  ['tableBillFg', 'tableBillBg'], ['tableInactiveFg', 'tableInactiveBg'], ['itemSentFg', 'itemSentBg'], ['itemInProgressFg', 'itemInProgressBg'],
  ['itemReadyFg', 'itemReadyBg'], ['itemServedFg', 'itemServedBg'], ['itemCancelledFg', 'itemCancelledBg'], ['ageNeutralFg', 'ageNeutralBg'],
  ['ageWarnFg', 'ageWarnBg'], ['ageAlertFg', 'ageAlertBg'], ['offlineBannerFg', 'offlineBannerBg'], ['errorBannerFg', 'errorBannerBg'],
  ['connOnline', 'surface'], ['connReconnecting', 'surface'], ['connOffline', 'surface'],
];
let bad = 0;
for (const [a, b] of P) { const r = cr(t[a], t[b]); const ok = r >= 4.5; if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${a} on ${b}: ${r.toFixed(2)}:1`); }
process.exit(bad ? 1 : 0);
