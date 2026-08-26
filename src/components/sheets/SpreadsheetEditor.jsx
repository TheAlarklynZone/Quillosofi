import { useState, useRef, useEffect, useCallback } from 'react';
import { app } from '@/api/localClient';
import { Save, Maximize2, Minimize2, TableIcon, Undo2, Redo2 } from 'lucide-react';
import SpreadsheetToolbar from './SpreadsheetToolbar';
import ConditionalFormatPanel from './ConditionalFormatPanel';
import * as XLSX from 'xlsx';

const COL_LETTER = (i) => {
  let s = ''; let n = i + 1;
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

const DEFAULT_ROWS = 20;
const DEFAULT_COLS = 10;
const DEFAULT_COL_WIDTH = 100;
const DEFAULT_ROW_HEIGHT = 24;

function makeEmptyData(rows, cols) {
  return Array.from({ length: rows }, () => Array(cols).fill(''));
}

// ── Formula evaluator ──────────────────────────────────────────
function evalFormula(expr, data) {
  if (!expr || !String(expr).startsWith('=')) return expr;
  const formula = String(expr).slice(1).trim().toUpperCase();

  const parseRef = (ref) => {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) return 0;
    const col = m[1].split('').reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const row = parseInt(m[2]) - 1;
    const val = data[row]?.[col] ?? '';
    return isNaN(Number(val)) ? val : Number(val);
  };

  const rangeVals = (range) => {
    const [start, end] = range.split(':');
    const sm = start.match(/^([A-Z]+)(\d+)$/); const em = end.match(/^([A-Z]+)(\d+)$/);
    if (!sm || !em) return [];
    const c1 = sm[1].split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const r1 = parseInt(sm[2]) - 1;
    const c2 = em[1].split('').reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const r2 = parseInt(em[2]) - 1;
    const vals = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      const v = data[r]?.[c] ?? ''; vals.push(isNaN(Number(v)) ? v : Number(v));
    }
    return vals;
  };

  const getArg = (arg) => arg.includes(':') ? rangeVals(arg) : arg.split(',').map(a => parseRef(a.trim()));

  try {
    if (formula.startsWith('SUM(')) { const v = getArg(formula.slice(4, -1)); return v.reduce((a, b) => a + (Number(b) || 0), 0); }
    if (formula.startsWith('AVERAGE(')) { const v = getArg(formula.slice(8, -1)); return v.reduce((a, b) => a + (Number(b) || 0), 0) / v.length; }
    if (formula.startsWith('COUNT(')) { const v = getArg(formula.slice(6, -1)); return v.filter(x => !isNaN(Number(x))).length; }
    if (formula.startsWith('MAX(')) { const v = getArg(formula.slice(4, -1)); return Math.max(...v.map(Number)); }
    if (formula.startsWith('MIN(')) { const v = getArg(formula.slice(4, -1)); return Math.min(...v.map(Number)); }
    if (formula.startsWith('ROUND(')) {
      const parts = formula.slice(6, -1).split(',');
      return Math.round(parseRef(parts[0].trim()) * Math.pow(10, Number(parts[1] || 0))) / Math.pow(10, Number(parts[1] || 0));
    }
    if (formula.startsWith('ABS(')) { return Math.abs(Number(parseRef(formula.slice(4, -1)))); }
    if (formula.startsWith('LEN(')) {
      const ref = formula.slice(4, -1).trim();
      const val = parseRef(ref);
      return String(val).length;
    }
    if (formula.startsWith('UPPER(')) { return String(parseRef(formula.slice(6, -1))).toUpperCase(); }
    if (formula.startsWith('LOWER(')) { return String(parseRef(formula.slice(6, -1))).toLowerCase(); }
    if (formula.startsWith('CONCAT(')) {
      return formula.slice(7, -1).split(',').map(a => {
        const t = a.trim();
        if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
        return String(parseRef(t));
      }).join('');
    }
    if (formula === 'TODAY()') { return new Date().toISOString().slice(0, 10); }
    if (formula.startsWith('IF(')) {
      const inner = formula.slice(3, -1);
      const parts = inner.split(',');
      if (parts.length >= 3) {
        const condStr = parts[0].trim().replace(/([A-Z]+\d+)/g, (m) => {
          const v = parseRef(m); return isNaN(v) ? `"${v}"` : v;
        });
        const evaluated = Function('"use strict"; return (' + condStr + ')')();
        return evaluated ? parts[1].trim().replace(/^"|"$/g, '') : parts[2].trim().replace(/^"|"$/g, '');
      }
    }
    // Simple math with cell refs
    const expr2 = formula.replace(/([A-Z]+\d+)/g, (m) => { const v = parseRef(m); return isNaN(v) ? 0 : v; });
    return Function('"use strict"; return (' + expr2 + ')')();
  } catch { return '#ERR'; }
}

// ── Conditional format evaluator ──────────────────────────────
function applyCFRules(rawVal, rules) {
  const num = Number(rawVal);
  for (const rule of rules) {
    let match = false;
    if (rule.condition === 'equals') match = String(rawVal) === String(rule.value);
    else if (rule.condition === 'not equals') match = String(rawVal) !== String(rule.value);
    else if (rule.condition === 'greater than') match = !isNaN(num) && num > Number(rule.value);
    else if (rule.condition === 'less than') match = !isNaN(num) && num < Number(rule.value);
    else if (rule.condition === 'contains') match = String(rawVal).includes(rule.value);
    else if (rule.condition === 'is empty') match = rawVal === '' || rawVal == null;
    if (match) return rule;
  }
  return null;
}

// ── Fill handle direction ──────────────────────────────────────
function fillValues(srcVal, count) {
  const num = Number(srcVal);
  if (!isNaN(num) && srcVal !== '') return Array.from({ length: count }, (_, i) => num + i + 1);
  return Array(count).fill(srcVal);
}

// MessageSpreadsheet — used in two contexts:
//  1) Inside a chat message (legacy /spreadsheet command). Pass `message`.
//  2) Inside the new Sheets Editor Hub. Pass `sheet` directly (a Spreadsheet
//     entity loaded by the hub) and `embedded={true}` to fill its container.
// Exactly one of `message` or `sheet` must be provided.
export default function MessageSpreadsheet({ message, sheet: sheetProp, onClose, onSave: onSaveCallback, embedded = false }) {
  const [spreadsheet, setSpreadsheet] = useState(null);
  const [data, setData] = useState(makeEmptyData(DEFAULT_ROWS, DEFAULT_COLS));
  const [title, setTitle] = useState('Spreadsheet');
  const [editingTitle, setEditingTitle] = useState(false);
  const [colWidths, setColWidths] = useState(Array(DEFAULT_COLS).fill(DEFAULT_COL_WIDTH));
  const [rowHeights, setRowHeights] = useState(Array(DEFAULT_ROWS).fill(DEFAULT_ROW_HEIGHT));
  const [cellFormats, setCellFormats] = useState({});
  const [cellTypes, setCellTypes] = useState({}); // { 'r,c': { type: 'dropdown'|'checkbox'|'date', options: [...] } }
  const [cfRules, setCfRules] = useState([]);
  const [showCFPanel, setShowCFPanel] = useState(false);
  const [selected, setSelected] = useState({ row: 0, col: 0 });
  const [selection, setSelection] = useState(null); // { r1,c1,r2,c2 } range
  const [editing, setEditing] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [autoSave, setAutoSave] = useState(true);
  const [savedLabel, setSavedLabel] = useState('');
  const [fullscreen, setFullscreen] = useState(false);
  const [formulaBar, setFormulaBar] = useState('');
  const [sortConfig, setSortConfig] = useState(null);
  const [isDraggingFill, setIsDraggingFill] = useState(false);
  const [fillEnd, setFillEnd] = useState(null);
  const [isMouseDown, setIsMouseDown] = useState(false);
  const [selStart, setSelStart] = useState(null);
  // Undo/redo
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  const autoSaveTimer = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const numRows = data.length;
  const numCols = data[0]?.length || DEFAULT_COLS;

  // Load or create spreadsheet — either by sheet ID (hub mode) or message ID (chat mode).
  const sheetIdProp = sheetProp?.id;
  const messageId = message?.id;
  useEffect(() => {
    const load = async () => {
      let s = null;
      if (sheetIdProp) {
        // Hub mode — sheet is provided. Use it directly (it was loaded by the hub).
        s = sheetProp;
      } else if (messageId) {
        const existing = await app.entities.Spreadsheet.filter({ message_id: messageId });
        if (existing.length > 0) {
          s = existing[0];
        } else {
          s = await app.entities.Spreadsheet.create({
            title: 'Spreadsheet', message_id: messageId,
            data: JSON.stringify(makeEmptyData(DEFAULT_ROWS, DEFAULT_COLS)),
            num_rows: DEFAULT_ROWS, num_cols: DEFAULT_COLS,
          });
        }
      }
      if (!s) return;
      setSpreadsheet(s);
      setTitle(s.title || 'Spreadsheet');
      if (s.data) try { setData(JSON.parse(s.data)); } catch { /* leave defaults */ }
      if (s.col_widths) try { setColWidths(JSON.parse(s.col_widths)); } catch {}
      if (s.row_heights) try { setRowHeights(JSON.parse(s.row_heights)); } catch {}
      if (s.cell_formats) try { setCellFormats(JSON.parse(s.cell_formats)); } catch {}
      if (s.cell_types) try { setCellTypes(JSON.parse(s.cell_types)); } catch {}
      if (s.cf_rules) try { setCfRules(JSON.parse(s.cf_rules)); } catch {}
    };
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetIdProp, messageId]);

  const save = useCallback(async (overrideData, overrideTitle) => {
    if (!spreadsheet) return;
    const d = overrideData ?? data;
    const t = overrideTitle ?? title;
    await app.entities.Spreadsheet.update(spreadsheet.id, {
      title: t, data: JSON.stringify(d),
      col_widths: JSON.stringify(colWidths), row_heights: JSON.stringify(rowHeights),
      cell_formats: JSON.stringify(cellFormats), cell_types: JSON.stringify(cellTypes),
      cf_rules: JSON.stringify(cfRules),
      num_rows: d.length, num_cols: d[0]?.length || DEFAULT_COLS,
    });
    // Generate CSV for AI context (chat mode); hub mode just gets the sheet id.
    const csv = d.map(r => r.map(c => String(c ?? '')).join(',')).join('\n');
    onSaveCallback?.(messageId || spreadsheet.id, csv);
    setSavedLabel('Saved!');
    setTimeout(() => setSavedLabel(''), 1500);
  }, [spreadsheet, data, title, colWidths, rowHeights, cellFormats, cellTypes, cfRules, onSaveCallback]);

  const triggerAutoSave = useCallback((newData) => {
    if (!autoSave) return;
    clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => save(newData), 1000);
  }, [autoSave, save]);

  useEffect(() => {
    setFormulaBar(data[selected.row]?.[selected.col] ?? '');
  }, [selected, data]);

  // ── Undo / Redo ──────────────────────────────────────────────
  const pushUndo = (prevData) => {
    undoStack.current.push(prevData.map(r => [...r]));
    redoStack.current = [];
  };

  const undo = () => {
    if (!undoStack.current.length) return;
    redoStack.current.push(data.map(r => [...r]));
    const prev = undoStack.current.pop();
    setData(prev);
  };

  const redo = () => {
    if (!redoStack.current.length) return;
    undoStack.current.push(data.map(r => [...r]));
    const next = redoStack.current.pop();
    setData(next);
  };

  // ── Data mutations ────────────────────────────────────────────
  const updateCell = (row, col, val) => {
    pushUndo(data);
    const newData = data.map((r, ri) => ri === row ? r.map((c, ci) => ci === col ? val : c) : r);
    setData(newData);
    triggerAutoSave(newData);
  };

  const commitEdit = () => {
    if (!editing) return;
    updateCell(editing.row, editing.col, editVal);
    setEditing(null);
  };

  const startEdit = (row, col, initialVal) => {
    const val = initialVal !== undefined ? initialVal : (data[row]?.[col] ?? '');
    setEditing({ row, col });
    setEditVal(val);
    setSelected({ row, col });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // ── Selection helpers ─────────────────────────────────────────
  const cellKey = (r, c) => `${r},${c}`;
  const fmt = (r, c) => cellFormats[cellKey(r, c)] || {};
  const ct = (r, c) => cellTypes[cellKey(r, c)] || {};

  const inSelection = (r, c) => {
    if (!selection) return false;
    const { r1, c1, r2, c2 } = selection;
    return r >= Math.min(r1, r2) && r <= Math.max(r1, r2) && c >= Math.min(c1, c2) && c <= Math.max(c1, c2);
  };

  // ── Fill handle drag ──────────────────────────────────────────
  const handleFillMouseDown = (e) => {
    e.preventDefault(); e.stopPropagation();
    setIsDraggingFill(true);
    setFillEnd({ row: selected.row, col: selected.col });
  };

  const handleCellMouseEnter = (row, col) => {
    if (isMouseDown && selStart) {
      setSelection({ r1: selStart.row, c1: selStart.col, r2: row, c2: col });
      setSelected({ row, col });
    }
    if (isDraggingFill) setFillEnd({ row, col });
  };

  const handleFillMouseUp = () => {
    if (!isDraggingFill || !fillEnd) { setIsDraggingFill(false); return; }
    const srcVal = data[selected.row]?.[selected.col] ?? '';
    pushUndo(data);
    const newData = data.map((r, ri) => r.map((c, ci) => {
      // Fill down if row differs
      if (ci === selected.col && ri > selected.row && ri <= fillEnd.row) {
        const filled = fillValues(srcVal, fillEnd.row - selected.row);
        return filled[ri - selected.row - 1];
      }
      // Fill right if col differs
      if (ri === selected.row && ci > selected.col && ci <= fillEnd.col) {
        const filled = fillValues(srcVal, fillEnd.col - selected.col);
        return filled[ci - selected.col - 1];
      }
      return c;
    }));
    setData(newData);
    setIsDraggingFill(false);
    setFillEnd(null);
    triggerAutoSave(newData);
  };

  // ── Format handler ────────────────────────────────────────────
  const handleFormat = (type, value) => {
    const affectedCells = selection
      ? Object.keys(cellFormats).length >= 0 && (() => {
          const keys = [];
          const { r1, c1, r2, c2 } = selection;
          for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++)
            for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) keys.push(cellKey(r, c));
          return keys;
        })()
      : [cellKey(selected.row, selected.col)];

    const newFormats = { ...cellFormats };
    (affectedCells || [cellKey(selected.row, selected.col)]).forEach(key => {
      const cur = newFormats[key] || {};
      if (type === 'align') newFormats[key] = { ...cur, align: value };
      else if (type === 'color') newFormats[key] = { ...cur, color: value };
      else if (type === 'bg') newFormats[key] = { ...cur, bg: value };
      else newFormats[key] = { ...cur, [type]: !cur[type] };
    });
    setCellFormats(newFormats);
  };

  // ── Cell type handler ─────────────────────────────────────────
  const handleCellType = (type) => {
    const key = cellKey(selected.row, selected.col);
    if (type === 'none') { const n = { ...cellTypes }; delete n[key]; setCellTypes(n); }
    else if (type === 'dropdown') {
      const opts = prompt('Enter dropdown options (comma separated):');
      if (opts) setCellTypes(t => ({ ...t, [key]: { type: 'dropdown', options: opts.split(',').map(s => s.trim()) } }));
    } else {
      setCellTypes(t => ({ ...t, [key]: { type } }));
    }
  };

  // ── Keyboard handler ──────────────────────────────────────────
  const handleKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); return; }

    if (editing) {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit(); setSelected(s => ({ ...s, row: Math.min(s.row + 1, numRows - 1) })); }
      if (e.key === 'Escape') { setEditing(null); setEditVal(''); }
      if (e.key === 'Tab') { e.preventDefault(); commitEdit(); setSelected(s => ({ ...s, col: Math.min(s.col + 1, numCols - 1) })); }
      return;
    }
    const { row, col } = selected;
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected({ row: Math.max(0, row - 1), col }); setSelection(null); }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected({ row: Math.min(numRows - 1, row + 1), col }); setSelection(null); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); setSelected({ row, col: Math.max(0, col - 1) }); setSelection(null); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setSelected({ row, col: Math.min(numCols - 1, col + 1) }); setSelection(null); }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(row, col); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); updateCell(row, col, ''); }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) startEdit(row, col, e.key);
  };

  // ── Sort ──────────────────────────────────────────────────────
  const handleSort = (colIdx) => {
    const asc = sortConfig?.col === colIdx ? !sortConfig.asc : true;
    setSortConfig({ col: colIdx, asc });
    pushUndo(data);
    const newData = [...data].sort((a, b) => {
      const av = a[colIdx] ?? ''; const bv = b[colIdx] ?? '';
      const an = Number(av); const bn = Number(bv);
      const cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av).localeCompare(String(bv));
      return asc ? cmp : -cmp;
    });
    setData(newData); triggerAutoSave(newData);
  };

  // ── Add/Delete rows & cols ───────────────────────────────────
  const addRow = () => { pushUndo(data); const d = [...data, Array(numCols).fill('')]; setData(d); triggerAutoSave(d); };
  const addCol = () => { pushUndo(data); const d = data.map(r => [...r, '']); setColWidths(w => [...w, DEFAULT_COL_WIDTH]); setData(d); triggerAutoSave(d); };
  const deleteRow = () => { if (numRows <= 1) return; pushUndo(data); const d = data.filter((_, i) => i !== selected.row); setData(d); setSelected(s => ({ ...s, row: Math.max(0, s.row - 1) })); triggerAutoSave(d); };

  // ── Export / Import ──────────────────────────────────────────
  const exportData = (fmt) => {
    if (fmt === 'JSON') {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}.json`; a.click();
    } else if (fmt === 'CSV') {
      const csv = data.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${title}.csv`; a.click();
    } else if (fmt === 'XLSX') {
      const ws = XLSX.utils.aoa_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      XLSX.writeFile(wb, `${title}.xlsx`);
    }
  };

  const importData = () => fileInputRef.current?.click();

  const handleImportFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      pushUndo(data);
      if (file.name.endsWith('.json')) { const p = JSON.parse(text); setData(Array.isArray(p) ? p : []); }
      else if (file.name.endsWith('.csv')) { setData(text.split('\n').map(r => r.split(',').map(c => c.replace(/^"|"$/g, '')))); }
      else { const wb = XLSX.read(ev.target.result, { type: 'binary' }); const ws = wb.Sheets[wb.SheetNames[0]]; setData(XLSX.utils.sheet_to_json(ws, { header: 1 })); }
    };
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) reader.readAsBinaryString(file);
    else reader.readAsText(file);
    e.target.value = '';
  };

  // ── Display val ───────────────────────────────────────────────
  const getDisplayVal = (row, col) => {
    const raw = data[row]?.[col] ?? '';
    if (typeof raw === 'string' && raw.startsWith('=')) return String(evalFormula(raw, data));
    return raw;
  };

  // ── Cell renderer ─────────────────────────────────────────────
  const renderCell = (ri, ci) => {
    const isSelected = selected.row === ri && selected.col === ci;
    const isEditing = editing?.row === ri && editing?.col === ci;
    const isInSel = inSelection(ri, ci);
    const isFillTarget = isDraggingFill && fillEnd && (
      (ci === selected.col && ri > selected.row && ri <= fillEnd.row) ||
      (ri === selected.row && ci > selected.col && ci <= fillEnd.col)
    );
    const f = fmt(ri, ci);
    const t = ct(ri, ci);
    const rawVal = data[ri]?.[ci] ?? '';
    const displayVal = getDisplayVal(ri, ci);
    const cfMatch = applyCFRules(displayVal, cfRules);

    const bgClass = f.bg ? '' : (isInSel ? 'bg-primary/10' : isFillTarget ? 'bg-green-900/30' : ri % 2 === 0 ? 'bg-[hsl(220,8%,18%)]' : 'bg-[hsl(220,8%,16%)]');

    return (
      <td
        key={ci}
        style={{
          width: colWidths[ci] || DEFAULT_COL_WIDTH,
          fontWeight: f.bold ? 'bold' : undefined,
          fontStyle: f.italic ? 'italic' : undefined,
          textDecoration: f.underline ? 'underline' : undefined,
          textAlign: f.align || 'left',
          color: cfMatch?.color || f.color || undefined,
          background: cfMatch?.bg || f.bg || undefined,
        }}
        className={`border border-[hsl(225,9%,13%)] px-1 cursor-default overflow-hidden whitespace-nowrap text-xs
          ${isSelected ? 'outline outline-2 outline-primary outline-offset-[-2px]' : ''}
          ${!f.color && !cfMatch?.color ? 'text-[hsl(220,7%,85%)]' : ''}
          ${bgClass}
          relative
        `}
        onClick={() => { commitEdit(); setSelected({ row: ri, col: ci }); setEditing(null); setSelection(null); }}
        onDoubleClick={() => startEdit(ri, ci)}
        onMouseDown={(e) => { if (e.button !== 0) return; setIsMouseDown(true); setSelStart({ row: ri, col: ci }); setSelected({ row: ri, col: ci }); setSelection(null); }}
        onMouseUp={() => { setIsMouseDown(false); if (isDraggingFill) handleFillMouseUp(); }}
        onMouseEnter={() => handleCellMouseEnter(ri, ci)}
      >
        {isEditing ? (
          t.type === 'checkbox' ? (
            <input type="checkbox" checked={rawVal === 'true' || rawVal === true} onChange={e => { updateCell(ri, ci, e.target.checked ? 'true' : 'false'); setEditing(null); }} className="accent-primary" />
          ) : t.type === 'date' ? (
            <input ref={inputRef} type="date" value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitEdit} className="w-full bg-transparent text-white text-xs focus:outline-none" />
          ) : t.type === 'dropdown' ? (
            <select ref={inputRef} value={editVal} onChange={e => { setEditVal(e.target.value); }} onBlur={commitEdit} className="w-full bg-[hsl(228,8%,27%)] text-white text-xs focus:outline-none rounded">
              <option value="">—</option>
              {(t.options || []).map(opt => <option key={opt}>{opt}</option>)}
            </select>
          ) : (
            <input ref={inputRef} value={editVal} onChange={e => setEditVal(e.target.value)} onBlur={commitEdit} className="w-full h-full bg-transparent focus:outline-none text-white text-xs" />
          )
        ) : (
          t.type === 'checkbox' ? (
            <input type="checkbox" checked={rawVal === 'true' || rawVal === true} onChange={e => updateCell(ri, ci, e.target.checked ? 'true' : 'false')} className="accent-primary" />
          ) : (
            <span>{displayVal}</span>
          )
        )}
        {/* Fill handle */}
        {isSelected && !isEditing && (
          <div
            onMouseDown={handleFillMouseDown}
            className="absolute bottom-0 right-0 w-2 h-2 bg-primary cursor-crosshair z-10"
            style={{ transform: 'translate(50%, 50%)' }}
          />
        )}
      </td>
    );
  };

  const inner = (
    <div
      className="flex flex-col h-full"
      onKeyDown={handleKeyDown}
      onMouseUp={() => { setIsMouseDown(false); if (isDraggingFill) handleFillMouseUp(); }}
      tabIndex={0}
      style={{ outline: 'none' }}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[hsl(225,9%,15%)] shrink-0">
        <TableIcon className="h-3.5 w-3.5 text-green-400 shrink-0" />
        {editingTitle ? (
          <input autoFocus value={title} onChange={e => setTitle(e.target.value)}
            onBlur={() => { setEditingTitle(false); save(undefined, title); }}
            onKeyDown={e => { if (e.key === 'Enter') { setEditingTitle(false); save(undefined, title); } if (e.key === 'Escape') setEditingTitle(false); }}
            className="text-xs font-semibold text-green-400 bg-[hsl(228,8%,27%)] border border-primary/50 rounded px-2 py-0.5 focus:outline-none w-36"
          />
        ) : (
          <button onClick={() => setEditingTitle(true)} className="text-xs font-semibold text-green-400 hover:text-green-300 transition-colors">{title}</button>
        )}
        <div className="flex items-center gap-1.5 ml-auto">
          <button onClick={undo} title="Undo (Ctrl+Z)" className="p-1 text-[hsl(220,7%,55%)] hover:text-white transition-colors disabled:opacity-30" disabled={!undoStack.current.length}>
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button onClick={redo} title="Redo (Ctrl+Y)" className="p-1 text-[hsl(220,7%,55%)] hover:text-white transition-colors disabled:opacity-30" disabled={!redoStack.current.length}>
            <Redo2 className="h-3.5 w-3.5" />
          </button>
          {savedLabel && <span className="text-[10px] text-green-400">{savedLabel}</span>}
          <button onClick={() => setAutoSave(v => !v)}
            className={`text-[10px] px-2 py-0.5 rounded-full border transition-all font-medium ${autoSave ? 'border-primary bg-primary/10 text-primary' : 'border-[hsl(225,9%,25%)] text-[hsl(220,7%,50%)] hover:text-white'}`}>
            Auto-save
          </button>
          <button onClick={() => save()} className="text-[hsl(220,7%,55%)] hover:text-white transition-colors" title="Save"><Save className="h-3.5 w-3.5" /></button>
          <button onClick={() => setFullscreen(v => !v)} className="text-[hsl(220,7%,55%)] hover:text-white transition-colors">
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <SpreadsheetToolbar
        onFormat={handleFormat}
        onExport={exportData}
        onImport={importData}
        onAddRow={addRow}
        onAddCol={addCol}
        onDeleteRow={deleteRow}
        onCellType={handleCellType}
        onToggleCF={() => setShowCFPanel(v => !v)}
        showCFPanel={showCFPanel}
        selectedCell={selected}
      />

      {/* Conditional formatting panel */}
      {showCFPanel && (
        <div className="relative">
          <ConditionalFormatPanel
            rules={cfRules}
            onChange={setCfRules}
            onClose={() => setShowCFPanel(false)}
          />
        </div>
      )}

      {/* Formula bar */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-[hsl(225,9%,15%)] shrink-0 bg-[hsl(220,8%,14%)]">
        <span className="text-[10px] text-[hsl(220,7%,45%)] font-mono shrink-0 w-12 text-center">
          {COL_LETTER(selected.col)}{selected.row + 1}
        </span>
        <div className="w-px h-4 bg-[hsl(225,9%,22%)]" />
        <input
          value={editing ? editVal : formulaBar}
          onChange={e => { if (editing) setEditVal(e.target.value); else { setEditing({ ...selected }); setEditVal(e.target.value); } }}
          onKeyDown={e => { if (e.key === 'Enter') { updateCell(selected.row, selected.col, editing ? editVal : formulaBar); setEditing(null); } }}
          placeholder="Value or =SUM(A1:A5), =IF(A1>0, Yes, No), =CONCAT(A1,B1)..."
          className="flex-1 bg-transparent text-xs text-white focus:outline-none font-mono"
        />
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto relative" style={{ userSelect: 'none' }}>
        <table className="border-collapse text-xs" style={{ tableLayout: 'fixed' }}>
          <thead>
            <tr>
              <th className="sticky top-0 left-0 z-20 bg-[hsl(220,8%,14%)] border border-[hsl(225,9%,13%)] w-8 min-w-8" />
              {Array.from({ length: numCols }).map((_, ci) => (
                <th key={ci} style={{ width: colWidths[ci] || DEFAULT_COL_WIDTH, minWidth: 40 }}
                  className="sticky top-0 z-10 bg-[hsl(220,8%,14%)] border border-[hsl(225,9%,13%)] px-1 py-0.5 text-center text-[hsl(220,7%,55%)] font-semibold cursor-pointer hover:bg-[hsl(228,7%,20%)] select-none"
                  onClick={() => handleSort(ci)}
                >
                  {COL_LETTER(ci)}{sortConfig?.col === ci && <span className="ml-0.5">{sortConfig.asc ? '↑' : '↓'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => (
              <tr key={ri} style={{ height: rowHeights[ri] || DEFAULT_ROW_HEIGHT }}>
                <td className="sticky left-0 z-10 bg-[hsl(220,8%,14%)] border border-[hsl(225,9%,13%)] px-1 text-center text-[hsl(220,7%,45%)] select-none text-[10px]">{ri + 1}</td>
                {row.map((_, ci) => renderCell(ri, ci))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <input ref={fileInputRef} type="file" accept=".csv,.json,.xlsx,.xls" onChange={handleImportFile} className="hidden" />
    </div>
  );

  if (fullscreen) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center p-3 md:p-0">
        <div className="absolute inset-0 bg-black/50 backdrop-blur-md" onClick={() => setFullscreen(false)} />
        <div className="relative z-10 flex flex-col w-full md:w-[95vw] h-[90vh] rounded-xl border border-[hsl(225,9%,25%)] shadow-2xl overflow-hidden bg-[hsl(220,8%,16%)]">{inner}</div>
      </div>
    );
  }

  // Embedded mode (Sheets Hub) — fill the parent flex container instead of
  // the constrained 360px chat-message preview.
  if (embedded) {
    return (
      <div className="flex-1 w-full h-full bg-[hsl(220,8%,16%)] overflow-hidden">
        {inner}
      </div>
    );
  }

  return (
    <div className="mt-2 w-full rounded-lg border border-[hsl(225,9%,20%)] bg-[hsl(220,8%,16%)] overflow-hidden" style={{ height: 360 }}>
      {inner}
    </div>
  );
}