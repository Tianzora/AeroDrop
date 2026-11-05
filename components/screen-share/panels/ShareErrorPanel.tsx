import React from 'react';
import { RefreshCw, X } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';

const banner = 'flex items-center gap-3 rounded-[4px] border border-danger/30 bg-danger/10 px-4 py-3 text-[13px] text-danger';

export const ShareErrorBanner: React.FC<{ error: string; className?: string }> = ({ error, className }) => (
  <div className={banner + (className ? ' ' + className : '') + ' mb-5'} role="alert">{error}</div>
);

export const ShareErrorPanel: React.FC<{ error: string; onRetry: () => void; onDismiss: () => void }> = ({ error, onRetry, onDismiss }) => (
  <Card className="p-5 space-y-4">
    <div className={banner} role="alert">{error}</div>
    <div className="flex justify-center gap-3">
      <Button icon={<RefreshCw size={16} />} onClick={onRetry}>重试连接</Button>
      <Button variant="secondary" icon={<X size={16} />} onClick={onDismiss}>取消</Button>
    </div>
  </Card>
);
