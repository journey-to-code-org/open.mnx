// A Server Component: it reads the programme on the server and hands it to the interactive
// schedule (a client component that uses zubra elements).
import { SESSIONS, TRACKS } from '@/lib/sessions.js';
import Schedule from './Schedule.jsx';

export default function Home() {
  return (
    <>
      <h1>Schedule</h1>
      <Schedule sessions={SESSIONS} tracks={TRACKS} />
    </>
  );
}
