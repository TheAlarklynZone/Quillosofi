/*
 * Right-click context menu for spellcheck + custom dictionary inside any
 * writing surface (Canvas Editor, Sheets cells, etc.).
 *
 * Per the v0.4 spec: right-click "Add to Dictionary" must work on BOTH
 * highlighted text AND on individual flagged (mis-spelled) words under the
 * cursor. When a word is flagged, the menu also shows up to 5 suggestions.
 *
 * Usage:
 *   <DictionaryContextMenu containerRef={editorRef} />
 *
 * The component listens to `contextmenu` on the container, figures out
 * what's under the cursor / what's selected, and renders a small floating
 * menu. Selection-aware: if the user has selected text it uses that;
 * otherwise it grabs the word at the click point via caretRangeFromPoint.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { BookPlus, Sparkles, Pin } from 'lucide-react';
import { addCustomWord, isCustomWord, togglePin as togglePinByText, listCustomWords, syncNativeSpellchecker } from '@/lib/customDict';
import { suggest, checkWordSync, preloadSpellcheck } from '@/lib/spellcheck';

function getWordAtPoint(x, y) {
  // Modern browsers: caretRangeFromPoint (Chrome/Safari) or caretPositionFromPoint (Firefox)
  let node = null;
  let offset = 0;
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (!range) return null;
    node = range.startContainer;
    offset = range.startOffset;
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    node = pos.offsetNode;
    offset = pos.offset;
  }
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  // Walk left/right to find word boundaries
  const isWordChar = (c) => /[A-Za-z']/.test(c);
  let start = offset;
  let end = offset;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;
  const word = text.slice(start, end).replace(/^'+|'+$/g, '');
  if (!word || word.length < 2) return null;
  return { word, node, start, end };
}

export default function DictionaryContextMenu({ containerRef }) {
  const [menu, setMenu] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [toast, setToast] = useState('');
  const menuRef = useRef(null);

  // Preload the spell dictionary on mount so suggestions don't lag, and push
  // the custom dictionary into Chromium's native spellchecker so pinned/added
  // words stop showing up as native squiggly-underline typos.
  useEffect(() => { preloadSpellcheck(); syncNativeSpellchecker(); }, []);

  useEffect(() => {
    const onContextMenu = async (e) => {
      const root = containerRef?.current;
      if (!root) return;
      if (!root.contains(e.target)) return;

      // Prefer current selection if present and inside the container.
      let chosenWord = '';
      let isSelection = false;
      const sel = window.getSelection();
      const selText = sel?.toString().trim() || '';
      if (selText && sel.rangeCount && root.contains(sel.anchorNode)) {
        chosenWord = selText;
        isSelection = true;
      } else {
        const found = getWordAtPoint(e.clientX, e.clientY);
        if (found) chosenWord = found.word;
      }

      if (!chosenWord) return;
      e.preventDefault();

      const flagged = !isSelection && chosenWord.split(/\s+/).length === 1 &&
                      !checkWordSync(chosenWord) && !isCustomWord(chosenWord);

      setMenu({
        word: chosenWord,
        x: e.clientX,
        y: e.clientY,
        flagged,
        isSelection,
      });
      setSuggestions([]);

      if (flagged) {
        const sug = await suggest(chosenWord, 5);
        setSuggestions(sug);
      }
    };

    document.addEventListener('contextmenu', onContextMenu);
    return () => document.removeEventListener('contextmenu', onContextMenu);
  }, [containerRef]);

  // Close on outside click or escape
  useEffect(() => {
    if (!menu) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEsc);
    };
  }, [menu]);

  const showToast = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const handleAdd = useCallback((opts = {}) => {
    if (!menu) return;
    const entry = addCustomWord({ word: menu.word, ...opts });
    if (entry) showToast(`"${entry.word}" added to dictionary`);
    setMenu(null);
  }, [menu]);

  const handleAddPinned = useCallback(() => {
    if (!menu) return;
    handleAdd({ is_pinned: true });
  }, [menu, handleAdd]);

  const handleReplace = useCallback((replacement) => {
    if (!menu) return;
    // Re-locate the word under the original click position and replace it
    // via execCommand for ReactQuill / contentEditable compatibility.
    const found = getWordAtPoint(menu.x, menu.y);
    if (!found) { setMenu(null); return; }
    const range = document.createRange();
    range.setStart(found.node, found.start);
    range.setEnd(found.node, found.end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, replacement);
    setMenu(null);
  }, [menu]);

  if (!menu && !toast) return null;

  return (
    <>
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-lg bg-[hsl(220,8%,12%)] border border-primary/40 text-xs text-white shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200">
          <Sparkles className="inline h-3 w-3 mr-1.5 text-primary" />
          {toast}
        </div>
      )}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-[9999] bg-[hsl(220,8%,13%)] border border-[hsl(225,9%,18%)] rounded-lg shadow-2xl p-1 min-w-[220px] max-w-[280px]"
          style={{
            left: Math.min(menu.x, window.innerWidth - 290),
            top: Math.min(menu.y, window.innerHeight - 240),
          }}
        >
          <div className="px-3 py-1.5 border-b border-[hsl(225,9%,18%)] mb-1">
            <p className="text-[10px] uppercase tracking-wider text-[hsl(220,7%,45%)] font-semibold">
              {menu.isSelection ? 'Selection' : (menu.flagged ? 'Possible typo' : 'Word')}
            </p>
            <p className="text-xs font-semibold text-white truncate">{menu.word}</p>
          </div>

          {menu.flagged && suggestions.length > 0 && (
            <div className="border-b border-[hsl(225,9%,18%)] pb-1 mb-1">
              <p className="px-3 py-1 text-[9px] uppercase tracking-wider text-[hsl(220,7%,45%)] font-semibold">
                Suggestions
              </p>
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => handleReplace(s)}
                  className="w-full text-left px-3 py-1.5 text-xs text-[hsl(220,14%,85%)] hover:bg-[hsl(228,7%,22%)] hover:text-white rounded transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          <button
            onClick={() => handleAdd()}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-white hover:bg-[hsl(228,7%,22%)] rounded transition-colors"
          >
            <BookPlus className="h-3.5 w-3.5 text-primary" />
            <span>Add to Dictionary</span>
          </button>

        </div>
      )}
    </>
  );
}
