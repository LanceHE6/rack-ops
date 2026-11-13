import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
} from '@heroui/react';
import { AlertTriangle } from 'lucide-react';

interface Props {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({ isOpen, title, message, confirmLabel = '确认删除', onConfirm, onClose }: Props) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm" classNames={{ base: 'bg-slate-900 border border-slate-700 text-slate-100' }}>
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 border-b border-slate-800 text-base">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          {title}
        </ModalHeader>
        <ModalBody className="py-4 text-sm text-slate-300">{message}</ModalBody>
        <ModalFooter className="border-t border-slate-800">
          <Button variant="flat" size="sm" onPress={onClose}>取消</Button>
          <Button color="danger" size="sm" onPress={onConfirm}>{confirmLabel}</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
