import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, fontSizes, MAX_FONT_SCALE, radii, spacing, touch, type IconName } from '../theme/tokens';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export interface AppTextFieldProps extends TextInputProps {
  label: string;
  error?: string | null;
  icon?: IconName;
  /** Adds a show/hide toggle (implies secureTextEntry while hidden). */
  password?: boolean;
}

export function AppTextField({ label, error, icon, password, style, onFocus, onBlur, ...rest }: AppTextFieldProps) {
  const { t } = useTranslation('mobile');
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const border = error ? colors.dangerText : focused ? colors.focusRing : colors.textMuted;
  return (
    <View style={styles.wrap}>
      <AppText variant="label" color={colors.textSecondary}>
        {label}
      </AppText>
      <View style={[styles.box, { borderColor: border, borderWidth: focused || error ? 2 : 1.5 }]}>
        {icon && <MaterialCommunityIcons name={icon} size={22} color={colors.textMuted} />}
        <TextInput
          accessibilityLabel={label}
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          maxFontSizeMultiplier={MAX_FONT_SCALE}
          cursorColor={colors.primaryText}
          selectionColor={colors.primaryText}
          {...rest}
          secureTextEntry={password ? hidden : rest.secureTextEntry}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, style]}
        />
        {password && (
          <IconButton
            icon={hidden ? 'eye-outline' : 'eye-off-outline'}
            accessibilityLabel={hidden ? t('login.showPassword') : t('login.hidePassword')}
            onPress={() => setHidden((h) => !h)}
            testID="toggle-password"
            color={colors.textSecondary}
          />
        )}
      </View>
      {!!error && (
        <AppText variant="label" color={colors.dangerText} accessibilityRole="alert">
          {error}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2 },
  box: { minHeight: touch.primary, flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingHorizontal: spacing.s3, backgroundColor: colors.surfaceRaised, borderRadius: radii.md },
  input: { flex: 1, minHeight: touch.primary, color: colors.textPrimary, fontSize: fontSizes.body, paddingVertical: 0 },
});
