// The registration page: Bootstrap's CSS (from the Sass theme) and its Modal; Zubra components for
// the ticket picker and the workshop list.
import './theme.scss';
import { Modal } from 'bootstrap';
import './components/ticket-picker.zb';
import './components/session-list.zb';

const tickets = [
  { id: 'student', name: 'Student', price: 49, perks: 'Talks, lunch, a student ID at the door' },
  { id: 'standard', name: 'Standard', price: 149, perks: 'Talks, workshops, lunch' },
  { id: 'supporter', name: 'Supporter', price: 249, perks: 'Everything, plus the speakers’ dinner' },
];
const sessions = [
  { id: 'a11y', title: 'Accessible components from scratch', time: '10:00–12:00 · Room A', level: 'Intermediate', seats: 12 },
  { id: 'css', title: 'Modern CSS layout', time: '10:00–12:00 · Room B', level: 'Beginner', seats: 4 },
  { id: 'perf', title: 'Performance budgets that hold', time: '14:00–16:00 · Room A', level: 'Advanced', seats: 0 },
  { id: 'wc', title: 'Web components in any framework', time: '14:00–16:00 · Room B', level: 'Intermediate', seats: 20 },
];

const form = document.querySelector('#register');
const picker = form.querySelector('ticket-picker');
const list = form.querySelector('#sessions');
const total = document.querySelector('#total');
const modal = new Modal('#done');

picker.tickets = tickets;
list.sessions = sessions;
const update = () => {
  const ticket = tickets.find((entry) => entry.id === picker.value);
  total.textContent = `€${ticket?.price ?? 0}`;
};
picker.addEventListener('valuechange', update);

// Bootstrap's validation pattern: check on submit, then show the styles with .was-validated.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  form.classList.add('was-validated');
  if (!form.checkValidity()) return;
  const data = new FormData(form);
  const ticket = tickets.find((entry) => entry.id === data.get('ticket'));
  const picked = sessions.filter((session) => list.value.includes(session.id)).map((session) => session.title);
  document.querySelector('#done-body').textContent =
    `${data.get('name')}: a ${ticket.name} ticket (€${ticket.price})${picked.length ? `, with ${picked.join(' and ')}` : ''}. Details are on their way to ${data.get('email')}.`;
  modal.show();
});

// Bootstrap's colour modes: data-bs-theme switches its CSS variables, for the shadow root too.
const mode = document.querySelector('#mode');
mode.addEventListener('click', () => {
  const dark = document.documentElement.dataset.bsTheme !== 'dark';
  document.documentElement.dataset.bsTheme = dark ? 'dark' : 'light';
  mode.setAttribute('aria-pressed', String(dark));
  mode.textContent = dark ? 'Light mode' : 'Dark mode';
});
