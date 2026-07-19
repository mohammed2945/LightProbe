import { useState, useEffect } from 'react';

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'agent';
  duration?: number;
}

type ToastListener = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let listeners: ToastListener[] = [];

export const toast = {
  show(message: string, type: Toast['type'] = 'info', duration = 4000) {
    const id = Math.random().toString(36).substring(2, 9);
    const newToast: Toast = { id, message, type, duration };
    toasts = [...toasts, newToast];
    listeners.forEach(l => l(toasts));

    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(id);
      }, duration);
    }
    return id;
  },
  dismiss(id: string) {
    toasts = toasts.filter(t => t.id !== id);
    listeners.forEach(l => l(toasts));
  },
  subscribe(listener: ToastListener) {
    listeners.push(listener);
    listener(toasts);
    return () => {
      listeners = listeners.filter(l => l !== listener);
    };
  }
};

export function useToasts() {
  const [activeToasts, setActiveToasts] = useState<Toast[]>([]);

  useEffect(() => {
    return toast.subscribe(setActiveToasts);
  }, []);

  return { toasts: activeToasts, dismiss: (id: string) => toast.dismiss(id) };
}
