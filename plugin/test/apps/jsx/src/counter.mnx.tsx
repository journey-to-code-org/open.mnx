import Badge from '../components/badge.mnx'

/** A counter written as a JSX component. */
export default function MnxCounter({ count = 0, step = 1, onCountChange }) {
  const doubled = count * 2
  function add() {
    count = count + step
    onCountChange(count)
  }
  return (
    <>
      <button type="button" onClick={add}>add</button>
      <Badge label="count" count={count} />
      <span class="doubled">{doubled}</span>
    </>
  )
}
