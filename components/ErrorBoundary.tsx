import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    
    if (process.env.NODE_ENV === 'development') {
      console.error('ErrorBoundary caught an error:', error, errorInfo);
    }
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="min-h-[50vh] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-raised rounded-[4px] shadow-[var(--shadow-2)] border border-border p-8 text-center">
            <div className="w-16 h-16 bg-danger/10 text-danger rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertTriangle size={32} />
            </div>

            <h2 className="text-xl font-bold text-slate-800 dark:text-white mb-2">
              出现了一些问题
            </h2>
            <p className="text-slate-500 dark:text-slate-400 mb-6">
              应用遇到了意外错误，请尝试刷新页面。
            </p>

            {process.env.NODE_ENV === 'development' && this.state.error && (
              <details className="text-left mb-6 bg-slate-50 dark:bg-slate-900 rounded-lg p-4 text-xs">
                <summary className="cursor-pointer text-slate-600 dark:text-slate-300 font-medium mb-2">
                  错误详情 (开发模式)
                </summary>
                <pre className="overflow-auto text-danger whitespace-pre-wrap break-words">
                  {this.state.error.toString()}
                  {this.state.errorInfo?.componentStack}
                </pre>
              </details>
            )}

            <div className="flex gap-3 justify-center">
              <button
                onClick={this.handleReset}
                className="px-5 py-2.5 bg-sunken text-text rounded-[4px] font-medium hover:bg-border transition-colors"
              >
                重试
              </button>
              <button
                onClick={this.handleReload}
                className="px-5 py-2.5 bg-accent text-accent-contrast rounded-[4px] font-medium hover:bg-accent/90 transition-colors flex items-center gap-2"
              >
                <RefreshCw size={16} />
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
