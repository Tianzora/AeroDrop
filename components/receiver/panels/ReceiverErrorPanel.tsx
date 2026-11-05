import React from 'react';
import { ErrorState } from '../../ui/ErrorState';
import { Button } from '../../ui/Button';

export const ReceiverErrorPanel: React.FC<{ errorMsg: string; onReset: () => void; onRetry: () => void }> = ({ errorMsg, onReset, onRetry }) => (
  <ErrorState
    title="传输失败"
    message={errorMsg}
    actions={
      <>
        <Button variant="secondary" onClick={onReset}>取消</Button>
        <Button onClick={onRetry}>重试</Button>
      </>
    }
  />
);
