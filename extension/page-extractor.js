// eslint-disable-next-line no-unused-vars
function detectBoxes({ draw = false, include_selector = false } = {}) {
  document.querySelectorAll('.__boxoverlay').forEach(x => x.remove());

  const px = v => Number.parseFloat(v) || 0;

  const visible = el => {
    if (!el || el.nodeType !== 1) return false;
    try { if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch { /* ignore */ }
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.1;
  };

  const textOf = el => {
    // For labeled form controls, find the associated <label> (by for/id or wrapping element)
    // before falling back to the element's own text. This surfaces checkbox and radio text.
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const wrapLabel = el.closest('label');
    return (el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
            el.getAttribute('alt') || el.getAttribute('title') ||
            forLabel?.textContent?.trim() || wrapLabel?.textContent?.trim() ||
            el.innerText?.trim() || el.textContent?.trim() || '')
      .replace(/\s+/g, ' ').slice(0, 200);
  };

  const pathOf = el => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && e !== document.body; e = e.parentElement) {
      let s = e.tagName.toLowerCase();
      if (e.id) { s += '#' + CSS.escape(e.id); parts.unshift(s); break; }
      parts.unshift(s + [...e.classList].slice(0,2).map(c=>'.'+ CSS.escape(c)).join(''));
    }
    return parts.join(' > ');
  };

  // All rect values rounded to integers
  const getRect = el => {
    const r = el.getBoundingClientRect();
    return {
      top:    Math.round(r.top),
      left:   Math.round(r.left),
      right:  Math.round(r.right),
      bottom: Math.round(r.bottom),
      width:  Math.round(r.width),
      height: Math.round(r.height)
    };
  };

  const inViewport = r =>
    r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
    r.top < innerHeight && r.left < innerWidth;

  const area = r => r.width * r.height;

  const overlaps = (a, b) => {
    const iw = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
    const ih = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    return (iw * ih) / Math.max(1, Math.min(area(a), area(b)));
  };

  // Extra metadata per element — only non-default values are included to keep
  // the payload compact. Eliminates most follow-up query() calls for state.
  const metaOf = el => {
    const tag = el.tagName;
    const m = {};
    if (tag === 'INPUT') {
      m.inputType = el.type || 'text';
      if (el.disabled) m.disabled = true;
      if (el.type === 'checkbox' || el.type === 'radio') {
        m.checked = el.checked;
      } else if (!['file','password','submit','button','image','reset'].includes(el.type)) {
        if (el.value) m.value = el.value.slice(0, 60);
      }
    } else if (tag === 'TEXTAREA') {
      if (el.disabled) m.disabled = true;
      if (el.value) m.value = el.value.slice(0, 60);
    } else if (tag === 'SELECT') {
      if (el.disabled) m.disabled = true;
      const opt = el.options[el.selectedIndex];
      if (opt && el.selectedIndex > 0) m.value = opt.text.trim().slice(0, 60);
    } else if (tag === 'BUTTON') {
      if (el.disabled) m.disabled = true;
    } else if (tag === 'A') {
      const raw = el.getAttribute('href');
      if (raw) {
        if (raw.startsWith('http')) {
          try {
            const u = new URL(el.href);
            m.href = u.origin === location.origin
              ? (u.pathname + u.search) : raw.slice(0, 80);
          } catch { m.href = raw.slice(0, 80); }
        } else {
          m.href = raw.slice(0, 80);
        }
      }
    }
    // ARIA disabled covers role-based controls
    if (el.getAttribute('aria-disabled') === 'true') m.disabled = true;
    // contenteditable rich-text fields (post composer, comment box, Gmail compose, etc.)
    if (el.getAttribute('contenteditable') === 'true') {
      m.inputType = 'contenteditable';
      const val = el.textContent.trim();
      if (val) m.value = val.slice(0, 60);
    }
    return m;
  };

  // ── PASS 1: CONTROLS ─────────────────────────────────────────────────────────
  const ctrlSel = 'a[href],button,input,select,textarea,[contenteditable="true"],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="searchbox"],[role="textbox"]';

  const rawControls = [...document.querySelectorAll(ctrlSel)].flatMap(el => {
    if (!visible(el)) return [];
    const r = getRect(el);
    if (!inViewport(r)) return [];
    if (r.width < 8 || r.height < 8) return [];
    const t = textOf(el);
    const elArea = area(r);
    const hasLabel = t.length > 2;
    const isLargeEnough = elArea > 800;
    // Checkboxes and radios are always small but are valid interactive controls —
    // include them regardless of area or label presence.
    const isToggleControl = el.tagName === 'INPUT' &&
      (el.type === 'checkbox' || el.type === 'radio');
    if (!hasLabel && !isLargeEnough && !isToggleControl) return [];
    const isIconOnly = !t && el.querySelector('svg,img') && elArea < 1300;
    if (isIconOnly) return [];
    return [{ el, tag: el.tagName.toLowerCase(), kind: 'control', text: t, rect: r, selector: pathOf(el), ...metaOf(el) }];
  });

  const controls = rawControls
    // Remove child when a parent tightly wraps it (ancestor dedup)
    .filter((c, _, arr) =>
      !arr.some(o => o !== c && o.el.contains(c.el) && overlaps(o.rect, c.rect) > 0.85)
    )
    // Remove sibling duplicates at nearly the same position with identical text
    // (e.g. range-slider tick labels rendered as two <span>s, offset by ~1px)
    .filter((c, i, arr) => !arr.some((o, j) => {
      if (j >= i) return false;
      if (o.text !== c.text) return false;
      const dx = Math.abs((o.rect.left + o.rect.width / 2) - (c.rect.left + c.rect.width / 2));
      const dy = Math.abs((o.rect.top + o.rect.height / 2) - (c.rect.top + c.rect.height / 2));
      return dx <= 4 && dy <= 4;
    }));

  // ── PASS 2: CARDS ────────────────────────────────────────────────────────────
  const CARD_CLASS_RE = /\b(card|box|panel|feature|item|widget|block|tile|entry|post|product|article|teaser|promo|result|row--)\b/i;

  const hasVisualBoundary = el => {
    const s = getComputedStyle(el);
    const borderSum = px(s.borderTopWidth)+px(s.borderRightWidth)+px(s.borderBottomWidth)+px(s.borderLeftWidth);
    const hasBg = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
    const hasShadow = s.boxShadow !== 'none' && s.boxShadow !== '';
    const radius = px(s.borderTopLeftRadius) || px(s.borderTopRightRadius) || px(s.borderRadius);
    return borderSum > 0 || hasShadow || (hasBg && radius >= 4);
  };

  const hasCardClassName = el => [...el.classList].some(c => CARD_CLASS_RE.test(c));

  const hasIconPlusText = el => {
    const hasIcon = !!el.querySelector('img,svg,[class*="icon"],[class*="Icon"]');
    const hasText = [...el.querySelectorAll('p,h1,h2,h3,h4,h5,h6,span,li')]
      .some(t => visible(t) && (t.innerText||t.textContent||'').trim().length > 20);
    return hasIcon && hasText;
  };

  const hasMultipleTextBlocks = el => {
    const headings = [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h => visible(h) && (h.innerText||'').trim().length > 3);
    const paras = [...el.querySelectorAll('p')].filter(p => visible(p) && (p.innerText||'').trim().length > 20);
    return headings.length >= 2 || (headings.length >= 1 && paras.length >= 1);
  };

  // Bare layout/grid class names that are structural containers, never content cards.
  const LAYOUT_CLASS_RE = /^(row|col(-\d+)?|container(-fluid)?|wrapper|layout|grid(-item)?)$/i;

  const isLayoutWrapper = (el, r) => {
    if (r.width > innerWidth * 0.96) return true;
    // Elements taller than 2× the viewport are content containers, not cards.
    if (r.height > innerHeight * 2) return true;
    const tag = el.tagName.toLowerCase();
    if (['main','header','footer','nav','body','html'].includes(tag)) return true;
    if (tag === 'section' && r.width > innerWidth * 0.85) return true;
    // Grid/layout divs: div.col-12, div.row, div.container, div.wrapper etc.
    if (tag === 'div' && [...el.classList].some(c => LAYOUT_CLASS_RE.test(c))) return true;
    return false;
  };

  const cardScore = el => {
    let score = 0;
    if (hasVisualBoundary(el)) score += 4;
    if (hasCardClassName(el)) score += 4;
    if (hasIconPlusText(el)) score += 3;
    if (hasMultipleTextBlocks(el)) score += 2;
    return score;
  };

  // Elements with explicit interactive ARIA roles should never be re-classified
  // as cards — they're already controls in Pass 1 (e.g. <li role="menuitem">).
  const interactiveRoles = new Set(['button','link','menuitem','tab','checkbox','radio','switch','combobox','searchbox','textbox']);
  const controlElSet = new Set(controls.map(c => c.el));

  const allCardCandidates = [...document.querySelectorAll('div,article,li,section,figure,aside')].filter(el => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (!inViewport(r)) return false;
    if (r.width < 50 || r.height < 30) return false;
    if (r.width * r.height < 1500) return false;
    if (isLayoutWrapper(el, r)) return false;
    // Skip elements already captured as interactive controls (e.g. <li role="menuitem">)
    const role = el.getAttribute('role');
    if (controlElSet.has(el) && role && interactiveRoles.has(role)) return false;
    // Skip elements inside page chrome (header, nav, footer) — those are navigation
    // UI, not content cards. detect_boxes already captures their controls via Pass 1.
    if (el.closest('header, nav, footer, [role="navigation"], [role="banner"]')) return false;
    return cardScore(el) >= 3;
  });

  // Keep only "leaf" card candidates: elements that don't contain other card candidates.
  // Grid/layout wrapper divs (col-*, row, container) are excluded from allCardCandidates
  // via isLayoutWrapper, so semantic elements like <article> become natural leaves.
  const innermostCards = allCardCandidates.filter(el => {
    const children = allCardCandidates.filter(o => o !== el && el.contains(o));
    return children.length === 0;
  });

  const dedupedCards = innermostCards.filter((el, i, arr) => {
    const r = el.getBoundingClientRect();
    const ra  = { left:r.left,  right:r.right,  top:r.top,  bottom:r.bottom,  width:r.width,  height:r.height };
    return !arr.some((other, j) => {
      if (other === el) return false;
      const or = other.getBoundingClientRect();
      const orr = { left:or.left, right:or.right, top:or.top, bottom:or.bottom, width:or.width, height:or.height };
      if (overlaps(ra, orr) <= 0.60) return false;
      // Remove el if a strictly smaller overlapping card exists (keep innermost)
      if (area(orr) < area(ra)) return true;
      // Remove el if an approximately same-size overlapping card appears earlier
      // (eliminates wrapper/content div pairs with identical rendered size)
      const areaRatio = area(orr) / Math.max(1, area(ra));
      return areaRatio >= 0.95 && areaRatio <= 1.05 && j < i;
    });
  });

  const cards = dedupedCards.map(el => ({
    el, tag: el.tagName.toLowerCase(), kind: 'card',
    text: textOf(el), rect: getRect(el), selector: pathOf(el)
  }));

  // ── PASS 3: IMAGES ───────────────────────────────────────────────────────────
  const images = [...document.querySelectorAll('img,video')].flatMap(el => {
    if (!visible(el)) return [];
    const r = getRect(el);
    if (!inViewport(r)) return [];
    if (r.width < 150 || r.height < 100) return [];
    if (el.closest('nav,header,[role="navigation"],[role="banner"]')) return [];
    if (cards.some(c => c.el.contains(el) && overlaps(c.rect, r) > 0.3)) return [];
    return [{ el, tag: el.tagName.toLowerCase(), kind: 'image',
              text: el.getAttribute('alt') || '', rect: r, selector: pathOf(el) }];
  });

  // ── PASS 4: CURSOR-POINTER NON-SEMANTIC ELEMENTS ──────────────────────────────
  // Catch custom click targets (<p>, <div>, <span> styled as buttons/close icons)
  // that don't use semantic interactive elements.
  const ctrlRects = controls.map(c => c.rect);
  const clickableNonStdRaw = [...document.querySelectorAll('p,span,li,td,th,div,h1,h2,h3,h4,h5,h6')].flatMap(el => {
    if (!visible(el)) return [];
    const r = getRect(el);
    if (!inViewport(r)) return [];
    const elArea = area(r);
    if (elArea < 100 || elArea > 50000) return [];
    const t = textOf(el);
    if (t.length < 3) return [];
    if (getComputedStyle(el).cursor !== 'pointer') return [];
    if (isLayoutWrapper(el, r)) return [];
    // Skip if already a standard control
    if (ctrlRects.some(cr => overlaps(cr, r) > 0.5)) return [];
    // Skip if this element IS one of the detected cards (same DOM node) — prevents
    // card elements with cursor:pointer from appearing in both C* and K* slots.
    if (dedupedCards.includes(el)) return [];
    return [{ el, tag: el.tagName.toLowerCase(), kind: 'control', text: t, rect: r, selector: pathOf(el), ...metaOf(el) }];
  });
  // Dedup Pass-4 items: remove children of earlier Pass-4 items and sibling duplicates
  // (e.g. v-chip outer + v-chip__content inner both have cursor:pointer and same text)
  const clickableNonStd = clickableNonStdRaw
    .filter((c, _, arr) =>
      !arr.some(o => o !== c && o.el.contains(c.el) && overlaps(o.rect, c.rect) > 0.85)
    )
    .filter((c, i, arr) => !arr.some((o, j) => {
      if (j >= i) return false;
      if (o.text !== c.text) return false;
      const dx = Math.abs((o.rect.left + o.rect.width / 2) - (c.rect.left + c.rect.width / 2));
      const dy = Math.abs((o.rect.top + o.rect.height / 2) - (c.rect.top + c.rect.height / 2));
      return dx <= 4 && dy <= 4;
    }));

  // ── PASS 5: TABLE SORT HEADERS ───────────────────────────────────────────────
  // <thead> <th> elements are column headers and are frequently sortable.
  // Many table-sort libraries (jQuery tablesorter, TanStack Table, etc.) don't
  // set cursor:pointer, so they escape Pass 1 (no href/role) and Pass 4 (no pointer).
  // Detecting them lets agents click to sort without needing a screenshot.
  const allControlRects = [...ctrlRects, ...clickableNonStd.map(c => c.rect)];
  const sortHeaders = [...document.querySelectorAll('thead th')].flatMap(el => {
    if (!visible(el)) return [];
    const r = getRect(el);
    if (!inViewport(r)) return [];
    if (r.width < 8 || r.height < 8) return [];
    const t = textOf(el);
    if (t.length < 2) return [];
    // Skip if already covered by a Pass 1/4 control (e.g. th contains an <a>)
    if (allControlRects.some(cr => overlaps(cr, r) > 0.5)) return [];
    return [{ el, tag: 'th', kind: 'control', text: t, rect: r, selector: pathOf(el) }];
  });

  // ── MERGE, INDEX, ADD id ──────────────────────────────────────────────────────
  // id = visualization label: C0, C1… for controls; K0, K1… for cards; I0, I1… for images
  const kindPrefix = { control: 'C', card: 'K', image: 'I' };
  const kindCounters = { control: 0, card: 0, image: 0 };

  // Strip `el` DOM reference before building the return value — keeping it in the
  // serialized payload causes CDP "Object reference chain is too long" on pages
  // with special input types (e.g. file inputs whose FileList chain is unserializable).
  const all = [...controls, ...clickableNonStd, ...sortHeaders, ...cards, ...images].map((item) => {
    const prefix = kindPrefix[item.kind] || 'X';
    const vizId = prefix + kindCounters[item.kind]++;
    // eslint-disable-next-line no-unused-vars
    const { el: _, rect, selector: itemSelector, ...rest } = item;
    const cx = Math.round(rect.left + rect.width  / 2);
    const cy = Math.round(rect.top  + rect.height / 2);
    const w  = rect.width;
    const h  = rect.height;
    // Expose raw rect as non-enumerable so draw pass can use it without polluting JSON output.
    const out = { ...rest, id: vizId, cx, cy, w, h };
    if (include_selector) out.selector = itemSelector;
    Object.defineProperty(out, '_rect', { value: rect, enumerable: false });
    return out;
  });

  // ── DRAW (optional — only when draw:true, for visual debugging) ───────────────
  if (draw) {
    const colors = { control: '#e53e3e', card: '#38a169', image: '#6b46c1' };
    all.forEach(item => {
      const { left, top, width, height } = item._rect;
      const color = colors[item.kind] || '#999';
      const div = document.createElement('div');
      div.className = '__boxoverlay';
      div.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;border:2px solid ${color};box-sizing:border-box;pointer-events:none;z-index:2147483647;`;
      const lbl = document.createElement('span');
      lbl.style.cssText = `position:absolute;top:0;left:0;font:bold 9px/1.2 monospace;background:${color};color:#fff;padding:1px 3px;white-space:nowrap;max-width:80px;overflow:hidden;text-overflow:ellipsis;`;
      lbl.textContent = item.id + (item.text ? ' ' + item.text.replace(/[^\x20-\x7E]/g,'').slice(0,12) : '');
      div.appendChild(lbl);
      document.body.appendChild(div);
    });
  }

  return all;
}

// eslint-disable-next-line no-unused-vars
function pageToMarkdown({ char_limit = 8000 } = {}) {
  // Structural chrome/script elements to skip entirely
  const BLOCK_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE']);
  // Interactive/form elements that are NOT content — already covered by detect_boxes.
  // Rendering their text creates noise (option lists, button labels, dismiss icons, etc.)
  const FORM_SKIP = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP']);

  function isHidden(el) {
    try {
      const s = getComputedStyle(el);
      return s.display === 'none' || s.visibility === 'hidden';
    } catch { return false; }
  }

  function childrenMd(node, depth) {
    return Array.from(node.childNodes).map(n => nodeToMd(n, depth)).join('');
  }

  function tableToMd(table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';
    const cells = rows.map(r =>
      Array.from(r.querySelectorAll('th,td')).map(c => c.textContent.trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|'))
    );
    if (!cells[0]?.length) return '';
    const header = cells[0];
    const sep = header.map(() => '---');
    const body = cells.slice(1);
    const fmt = row => '| ' + row.join(' | ') + ' |';
    return '\n' + [fmt(header), fmt(sep), ...body.map(fmt)].join('\n') + '\n\n';
  }

  function nodeToMd(node, depth = 0) {
    // Text node: skip whitespace-only (indentation, newlines between block elements)
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (!t.trim()) return '';
      return t.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const tag = node.tagName;
    if (BLOCK_SKIP.has(tag)) return '';
    if (FORM_SKIP.has(tag)) return '';
    if (node.closest('nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"]')) return '';
    if (isHidden(node)) return '';

    switch (tag) {
      case 'H1': return `\n# ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;
      case 'H2': return `\n## ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;
      case 'H3': return `\n### ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;
      case 'H4': return `\n#### ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;
      case 'H5': return `\n##### ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;
      case 'H6': return `\n###### ${node.textContent.replace(/\s+/g,' ').trim()}\n\n`;

      case 'P': {
        const text = childrenMd(node, depth).trim();
        return text ? `\n${text}\n\n` : '';
      }

      case 'BR': return '\n';
      case 'HR': return '\n---\n\n';

      case 'STRONG':
      case 'B': {
        const inner = childrenMd(node, depth).trim();
        return inner ? `**${inner}**` : '';
      }

      case 'EM':
      case 'I': {
        const inner = childrenMd(node, depth).trim();
        return inner ? `*${inner}*` : '';
      }

      case 'CODE': {
        if (node.closest('pre')) return node.textContent;
        return `\`${node.textContent}\``;
      }

      case 'PRE': {
        const codeEl = node.querySelector('code');
        const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] ?? '';
        const content = (codeEl ?? node).textContent;
        return `\n\`\`\`${lang}\n${content}\n\`\`\`\n\n`;
      }

      case 'BLOCKQUOTE': {
        const inner = childrenMd(node, depth).trim().split('\n').map(l => `> ${l}`).join('\n');
        return `\n${inner}\n\n`;
      }

      case 'A': {
        const href = node.getAttribute('href');
        const text = node.textContent.replace(/\s+/g,' ').trim();
        if (!href || !text) return text || '';
        if (href.startsWith('javascript:') || href === '#') return text;
        return `[${text}](${href})`;
      }

      case 'IMG': {
        const alt = node.getAttribute('alt')?.trim() ?? '';
        const src = node.getAttribute('src') ?? '';
        return alt ? `![${alt}](${src})` : '';
      }

      case 'UL': {
        const items = Array.from(node.children)
          .filter(c => c.tagName === 'LI')
          .map(li => {
            const content = childrenMd(li, depth + 1).trim().replace(/\n\n+/g, '\n');
            const indent = '  '.repeat(depth);
            return `${indent}- ${content}`;
          });
        return items.length ? '\n' + items.join('\n') + '\n\n' : '';
      }

      case 'OL': {
        const items = Array.from(node.children)
          .filter(c => c.tagName === 'LI')
          .map((li, i) => {
            const content = childrenMd(li, depth + 1).trim().replace(/\n\n+/g, '\n');
            const indent = '  '.repeat(depth);
            return `${indent}${i + 1}. ${content}`;
          });
        return items.length ? '\n' + items.join('\n') + '\n\n' : '';
      }

      case 'LI': return childrenMd(node, depth);

      case 'TABLE': return tableToMd(node);
      // TR/TH/TD are handled inside tableToMd; fallthrough to recurse if standalone
      case 'THEAD':
      case 'TBODY':
      case 'TFOOT':
      case 'TR':
      case 'TH':
      case 'TD':
        return childrenMd(node, depth);

      default:
        return childrenMd(node, depth);
    }
  }

  try {
    const root = document.querySelector('main,[role="main"],article') ?? document.body;
    const raw = nodeToMd(root)
      .replace(/[ \t]+\n/g, '\n')   // trailing horizontal whitespace on any line
      .replace(/\n[ \t]+\n/g, '\n\n') // lines containing only spaces/tabs → blank line
      .replace(/\n{3,}/g, '\n\n')    // collapse 3+ newlines to double newline
      .trim();
    return raw.length > char_limit ? raw.slice(0, char_limit) + '\n\u2026(truncated)' : raw;
  } catch {
    return '';
  }
}