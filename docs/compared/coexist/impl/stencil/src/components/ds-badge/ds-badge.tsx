// An order's status, as a coloured label.
import { Component, Prop, h } from '@stencil/core';

@Component({ tag: 'ds-badge', styleUrl: 'ds-badge.css', shadow: true })
export class DsBadge {
  @Prop() status: string = 'pending';

  render() {
    return <span data-status={this.status}>{this.status.slice(0, 1).toUpperCase() + this.status.slice(1)}</span>;
  }
}
