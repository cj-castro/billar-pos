/**
 * Typed view of the design tokens. Source of truth: docs/mobile/design/tokens.json, copied to
 * ./tokens.json by `node scripts/sync-tokens.mjs` (Metro cannot import outside the project root).
 * Screens import from here, never the JSON.
 */
import type { MaterialCommunityIcons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import raw from './tokens.json';

export const colors = raw.colors;
export const spacing = raw.spacing;
export const radii = raw.radii;
export const fontSizes = raw.fontSizes;
export const fontSizesKds = raw.fontSizesKds;
export const lineHeights = raw.lineHeights;
export const fontWeights = raw.fontWeights as {
  regular: '400';
  medium: '500';
  semibold: '600';
  bold: '700';
};
export const touch = raw.touch;
export const elevation = raw.elevation;
export const durations = raw.durations;
export const kds = raw.kds;
export const layout = raw.layout;

/** Max OS font scale honoured on regular screens (DESIGN_SYSTEM §2). */
export const MAX_FONT_SCALE = 1.3;

export type IconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

// ---------------------------------------------------------------- table status (DESIGN_SYSTEM §1.3)
export type TableState = 'FREE' | 'OCCUPIED' | 'BILL_REQUESTED' | 'INACTIVE';

export interface StatusStyle {
  fg: string;
  bg: string;
  border: string;
  icon: IconName;
  /** i18n key in the `mobile` namespace. */
  labelKey: string;
}

export function tableStatusStyle(state: TableState): StatusStyle {
  switch (state) {
    case 'FREE':
      return { fg: colors.tableFreeFg, bg: colors.tableFreeBg, border: colors.tableFreeBorder, icon: 'check', labelKey: 'status.table.FREE' };
    case 'OCCUPIED':
      return { fg: colors.tableOccupiedFg, bg: colors.tableOccupiedBg, border: colors.tableOccupiedBorder, icon: 'account-outline', labelKey: 'status.table.OCCUPIED' };
    case 'BILL_REQUESTED':
      return { fg: colors.tableBillFg, bg: colors.tableBillBg, border: colors.tableBillBorder, icon: 'bell-outline', labelKey: 'status.table.BILL_REQUESTED' };
    case 'INACTIVE':
      return { fg: colors.tableInactiveFg, bg: colors.tableInactiveBg, border: colors.tableInactiveBorder, icon: 'close', labelKey: 'status.table.INACTIVE' };
  }
}

// ---------------------------------------------------------------- line status (§1.4)
export type LineStatus = 'SENT' | 'IN_PROGRESS' | 'READY' | 'SERVED' | 'VOIDED';
export type DraftStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';

export interface LineStyle {
  fg: string;
  bg: string;
  icon: IconName;
  labelKey: string;
  strike?: boolean;
}

export function lineStatusStyle(status: LineStatus): LineStyle {
  switch (status) {
    case 'SENT':
      return { fg: colors.itemSentFg, bg: colors.itemSentBg, icon: 'send', labelKey: 'status.item.SENT' };
    case 'IN_PROGRESS':
      return { fg: colors.itemInProgressFg, bg: colors.itemInProgressBg, icon: 'fire', labelKey: 'status.item.IN_PROGRESS' };
    case 'READY':
      return { fg: colors.itemReadyFg, bg: colors.itemReadyBg, icon: 'check', labelKey: 'status.item.READY' };
    case 'SERVED':
      return { fg: colors.itemServedFg, bg: colors.itemServedBg, icon: 'check-all', labelKey: 'status.item.SERVED' };
    case 'VOIDED':
      return { fg: colors.itemCancelledFg, bg: colors.itemCancelledBg, icon: 'close', labelKey: 'status.item.VOIDED', strike: true };
  }
}

export function draftStatusStyle(status: DraftStatus): LineStyle {
  switch (status) {
    case 'PENDING':
      return { fg: colors.itemSentFg, bg: colors.itemSentBg, icon: 'clock-outline', labelKey: 'status.draft.PENDING' };
    case 'SENDING':
      return { fg: colors.itemInProgressFg, bg: colors.itemInProgressBg, icon: 'refresh', labelKey: 'status.draft.SENDING' };
    case 'SENT':
      return { fg: colors.itemReadyFg, bg: colors.itemReadyBg, icon: 'check', labelKey: 'status.draft.SENT' };
    case 'FAILED':
      return { fg: colors.itemCancelledFg, bg: colors.itemCancelledBg, icon: 'alert-circle-outline', labelKey: 'status.draft.FAILED' };
  }
}

// ---------------------------------------------------------------- KDS age (§1.5)
export type AgeLevel = 'neutral' | 'warn' | 'alert';

/** < 10 min neutral, 10..20 min (inclusive) warn, > 20 min alert. Thresholds from tokens.kds. */
export function kdsAgeLevel(minutes: number): AgeLevel {
  if (!(minutes >= kds.warnAfterMin)) return 'neutral'; // also NaN -> neutral
  return minutes > kds.alertAfterMin ? 'alert' : 'warn';
}

export function ageStyle(level: AgeLevel): { fg: string; bg: string; border: string; borderWidth: number } {
  switch (level) {
    case 'neutral':
      return { fg: colors.ageNeutralFg, bg: colors.ageNeutralBg, border: colors.border, borderWidth: 1 };
    case 'warn':
      return { fg: colors.ageWarnFg, bg: colors.ageWarnBg, border: colors.ageWarnBg, borderWidth: 2 };
    case 'alert':
      return { fg: colors.ageAlertFg, bg: colors.ageAlertBg, border: colors.ageAlertBg, borderWidth: 2 };
  }
}

// ---------------------------------------------------------------- connection (§1.6)
export type ConnLevel = 'online' | 'reconnecting' | 'offline';
export const connColor: Record<ConnLevel, string> = {
  online: colors.connOnline,
  reconnecting: colors.connReconnecting,
  offline: colors.connOffline,
};
