import { LitElement, html, css } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { ContextProvider } from '@lit/context';
import { userContext } from './user.js';
import './components/chat-message.zb';
import './components/message-composer.zb';
import './components/typing-dots.zb';

const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds'];
const minutes = (n) => Date.now() - n * 60000;
let next = 1;
const message = (author, text, time, extra = {}) => ({ id: `m${next++}`, author, text, time, reactions: {}, replyTo: null, ...extra });

// Replies from the rest of the team, so the room feels alive. `?delay=<ms>` in the URL changes
// how long they take (the tests make them quick).
const DELAY = Number(new URLSearchParams(location.search).get('delay')) || 1400;
const ANSWERS = {
  'Ada Lovelace': ['Agreed. I can take the first pass.', 'Let me sketch the analysis and share it.'],
  'Grace Hopper': ['Ship it, then make it better.', "It's easier to ask forgiveness than permission."],
  'Linus Torvalds': ['Show me the code.', 'Looks good, merging after CI.'],
};

export class TeamChat extends LitElement {
  static properties = {
    me: { state: true },
    channel: { state: true },
    channels: { state: true },
    replyTo: { state: true },
    typing: { state: true },
  };

  // The user, provided to every element inside (the zubra messages read it with inject()).
  #provider = new ContextProvider(this, { context: userContext, initialValue: { name: PEOPLE[0] } });

  constructor() {
    super();
    this.me = PEOPLE[0];
    this.channel = 'general';
    this.replyTo = null;
    this.typing = [];
    this.channels = {
      general: { title: 'general', unread: 0, messages: [
        message('Grace Hopper', 'Morning! Standup notes are in the doc: https://example.com/notes', minutes(42), { reactions: { '👍': ['Linus Torvalds'] } }),
        message('Linus Torvalds', 'The release branch is cut. @Ada can you look at the flaky test?', minutes(30)),
        message('Ada Lovelace', 'On it.', minutes(28)),
      ] },
      design: { title: 'design', unread: 2, messages: [
        message('Grace Hopper', 'New empty states are up for review.', minutes(90)),
        message('Ada Lovelace', 'Love the illustrations 🎨', minutes(80), { reactions: { '❤️': ['Grace Hopper'] } }),
      ] },
      random: { title: 'random', unread: 0, messages: [message('Linus Torvalds', 'Who else is going to the meetup on Thursday?', minutes(200))] },
    };
  }

  get messages() {
    return this.channels[this.channel].messages;
  }

  #update(channel, change) {
    this.channels = { ...this.channels, [channel]: { ...this.channels[channel], ...change(this.channels[channel]) } };
  }

  switchUser(name) {
    this.me = name;
    this.#provider.setValue({ name });
  }

  open(channel) {
    this.channel = channel;
    this.replyTo = null;
    this.#update(channel, () => ({ unread: 0 }));
  }

  send(text) {
    const channel = this.channel;
    const sent = message(this.me, text, Date.now(), { replyTo: this.replyTo && { author: this.replyTo.author, text: this.replyTo.text } });
    this.#update(channel, (c) => ({ messages: [...c.messages, sent] }));
    this.replyTo = null;
    // Someone answers: whoever was mentioned, or whoever was replied to, or the next person.
    const mentioned = PEOPLE.find((person) => person !== this.me && text.toLowerCase().includes(`@${person.split(' ')[0].toLowerCase()}`));
    const replier = mentioned ?? (sent.replyTo && sent.replyTo.author !== this.me ? sent.replyTo.author : PEOPLE.find((person) => person !== this.me));
    this.typing = [...this.typing.filter((name) => name !== replier), replier];
    setTimeout(() => {
      this.typing = this.typing.filter((name) => name !== replier);
      const answers = ANSWERS[replier];
      this.#update(channel, (c) => ({
        messages: [...c.messages, message(replier, answers[c.messages.length % answers.length], Date.now(), { replyTo: { author: sent.author, text: sent.text } })],
        unread: this.channel === channel ? 0 : c.unread + 1,
      }));
    }, DELAY);
  }

  react(id, emoji) {
    this.#update(this.channel, (c) => ({
      messages: c.messages.map((item) => {
        if (item.id !== id) return item;
        const people = item.reactions[emoji] ?? [];
        const nextPeople = people.includes(this.me) ? people.filter((person) => person !== this.me) : [...people, this.me];
        return { ...item, reactions: { ...item.reactions, [emoji]: nextPeople } };
      }),
    }));
  }

  updated() {
    const list = this.renderRoot.querySelector('.messages');
    list.scrollTop = list.scrollHeight;
  }

  render() {
    return html`
      <aside>
        <h1>team<b>chat</b></h1>
        <nav aria-label="Channels">
          ${Object.entries(this.channels).map(([id, channel]) => html`
            <button type="button" class=${id === this.channel ? 'on' : ''} data-channel=${id} @click=${() => this.open(id)}>
              <span># ${channel.title}</span>
              ${channel.unread ? html`<b class="unread" aria-label="${channel.unread} unread">${channel.unread}</b>` : null}
            </button>`)}
        </nav>
        <label class="signed-in">Signed in as
          <select aria-label="Signed in as" @change=${(event) => this.switchUser(event.target.value)}>
            ${PEOPLE.map((person) => html`<option ?selected=${person === this.me}>${person}</option>`)}
          </select>
        </label>
      </aside>
      <main>
        <header><h2># ${this.channels[this.channel].title}</h2><span>${this.messages.length} messages</span></header>
        <div class="messages" role="log" aria-label="Messages">
          ${repeat(this.messages, (item) => item.id, (item) => html`
            <chat-message data-id=${item.id} .message=${item}
              @reacttoggle=${(event) => this.react(item.id, event.detail)}
              @reply=${() => { this.replyTo = item; this.renderRoot.querySelector('message-composer textarea')?.focus(); }}></chat-message>`)}
        </div>
        <footer>
          <typing-dots .names=${this.typing}></typing-dots>
          <message-composer .placeholder=${`Message #${this.channels[this.channel].title}`} .replyto=${this.replyTo}
            @send=${(event) => this.send(event.detail)}
            @replycancel=${() => (this.replyTo = null)}></message-composer>
        </footer>
      </main>`;
  }

  static styles = css`
    :host {
      --bg: #f7f7fb; --surface: #fff; --ink: #1c1d26; --muted: #6b6e80; --line: #e4e5ee; --hover: #f2f2f8;
      --side: #2b2240; --side-ink: #d9d3ea; --link: #5b4bdb; --mention: #b4530a; --mention-wash: #fdf1e3;
      display: grid; grid-template-columns: 15rem 1fr; height: 100vh; background: var(--bg); color: var(--ink);
    }
    @media (prefers-color-scheme: dark) {
      :host { --bg: #15151c; --surface: #1d1d27; --ink: #e8e8f2; --muted: #9a9cb0; --line: #2c2d3a; --hover: #232331; --side: #110e1a; --link: #9d92ff; --mention: #f2a65a; --mention-wash: #3a2a17; }
    }
    aside { display: flex; flex-direction: column; gap: 1rem; padding: 1.1rem 0.75rem; background: var(--side); color: var(--side-ink); }
    h1 { margin: 0 0.5rem; font-size: 1.25rem; font-weight: 400; color: white; }
    h1 b { font-weight: 800; }
    nav { display: grid; gap: 0.15rem; }
    nav button { display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.6rem; border: 0; border-radius: 0.45rem; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
    nav button:hover { background: #ffffff14; }
    nav button.on { background: #ffffff26; color: white; font-weight: 700; }
    .unread { min-width: 1.3rem; padding: 0 0.35rem; border-radius: 999px; background: #e0457b; color: white; font-size: 0.75rem; text-align: center; }
    .signed-in { margin-top: auto; display: grid; gap: 0.3rem; padding: 0 0.5rem; font-size: 0.75rem; }
    .signed-in select { padding: 0.35rem; border-radius: 0.45rem; border: 0; font: inherit; font-size: 0.875rem; }
    main { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; }
    main > header { display: flex; align-items: baseline; gap: 0.75rem; padding: 0.9rem 1.25rem; border-bottom: 1px solid var(--line); }
    main > header h2 { margin: 0; font-size: 1.05rem; }
    main > header span { font-size: 0.8125rem; color: var(--muted); }
    .messages { overflow-y: auto; padding: 0.75rem 0; }
    footer { padding: 0 1.25rem 1rem; }
    @media (max-width: 40rem) { :host { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } aside { flex-direction: row; flex-wrap: wrap; align-items: center; } nav { display: flex; } .signed-in { margin: 0; } }
  `;
}

customElements.define('team-chat', TeamChat);
