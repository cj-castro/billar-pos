import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme/tokens';

export interface ScreenScaffoldProps {
  children: ReactNode;
  /** Usually <ScreenHeader/>. */
  header?: ReactNode;
  /** <OfflineBanner/> or an error banner, under the header. */
  banner?: ReactNode;
  /** <BottomActionBar/>; sits above the bottom inset. Not used inside tab navigators. */
  footer?: ReactNode;
  /** Wrap children in a ScrollView (forms). Lists should render their own FlatList with scroll=false. */
  scroll?: boolean;
  /** Vertically centre scrolled content (auth screens). */
  center?: boolean;
  /** 16 dp gutter around children (default true). */
  padded?: boolean;
  /** Safe-area edges; default top + bottom unless a footer / tab bar owns the bottom. */
  edges?: Edge[];
  testID?: string;
}

/** Status-bar / safe-area aware container shared by every screen. */
export function ScreenScaffold({ children, header, banner, footer, scroll, center, padded = true, edges, testID }: ScreenScaffoldProps) {
  const safeEdges: Edge[] = edges ?? (footer ? ['top'] : ['top', 'bottom']);
  const body = scroll ? (
    <ScrollView
      contentContainerStyle={[styles.scroll, padded && styles.padded, center && styles.center]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, padded && styles.padded]}>{children}</View>
  );
  return (
    <SafeAreaView testID={testID} style={styles.root} edges={safeEdges}>
      {header}
      {banner}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {body}
      </KeyboardAvoidingView>
      {footer}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  scroll: { flexGrow: 1, gap: spacing.s4 },
  padded: { padding: spacing.s4 },
  center: { justifyContent: 'center' },
});
