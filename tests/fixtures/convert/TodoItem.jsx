import { useState, useMemo, useCallback, useEffect, useRef } from 'react';

/** One to-do, editable in place. */
export default function TodoItem({ text, done = false, onToggle, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => text);
  const [saves, setSaves] = useState(0);
  const input = useRef(null);
  const label = useMemo(() => (done ? `${text} (done)` : text), [done, text]);

  useEffect(() => {
    if (editing) input.current.focus();
  }, [editing]);

  useEffect(() => {
    console.log('mounted');
    return () => console.log('unmounted');
  }, []);

  const save = useCallback(() => {
    setEditing(false);
    setSaves((n) => n + 1);
    if (draft.trim() && draft !== text) onRename(draft.trim());
  }, [draft, text, onRename]);

  return (
    <li className={done ? 'done' : ''}>
      {editing ? (
        <input ref={input} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
      ) : (
        <>
          <input type="checkbox" checked={done} onChange={() => onToggle(!done)} />
          <span onDoubleClick={() => setEditing(true)}>{label}</span>
          <small>{saves} saves</small>
        </>
      )}
    </li>
  );
}
