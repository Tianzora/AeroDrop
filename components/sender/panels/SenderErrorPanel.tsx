import React from 'react';
import { ErrorState } from '../../ui/ErrorState';
import { Button } from '../../ui/Button';

export const SenderErrorPanel: React.FC<{ errorMsg: string; stopSharing: () => void }> = ({ errorMsg, stopSharing }) => (
  <ErrorState title="发生错误" message={errorMsg} actions={<Button variant="secondary" onClick={stopSharing}>返回</Button>} />
);
