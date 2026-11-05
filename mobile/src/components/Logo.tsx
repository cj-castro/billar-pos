import { Image, StyleSheet } from 'react-native';
import { colors, radii } from '../theme/tokens';

/** Bola 8 Pool Club mark (rounded square, as in prototypes 01/02/17). */
export function Logo({ size = 96 }: { size?: number }) {
  return (
    <Image
      source={require('../../assets/images/logo.jpg')}
      accessibilityIgnoresInvertColors
      accessible={false}
      style={[styles.img, { width: size, height: size, borderRadius: size * 0.24 }]}
    />
  );
}

const styles = StyleSheet.create({
  img: { borderWidth: 2, borderColor: colors.surfaceOverlay, borderRadius: radii.xl },
});
