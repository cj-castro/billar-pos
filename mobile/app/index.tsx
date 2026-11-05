import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { boot, type BootTarget } from '../src/auth/boot';
import { colors } from '../src/theme/tokens';

/** Boot gate: decides setup / login / role home, then redirects. */
export default function Index() {
  const [target, setTarget] = useState<BootTarget | null>(null);
  useEffect(() => {
    boot()
      .then(setTarget)
      .catch(() => setTarget('/setup'));
  }, []);

  if (!target) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  return <Redirect href={target} />;
}
