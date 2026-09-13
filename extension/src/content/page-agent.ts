/**
 * Page agent. Injected at document_start into every frame.
 *
 * This is the ref engine. Coordinates alone are brittle: a screenshot goes
 * stale the moment the page reflows, and a click at (412, 380) will happily
 * land on whatever moved there. Refs are WeakRef-backed, so a stale ref says
 * "that element is gone" instead of acting on a recycled node.
 *
 * It lives in the extension's isolated world, which means chrome.scripting
 * calls from the service worker share these globals and can call straight in.
 */

interface PricklyPageAgent {
  version: number;
  tree(options: TreeOptions): TreeResult;
  text(): string;
  resolve(ref: string): ResolveResult;
  setValue(ref: string, value: string): ActionResult;
  rect(ref: string): RectResult;
  search(query: string, limit: number): SearchResult;
}

interface TreeOptions {
  maxDepth?: number;
  /** "interactive" drops static text and containers. */
  filter?: "all" | "interactive";
  /** Subtree root, so an agent can drill in without re-reading the page. */
  rootRef?: string;
  maxChars?: number;
}

interface TreeResult {
  text: string;
  truncated: boolean;
  fullLength: number;
  nodeCount: number;
  url: string;
  title: string;
}

type ResolveResult =
  | { ok: true; ref: string; role: string; name: string }
  | { ok: false; error: string };

type ActionResult = { ok: true } | { ok: false; error: string };

type RectResult =
  | { ok: true; x: number; y: number; width: number; height: number; visible: boolean }
  | { ok: false; error: string };

interface SearchMatch {
  ref: string;
  role: string;
  name: string;
  score: number;
  detail: string;
}

interface SearchResult {
  matches: SearchMatch[];
  scanned: number;
}

(() => {
  const w = window as unknown as {
    __prickly?: PricklyPageAgent;
    __pricklyRefs?: Map<string, WeakRef<Element>>;
    __pricklyReverse?: WeakMap<Element, string>;
    __pricklyCounter?: number;
  };
  if (w.__prickly) return;

  const refs = (w.__pricklyRefs ??= new Map());
  const reverse = (w.__pricklyReverse ??= new WeakMap());

  const nextRef = (el: Element): string => {
    const existing = reverse.get(el);
    if (existing && refs.get(existing)?.deref() === el) return existing;
    w.__pricklyCounter = (w.__pricklyCounter ?? 0) + 1;
    const ref = `ref_${w.__pricklyCounter}`;
    refs.set(ref, new WeakRef(el));
    reverse.set(el, ref);
    return ref;
  };

  const deref = (ref: string): Element | { error: string } => {
    const held = refs.get(ref);
    if (!held) {
      return { error: `${ref} is not a known ref. Read the page again to get fresh refs.` };
    }
    const el = held.deref();
    if (!el) {
      return { error: `${ref} has been garbage collected; the element is gone.` };
    }
    if (!el.isConnected) {
      return { error: `${ref} is no longer in the document.` };
    }
    return el;
  };

  // -------------------------------------------------------------------------
  // Roles and names
  // -------------------------------------------------------------------------

  const TAG_ROLES: Record<string, string> = {
    a: "link",
    button: "button",
    select: "combobox",
    textarea: "textbox",
    img: "image",
    h1: "heading",
    h2: "heading",
    h3: "heading",
    h4: "heading",
    h5: "heading",
    h6: "heading",
    nav: "navigation",
    main: "main",
    header: "banner",
    footer: "contentinfo",
    aside: "complementary",
    form: "form",
    table: "table",
    tr: "row",
    td: "cell",
    th: "columnheader",
    ul: "list",
    ol: "list",
    li: "listitem",
    dialog: "dialog",
    summary: "button",
    details: "group",
    label: "label",
    p: "paragraph",
    video: "video",
    audio: "audio",
    iframe: "iframe",
  };

  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox",
    radio: "radio",
    submit: "button",
    button: "button",
    reset: "button",
    image: "button",
    range: "slider",
    file: "file input",
    search: "searchbox",
    hidden: "hidden",
  };

  const INTERACTIVE_ROLES = new Set([
    "link",
    "button",
    "textbox",
    "searchbox",
    "combobox",
    "checkbox",
    "radio",
    "slider",
    "file input",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "tab",
    "spinbutton",
  ]);

  const roleOf = (el: Element): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0] ?? "generic";
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el as HTMLInputElement).type?.toLowerCase() ?? "text";
      return INPUT_ROLES[type] ?? "textbox";
    }
    return TAG_ROLES[tag] ?? "generic";
  };

  const SENSITIVE_AUTOCOMPLETE =
    /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/i;

  const isSensitive = (el: Element): boolean => {
    if (el.tagName !== "INPUT") return false;
    const input = el as HTMLInputElement;
    const type = input.type?.toLowerCase();
    if (type === "password" || type === "hidden") return true;
    return SENSITIVE_AUTOCOMPLETE.test(input.getAttribute("autocomplete") ?? "");
  };

  const clean = (value: string | null | undefined): string =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

  const nameOf = (el: Element): string => {
    const labelled = el.getAttribute("aria-labelledby");
    if (labelled) {
      const parts = labelled
        .split(/\s+/)
        .map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    for (const attr of ["aria-label", "alt", "title", "placeholder"]) {
      const value = clean(el.getAttribute(attr));
      if (value) return value;
    }
    const id = el.getAttribute("id");
    if (id) {
      const label = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = clean(label?.textContent);
      if (text) return text;
    }
    const wrapping = el.closest("label");
    if (wrapping) {
      const text = clean(wrapping.textContent);
      if (text) return text;
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const value = (el as HTMLInputElement).value;
      if (value) return isSensitive(el) ? "[value redacted]" : clean(value);
      return "";
    }
    // Leaf text only, so a <div> wrapping the page does not claim the page.
    const children = el.children.length;
    if (children === 0) return clean(el.textContent);
    if (children <= 3) {
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => clean(n.textContent))
        .filter(Boolean)
        .join(" ");
      if (own) return own;
    }
    return "";
  };

  const isHidden = (el: Element): boolean => {
    if (el.getAttribute("aria-hidden") === "true") return true;
    if ((el as HTMLElement).hidden) return true;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden") return true;
    if (style.opacity === "0") return true;
    return false;
  };

  const stateOf = (el: Element): string => {
    const bits: string[] = [];
    const input = el as HTMLInputElement;
    if (input.disabled) bits.push("disabled");
    if (input.checked) bits.push("checked");
    if (el.getAttribute("aria-expanded") === "true") bits.push("expanded");
    if (el.getAttribute("aria-selected") === "true") bits.push("selected");
    if (input.required) bits.push("required");
    if (el.tagName === "INPUT" && input.type) bits.push(`type=${input.type}`);
    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("#")) bits.push(`href=${href.slice(0, 120)}`);
    }
    return bits.length ? ` [${bits.join(", ")}]` : "";
  };

  // -------------------------------------------------------------------------
  // Tree
  // -------------------------------------------------------------------------

  const childrenOf = (el: Element): Element[] => {
    const kids = [...el.children];
    const shadow = (el as HTMLElement).shadowRoot;
    if (shadow) kids.push(...shadow.children);
    return kids;
  };

  const tree = (options: TreeOptions): TreeResult => {
    const maxDepth = options.maxDepth ?? 15;
    const maxChars = options.maxChars ?? 50_000;
    const interactiveOnly = options.filter === "interactive";

    let root: Element = document.documentElement;
    if (options.rootRef) {
      const found = deref(options.rootRef);
      if ("error" in found) {
        return {
          text: found.error,
          truncated: false,
          fullLength: 0,
          nodeCount: 0,
          url: location.href,
          title: document.title,
        };
      }
      root = found;
    }

    const lines: string[] = [];
    let nodeCount = 0;

    const visit = (el: Element, depth: number): void => {
      if (depth > maxDepth) return;
      if (isHidden(el)) return;

      const role = roleOf(el);
      if (role === "hidden") return;

      const name = nameOf(el);
      const interactive = INTERACTIVE_ROLES.has(role);
      const show = interactiveOnly ? interactive : role !== "generic" || name !== "";

      let childDepth = depth;
      if (show) {
        nodeCount++;
        const ref = interactive || name ? nextRef(el) : "";
        const indent = "  ".repeat(depth);
        const label = name ? ` "${name}"` : "";
        lines.push(`${indent}${role}${label}${stateOf(el)}${ref ? ` ${ref}` : ""}`);
        childDepth = depth + 1;
      }

      for (const child of childrenOf(el)) visit(child, childDepth);
    };

    visit(root, 0);

    const full = lines.join("\n");
    if (full.length <= maxChars) {
      return {
        text: full,
        truncated: false,
        fullLength: full.length,
        nodeCount,
        url: location.href,
        title: document.title,
      };
    }
    // Cut at a line boundary; a half-line of tree is worse than none.
    const cut = full.lastIndexOf("\n", maxChars);
    return {
      text: full.slice(0, cut > 0 ? cut : maxChars),
      truncated: true,
      fullLength: full.length,
      nodeCount,
      url: location.href,
      title: document.title,
    };
  };

  // -------------------------------------------------------------------------
  // Local search, in place of a nested model call
  // -------------------------------------------------------------------------

  // Common words match nearly every element, so a full-sentence query drowns
  // the real hit in noise. These score far lower than distinctive tokens.
  const STOPWORDS = new Set([
    "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "with", "at",
    "by", "from", "into", "is", "it", "this", "that", "button", "input", "field",
    "the", "message", "chat", "box", "text", "click", "open", "main",
  ]);

  const search = (query: string, limit: number): SearchResult => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const distinctive = terms.filter((t) => !STOPWORDS.has(t) && t.length > 2);
    const candidates = [
      ...document.querySelectorAll(
        "a, button, input, select, textarea, summary, [role], [onclick], [tabindex], " +
          "[contenteditable]:not([contenteditable=false]), [aria-placeholder], [data-placeholder]",
      ),
    ];

    const matches: SearchMatch[] = [];
    for (const el of candidates) {
      if (isHidden(el)) continue;
      const role = roleOf(el);
      if (role === "hidden") continue;
      const name = nameOf(el);
      // Placeholder text lives in several attributes across real inputs and the
      // contenteditable editors that busy apps use for composers; index them
      // all so "send a chat" finds the box that shows that placeholder.
      const placeholder =
        el.getAttribute("placeholder") ??
        el.getAttribute("aria-placeholder") ??
        el.getAttribute("data-placeholder") ??
        "";
      const editable = (el as HTMLElement).isContentEditable ? "editable textbox" : "";
      const haystack = [
        name,
        role,
        placeholder,
        editable,
        el.getAttribute("id") ?? "",
        el.getAttribute("name") ?? "",
        el.getAttribute("aria-label") ?? "",
        el.getAttribute("href") ?? "",
        el.className && typeof el.className === "string" ? el.className : "",
      ]
        .join(" ")
        .toLowerCase();

      let score = 0;
      const why: string[] = [];
      for (const term of terms) {
        if (!haystack.includes(term)) continue;
        const weak = STOPWORDS.has(term) || term.length <= 2;
        // A stopword hit barely counts, so it never outranks a real token.
        score += weak ? 0.1 : 1;
        if (name.toLowerCase() === term) {
          score += 4;
          why.push(`exact name "${term}"`);
        } else if (placeholder.toLowerCase().includes(term) && !weak) {
          score += 3;
          why.push(`placeholder has "${term}"`);
        } else if (name.toLowerCase().startsWith(term)) {
          score += 2;
          why.push(`name starts with "${term}"`);
        } else if (role === term) {
          score += 2;
          why.push(`role is ${term}`);
        } else if (!weak) {
          why.push(`contains "${term}"`);
        }
      }
      // Require at least one distinctive-term hit when the query has any, so a
      // match built purely on stopwords is dropped.
      if (score === 0) continue;
      if (distinctive.length > 0 && !distinctive.some((t) => haystack.includes(t))) continue;
      if (INTERACTIVE_ROLES.has(role)) score += 1;
      matches.push({ ref: nextRef(el), role, name, score, detail: why.join(", ") });
    }

    matches.sort((a, b) => b.score - a.score);
    return { matches: matches.slice(0, limit), scanned: candidates.length };
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const rect = (ref: string): RectResult => {
    const found = deref(ref);
    if ("error" in found) return { ok: false, error: found.error };
    const el = found as Element;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) {
      return { ok: false, error: `${ref} has no layout box; it may be collapsed or offscreen.` };
    }
    // Whether the centre really belongs to this element. An overlay stealing
    // the click is otherwise invisible until the click does nothing.
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const visible = top === el || (top !== null && el.contains(top)) || (top?.contains(el) ?? false);
    return { ok: true, x: cx, y: cy, width: box.width, height: box.height, visible };
  };

  const setValue = (ref: string, value: string): ActionResult => {
    const found = deref(ref);
    if ("error" in found) return { ok: false, error: found.error };
    const el = found as HTMLElement;

    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find(
        (o) => o.value === value || o.textContent?.trim() === value,
      );
      if (!option) {
        return {
          ok: false,
          error: `No option matching "${value}". Options: ${[...el.options]
            .map((o) => o.textContent?.trim())
            .filter(Boolean)
            .slice(0, 20)
            .join(", ")}`,
        };
      }
      el.value = option.value;
    } else if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      el.checked = value === "true" || value === "on" || value === "1";
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      el.value = value;
    } else if (el.isContentEditable) {
      el.focus();
      el.textContent = value;
    } else {
      return { ok: false, error: `${ref} (${roleOf(el)}) does not take a value.` };
    }

    // React and friends listen for these; a bare value assignment looks like
    // nothing happened to a controlled component.
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { ok: true };
  };

  const text = (): string => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const el of clone.querySelectorAll("script, style, noscript, svg, template")) {
      el.remove();
    }
    return (clone.innerText ?? clone.textContent ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n");
  };

  const resolve = (ref: string): ResolveResult => {
    const found = deref(ref);
    if ("error" in found) return { ok: false, error: found.error };
    const el = found as Element;
    return { ok: true, ref, role: roleOf(el), name: nameOf(el) };
  };

  w.__prickly = { version: 1, tree, text, resolve, setValue, rect, search };
})();
