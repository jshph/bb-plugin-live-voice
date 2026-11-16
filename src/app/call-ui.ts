export type CallUi = {
  status: 'connecting' | 'active' | 'closed';
  muted: boolean;
  speaking: boolean;
  blocked: boolean;
  message: string | null;
  toggleMute(): void;
  enableAudio(): void;
  retry(): void;
};

// Transport lives in the app overlay; either surface can control the same call.
let snapshot: CallUi | null = null;
const listeners = new Set<() => void>();
export const callUi = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  publish(next: CallUi | null) { snapshot = next; for (const listener of listeners) listener(); },
};

// Hide the floating dial only while matching composer controls are actually visible.
// Route identity alone is insufficient when a pane or its composer is hidden.
const anchors = new Map<symbol, number>();
let visibleCalls: ReadonlySet<number> = new Set();
const anchorListeners = new Set<() => void>();
export const callAnchors = {
  getSnapshot: () => visibleCalls,
  subscribe(listener: () => void) { anchorListeners.add(listener); return () => { anchorListeners.delete(listener); }; },
  observe(callId: number, element: HTMLElement) {
    const token = Symbol();
    let disposed = false;
    const update = (visible: boolean) => {
      if (visible) anchors.set(token, callId); else anchors.delete(token);
      const next = new Set(anchors.values());
      if (next.size === visibleCalls.size && [...next].every(id => visibleCalls.has(id))) return;
      visibleCalls = next;
      for (const listener of anchorListeners) listener();
    };
    let intersecting = false;
    const refresh = () => {
      if (disposed) return;
      let visible = intersecting;
      for (let node: HTMLElement | null = element; visible && node; node = node.parentElement) {
        const style = getComputedStyle(node);
        visible = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0' && style.pointerEvents !== 'none';
      }
      update(visible);
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0);
      refresh();
    });
    const styles = observer ? new MutationObserver(refresh) : null;
    if (observer) {
      observer.observe(element);
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        styles?.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
      }
    } else update(true);
    return () => { disposed = true; observer?.disconnect(); styles?.disconnect(); update(false); };
  },
};
