/*
 * Custom dictionary for Quillosofi v0.4.
 *
 * Local-first vocabulary store backed by localStorage. Replaces the legacy
 * `CustomWord` entity so the dictionary works without auth and survives
 * cloud-backed dictionary that was removed in v0.4.2.
 *
 * Each entry: { id, word, definition, category, is_pinned, created_date }
 *
 * "Fresh, no pre-seed" — the dictionary starts empty per Alaria's spec.
 */

import { useEffect, useState, useCallback } from 'react';

const STORAGE_KEY = 'quillosofi:customDict';

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(words) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(words));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent('quillosofi:custom-dict-changed'));
}

function genId() {
  return 'w_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Desktop only (window.quillosofi is injected by electron/preload.cjs).
// No-ops in the web build — the browser's native spellchecker is left alone.
function pushToNativeSpellchecker(word) {
  try { window.quillosofi?.spellchecker?.addWord(word); } catch { /* ignore */ }
}
function removeFromNativeSpellchecker(word) {
  try { window.quillosofi?.spellchecker?.removeWord(word); } catch { /* ignore */ }
}

/**
 * Pushes every stored custom word into Chromium's native spellchecker
 * dictionary. Call once on app/editor startup so words added before this
 * bridge existed (or added on another device) still get honored.
 */
export function syncNativeSpellchecker() {
  if (typeof window === 'undefined' || !window.quillosofi?.spellchecker) return;
  readAll().forEach(e => pushToNativeSpellchecker(e.word));
}

export function listCustomWords() {
  return readAll();
}

export function getCustomWord(word) {
  if (!word) return null;
  const w = word.trim().toLowerCase();
  if (!w) return null;
  return readAll().find(e => (e.word || '').toLowerCase() === w) || null;
}

export function isCustomWord(word) {
  return !!getCustomWord(word);
}

export function addCustomWord({ word, definition = '', category = '', is_pinned = false }) {
  const trimmed = (word || '').trim();
  if (!trimmed) return null;
  const all = readAll();
  const existing = all.find(e => (e.word || '').toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const entry = {
    id: genId(),
    word: trimmed,
    definition,
    category,
    is_pinned: !!is_pinned,
    created_date: new Date().toISOString(),
  };
  writeAll([entry, ...all]);
  pushToNativeSpellchecker(entry.word);
  return entry;
}

export function updateCustomWord(id, patch) {
  const all = readAll();
  const next = all.map(e => (e.id === id ? { ...e, ...patch } : e));
  writeAll(next);
  return next.find(e => e.id === id) || null;
}

export function deleteCustomWord(id) {
  const all = readAll();
  const removed = all.find(e => e.id === id);
  writeAll(all.filter(e => e.id !== id));
  if (removed) removeFromNativeSpellchecker(removed.word);
}

export function deleteCustomWordByText(word) {
  if (!word) return;
  const w = word.trim().toLowerCase();
  const all = readAll();
  writeAll(all.filter(e => (e.word || '').toLowerCase() !== w));
  removeFromNativeSpellchecker(word);
}

export function togglePin(id) {
  const all = readAll();
  const next = all.map(e => (e.id === id ? { ...e, is_pinned: !e.is_pinned } : e));
  writeAll(next);
  return next.find(e => e.id === id) || null;
}

export function clearAll() {
  writeAll([]);
}

/**
 * React hook — returns the live list of custom words and CRUD helpers.
 */
export function useCustomDict() {
  const [words, setWords] = useState(readAll);

  useEffect(() => {
    const refresh = () => setWords(readAll());
    window.addEventListener('quillosofi:custom-dict-changed', refresh);
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) refresh();
    });
    return () => {
      window.removeEventListener('quillosofi:custom-dict-changed', refresh);
    };
  }, []);

  const add = useCallback((entry) => addCustomWord(entry), []);
  const update = useCallback((id, patch) => updateCustomWord(id, patch), []);
  const remove = useCallback((id) => deleteCustomWord(id), []);
  const removeByText = useCallback((word) => deleteCustomWordByText(word), []);
  const toggle = useCallback((id) => togglePin(id), []);

  return { words, add, update, remove, removeByText, togglePin: toggle };
}

/**
 * Returns words pinned for AI context, formatted for the LLM USER VOCABULARY
 * block. Used by chat / research when the Custom Dictionary AI extension is on.
 */
export function getPinnedAiContext() {
  return readAll().filter(w => w.is_pinned);
}
