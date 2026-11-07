/**
 * A two-star rating.
 * @fires valuechange - The value changed.
 * @fires change - Committed.
 */
export default function MnxRating({ value = 0, label = "Rating", onValueChange, onChange }) {
  let hovered = null
  const shown = hovered ?? value
  function rate(stars) {
    value = stars
    onValueChange(stars)
    onChange()
  }
  return (
    <>
      <span class="label">{label}</span>
      {[1, 2].map((star) => (
        <button key={star} type="button" className={star <= shown ? "on" : "off"}
          onClick={() => rate(star)} onMouseEnter={() => (hovered = star)} onMouseLeave={() => { hovered = null }}>
          {star}
        </button>
      ))}
      <output>{shown}</output>
      {value > 1 && <em>Great!</em>}
    </>
  )
}
