import React from 'react';
import { cn } from './cn';

export const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={cn('animate-pulse rounded-md bg-sunken', className)} aria-hidden />
);
