import type { ToasterProps } from 'sonner';

/**
 * Toaster 的共享配置。
 *
 * 单独放在这里是为了可测：App 直接渲染 <Toaster> 会牵出 streamsaver 这类依赖
 * document 的模块，Node 测试里 SSR 不起来。文案与位置属于产品决策，集中一份，
 * 谁改谁就在这里改（测试盯着 containerAriaLabel）。
 */
export const TOASTER_PROPS: ToasterProps = {
  position: 'bottom-center',
  theme: 'system',
  duration: 4000,
  offset: 16,
  mobileOffset: 16,
  /* sonner 的容器本身是 aria-live="polite" 的 section；这里只把它默认的英文
     「Notifications」换成中文，免得读屏用户听到一半英文。 */
  containerAriaLabel: '通知',
  toastOptions: { className: 'font-sans', style: { fontSize: '14px' } },
};
