// The list page's glue: the filter hides trails, and the units switch every card (remembered).
const items = [...document.querySelectorAll('.trails > li')];
const none = document.querySelector('.none');
const units = document.querySelector('segmented-control');

document.querySelector('trail-filter').addEventListener('filterchange', (event) => {
  const { levels, longest } = event.detail;
  let shown = 0;
  for (const item of items) {
    item.hidden = !levels.includes(item.dataset.level) || Number(item.dataset.km) > longest;
    if (!item.hidden) shown++;
  }
  none.hidden = shown > 0;
});

function setUnits(value) {
  for (const card of document.querySelectorAll('trail-card')) card.units = value;
  try {
    localStorage.setItem('units', value);
  } catch {}
}
units.addEventListener('valuechange', (event) => setUnits(event.detail));
let saved = null;
try {
  saved = localStorage.getItem('units');
} catch {}
if (saved === 'mi') {
  await customElements.whenDefined('segmented-control');
  units.value = 'mi';
  setUnits('mi');
}
