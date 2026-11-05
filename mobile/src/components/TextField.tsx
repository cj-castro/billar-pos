import { StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { colors, font, minTouch, radius } from '../theme/tokens';

interface Props extends TextInputProps {
  label: string;
  error?: string | null;
}

export function TextField({ label, error, style, ...rest }: Props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, !!error && { borderColor: colors.danger }, style]}
        {...rest}
      />
      {!!error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 6 },
  label: { color: colors.textMuted, fontSize: font.sm },
  input: {
    minHeight: minTouch,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    color: colors.text,
    fontSize: font.md,
  },
  error: { color: colors.danger, fontSize: font.sm },
});
