'use client';
// The schedule: a track filter (the registry's segmented control) and a card per session (the
// app's own component), both mnx elements used as React components from the library build in
// ui/. Starred sessions are remembered in localStorage.
import { useEffect, useMemo, useState } from 'react';
import { SegmentedControl, SessionCard } from '@ui/react';

const KEY = 'webconf:starred';

export default function Schedule({ sessions, tracks }) {
  const [track, setTrack] = useState('all');
  const [starred, setStarred] = useState(() => new Set());
  useEffect(() => {
    try { setStarred(new Set(JSON.parse(localStorage.getItem(KEY) ?? '[]'))); } catch {}
  }, []);
  const star = (id, on) => {
    setStarred((current) => {
      const next = new Set(current);
      if (on) next.add(id); else next.delete(id);
      try { localStorage.setItem(KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const shown = useMemo(
    () => sessions.filter((session) => track === 'all' || (track === 'starred' ? starred.has(session.id) : session.track === track)),
    [sessions, track, starred],
  );
  const days = [...new Set(shown.map((session) => session.day))];
  return (
    <>
      <SegmentedControl value={track} options={tracks} label="Track" onValueChange={(event) => setTrack(event.detail)} />
      <p className="muted count">{shown.length} session{shown.length === 1 ? '' : 's'}{starred.size ? ` · ${starred.size} starred` : ''}</p>
      {days.length === 0 && <p className="empty">Nothing starred yet: use ★ on a session.</p>}
      {days.map((day) => (
        <section key={day} className="day">
          <h2>{day === 'Thu' ? 'Thursday' : 'Friday'}</h2>
          {shown.filter((session) => session.day === day).map((session) => (
            <SessionCard
              key={session.id}
              idText={session.id}
              titleText={session.title}
              speaker={session.speaker}
              start={session.start}
              end={session.end}
              room={session.room}
              track={session.track}
              href={`/sessions/${session.id}`}
              starred={starred.has(session.id)}
              onStarredChange={(event) => star(session.id, event.detail)}
            />
          ))}
        </section>
      ))}
    </>
  );
}
