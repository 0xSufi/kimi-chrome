// Builds an element map keyed by stable refs, exposed via
// window.__dyspelGenerateAccessibilityTree(filter, depth, max, ref).
//
// Runs at document_start in every frame. Tools use the refs as the
// targeting primitive (computer click, form_input, scroll_to, etc.).

export {};

declare global {
  interface Window {
    __dyspelElementMap: Record<string, WeakRef<Element>>;
    __dyspelRefCounter: number;
    __dyspelGenerateAccessibilityTree: (
      filter: string | null,
      depth: number,
      maxChars: number,
      refId: string | null,
    ) => AccessibilityTreeResult;
  }
}

interface AccessibilityTreeResult {
  pageContent: string;
  viewport: { width: number; height: number };
  error?: string;
}

(function () {
  if (!window.__dyspelElementMap) window.__dyspelElementMap = {};
  if (!window.__dyspelRefCounter) window.__dyspelRefCounter = 0;

  const TAG_TO_ROLE: Record<string, string> = {
    a: 'link', button: 'button', select: 'combobox', textarea: 'textbox',
    h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
    img: 'image', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
    section: 'region', article: 'article', aside: 'complementary', form: 'form', table: 'table',
    ul: 'list', ol: 'list', li: 'listitem', label: 'label',
  };

  const INPUT_TYPE_ROLES: Record<string, string> = {
    submit: 'button', button: 'button', checkbox: 'checkbox', radio: 'radio', file: 'button',
  };

  const SKIP = new Set(['script', 'style', 'meta', 'link', 'title', 'noscript']);
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'details', 'summary']);
  const STRUCTURAL = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'nav', 'main', 'header', 'footer', 'section', 'article', 'aside']);
  const INLINE_TEXT = new Set(['button', 'a', 'summary']);

  function getRole(el: Element): string {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return INPUT_TYPE_ROLES[el.getAttribute('type') ?? ''] ?? 'textbox';
    return TAG_TO_ROLE[tag] ?? 'generic';
  }

  function getLabel(el: Element): string {
    const tag = el.tagName.toLowerCase();

    if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const selected = select.querySelector('option[selected]') ?? select.options[select.selectedIndex];
      const text = selected?.textContent?.trim();
      if (text) return text;
    }

    for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
      const value = el.getAttribute(attr)?.trim();
      if (value) return value;
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      const t = label?.textContent?.trim();
      if (t) return t;
    }

    if (tag === 'input') {
      const input = el as HTMLInputElement;
      const type = el.getAttribute('type') ?? '';
      const value = el.getAttribute('value');
      if (type === 'submit' && value?.trim()) return value.trim();
      if (input.value && input.value.length < 50 && input.value.trim()) return input.value.trim();
    }

    if (INLINE_TEXT.has(tag)) {
      const text = directText(el).trim();
      if (text) return text;
    }

    if (/^h[1-6]$/.test(tag)) {
      const text = el.textContent?.trim();
      if (text) return text.slice(0, 100);
    }

    if (tag === 'img') return '';

    const direct = directText(el).trim();
    if (direct.length >= 3) return direct.length > 100 ? direct.slice(0, 100) + '…' : direct;

    return '';
  }

  function directText(el: Element): string {
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? '';
    }
    return text;
  }

  function isVisible(el: Element): boolean {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const html = el as HTMLElement;
    return html.offsetWidth > 0 && html.offsetHeight > 0;
  }

  function isInteractive(el: Element): boolean {
    if (INTERACTIVE.has(el.tagName.toLowerCase())) return true;
    if (el.getAttribute('onclick') != null) return true;
    if (el.getAttribute('tabindex') != null) return true;
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    if (el.getAttribute('contenteditable') === 'true') return true;
    return false;
  }

  function isInViewport(el: Element): boolean {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0 && r.left < window.innerWidth && r.right > 0;
  }

  function isRelevant(el: Element, opts: { filter: string | null; refId: string | null }): boolean {
    const tag = el.tagName.toLowerCase();
    if (SKIP.has(tag)) return false;
    if (opts.filter !== 'all' && el.getAttribute('aria-hidden') === 'true') return false;
    if (opts.filter !== 'all' && !isVisible(el)) return false;
    if (opts.filter !== 'all' && !opts.refId && !isInViewport(el)) return false;

    if (opts.filter === 'interactive') return isInteractive(el);
    if (isInteractive(el)) return true;
    if (STRUCTURAL.has(tag) || el.getAttribute('role')) return true;
    if (getLabel(el).length > 0) return true;

    const role = getRole(el);
    return role !== 'generic' && role !== 'image';
  }

  function getOrCreateRef(el: Element): string {
    for (const id in window.__dyspelElementMap) {
      if (window.__dyspelElementMap[id].deref() === el) return id;
    }
    const id = `ref_${++window.__dyspelRefCounter}`;
    window.__dyspelElementMap[id] = new WeakRef(el);
    return id;
  }

  window.__dyspelGenerateAccessibilityTree = function (filter, depth, maxChars, refId) {
    try {
      const lines: string[] = [];
      const maxDepth = depth ?? 15;
      const opts = { filter, refId };

      const walk = (el: Element, level: number): void => {
        if (level > maxDepth || !el.tagName) return;

        const relevant = isRelevant(el, opts) || (refId != null && level === 0);
        if (relevant) {
          const role = getRole(el);
          const label = getLabel(el).replace(/\s+/g, ' ').slice(0, 100);
          const ref = getOrCreateRef(el);

          let line = ' '.repeat(level) + role;
          if (label) line += ` "${label.replace(/"/g, '\\"')}"`;
          line += ` [${ref}]`;

          const href = el.getAttribute('href'); if (href) line += ` href="${href}"`;
          const type = el.getAttribute('type'); if (type) line += ` type="${type}"`;
          const ph = el.getAttribute('placeholder'); if (ph) line += ` placeholder="${ph}"`;

          lines.push(line);

          if (el.tagName.toLowerCase() === 'select') {
            const options = (el as HTMLSelectElement).options;
            for (const opt of options) {
              let optLine = ' '.repeat(level + 1) + 'option';
              const text = opt.textContent?.trim().replace(/\s+/g, ' ').slice(0, 100) ?? '';
              if (text) optLine += ` "${text.replace(/"/g, '\\"')}"`;
              if (opt.selected) optLine += ' (selected)';
              if (opt.value && opt.value !== text) optLine += ` value="${opt.value.replace(/"/g, '\\"')}"`;
              lines.push(optLine);
            }
          }
        }

        if (el.children && level < maxDepth) {
          for (const child of el.children) walk(child, relevant ? level + 1 : level);
        }
      };

      if (refId != null) {
        const weak = window.__dyspelElementMap[refId];
        if (!weak) {
          return {
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
            error: `Element ref_id '${refId}' not found. Call read_page without ref_id to refresh refs.`,
          };
        }
        const el = weak.deref();
        if (!el) {
          return {
            pageContent: '',
            viewport: { width: window.innerWidth, height: window.innerHeight },
            error: `Element ref_id '${refId}' is no longer in the DOM. Call read_page without ref_id to refresh refs.`,
          };
        }
        walk(el, 0);
      } else if (document.body) {
        walk(document.body, 0);
      }

      // Sweep stale weak refs.
      for (const id in window.__dyspelElementMap) {
        if (!window.__dyspelElementMap[id].deref()) delete window.__dyspelElementMap[id];
      }

      const content = lines.join('\n');
      if (content.length > maxChars) {
        return {
          pageContent: '',
          viewport: { width: window.innerWidth, height: window.innerHeight },
          error: `Output exceeds ${maxChars} characters (${content.length}). Try a smaller depth or pass a ref_id to focus on a subtree.`,
        };
      }

      return {
        pageContent: content,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    } catch (e) {
      throw new Error(`Accessibility tree error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
})();
