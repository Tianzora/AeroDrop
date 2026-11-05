import React from 'react';
import { Loader2 } from 'lucide-react';
import { Card } from '../../ui/Card';
import { Button } from '../../ui/Button';
import { getReceiverWaitingStatusCopy, type ReceiverWaitingStage } from '../../../services/receiverStatusCopy';

export interface ReceiverConnectingPanelProps {
  connectingStage: ReceiverWaitingStage;
  reconnectAttempt: number;
  onReset: () => void;
}

export const ReceiverConnectingPanel: React.FC<ReceiverConnectingPanelProps> = ({ connectingStage, reconnectAttempt, onReset }) => {
  const status = getReceiverWaitingStatusCopy({ stage: connectingStage, reconnectAttempt });
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <Loader2 size={38} className="animate-spin text-accent" />
      <p className="text-[15px] font-bold text-ink">{status.title}</p>
      <p className="max-w-[38ch] text-[13px] text-muted">{status.detail}</p>
      <Button variant="secondary" size="sm" className="mt-4" onClick={onReset}>{status.cancelLabel}</Button>
    </Card>
  );
};
