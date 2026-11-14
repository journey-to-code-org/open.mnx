// A tab list. `tabs` is `[{ id, label }]`; `selected` is two-way: it fires `selectedchange` with
// the chosen tab's id. Arrow keys, Home and End move between the tabs and choose the one they
// land on. The panels are the page's.
import { Component, Element, Event, EventEmitter, Prop, h } from '@stencil/core';

@Component({ tag: 'ds-tabs', styleUrl: 'ds-tabs.css', shadow: true })
export class DsTabs {
  @Element() host: HTMLElement;
  @Prop() tabs: { id: string; label: string }[] = [];
  @Prop({ mutable: true }) selected: string = '';
  @Prop() label: string = '';
  @Event({ eventName: 'selectedchange' }) selectedChange: EventEmitter<string>;
  private focusNext = false;

  private select(id: string) {
    this.selected = id;
    this.selectedChange.emit(id);
  }
  private move = (event: KeyboardEvent) => {
    const index = this.tabs.findIndex((tab) => tab.id === this.selected);
    const last = this.tabs.length - 1;
    const next = { ArrowRight: index === last ? 0 : index + 1, ArrowLeft: index <= 0 ? last : index - 1, Home: 0, End: last }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    this.focusNext = true;
    this.select(this.tabs[next].id);
  };
  componentDidRender() {
    if (!this.focusNext) return;
    this.focusNext = false;
    this.host.shadowRoot.querySelector<HTMLElement>('[aria-selected=true]')?.focus();
  }

  render() {
    return (
      <div role="tablist" aria-label={this.label || null} onKeyDown={this.move}>
        {this.tabs.map((tab) => (
          <button type="button" role="tab" key={tab.id} aria-selected={tab.id === this.selected ? 'true' : 'false'}
                  tabindex={tab.id === this.selected ? 0 : -1} onClick={() => this.select(tab.id)}>{tab.label}</button>
        ))}
      </div>
    );
  }
}
