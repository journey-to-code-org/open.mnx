import { LitElement, html, css } from 'lit';
// In a Lit template, .count sets the property and @countchange listens.
import './components/hello-counter.zb';

class MyApp extends LitElement {
  static properties = { count: { state: true } };
  static styles = css`main { display: grid; gap: 1rem; } p { margin: 0; color: #5d6375; } h1 { margin: 0; font-size: 1.5rem; }`;

  constructor() {
    super();
    this.count = 0;
  }

  render() {
    return html`
      <main>
        <h1>{{title}}</h1>
        <hello-counter .count=${this.count} @countchange=${(event) => (this.count = event.detail)} label="Clicks"></hello-counter>
        <p>Lit sees <span id="seen">${this.count}</span></p>
      </main>
    `;
  }
}
customElements.define('my-app', MyApp);
