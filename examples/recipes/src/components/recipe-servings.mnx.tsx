import { from } from '@mnx/runtime'
/** A recipe's ingredients, scaled to the number of people. */
export default function RecipeServings({ servings = 1, ingredients = [] }) {
  let people = from(servings)
  const factor = people / servings
  const label = people === 1 ? "serving" : "servings"

  function amount(value) {
    const scaled = Math.round(value * factor * 100) / 100
    return String(scaled)
  }
  function change(by) {
    people = Math.max(1, people + by)
  }

  return (
    <>
      <div class="servings">
        <button type="button" class="fewer" aria-label="Fewer servings" disabled={people <= 1} onClick={() => change(-1)}>−</button>
        <output>{people}</output> {label}
        <button type="button" class="more" aria-label="More servings" onClick={() => change(1)}>+</button>
      </div>
      <ul class="ingredients">
        {ingredients.map((item) => (
          <li key={item.name}><b>{amount(item.amount)}{item.unit ? ` ${item.unit}` : ""}</b> {item.name}</li>
        ))}
      </ul>
    </>
  )
}
