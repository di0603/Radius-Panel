import { notifications } from '@mantine/notifications';
import { apiErrorMessage } from '../api/client';

export function notifyOk(message: string): void {
  notifications.show({ color: 'teal', message });
}

export function notifyError(error: unknown, title = 'Error'): void {
  notifications.show({ color: 'red', title, message: apiErrorMessage(error) });
}
