import Badge from '../badge.zb'
import Rating from './rating.zb.jsx'

type Item = { id: number; name: string; unread: number }

const total = (items: Item[]) => items.reduce((sum, item) => sum + item.unread, 0)

/** A panel of people, in TypeScript, using an .zb and a JSX component. */
export default function ZbPanel({ heading = "People", items = [{ id: 1, name: "Ada", unread: 2 }, { id: 2, name: "Linus", unread: 0 }], open = true, onToggle, children }) {
  let clicks = 0
  const unread = total(items)
  const summary = `${unread} unread, ${clicks} clicks`
  function toggle() {
    open = !open
    clicks++
    onToggle(open)
  }
  return (
    <zb-panel>
      <header>
        <h2 onClick={toggle}>{heading}</h2>
        <zb-slot name="actions"><small>no actions</small></zb-slot>
      </header>
      {open ? (
        <ul>
          {items.map((item, i) => (
            <li key={item.id} data-index={i}>
              <Badge label={item.name} count={item.unread} />
            </li>
          ))}
        </ul>
      ) : (
        <p class="closed">Closed</p>
      )}
      <p class="summary">{summary}</p>
      <Rating value={unread > 1 ? 2 : 1} />
      <footer>{children}</footer>
    </zb-panel>
  )
}
