import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { colors, fontSizes, type IconName } from '../theme/tokens';

type TabsProps = ComponentProps<typeof Tabs>;
export type TabScreenOptions = NonNullable<TabsProps['screenOptions']>;

/** Shared bottom-tab styling for every role group (DESIGN_SYSTEM: icon + 12 dp label always visible). */
export const tabScreenOptions: TabScreenOptions = {
  headerShown: false,
  tabBarActiveTintColor: colors.primaryText,
  tabBarInactiveTintColor: colors.textMuted,
  tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
  tabBarLabelStyle: { fontSize: fontSizes.caption, fontWeight: '600' },
  tabBarHideOnKeyboard: true,
  sceneStyle: { backgroundColor: colors.bg },
};

export function tabIcon(name: IconName) {
  const TabIcon = ({ color }: { color: ColorValue }) => <MaterialCommunityIcons name={name} size={24} color={color as string} />;
  return TabIcon;
}
