export interface Room {
  id: string;
  title: string;
  detail: string;
  sleeps: number;
  nightly: number;
}

export interface Place {
  id: string;
  title: string;
  detail: string;
  note: string;
  rooms: Room[];
}

export const PLACES: Place[] = [
  {
    id: 'lake',
    title: 'Lakeside cabins',
    detail: 'Docks, canoes and quiet mornings on the water.',
    note: 'Most booked',
    rooms: [
      { id: 'lake-loft', title: 'Loft cabin', detail: 'One room under the eaves, lake view', sleeps: 2, nightly: 140 },
      { id: 'lake-family', title: 'Family cabin', detail: 'Two bedrooms and a porch', sleeps: 5, nightly: 230 },
    ],
  },
  {
    id: 'ridge',
    title: 'Ridge lodge',
    detail: 'Trailheads at the door, fireplace in every room.',
    note: 'Ski season',
    rooms: [
      { id: 'ridge-queen', title: 'Queen room', detail: 'Fireplace and a mountain view', sleeps: 2, nightly: 165 },
      { id: 'ridge-bunk', title: 'Bunk room', detail: 'Two bunks, shared lounge', sleeps: 4, nightly: 120 },
      { id: 'ridge-suite', title: 'Summit suite', detail: 'Hot tub on the balcony', sleeps: 3, nightly: 310 },
    ],
  },
  {
    id: 'coast',
    title: 'Coastal retreat',
    detail: 'A short walk to the dunes and the beach.',
    note: '',
    rooms: [
      { id: 'coast-studio', title: 'Dune studio', detail: 'Kitchenette and a deck', sleeps: 2, nightly: 150 },
      { id: 'coast-house', title: 'Beach house', detail: 'Three bedrooms, sleeps the whole crew', sleeps: 8, nightly: 420 },
    ],
  },
];

export interface Extra {
  id: 'breakfast' | 'late' | 'pickup' | 'pet';
  label: string;
  description: string;
  /** What it costs for a stay. */
  price: (stay: { nights: number; guests: number }) => number;
  per: string;
}

export const EXTRAS: Extra[] = [
  { id: 'breakfast', label: 'Breakfast', description: 'Served at the lodge, every morning', price: ({ nights, guests }) => 18 * nights * guests, per: '$18 per guest per night' },
  { id: 'late', label: 'Late check-out', description: 'Keep the room until 2 pm', price: () => 40, per: '$40' },
  { id: 'pickup', label: 'Airport pickup', description: 'We meet you at arrivals', price: () => 65, per: '$65' },
  { id: 'pet', label: 'Bringing a pet', description: 'Bed, bowls and treats waiting', price: ({ nights }) => 25 * nights, per: '$25 per night' },
];

export const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
