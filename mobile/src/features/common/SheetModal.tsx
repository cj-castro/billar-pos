import type { ReactNode } from 'react';
import { Modal } from 'react-native';
import { Sheet } from '../waiter/ui/Sheet';

/** In-screen bottom sheet (RN Modal + the shared Sheet) for flows that are not routes. */
export function SheetModal({ visible, onClose, children, testID }: { visible: boolean; onClose?: () => void; children: ReactNode; testID?: string }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Sheet onClose={onClose} testID={testID}>
        {children}
      </Sheet>
    </Modal>
  );
}
