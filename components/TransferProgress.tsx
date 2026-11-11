import React, { useEffect } from 'react';
import { motion, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { ArrowDown, Check } from 'lucide-react';
import { formatFileSize } from '../services/fileUtils';

const EASE_UI: [number, number, number, number] = [0.23, 1, 0.32, 1];
/** 进度条只追位置，不追颜色，弹簧参数比进场动画更硬一点 */
const BAR_SPRING = { type: 'spring', stiffness: 140, damping: 24, mass: 0.6 } as const;
const ENTER_DURATION = 0.24;

/**
 * 速度与字节数每 500ms 跳一次原始值，直接写在文本里会「跳字」。
 * 用弹簧把数值追到目标值，文本只跟着弹簧渲染（不触发父组件重渲染）。
 */
export const AnimatedNumber: React.FC<{ value: number; format: (value: number) => string; className?: string }> = ({
  value,
  format,
  className,
}) => {
  const reduceMotion = useReducedMotion();
  const spring = useSpring(value, { stiffness: 120, damping: 26, mass: 0.6 });
  const text = useTransform(spring, (latest) => format(latest));

  useEffect(() => {
    spring.set(value);
  }, [spring, value]);

  if (reduceMotion) {
    return <span className={className}>{format(value)}</span>;
  }

  return <motion.span className={className}>{text}</motion.span>;
};

/**
 * 确定性进度条：scaleX 只走合成层；未完成时在已填充段内叠一条流动高光，
 * 读起来是「有数据在走」而不是「在等」。
 */
export const ProgressTrack: React.FC<{ value: number; tone: 'brand' | 'success'; label: string }> = ({
  value,
  tone,
  label,
}) => {
  const reduceMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, value));
  const complete = clamped >= 100;

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-night-800"
    >
      <motion.div
        className={`relative h-full w-full origin-left overflow-hidden rounded-full ${
          tone === 'success' ? 'bg-emerald-500' : 'bg-brand-500'
        }`}
        initial={false}
        animate={{ scaleX: clamped / 100 }}
        style={{ originX: 0 }}
        transition={reduceMotion ? { duration: 0 } : BAR_SPRING}
      >
        {!reduceMotion && !complete && (
          <motion.span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/35 to-transparent"
            animate={{ x: ['-120%', '420%'] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: 'linear' }}
          />
        )}
      </motion.div>
    </div>
  );
};

export interface TransferProgressCardProps {
  progress: number;
  transferredBytes: number;
  totalBytes: number;
  fileName?: string;
  /** 「第 2 / 3 个文件」这类位置说明 */
  filePosition?: string;
  currentSpeedBytes?: number;
  averageSpeedBytes?: number;
  /** 剩余时间值，例 `00:32` */
  eta?: string;
}

/**
 * 两端的传输进度卡：文件名 + 弹簧追字的百分比 + 确定性进度 + 字节/速度/剩余时间。
 * 只做展示，进度来源由调用方决定。
 */
export const TransferProgressCard: React.FC<TransferProgressCardProps> = ({
  progress,
  transferredBytes,
  totalBytes,
  fileName,
  filePosition,
  currentSpeedBytes,
  averageSpeedBytes,
  eta,
}) => {
  const reduceMotion = useReducedMotion();
  const clamped = Math.max(0, Math.min(100, progress));
  const complete = clamped >= 100;

  return (
    <motion.section
      className={`mt-5 rounded-control p-4 text-left transition-colors motion-base ${
        complete ? 'bg-emerald-50/70 dark:bg-emerald-500/[0.07]' : 'bg-slate-50/80 dark:bg-night-900/60'
      }`}
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: ENTER_DURATION, ease: EASE_UI }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {fileName && (
            <p className="truncate text-sm font-semibold text-slate-900 dark:text-night-100">{fileName}</p>
          )}
          {filePosition && (
            <p className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-night-400">{filePosition}</p>
          )}
        </div>
        <div className="flex h-8 shrink-0 items-center">
          {complete ? (
            <motion.span
              initial={reduceMotion ? false : { scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.22, ease: EASE_UI }}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500 text-white"
            >
              <Check size={15} strokeWidth={3} aria-hidden="true" />
            </motion.span>
          ) : (
            <span className="flex items-baseline font-mono text-2xl font-bold leading-none tabular-nums text-slate-900 dark:text-night-100">
              <AnimatedNumber value={clamped} format={(latest) => `${Math.round(latest)}`} />
              <span className="ml-0.5 text-sm font-medium text-slate-500 dark:text-night-400">%</span>
            </span>
          )}
        </div>
      </div>

      <div className="mt-3">
        <ProgressTrack value={clamped} tone={complete ? 'success' : 'brand'} label="传输进度" />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[11px] tabular-nums text-slate-500 dark:text-night-400">
            <AnimatedNumber value={transferredBytes} format={formatFileSize} /> / {formatFileSize(totalBytes)}
          </p>
          {averageSpeedBytes !== undefined && (
            <p className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-night-400">
              平均 <AnimatedNumber value={averageSpeedBytes} format={(latest) => `${formatFileSize(latest)}/s`} />
            </p>
          )}
        </div>
        {!complete && (currentSpeedBytes !== undefined || eta) && (
          <div className="shrink-0 text-right">
            {currentSpeedBytes !== undefined && (
              <p className="flex items-center justify-end gap-1 text-xs font-semibold tabular-nums text-brand-600 dark:text-brand-400">
                <ArrowDown size={12} aria-hidden="true" />
                <AnimatedNumber value={currentSpeedBytes} format={(latest) => `${formatFileSize(latest)}/s`} />
              </p>
            )}
            {eta && (
              <p className="mt-0.5 text-[11px] tabular-nums text-slate-500 dark:text-night-400">剩余 {eta}</p>
            )}
          </div>
        )}
      </div>
    </motion.section>
  );
};
