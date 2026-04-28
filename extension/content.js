/**
 * Tiny Browser MCP — content script
 *
 * Injected on-demand by the service worker. Exposes window.__tinyMcp
 * with click / type / scroll helpers.
 *
 * Safe to inject multiple times (idempotent guard at the bottom).
 */

if (!window.__tinyMcp) {
  window.__tinyMcp = {
    click(x, y) {
      const el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`no element at (${x}, ${y})`);
      el.focus?.();
      el.click();
    },

    type(text, x, y) {
      if (x != null && y != null) {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.focus?.();
          el.click?.();
        }
      }
      const target = document.activeElement ?? document.body;
      // Native input value setter so React/Vue controlled inputs update correctly
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
        nativeInputValueSetter
      ) {
        nativeInputValueSetter.call(target, target.value + text);
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // For contenteditable / other elements fall back to insertText
        document.execCommand('insertText', false, text);
      }
    },

    scroll(deltaX, deltaY, x, y) {
      if (x != null && y != null) {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.scrollBy?.(deltaX, deltaY);
          return;
        }
      }
      window.scrollBy(deltaX, deltaY);
    },
  };
}
