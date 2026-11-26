import { Text, type TextProps } from 'react-native';
import { colors, fontSizes, fontWeights, lineHeights, MAX_FONT_SCALE } from '../theme/tokens';

export type TextVariant = 'caption' | 'label' | 'body' | 'bodyLg' | 'title' | 'headline' | 'display' | 'timer';

const WEIGHT: Record<TextVariant, '400' | '500' | '600' | '700'> = {
  caption: fontWeights.semibold,
  label: fontWeights.semibold,
  body: fontWeights.regular,
  bodyLg: fontWeights.semibold,
  title: fontWeights.bold,
  headline: fontWeights.bold,
  display: fontWeights.bold,
  timer: fontWeights.bold,
};

export interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: string;
  bold?: boolean;
  /** KDS screens ignore the OS font scale (DESIGN_SYSTEM section 2). */
  fixedScale?: boolean;
}

/** The only Text wrapper: token sizes, OS font scale honoured up to 1.3x. */
export function AppText({ variant = 'body', color = colors.textPrimary, bold, fixedScale, style, ...rest }: AppTextProps) {
  return (
    <Text
      allowFontScaling={!fixedScale}
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[
        {
          color,
          fontSize: fontSizes[variant],
          lineHeight: lineHeights[variant],
          fontWeight: bold ? fontWeights.bold : WEIGHT[variant],
        },
        variant === 'timer' || variant === 'display' ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
      {...rest}
    />
  );
}
