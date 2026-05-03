// eslint-disable-next-line no-unused-vars
function detectBoxes({ draw = false } = {}) {
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

  // ── PASS 1: CONTROLS ─────────────────────────────────────────────────────────
  const ctrlSel = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="searchbox"]';

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
    return [{ el, tag: el.tagName.toLowerCase(), kind: 'control', text: t, rect: r, selector: pathOf(el) }];
  });

  const controls = rawControls.filter((c, _, arr) =>
    !arr.some(o => o !== c && o.el.contains(c.el) && overlaps(o.rect, c.rect) > 0.85)
  );

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

  const isLayoutWrapper = (el, r) => {
    if (r.width > innerWidth * 0.96) return true;
    const tag = el.tagName.toLowerCase();
    if (['main','header','footer','nav','body','html'].includes(tag)) return true;
    if (tag === 'section' && r.width > innerWidth * 0.85) return true;
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

  const allCardCandidates = [...document.querySelectorAll('div,article,li,section,figure,aside')].filter(el => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    if (!inViewport(r)) return false;
    if (r.width < 50 || r.height < 30) return false;
    if (r.width * r.height < 1500) return false;
    if (isLayoutWrapper(el, r)) return false;
    return cardScore(el) >= 3;
  });

  const innermostCards = allCardCandidates.filter(el =>
    !allCardCandidates.some(other => other !== el && el.contains(other))
  );

  const dedupedCards = innermostCards.filter((el, _, arr) => {
    const r = el.getBoundingClientRect();
    return !arr.some(other => {
      if (other === el) return false;
      const or = other.getBoundingClientRect();
      const ra  = { left:r.left,  right:r.right,  top:r.top,  bottom:r.bottom,  width:r.width,  height:r.height };
      const orr = { left:or.left, right:or.right, top:or.top, bottom:or.bottom, width:or.width, height:or.height };
      return overlaps(ra, orr) > 0.60 && area(orr) < area(ra);
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

  // ── MERGE, INDEX, ADD id ──────────────────────────────────────────────────────
  // id = visualization label: C0, C1… for controls; K0, K1… for cards; I0, I1… for images
  const kindPrefix = { control: 'C', card: 'K', image: 'I' };
  const kindCounters = { control: 0, card: 0, image: 0 };

  const all = [...controls, ...cards, ...images].map((item, i) => {
    const prefix = kindPrefix[item.kind] || 'X';
    const vizId = prefix + kindCounters[item.kind]++;
    return { ...item, index: i, id: vizId };
  });

  // ── DRAW (optional — only when draw:true, for visual debugging) ───────────────
  if (draw) {
    const colors = { control: '#e53e3e', card: '#38a169', image: '#6b46c1' };
    all.forEach(item => {
      const { left, top, width, height } = item.rect;
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