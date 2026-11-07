import { useEffect, useRef, useState } from 'react';
import TagInput from './components/tag-input.mnx';
import { PEOPLE } from './board.js';

/** Edit a card (or a new one) in a modal dialog. */
export function CardEditor({ card, isNew, suggestions, onSave, onDelete, onClose }) {
  const dialog = useRef(null);
  const [draft, setDraft] = useState(card);
  const set = (key) => (event) => setDraft({ ...draft, [key]: key === 'points' ? Number(event.target.value) : event.target.value });

  useEffect(() => {
    dialog.current.showModal();
  }, []);

  function submit(event) {
    event.preventDefault();
    onSave({ ...draft, title: draft.title.trim() });
  }

  return (
    <dialog ref={dialog} className="editor" onClose={onClose} aria-labelledby="editor-title">
      <form onSubmit={submit}>
        <h2 id="editor-title">{isNew ? 'New card' : 'Edit card'}</h2>
        <label>
          Title
          <input name="title" required value={draft.title} onChange={set('title')} autoFocus />
        </label>
        <div className="row">
          <label>
            Points
            <select name="points" value={draft.points} onChange={set('points')}>
              {[1, 2, 3, 5, 8, 13].map((points) => <option key={points}>{points}</option>)}
            </select>
          </label>
          <label>
            Priority
            <select name="priority" value={draft.priority} onChange={set('priority')}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </label>
          <label>
            Assignee
            <select name="assignee" value={draft.assignee} onChange={set('assignee')}>
              <option value="">Unassigned</option>
              {PEOPLE.map((person) => <option key={person}>{person}</option>)}
            </select>
          </label>
        </div>
        <div className="field">
          <span>Tags</span>
          {/* An mnx form control, controlled like any React input: value + onValueChange. */}
          <TagInput value={draft.tags} suggestions={suggestions} max={5} onValueChange={(event) => setDraft({ ...draft, tags: event.detail })} />
        </div>
        <div className="actions">
          {!isNew && <button type="button" className="danger" onClick={onDelete}>Delete</button>}
          <span className="spacer" />
          <button type="button" onClick={() => dialog.current.close()}>Cancel</button>
          <button type="submit" className="primary">Save</button>
        </div>
      </form>
    </dialog>
  );
}
