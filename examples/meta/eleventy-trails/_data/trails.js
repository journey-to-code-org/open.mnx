// The trails. (The elevation profile works out its own SVG points: components' JavaScript runs
// at build time too.)
const TRAILS = [
  ['Laurel Run Loop', 'easy', 4.2, [520, 540, 575, 560, 590, 610, 585, 540, 520], 'A shaded loop along the run, with three footbridges and a picnic meadow at the halfway point.'],
  ['Spruce Knob Summit', 'moderate', 7.8, [1180, 1230, 1290, 1340, 1410, 1460, 1482, 1440, 1360, 1250], 'Up through red spruce to the highest point in the state, with an observation tower at the top.'],
  ['Seneca Rocks Trail', 'moderate', 4.1, [580, 640, 700, 760, 820, 870, 880, 820, 700, 580], 'Switchbacks to a viewing platform below the sandstone fins. The rock beyond is for climbers.'],
  ['Dolly Sods North', 'hard', 15.3, [1150, 1180, 1120, 1190, 1240, 1210, 1260, 1220, 1170, 1200, 1150], 'High plains, heath barrens and wind. Navigation can be tricky in fog: bring a map.'],
  ['Blackwater Canyon Rim', 'easy', 5.6, [960, 955, 950, 945, 930, 925, 940, 950], 'A rail-trail grade along the canyon rim, with overlooks into the gorge.'],
  ['Otter Creek Wilderness', 'hard', 18.9, [560, 610, 700, 820, 900, 860, 780, 700, 640, 600, 560], 'Long and wet: a dozen fords, deep pools, and some of the quietest woods anywhere.'],
  ['Cranberry Glades Boardwalk', 'easy', 0.8, [1030, 1030, 1031, 1030, 1030], 'A short boardwalk over a bog with carnivorous plants and orchids.'],
  ['North Fork Mountain', 'hard', 37.2, [700, 900, 1100, 1180, 1150, 1210, 1160, 1190, 1120, 960, 640], 'A ridge walk with cliffs on one side and views on the other, end to end.'],
];

const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const round = (number) => Math.round(number * 10) / 10;

export default TRAILS.map(([name, difficulty, km, elevation, summary]) => {
  const low = Math.min(...elevation);
  const high = Math.max(...elevation);
  const climb = elevation.slice(1).reduce((sum, meters, index) => sum + Math.max(0, meters - elevation[index]), 0);
  return { name, slug: slug(name), url: `/trails/${slug(name)}/`, difficulty, km, mi: round(km * 0.621371), summary, low, high, climb, elevation };
});
