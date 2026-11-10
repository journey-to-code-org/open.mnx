import { useEffect, useMemo, useReducer, useState } from 'react';
// The column comes from a library (built with `zubra build --lib`, see ../ui), as a React
// component; the card and the editor are this app's own components.
// zubra-snippet:start react-imports
import { KanbanColumn } from '@zubra-examples/ui/react';
import TaskCard from './components/task-card.zb';
// zubra-snippet:end react-imports
// The editor was a React component; `zubra convert` made it a zubra one (see ../CONVERTED.md).
import CardEditor from './components/card-editor.zb.jsx';
import { COLUMNS, PEOPLE, load, reducer, save } from './board.js';

export function App() {
  const [board, dispatch] = useReducer(reducer, null, load);
  const [query, setQuery] = useState('');
  const [person, setPerson] = useState('');
  const [editing, setEditing] = useState(null); // { card, column, isNew }

  useEffect(() => save(board), [board]);

  const matches = (card) =>
    (!person || card.assignee === person) &&
    (!query || `${card.title} ${card.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const visible = useMemo(
    () => Object.fromEntries(COLUMNS.map(({ id }) => [id, board.columns[id].map((cardId) => board.cards[cardId]).filter(matches)])),
    [board, query, person],
  );
  const allTags = useMemo(() => [...new Set(Object.values(board.cards).flatMap((card) => card.tags))].sort(), [board.cards]);
  const points = (column) => board.columns[column].reduce((sum, id) => sum + board.cards[id].points, 0);
  const total = COLUMNS.reduce((sum, { id }) => sum + points(id), 0);
  const done = points('done');

  function open(card) {
    setEditing({ card, isNew: false });
  }
  function create(column) {
    setEditing({ card: { id: `c${Date.now().toString(36)}`, title: '', points: 3, assignee: '', tags: [], priority: 'normal' }, column, isNew: true });
  }

  return (
    <div className="app">
      <header>
        <div>
          <h1>Sprint 14</h1>
          <p className="progress">
            <progress max={total || 1} value={done} aria-label="Points done" /> {done} of {total} points done
          </p>
        </div>
        <div className="tools">
          <input type="search" placeholder="Filter cards" aria-label="Filter cards" value={query} onChange={(event) => setQuery(event.target.value)} />
          <select aria-label="Assignee" value={person} onChange={(event) => setPerson(event.target.value)}>
            <option value="">Everyone</option>
            {PEOPLE.map((name) => <option key={name}>{name}</option>)}
          </select>
          <button type="button" className="undo" disabled={!board.history.length} onClick={() => dispatch({ type: 'undo' })}>Undo move</button>
          <button type="button" className="reset" onClick={() => dispatch({ type: 'reset' })}>Reset</button>
        </div>
      </header>
      <main className="board">
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            data-column={column.id}
            heading={column.heading}
            count={board.columns[column.id].length}
            limit={column.limit}
            onCardDrop={(event) => dispatch({ type: 'move', id: event.detail.id, column: column.id, before: visible[column.id][event.detail.index]?.id ?? null })}
          >
            {/* zubra-snippet:start react-cards */}
            {visible[column.id].map((card) => (
              <TaskCard
                key={card.id}
                data-id={card.id}
                card={card}
                onCardOpen={() => open(card)}
                onCardMove={(event) => dispatch({ type: 'shift', id: card.id, by: event.detail })}
                onCardReorder={(event) => dispatch({ type: 'reorder', id: card.id, by: event.detail })}
              />
            ))}
            {/* zubra-snippet:end react-cards */}
            <button type="button" slot="actions" className="add" onClick={() => create(column.id)}>+ Add card</button>
          </KanbanColumn>
        ))}
      </main>
      <p className="hint">Drag cards between columns, or focus one: Enter opens it, Shift+arrows move it.</p>
      {editing && (
        <CardEditor
          card={editing.card}
          isNew={editing.isNew}
          suggestions={allTags}
          onClose={() => setEditing(null)}
          onSave={(event) => { dispatch({ type: 'save', card: event.detail, column: editing.column }); setEditing(null); }}
          onDelete={() => { dispatch({ type: 'remove', id: editing.card.id }); setEditing(null); }}
        />
      )}
    </div>
  );
}
