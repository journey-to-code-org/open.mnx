// Demo data: two agents, three customers and a queue of tickets spread over the last two weeks.

export const USERS = [
  { id: 'u-ada', name: 'Ada Park', role: 'agent', email: 'ada@helpdesk.test' },
  { id: 'u-sam', name: 'Sam Okafor', role: 'agent', email: 'sam@helpdesk.test' },
  { id: 'u-lena', name: 'Lena Vogel', role: 'customer', email: 'lena@example.com' },
  { id: 'u-raj', name: 'Raj Mehta', role: 'customer', email: 'raj@example.com' },
  { id: 'u-tom', name: 'Tom Reyes', role: 'customer', email: 'tom@example.com' },
];

const HOUR = 3_600_000;

/** Response targets by priority (the SLA). */
export const SLA_HOURS = { urgent: 4, high: 8, normal: 24, low: 72 };

const TICKETS = [
  ['Checkout page shows a blank screen on Safari', 'u-lena', 'u-ada', 'urgent', 'open', 3, ['I click Pay and the page goes white. Safari 19 on a Mac.'], ['Reproduced on Safari 19. Looking into it.', 'agent']],
  ['Invoice #2291 has the wrong VAT number', 'u-raj', 'u-sam', 'high', 'pending', 20, ['Our VAT number changed in March; the invoice still shows the old one.'], ['Could you send the new number? We will reissue it.', 'agent']],
  ['How do I add a second admin?', 'u-tom', null, 'normal', 'open', 30, ['We need two people who can manage billing.']],
  ['Export to CSV drops accented letters', 'u-lena', 'u-sam', 'normal', 'open', 52, ['Names like Zoë come out as Zo?.']],
  ['Password reset email never arrives', 'u-raj', 'u-ada', 'high', 'solved', 75, ['Tried three times.'], ['It was in our spam filter. Fixed on our side.', 'agent'], ['Got it now, thanks!']],
  ['Feature request: dark mode', 'u-tom', null, 'low', 'open', 110, ['The dashboard is very bright at night.']],
  ['API rate limit too low for our sync', 'u-lena', 'u-ada', 'high', 'pending', 140, ['We hit 429s every hour.'], ['What volume do you need? We can raise it.', 'agent']],
  ['Can we change the account owner?', 'u-raj', 'u-sam', 'normal', 'solved', 170, ['Maria is leaving; Raj should own it.'], ['Done: Raj is the owner now.', 'agent']],
  ['Mobile app crashes on launch (Android 16)', 'u-tom', 'u-ada', 'urgent', 'solved', 200, ['Since this morning the app closes immediately.'], ['A fix is out in 4.2.1.', 'agent']],
  ['Typo on the pricing page', 'u-lena', null, 'low', 'open', 230, ['"Anual" should be "Annual".']],
  ['SSO login loops back to the sign-in page', 'u-raj', 'u-sam', 'urgent', 'open', 6, ['Okta sends us back to the login page every time.']],
  ['Webhook retries are not documented', 'u-tom', 'u-sam', 'normal', 'pending', 290, ['How many times do you retry, and how far apart?']],
];

/** The seed tickets, with times relative to `now`. */
export function seedTickets(now = Date.now()) {
  return TICKETS.map(([subject, requester, assignee, priority, status, hoursAgo, ...messages], index) => {
    const createdAt = now - hoursAgo * HOUR;
    return {
      id: 1001 + index,
      subject,
      requester,
      assignee,
      priority,
      status,
      createdAt,
      updatedAt: createdAt + (messages.length - 1) * HOUR,
      dueAt: createdAt + SLA_HOURS[priority] * HOUR,
      messages: messages.map(([body, by], at) => ({
        id: `m${index}-${at}`,
        author: by === 'agent' ? assignee : requester,
        body,
        at: createdAt + at * HOUR,
        internal: false,
      })),
    };
  });
}
