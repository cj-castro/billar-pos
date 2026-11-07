import { KdsFocusEffects } from '../../../src/features/kitchen/KdsFocusEffects';
import { KdsScreen } from '../../../src/features/kitchen/KdsScreen';

/** SCR-M-04: KDS inside the manager tabs (station switch). */
export default function Kds() {
  return (
    <>
      <KdsScreen tabs />
      <KdsFocusEffects />
    </>
  );
}
