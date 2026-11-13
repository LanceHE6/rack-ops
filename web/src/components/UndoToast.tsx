import { useEffect } from 'react';
import { Undo2, X, CheckCircle2 } from 'lucide-react';

export interface ToastState {
  id: number;
  message: string;
  undo?: () => Promise<void>;
}

interface Props {
  toast: ToastState | null;
  onDismiss: () => void;
}

export function UndoToast({ toast, onDismiss }: Props) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] toast-in">
      <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-slate-900/95 border border-sky-500/40 shadow-2xl shadow-sky-950/60 backdrop-blur">
        <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
        <span className="text-sm text-slate-200">{toast.message}</span>
        {toast.undo && (
          <button
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-sky-600/20 border border-sky-500/50 text-sky-300 text-xs font-semibold hover:bg-sky-600/40 transition-colors"
            onClick={async () => {
              try {
                await toast.undo!();
              } finally {
                onDismiss();
              }
            }}
          >
            <Undo2 className="w-3.5 h-3.5" />
            撤销
          </button>
        )}
        <button className="text-slate-500 hover:text-slate-300 transition-colors" onClick={onDismiss}>
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
