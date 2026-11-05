import { clsx, type ClassValue } from 'clsx';

/** Join conditional class names. (No tailwind-merge in the hot path — keeps first-load JS small.) */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
