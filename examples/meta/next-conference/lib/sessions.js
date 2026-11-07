// The programme: two days, three tracks.
export const TRACKS = [
  { value: 'all', label: 'All' },
  { value: 'Web', label: 'Web' },
  { value: 'Data', label: 'Data' },
  { value: 'Design', label: 'Design' },
  { value: 'starred', label: '★ Starred' },
];

export const SESSIONS = [
  ['s1', 'Thu', '09:00', '09:45', 'Keynote: The Platform Is the Framework', 'Grace Lin', 'Main hall', 'Web'],
  ['s2', 'Thu', '10:00', '10:40', 'Signals Without the Framework', 'Omar Haddad', 'Room A', 'Web'],
  ['s3', 'Thu', '10:00', '10:40', 'Postgres at the Edge', 'Priya Nair', 'Room B', 'Data'],
  ['s4', 'Thu', '11:00', '11:40', 'Design Tokens That Survive a Rebrand', 'Jonas Berg', 'Room C', 'Design'],
  ['s5', 'Thu', '11:00', '11:40', 'Streaming SQL for Mortals', 'Ana Souza', 'Room B', 'Data'],
  ['s6', 'Thu', '14:00', '14:40', 'Forms Are Still the Web’s Best API', 'Mei Tanaka', 'Room A', 'Web'],
  ['s7', 'Thu', '15:00', '15:40', 'Accessible Charts, Actually', 'Leo Martin', 'Room C', 'Design'],
  ['s8', 'Fri', '09:30', '10:10', 'Server Components, Client Islands', 'Sara Kim', 'Main hall', 'Web'],
  ['s9', 'Fri', '10:30', '11:10', 'Vector Search Without a Vector DB', 'Ravi Patel', 'Room B', 'Data'],
  ['s10', 'Fri', '10:30', '11:10', 'Motion With Meaning', 'Elena Rossi', 'Room C', 'Design'],
  ['s11', 'Fri', '11:30', '12:10', 'Web Components in Every Framework', 'Ade Okoye', 'Room A', 'Web'],
  ['s12', 'Fri', '14:00', '14:40', 'Closing: What We Learned', 'Grace Lin', 'Main hall', 'Web'],
].map(([id, day, start, end, title, speaker, room, track]) => ({ id, day, start, end, title, speaker, room, track }));

export const findSession = (id) => SESSIONS.find((session) => session.id === id) ?? null;
